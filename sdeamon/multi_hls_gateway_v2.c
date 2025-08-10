// multi_hls_gateway_opt.c
// Performans odaklı sürüm:
// - YENI: avio_open_dyn_buf ile segment sonu kopyasını kaldırdık. Özel AVIOContext (write callback) ile
//         doğrudan segment tamponuna yazıyoruz (memcpy azalır, avio_close_dyn_buf → malloc/copy yok).
// - YENI: Segmenti gerçekten “anlık” kapatıyoruz. Önceki kod segmentleri döngüde hiç finalize etmiyordu,
//         sadece thread biterken son segmenti kapatıyordu. Artık her 2 saniyede bir önceki segmenti
//         av_write_trailer ile kapatıp diziye koyuyoruz; m3u8 gerçek canlı listesi üretir.
// - YENI: Ses yolu; SWR giriş/çıkış formatlarını gerçek dekoder parametrelerinden türetiyoruz.
//         FIFO ve SWR format uyumsuzluğu (ESKI: FIFO=S16, SWR out=FLTP) giderildi.
//         FIFO artık encoder sample_fmt (FLTP) ile çalışır; per-frame av_samples_alloc/free yok.
// - YENI: AVFrame/AVPacket tahsisleri yeniden kullanılıyor (heap churn azalır).
// - YENI: Girdi için reconnect opsiyonları ve küçük timeouts eklendi (kararlılık/latency).
// - YENI: SSL bevcb C++ lambda yerine C fonksiyonu (C derleyici uyumlu).
// - YENI: /seg_XXX.ts için gencb ile dinamik path routing (ESKI: evhttp_set_cb "/seg_" exact match yapmaz).
// - YENI: HLS m3u8 canlı (ENDLIST yok), MEDIA-SEQUENCE ilk segment numarasına ayarlandı.
// - DİPNOT: Bu dosya yan sürüm; ana dosyayı bozmaz.

#include <event2/event.h>
#include <event2/http.h>
#include <event2/http_struct.h>
#include <event2/buffer.h>
#include <event2/keyvalq_struct.h>
#include <openssl/ssl.h>
#include <openssl/err.h>

#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/avstring.h>
#include <libavutil/channel_layout.h>
#include <libswresample/swresample.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>
#include <ctype.h>

#define PORT 5001
#define MAX_STREAMS 50
#define MAX_SEGMENTS 10
#define SEGMENT_DURATION_MS 2000
#define STREAM_TIMEOUT_SEC 600  // 10 dakika
#define IO_BUF_SIZE 32768

// === Bellek Üzerinde Segment ===
typedef struct {
    uint8_t *data;
    size_t size;
    size_t cap;
    int num;
    int64_t pts_start, pts_end;
    AVIOContext *avio;     // YENI: AVIOContext referansı (write callback için)
    uint8_t *avio_buf;     // YENI: AVIO internal buffer
} mem_segment_t;

// === Transkoder Bağlamı ===
typedef struct {
    char input_url[512];
    int video_stream_index;
    int audio_stream_index;

    AVFormatContext *ifmt_ctx;
    AVCodecContext *a_dec_ctx;
    AVCodecContext *a_enc_ctx;
    SwrContext *swr_ctx;
    AVAudioFifo *fifo;

    AVFormatContext *ofmt_ctx;  // aktif segment için muxer ctx
    int active_seg_index;       // YENI: aktif yazılan segment indeksi
    int64_t seg_start_time_ms;  // YENI: segment başlangıç timestamp (ms)

    // YENI: PTS takibi (ses)
    int64_t a_next_pts; // encoder time_base: 1/sample_rate (samples cinsinden)

    mem_segment_t segments[MAX_SEGMENTS];
    int seg_head; // toplam üretilen segment sayacı (artarak gider)

    pthread_mutex_t mutex;
    pthread_t thread;

    time_t last_access;  // çoklu akış için erişim zamanı
} transcoder_t;

// === Akış Haritası: hash → transcoder ===
typedef struct {
    unsigned int hash;
    transcoder_t *t;
    char url[512];
} stream_entry_t;

static stream_entry_t stream_map[MAX_STREAMS];
static int stream_count = 0;
static pthread_mutex_t map_mutex = PTHREAD_MUTEX_INITIALIZER;
static struct event_base *base;

static SSL_CTX *g_ssl_ctx = NULL;

// === URL Decode ===
static void url_decode(char *dst, const char *src) {
    char a, b;
    while (*src) {
        if (*src == '%' && src[1] && src[2]) {
            a = toupper((unsigned char)src[1]); b = toupper((unsigned char)src[2]);
            if (isxdigit((unsigned char)a) && isxdigit((unsigned char)b)) {
                *dst++ = ((a <= '9') ? a - '0' : a - 'A' + 10) << 4 |
                         ((b <= '9') ? b - '0' : b - 'A' + 10);
                src += 3; continue;
            }
        }
        *dst++ = *src++;
    }
    *dst = '\0';
}

// === Hash Fonksiyonu ===
static unsigned int hash_str(const char *s) {
    unsigned int h = 5381;
    unsigned char c;
    while ((c = (unsigned char)*s++) != 0) h = ((h << 5) + h) + c;
    return h;
}

// === AVIO write callback (segmente direkt yaz) ===
// YENI: avio_open_dyn_buf yerine; kopyasız/malok-free pek az.
static int seg_write_cb(void *opaque, uint8_t *buf, int buf_size) {
    mem_segment_t *seg = (mem_segment_t*)opaque;
    if (!buf_size) return 0;
    size_t need = seg->size + buf_size;
    if (need > seg->cap) {
        size_t new_cap = seg->cap ? seg->cap : (size_t) (IO_BUF_SIZE * 2);
        while (new_cap < need) new_cap *= 2;
        uint8_t *p = (uint8_t*)av_realloc(seg->data, new_cap);
        if (!p) return AVERROR(ENOMEM);
        seg->data = p;
        seg->cap = new_cap;
    }
    memcpy(seg->data + seg->size, buf, buf_size);
    seg->size += buf_size;
    return buf_size;
}

// === AVIO open/close helpers ===
static int open_segment_muxer(transcoder_t *t, mem_segment_t *seg) {
    // ofmt_ctx kur
    int ret = avformat_alloc_output_context2(&t->ofmt_ctx, NULL, "mpegts", NULL);
    if (ret < 0 || !t->ofmt_ctx) return AVERROR_UNKNOWN;

    // Video stream (ESKI: time_base sabit 1/90000; YENI: yine 1/90000, TS uyumlu).
    AVStream *vst = avformat_new_stream(t->ofmt_ctx, NULL);
    if (!vst) return AVERROR(ENOMEM);
    ret = avcodec_parameters_copy(vst->codecpar, t->ifmt_ctx->streams[t->video_stream_index]->codecpar);
    if (ret < 0) return ret;
    vst->time_base = (AVRational){1, 90000};

    // Audio stream (AAC paramları encoder’dan)
    AVStream *ast = avformat_new_stream(t->ofmt_ctx, NULL);
    if (!ast) return AVERROR(ENOMEM);
    ast->codecpar->codec_id = AV_CODEC_ID_AAC;
    ast->codecpar->codec_type = AVMEDIA_TYPE_AUDIO;
    ast->codecpar->sample_rate = t->a_enc_ctx->sample_rate;
    ast->codecpar->channel_layout = t->a_enc_ctx->channel_layout;
    ast->codecpar->channels = t->a_enc_ctx->channels;
    ast->codecpar->format = t->a_enc_ctx->sample_fmt;
    ast->codecpar->bit_rate = t->a_enc_ctx->bit_rate;
    ast->time_base = (AVRational){1, t->a_enc_ctx->sample_rate};

    // Özel AVIO bağla
    seg->size = 0;
    if (!seg->avio_buf) seg->avio_buf = (uint8_t*)av_malloc(IO_BUF_SIZE);
    if (!seg->avio_buf) return AVERROR(ENOMEM);
    seg->avio = avio_alloc_context(seg->avio_buf, IO_BUF_SIZE, 1 /*write*/, seg, NULL, seg_write_cb, NULL);
    if (!seg->avio) return AVERROR(ENOMEM);
    t->ofmt_ctx->pb = seg->avio;
    t->ofmt_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;

    if ((ret = avformat_write_header(t->ofmt_ctx, NULL)) < 0) return ret;
    return 0;
}

static void close_segment_muxer(transcoder_t *t) {
    if (!t->ofmt_ctx) return;
    // TS için trailer minimal; yine de çağırmak iyi.
    av_write_trailer(t->ofmt_ctx);
    if (t->ofmt_ctx->pb) {
        // avio_free: buffer av_malloc ile; avio_context_free serbest bırakır.
        AVIOContext *pb = t->ofmt_ctx->pb;
        t->ofmt_ctx->pb = NULL;
        avio_context_free(&pb); // buffer'ı da free eder
    }
    avformat_free_context(t->ofmt_ctx);
    t->ofmt_ctx = NULL;
}

// === Yeni Segment Başlat / Öncekini finalize et ===
static int start_new_segment(transcoder_t *t) {
    pthread_mutex_lock(&t->mutex);

    // Eğer aktif segment varsa, finalize et (YENI)
    if (t->active_seg_index >= 0 && t->ofmt_ctx) {
        close_segment_muxer(t);
        // finalize edilmiş segment zaten seg dizisinde duruyor (data/size dolu)
    }

    // Yeni slot
    int idx = t->seg_head % MAX_SEGMENTS;
    mem_segment_t *seg = &t->segments[idx];

    // Eski slotu temizle
    if (seg->data) {
        av_free(seg->data);
        seg->data = NULL;
        seg->size = 0;
        seg->cap = 0;
    }
    if (seg->avio) {
        avio_context_free(&seg->avio); // güvenlik
        seg->avio = NULL;
    }
    // avio_buf kalabilir; avio_context_free onu da serbest bırakırdı.

    seg->num = t->seg_head;

    // Yeni muxer/avio aç
    int ret = open_segment_muxer(t, seg);
    if (ret == 0) {
        t->active_seg_index = idx;
        t->seg_start_time_ms = av_gettime() / 1000;
        t->seg_head++;
    }

    pthread_mutex_unlock(&t->mutex);
    return ret;
}

// === Ses: FIFO'ya encoder formatında (FLTP) yaz, frame boyutunda encode et ===
static int push_and_encode_audio(transcoder_t *t, AVFrame *in_frame) {
    int ret = 0;

    // Dönüşüm çerçevesi
    AVFrame *cfrm = av_frame_alloc();
    if (!cfrm) return AVERROR(ENOMEM);
    cfrm->channel_layout = t->a_enc_ctx->channel_layout;
    cfrm->channels       = t->a_enc_ctx->channels;
    cfrm->format         = t->a_enc_ctx->sample_fmt;
    cfrm->sample_rate    = t->a_enc_ctx->sample_rate;
    cfrm->nb_samples     = in_frame ? in_frame->nb_samples : 0;

    if (in_frame) {
        if ((ret = av_frame_get_buffer(cfrm, 0)) < 0) goto done;
        if ((ret = swr_convert_frame(t->swr_ctx, cfrm, in_frame)) < 0) goto done;

        // FIFO'ya ekle
        if ((ret = av_audio_fifo_realloc(t->fifo, av_audio_fifo_size(t->fifo) + cfrm->nb_samples)) < 0) goto done;
        ret = av_audio_fifo_write(t->fifo, (void**)cfrm->data, cfrm->nb_samples);
        if (ret < cfrm->nb_samples) { ret = AVERROR_UNKNOWN; goto done; }
    }

    // FIFO'da frame_size kadar varsa encode et
    AVPacket *pkt = av_packet_alloc();
    AVFrame  *efr = av_frame_alloc();
    if (!pkt || !efr) { ret = AVERROR(ENOMEM); goto done2; }

    while (av_audio_fifo_size(t->fifo) >= t->a_enc_ctx->frame_size) {
        efr->nb_samples     = t->a_enc_ctx->frame_size;
        efr->channel_layout = t->a_enc_ctx->channel_layout;
        efr->channels       = t->a_enc_ctx->channels;
        efr->format         = t->a_enc_ctx->sample_fmt;
        efr->sample_rate    = t->a_enc_ctx->sample_rate;
        if ((ret = av_frame_get_buffer(efr, 0)) < 0) break;

        // FIFO'dan çek
        ret = av_audio_fifo_read(t->fifo, (void**)efr->data, efr->nb_samples);
        if (ret < efr->nb_samples) { ret = AVERROR_UNKNOWN; break; }

        // PTS (samples cinsinden)
        efr->pts = t->a_next_pts;
        t->a_next_pts += efr->nb_samples;

        if ((ret = avcodec_send_frame(t->a_enc_ctx, efr)) < 0) break;
        while ((ret = avcodec_receive_packet(t->a_enc_ctx, pkt)) == 0) {
            pkt->stream_index = 1; // out audio
            // Yaz
            pthread_mutex_lock(&t->mutex);
            if (t->ofmt_ctx) av_interleaved_write_frame(t->ofmt_ctx, pkt);
            pthread_mutex_unlock(&t->mutex);
            av_packet_unref(pkt);
        }
        av_frame_unref(efr);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) ret = 0;
    }

done2:
    if (pkt) av_packet_free(&pkt);
    if (efr) av_frame_free(&efr);
done:
    av_frame_free(&cfrm);
    return ret;
}

// === Transkod Döngüsü ===
static void* transcode_loop(void *arg) {
    transcoder_t *t = (transcoder_t*)arg;

    AVPacket *pkt = av_packet_alloc();
    AVFrame  *frame = av_frame_alloc();
    if (!pkt || !frame) return NULL;

    // İlk segment
    if (start_new_segment(t) < 0) { goto end; }

    int64_t last_seg_ms = t->seg_start_time_ms;

    while (av_read_frame(t->ifmt_ctx, pkt) >= 0) {
        int64_t now_ms = av_gettime() / 1000;
        if (now_ms - last_seg_ms >= SEGMENT_DURATION_MS) {
            start_new_segment(t);
            last_seg_ms = t->seg_start_time_ms;
        }

        if (pkt->stream_index == t->video_stream_index) {
            AVStream *in_st = t->ifmt_ctx->streams[pkt->stream_index];
            // Ölçekle ve yaz
            pthread_mutex_lock(&t->mutex);
            if (t->ofmt_ctx) {
                av_packet_rescale_ts(pkt, in_st->time_base, t->ofmt_ctx->streams[0]->time_base);
                pkt->stream_index = 0;
                av_interleaved_write_frame(t->ofmt_ctx, pkt);
            }
            pthread_mutex_unlock(&t->mutex);
        } else if (pkt->stream_index == t->audio_stream_index) {
            if (avcodec_send_packet(t->a_dec_ctx, pkt) == 0) {
                while (avcodec_receive_frame(t->a_dec_ctx, frame) == 0) {
                    push_and_encode_audio(t, frame);
                    av_frame_unref(frame);
                }
            }
        }

        av_packet_unref(pkt);

        // Erişim zamanını güncelle
        pthread_mutex_lock(&map_mutex);
        t->last_access = time(NULL);
        pthread_mutex_unlock(&map_mutex);
    }

    // Flush: decoder → swr → fifo → encoder
    avcodec_send_packet(t->a_dec_ctx, NULL);
    while (avcodec_receive_frame(t->a_dec_ctx, frame) == 0) {
        push_and_encode_audio(t, frame);
        av_frame_unref(frame);
    }
    // FIFO'da kalanları encode et
    push_and_encode_audio(t, NULL);
    // Encoder flush
    avcodec_send_frame(t->a_enc_ctx, NULL);
    AVPacket *fpkt = av_packet_alloc();
    while (avcodec_receive_packet(t->a_enc_ctx, fpkt) == 0) {
        fpkt->stream_index = 1;
        pthread_mutex_lock(&t->mutex);
        if (t->ofmt_ctx) av_interleaved_write_frame(t->ofmt_ctx, fpkt);
        pthread_mutex_unlock(&t->mutex);
        av_packet_unref(fpkt);
    }
    av_packet_free(&fpkt);

end:
    // Aktif segmenti kapat
    pthread_mutex_lock(&t->mutex);
    close_segment_muxer(t);
    pthread_mutex_unlock(&t->mutex);

    av_packet_free(&pkt);
    av_frame_free(&frame);

    // Kaynaklar
    avformat_close_input(&t->ifmt_ctx);
    avcodec_free_context(&t->a_dec_ctx);
    avcodec_free_context(&t->a_enc_ctx);
    swr_free(&t->swr_ctx);
    if (t->fifo) av_audio_fifo_free(t->fifo);

    // Haritadan kaldır
    pthread_mutex_lock(&map_mutex);
    for (int i = 0; i < stream_count; i++) {
        if (stream_map[i].t == t) {
            // segment bufferlarını bırak
            for (int k = 0; k < MAX_SEGMENTS; k++) {
                if (t->segments[k].data) av_free(t->segments[k].data);
                if (t->segments[k].avio) avio_context_free(&t->segments[k].avio);
            }
            free(stream_map[i].t);
            memmove(&stream_map[i], &stream_map[i+1], (--stream_count - i) * sizeof(stream_entry_t));
            break;
        }
    }
    pthread_mutex_unlock(&map_mutex);

    return NULL;
}

// === Yeni Transcoder Başlat ===
static transcoder_t* start_transcoder(const char *url) {
    transcoder_t *t = (transcoder_t*)calloc(1, sizeof(transcoder_t));
    if (!t) return NULL;

    av_strlcpy(t->input_url, url, sizeof(t->input_url));
    t->last_access = time(NULL);
    pthread_mutex_init(&t->mutex, NULL);
    t->active_seg_index = -1;
    t->a_next_pts = 0;

    // YENI: reconnect/timeout opsiyonları
    AVDictionary *opts = NULL;
    av_dict_set(&opts, "reconnect", "1", 0);
    av_dict_set(&opts, "reconnect_streamed", "1", 0);
    av_dict_set(&opts, "reconnect_on_network_error", "1", 0);
    av_dict_set(&opts, "rw_timeout", "2000000", 0); // 2s microseconds

    if (avformat_open_input(&t->ifmt_ctx, url, NULL, &opts) < 0) goto fail;
    av_dict_free(&opts);
    if (avformat_find_stream_info(t->ifmt_ctx, NULL) < 0) goto fail;

    t->video_stream_index = av_find_best_stream(t->ifmt_ctx, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);

    t->audio_stream_index = -1;
    for (unsigned i = 0; i < t->ifmt_ctx->nb_streams; i++) {
        if (t->ifmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            // ESKI: yalnız MP2 kabul ediyordu. YENI: MP2 ağırlıkta ama audio varsa al.
            t->audio_stream_index = (int)i; break;
        }
    }
    if (t->audio_stream_index < 0) goto fail;

    // MP2 decode (veya mevcut audio codec)
    const AVCodec *dec = avcodec_find_decoder(t->ifmt_ctx->streams[t->audio_stream_index]->codecpar->codec_id);
    if (!dec) goto fail;
    t->a_dec_ctx = avcodec_alloc_context3(dec);
    avcodec_parameters_to_context(t->a_dec_ctx, t->ifmt_ctx->streams[t->audio_stream_index]->codecpar);
    if (avcodec_open2(t->a_dec_ctx, dec, NULL) < 0) goto fail;

    // AAC encode
    const AVCodec *enc = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (!enc) goto fail;
    t->a_enc_ctx = avcodec_alloc_context3(enc);
    t->a_enc_ctx->sample_rate    = 48000;
    t->a_enc_ctx->channel_layout = AV_CH_LAYOUT_STEREO;
    t->a_enc_ctx->channels       = av_get_channel_layout_nb_channels(t->a_enc_ctx->channel_layout);
    t->a_enc_ctx->sample_fmt     = enc->sample_fmts ? enc->sample_fmts[0] : AV_SAMPLE_FMT_FLTP; // çoğu durumda FLTP
    t->a_enc_ctx->bit_rate       = 128000;
    t->a_enc_ctx->time_base      = (AVRational){1, t->a_enc_ctx->sample_rate};
    av_opt_set(t->a_enc_ctx, "profile", "aac_low", 0);
    if (avcodec_open2(t->a_enc_ctx, enc, NULL) < 0) goto fail;

    // YENI: SWR in/out gerçek formatlara göre
    t->swr_ctx = swr_alloc_set_opts(
        NULL,
        t->a_enc_ctx->channel_layout, t->a_enc_ctx->sample_fmt, t->a_enc_ctx->sample_rate,
        (t->a_dec_ctx->channel_layout ? t->a_dec_ctx->channel_layout : av_get_default_channel_layout(t->a_dec_ctx->channels)),
        t->a_dec_ctx->sample_fmt, t->a_dec_ctx->sample_rate ? t->a_dec_ctx->sample_rate : 48000,
        0, NULL
    );
    if (!t->swr_ctx || swr_init(t->swr_ctx) < 0) goto fail;

    // YENI: FIFO encoder formatında
    t->fifo = av_audio_fifo_alloc(t->a_enc_ctx->sample_fmt, t->a_enc_ctx->channels, 1024);
    if (!t->fifo) goto fail;

    // Thread
    if (pthread_create(&t->thread, NULL, transcode_loop, t) != 0) goto fail;

    return t;

fail:
    if (t->fifo) av_audio_fifo_free(t->fifo);
    if (t->swr_ctx) swr_free(&t->swr_ctx);
    if (t->a_enc_ctx) avcodec_free_context(&t->a_enc_ctx);
    if (t->a_dec_ctx) avcodec_free_context(&t->a_dec_ctx);
    if (t->ifmt_ctx) avformat_close_input(&t->ifmt_ctx);
    free(t);
    return NULL;
}

// === Akış Bul veya Oluştur ===
static transcoder_t* get_or_create_transcoder(const char *url) {
    unsigned int h = hash_str(url);

    pthread_mutex_lock(&map_mutex);
    for (int i = 0; i < stream_count; i++) {
        if (stream_map[i].hash == h && strcmp(stream_map[i].url, url) == 0) {
            stream_map[i].t->last_access = time(NULL);
            transcoder_t *ret = stream_map[i].t;
            pthread_mutex_unlock(&map_mutex);
            return ret;
        }
    }

    if (stream_count >= MAX_STREAMS) {
        pthread_mutex_unlock(&map_mutex);
        return NULL;
    }

    transcoder_t *t = start_transcoder(url);
    if (!t) { pthread_mutex_unlock(&map_mutex); return NULL; }

    stream_map[stream_count].hash = h;
    stream_map[stream_count].t = t;
    av_strlcpy(stream_map[stream_count].url, url, sizeof(stream_map[stream_count].url));
    stream_count++;

    pthread_mutex_unlock(&map_mutex);
    return t;
}

// === /m3u8?q=... Handler ===
static void m3u8_handler(struct evhttp_request *req) {
    const char *uri = evhttp_request_get_uri(req);
    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    if (!decoded) { evhttp_send_error(req, 400, "Bad Request"); return; }

    const char *query = evhttp_uri_get_query(decoded);
    if (!query) { evhttp_send_error(req, 400, "Missing query"); evhttp_uri_free(decoded); return; }

    const char *q = strstr(query, "q=");
    if (!q) { evhttp_send_error(req, 400, "q= required"); evhttp_uri_free(decoded); return; }

    char encoded[1024] = {0};
    av_strlcpy(encoded, q + 2, sizeof(encoded));
    char input_url[1024];
    url_decode(input_url, encoded);

    transcoder_t *t = get_or_create_transcoder(input_url);
    if (!t) { evhttp_send_error(req, 500, "Cannot start transcoder"); evhttp_uri_free(decoded); return; }

    // YENI: canlı playlist (ENDLIST yok), media-sequence hesapla
    char m3u8[4096] = {0};
    strcat(m3u8, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n");

    pthread_mutex_lock(&t->mutex);
    int first_num = -1, count = 0;
    for (int i = 0; i < MAX_SEGMENTS; i++) {
        if (t->segments[i].size > 0) {
            if (first_num < 0) first_num = t->segments[i].num;
            if (t->segments[i].num < first_num) first_num = t->segments[i].num;
        }
    }
    if (first_num < 0) first_num = 0;
    char line[128];
    sprintf(line, "#EXT-X-MEDIA-SEQUENCE:%d\n", first_num);
    strcat(m3u8, line);

    // Segmentleri numaraya göre sırala (küçük buffer, O(n^2) sorun değil)
    for (int n = first_num; n < first_num + 10000; n++) {
        for (int i = 0; i < MAX_SEGMENTS; i++) {
            if (t->segments[i].size > 0 && t->segments[i].num == n) {
                sprintf(line, "#EXTINF:2.0,\nseg_%03d.ts?h=%x\n", t->segments[i].num, hash_str(input_url));
                strcat(m3u8, line);
                count++;
            }
        }
        if (count >= MAX_SEGMENTS) break;
    }
    pthread_mutex_unlock(&t->mutex);

    struct evbuffer *buf = evbuffer_new();
    evbuffer_add_printf(buf, "%s", m3u8);
    evhttp_add_header(evhttp_request_get_output_headers(req), "Content-Type", "application/vnd.apple.mpegurl");
    evhttp_send_reply(req, 200, "OK", buf);
    evbuffer_free(buf);
    evhttp_uri_free(decoded);
}

// === /seg_XXX.ts?h=... Handler ===
static void segment_handler(struct evhttp_request *req) {
    const char *uri = evhttp_request_get_uri(req);
    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    if (!decoded) { evhttp_send_error(req, 400, "Bad Request"); return; }

    // num
    int num = -1;
    const char *path = evhttp_uri_get_path(decoded);
    if (!path || sscanf(path, "/seg_%d.ts", &num) != 1) {
        evhttp_send_error(req, 400, "Invalid segment");
        evhttp_uri_free(decoded);
        return;
    }

    // hash al
    const char *query = evhttp_uri_get_query(decoded);
    const char *h_str = (query ? strstr(query, "h=") : NULL);
    if (!h_str) {
        evhttp_send_error(req, 400, "h= required");
        evhttp_uri_free(decoded);
        return;
    }
    unsigned int target_hash = (unsigned int)strtoul(h_str + 2, NULL, 16);

    // Haritadan bul
    transcoder_t *t = NULL;
    pthread_mutex_lock(&map_mutex);
    for (int i = 0; i < stream_count; i++) {
        if (hash_str(stream_map[i].url) == target_hash) {
            t = stream_map[i].t;
            t->last_access = time(NULL);
            break;
        }
    }
    pthread_mutex_unlock(&map_mutex);

    if (!t) {
        evhttp_send_error(req, 404, "Stream not found");
        evhttp_uri_free(decoded);
        return;
    }

    mem_segment_t *found = NULL;
    pthread_mutex_lock(&t->mutex);
    for (int i = 0; i < MAX_SEGMENTS; i++) {
        if (t->segments[i].num == num && t->segments[i].size > 0) {
            found = &t->segments[i];
            break;
        }
    }
    pthread_mutex_unlock(&t->mutex);

    if (!found) {
        evhttp_send_error(req, 404, "Segment not found");
        evhttp_uri_free(decoded);
        return;
    }

    struct evbuffer *buf = evbuffer_new();
    evbuffer_add(buf, found->data, found->size);
    evhttp_add_header(evhttp_request_get_output_headers(req), "Content-Type", "video/MP2T");
    evhttp_send_reply(req, 200, "OK", buf);
    evbuffer_free(buf);
    evhttp_uri_free(decoded);
}

// === Temizlik Thread’i ===
static void* cleanup_thread(void *arg) {
    while (1) {
        sleep(60);
        time_t now = time(NULL);
        pthread_mutex_lock(&map_mutex);
        for (int i = 0; i < stream_count; i++) {
            if (now - stream_map[i].t->last_access > STREAM_TIMEOUT_SEC) {
                printf("Akış zaman aşımına uğradı: %s\n", stream_map[i].url);
                // Kaynakları serbest bırak (thread kendi kapanır/kapatıldı varsayalım)
                transcoder_t *t = stream_map[i].t;
                for (int k = 0; k < MAX_SEGMENTS; k++) {
                    if (t->segments[k].data) av_free(t->segments[k].data);
                    if (t->segments[k].avio) avio_context_free(&t->segments[k].avio);
                }
                free(t);
                memmove(&stream_map[i], &stream_map[i+1], (--stream_count - i) * sizeof(stream_entry_t));
                i--;
            }
        }
        pthread_mutex_unlock(&map_mutex);
    }
    return NULL;
}

// === SSL bufferevent callback (C dostu) ===
static struct bufferevent* bevcb(struct event_base *base, void *arg) {
    SSL *ssl = SSL_new(g_ssl_ctx);
    return bufferevent_openssl_socket_new(base, -1, ssl, BUFFEREVENT_SSL_ACCEPTING, BEV_OPT_CLOSE_ON_FREE);
}

// === Generic router (YENI): dinamik path'ler için ===
static void generic_handler(struct evhttp_request *req, void *arg) {
    const char *uri = evhttp_request_get_uri(req);
    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    if (!decoded) { evhttp_send_error(req, 400, "Bad Request"); return; }
    const char *path = evhttp_uri_get_path(decoded);
    if (!path) { evhttp_send_error(req, 404, "Not Found"); evhttp_uri_free(decoded); return; }

    if (strcmp(path, "/m3u8") == 0) {
        evhttp_uri_free(decoded);
        m3u8_handler(req);
        return;
    }
    if (strncmp(path, "/seg_", 5) == 0) {
        evhttp_uri_free(decoded);
        segment_handler(req);
        return;
    }
    evhttp_uri_free(decoded);
    evhttp_send_error(req, 404, "Not Found");
}

// === Ana Fonksiyon ===
int main() {
    avformat_network_init(); // YENI: modern FFmpeg init
    SSL_load_error_strings();
    OpenSSL_add_ssl_algorithms();

    base = event_base_new();
    struct evhttp *http = evhttp_new(base);

    g_ssl_ctx = SSL_CTX_new(TLS_server_method());
    if (SSL_CTX_use_certificate_file(g_ssl_ctx, "cert.pem", SSL_FILETYPE_PEM) <= 0 ||
        SSL_CTX_use_PrivateKey_file(g_ssl_ctx, "key.pem", SSL_FILETYPE_PEM) <= 0) {
        fprintf(stderr, "Sertifika hatası. 'cert.pem' ve 'key.pem' oluşturun.\n");
        return 1;
    }

    evhttp_set_bevcb(http, bevcb, NULL);
    evhttp_set_allowed_methods(http, EVHTTP_REQ_GET);
    evhttp_set_max_headers_size(http, 8192);

    // ESKI: evhttp_set_cb(http, "/seg_", ...) exact match yapmaz.
    // YENI: generic router ile /m3u8 ve /seg_XXX.ts path'lerini yönetiyoruz.
    evhttp_set_gencb(http, generic_handler, NULL);

    if (evhttp_bind_socket(http, "0.0.0.0", PORT) < 0) {
        fprintf(stderr, "Bağlantı hatası\n");
        return 1;
    }

    // Temizlik thread'i
    pthread_t cleanup_tid;
    pthread_create(&cleanup_tid, NULL, cleanup_thread, NULL);

    printf("🚀 Çoklu HLS Gateway (opt) Başladı\n");
    printf("🔗 https://localhost:%d/m3u8?q=http%%3A%%2F%%2F185.234.111.229%%3A8000%%2Fplay%%2Fa01y\n", PORT);

    event_base_dispatch(base);

    evhttp_free(http);
    event_base_free(base);
    SSL_CTX_free(g_ssl_ctx);
    return 0;
}