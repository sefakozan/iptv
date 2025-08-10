// multi_hls_gateway_http_only.c - DÜZELTILMIŞ VERSİYON
// ✅ Sadece HTTP üzerinden hizmet veren, sadeleştirilmiş HLS gateway.
// ✅ Video (passthrough) ve ses (transcode) işler.
// ✅ Bellek sızıntısı, race condition ve diğer hatalar düzeltildi.

// --- Gerekli Kütüphaneler ---
// libevent: Yüksek performanslı HTTP sunucusu için
#include <event2/event.h>
#include <event2/http.h>
#include <event2/http_struct.h>
#include <event2/buffer.h>
#include <event2/keyvalq_struct.h>

// FFmpeg: Video/Ses işleme kütüphaneleri
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavutil/opt.h>
#include <libavutil/avstring.h>
#include <libavutil/channel_layout.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/time.h>
#include <libswresample/swresample.h>

// Standart C kütüphaneleri
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/wait.h>

#ifndef MAX
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#endif

// --- Global Ayarlar ve Tanımlar ---
#define PORT 5001                          // Sunucunun çalışacağı port
#define MAX_STREAMS 10                     // Eş zamanlı desteklenecek maksimum yayın sayısı
#define MAX_SEGMENTS 48                    // Her yayın için bellekte tutulacak maksimum segment sayısı
#define IO_BUF_SIZE 65536                  // FFmpeg I/O buffer boyutu
#define SEGMENT_PREALLOC (2 * 1024 * 1024) // Her segment için başlangıçta ayrılacak bellek (2MB)
#define STREAM_TIMEOUT_SEC 300             // Bir yayına hiç istek gelmezse ne kadar süre sonra sonlandırılacağı (saniye)
#define AUDIO_FIFO_SIZE 4096               // Audio FIFO buffer boyutu

// Global kontrol değişkenleri
static volatile int running = 1;
static struct event_base *base = NULL;

// Ortam değişkenleriyle (environment variables) değiştirilebilen global ayarlar
static int G_SEG_MS = 2000;  // Her bir .ts segmentinin milisaniye cinsinden süresi
static int G_AAC_BR = 96000; // Ses için hedef bitrate (bits per second)
static int G_AAC_SR = 48000; // Ses için hedef örnekleme oranı (sample rate)
static int G_AAC_CH = 2;     // Ses için hedef kanal sayısı (1: mono, 2: stereo)
static int G_WORKERS = 1;    // Çalışacak işçi (worker/process) sayısı

// Bellekte tutulan bir HLS segmentini temsil eden yapı
typedef struct
{
    uint8_t *data;     // Segmentin binary verisi
    size_t size;       // Verinin mevcut boyutu
    size_t cap;        // Veri için ayrılmış toplam kapasite
    int num;           // Segmentin sıralı numarası (örn: seg_001.ts -> num=1)
    AVIOContext *avio; // FFmpeg'in belleğe yazmak için kullandığı I/O context'i
    uint8_t *avio_buf; // AVIO context'i için tampon bellek
    int ready;         // Segment tamamen yazıldı mı?
} mem_segment_t;

// Her bir canlı yayın için tüm durumu (state) yöneten ana yapı
typedef struct
{
    char input_url[512];    // Gelen kaynak yayının URL'si
    int video_stream_index; // Kaynaktaki video akışının indeksi
    int audio_stream_index; // Kaynaktaki ses akışının indeksi

    // FFmpeg context'leri
    AVFormatContext *ifmt_ctx; // Giriş (Input) format context'i
    AVCodecContext *a_dec_ctx; // Ses decoder context'i
    AVCodecContext *a_enc_ctx; // Ses encoder context'i (AAC)
    SwrContext *swr_ctx;       // Ses yeniden örnekleme (resample) context'i
    AVAudioFifo *fifo;         // Ham ses verisi için FIFO (First-In-First-Out) buffer'ı

    AVFormatContext *ofmt_ctx; // Çıkış (Output) format context'i (MPEG-TS)
    AVBSFContext *v_bsf;       // Video bitstream filtresi (örn: h264_mp4toannexb)

    // Segment yönetimi
    mem_segment_t segments[MAX_SEGMENTS]; // Segmentler için ring buffer
    int seg_head;                         // Bir sonraki yazılacak segmentin numarası
    int active_seg_index;                 // Şu an yazılmakta olan segmentin `segments` dizisindeki indeksi
    int64_t seg_start_time_ms;            // Mevcut segmentin başladığı zaman

    // Zaman damgası (timestamp) yönetimi
    int64_t a_next_pts;       // Bir sonraki ses paketinin PTS (Presentation Timestamp) değeri
    int64_t video_pts_offset; // Video PTS offset değeri
    int64_t audio_pts_offset; // Ses PTS offset değeri
    int64_t last_video_pts;   // Son video PTS değeri
    int64_t last_audio_pts;   // Son ses PTS değeri

    // Thread ve senkronizasyon
    pthread_mutex_t mutex; // Bu yapıya erişimi senkronize etmek için mutex
    pthread_t thread;      // Transcoding işlemini yapan iş parçacığı (thread)
    int thread_running;    // Thread çalışıyor mu?

    time_t last_access;      // Bu yayına en son ne zaman istek geldiği (timeout için)
    int segment_initialized; // Segment header'ının yazılıp yazılmadığını kontrol eder
    int cleanup_requested;   // Temizlik talep edildi mi?
} transcoder_t;

// URL hash'ine göre transcoder'ları tutan harita yapısı
typedef struct
{
    unsigned int hash;
    transcoder_t *t;
    char url[512];
} stream_entry_t;

static stream_entry_t stream_map[MAX_STREAMS];
static int stream_count = 0;
static pthread_mutex_t map_mutex = PTHREAD_MUTEX_INITIALIZER;

// --- YARDIMCI FONKSİYONLAR ---

// Signal handler
static void signal_handler(int sig)
{
    fprintf(stderr, "[gateway] Signal %d alindi, kapatiliyor...\n", sig);
    running = 0;
    if (base)
    {
        event_base_loopbreak(base);
    }
}

// Ortam değişkeninden integer değer okuyan güvenli fonksiyon
static int getenv_int(const char *k, int defv)
{
    const char *v = getenv(k);
    if (!v || !*v)
        return defv;
    char *e = NULL;
    long x = strtol(v, &e, 10);
    if (e == v || *e != '\0' || x < INT_MIN || x > INT_MAX)
        return defv;
    return (int)x;
}

// URL-encoded bir string'i çözer (örn: %2F -> /)
static void url_decode(char *dst, const char *src)
{
    char a, b;
    while (*src)
    {
        if (*src == '%' && src[1] && src[2])
        {
            a = toupper((unsigned char)src[1]);
            b = toupper((unsigned char)src[2]);
            if (isxdigit((unsigned char)a) && isxdigit((unsigned char)b))
            {
                *dst++ = ((a <= '9' ? a - '0' : a - 'A' + 10) << 4) | (b <= '9' ? b - '0' : b - 'A' + 10);
                src += 3;
                continue;
            }
        }
        *dst++ = *src++;
    }
    *dst = '\0';
}

// String için basit bir hash değeri üretir
static unsigned int hash_str(const char *s)
{
    unsigned int h = 5381;
    unsigned char c;
    while ((c = (unsigned char)*s++) != 0)
        h = ((h << 5) + h) + c;
    return h;
}

// FFmpeg hata kodlarını okunabilir string'e çevirir ve loglar
static inline void log_averr(const char *what, int err)
{
    if (err >= 0)
        return;
    char msg[256];
    av_strerror(err, msg, sizeof(msg));
    fprintf(stderr, "[gateway][fferr] %s: (%d) %s\n", what, err, msg);
}

// --- TRANSCODER TEMİZLİK FONKSİYONLARI ---

// Bir segment'i temizleyen fonksiyon
static void cleanup_segment(mem_segment_t *seg)
{
    if (!seg)
        return;

    if (seg->avio && seg->avio != NULL)
    {
        avio_context_free(&seg->avio);
        seg->avio = NULL;
    }
    if (seg->avio_buf)
    {
        av_free(seg->avio_buf);
        seg->avio_buf = NULL;
    }
    if (seg->data)
    {
        av_free(seg->data);
        seg->data = NULL;
    }
    seg->size = 0;
    seg->cap = 0;
    seg->num = -1;
    seg->ready = 0;
}

// Transcoder'ı tamamen temizleyen fonksiyon
static void cleanup_transcoder(transcoder_t *t)
{
    if (!t)
        return;

    fprintf(stderr, "[gateway] Transcoder temizleniyor: %s\n", t->input_url);

    // Cleanup flag'ini set et
    t->cleanup_requested = 1;

    // Thread'i düzgün sonlandır
    if (t->thread_running)
    {
        pthread_cancel(t->thread);
        pthread_join(t->thread, NULL);
        t->thread_running = 0;
    }

    // Mutex'i lock'la ve context'leri temizle
    pthread_mutex_lock(&t->mutex);

    // FFmpeg context'lerini temizle
    if (t->ofmt_ctx)
    {
        if (t->ofmt_ctx->pb)
        {
            av_write_trailer(t->ofmt_ctx);
            avio_flush(t->ofmt_ctx->pb);
        }
        avformat_free_context(t->ofmt_ctx);
        t->ofmt_ctx = NULL;
    }

    if (t->ifmt_ctx)
    {
        avformat_close_input(&t->ifmt_ctx);
    }

    if (t->a_dec_ctx)
    {
        avcodec_free_context(&t->a_dec_ctx);
    }

    if (t->a_enc_ctx)
    {
        avcodec_free_context(&t->a_enc_ctx);
    }

    if (t->v_bsf)
    {
        av_bsf_free(&t->v_bsf);
    }

    if (t->swr_ctx)
    {
        swr_free(&t->swr_ctx);
    }

    if (t->fifo)
    {
        av_audio_fifo_free(t->fifo);
    }

    // Tüm segmentleri temizle
    for (int i = 0; i < MAX_SEGMENTS; i++)
    {
        cleanup_segment(&t->segments[i]);
    }

    pthread_mutex_unlock(&t->mutex);

    // Mutex'i destroy et
    pthread_mutex_destroy(&t->mutex);

    // Transcoder yapısını serbest bırak
    free(t);
}

// --- FFmpeg İŞLEMLERİ ---

// FFmpeg'in veriyi doğrudan bellekteki segment'e yazmasını sağlayan callback
static int seg_write_cb(void *opaque, uint8_t *buf, int buf_size)
{
    mem_segment_t *seg = (mem_segment_t *)opaque;
    if (buf_size <= 0)
        return 0;

    size_t need = seg->size + (size_t)buf_size;
    if (need > seg->cap)
    {
        size_t new_cap = seg->cap ? seg->cap : SEGMENT_PREALLOC;
        while (new_cap < need)
            new_cap <<= 1;
        uint8_t *p = (uint8_t *)av_realloc(seg->data, new_cap);
        if (!p)
            return AVERROR(ENOMEM);
        seg->data = p;
        seg->cap = new_cap;
    }
    memcpy(seg->data + seg->size, buf, buf_size);
    seg->size += (size_t)buf_size;
    return buf_size;
}

// Yeni bir .ts segmenti için FFmpeg muxer'ını açar ve ayarlar
static int open_segment_muxer(transcoder_t *t, mem_segment_t *seg)
{
    int ret = avformat_alloc_output_context2(&t->ofmt_ctx, NULL, "mpegts", NULL);
    if (ret < 0 || !t->ofmt_ctx)
    {
        log_averr("avformat_alloc_output_context2", ret);
        return ret;
    }

    // HLS uyumluluğu için önemli MPEG-TS ayarları
    av_opt_set(t->ofmt_ctx->priv_data, "mpegts_flags", "resend_headers+initial_discontinuity", 0);
    av_opt_set(t->ofmt_ctx->priv_data, "flush_packets", "1", 0);
    av_opt_set(t->ofmt_ctx->priv_data, "mpegts_copyts", "1", 0);

    // Video stream'ini çıkış formatına ekle (passthrough)
    AVStream *vst = avformat_new_stream(t->ofmt_ctx, NULL);
    if (!vst)
    {
        avformat_free_context(t->ofmt_ctx);
        t->ofmt_ctx = NULL;
        return AVERROR(ENOMEM);
    }

    // Eğer bitstream filter kullanılıyorsa, onun parametrelerini kopyala
    if (t->v_bsf && t->v_bsf->par_out && t->v_bsf->par_out->codec_id == AV_CODEC_ID_H264)
    {
        if ((ret = avcodec_parameters_copy(vst->codecpar, t->v_bsf->par_out)) < 0)
        {
            avformat_free_context(t->ofmt_ctx);
            t->ofmt_ctx = NULL;
            return ret;
        }
    }
    else
    {
        if ((ret = avcodec_parameters_copy(vst->codecpar, t->ifmt_ctx->streams[t->video_stream_index]->codecpar)) < 0)
        {
            avformat_free_context(t->ofmt_ctx);
            t->ofmt_ctx = NULL;
            return ret;
        }
    }
    vst->time_base = (AVRational){1, 90000};
    vst->codecpar->codec_tag = 0;

    // Ses stream'ini çıkış formatına ekle (transcode edilmiş AAC)
    AVStream *ast = avformat_new_stream(t->ofmt_ctx, NULL);
    if (!ast)
    {
        avformat_free_context(t->ofmt_ctx);
        t->ofmt_ctx = NULL;
        return AVERROR(ENOMEM);
    }
    if ((ret = avcodec_parameters_from_context(ast->codecpar, t->a_enc_ctx)) < 0)
    {
        avformat_free_context(t->ofmt_ctx);
        t->ofmt_ctx = NULL;
        return ret;
    }
    ast->codecpar->codec_tag = 0;
    ast->time_base = (AVRational){1, t->a_enc_ctx->sample_rate};

    // Belleğe yazmak için AVIO context'i hazırla
    seg->size = 0;
    seg->ready = 0;

    if (!seg->avio_buf)
    {
        seg->avio_buf = (uint8_t *)av_malloc(IO_BUF_SIZE);
        if (!seg->avio_buf)
        {
            avformat_free_context(t->ofmt_ctx);
            t->ofmt_ctx = NULL;
            return AVERROR(ENOMEM);
        }
    }

    seg->avio = avio_alloc_context(seg->avio_buf, IO_BUF_SIZE, 1, seg, NULL, seg_write_cb, NULL);
    if (!seg->avio)
    {
        av_free(seg->avio_buf);
        seg->avio_buf = NULL;
        avformat_free_context(t->ofmt_ctx);
        t->ofmt_ctx = NULL;
        return AVERROR(ENOMEM);
    }

    t->ofmt_ctx->pb = seg->avio;
    t->ofmt_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;

    t->segment_initialized = 0;
    if ((ret = avformat_write_header(t->ofmt_ctx, NULL)) < 0)
    {
        log_averr("avformat_write_header", ret);
        avio_context_free(&seg->avio);
        seg->avio = NULL;
        av_free(seg->avio_buf);
        seg->avio_buf = NULL;
        avformat_free_context(t->ofmt_ctx);
        t->ofmt_ctx = NULL;
        return ret;
    }

    // Header'ı hemen belleğe yaz
    if (t->ofmt_ctx->pb)
        avio_flush(t->ofmt_ctx->pb);

    t->segment_initialized = 1;
    fprintf(stderr, "[gateway] Segment %d başlatıldı (boyut=%zu)\n", seg->num, seg->size);
    return 0;
}

// Aktif segment muxer'ını düzgün bir şekilde kapatır
static void close_segment_muxer(transcoder_t *t)
{
    if (!t->ofmt_ctx)
        return;

    if (t->ofmt_ctx->pb)
    {
        av_write_trailer(t->ofmt_ctx);
        avio_flush(t->ofmt_ctx->pb);
    }

    // Active segment'i ready olarak işaretle
    if (t->active_seg_index >= 0 && t->active_seg_index < MAX_SEGMENTS)
    {
        t->segments[t->active_seg_index].ready = 1;
    }

    if (t->ofmt_ctx->pb)
    {
        AVIOContext *pb = t->ofmt_ctx->pb;
        t->ofmt_ctx->pb = NULL;
        avio_context_free(&pb);
        if (t->active_seg_index >= 0 && t->active_seg_index < MAX_SEGMENTS)
        {
            mem_segment_t *cur = &t->segments[t->active_seg_index];
            cur->avio = NULL;
            // avio_buf'ı burada free etme, segment temizlenirken yapılacak
        }
    }
    avformat_free_context(t->ofmt_ctx);
    t->ofmt_ctx = NULL;
    t->segment_initialized = 0;
}

// Eski segmenti kapatıp yenisini başlatan ana fonksiyon
static int start_new_segment(transcoder_t *t)
{
    pthread_mutex_lock(&t->mutex);

    if (t->cleanup_requested)
    {
        pthread_mutex_unlock(&t->mutex);
        return -1;
    }

    if (t->active_seg_index >= 0 && t->ofmt_ctx)
        close_segment_muxer(t);

    int idx = t->seg_head % MAX_SEGMENTS;
    mem_segment_t *seg = &t->segments[idx];

    // Eski segmenti temizle
    cleanup_segment(seg);

    seg->num = t->seg_head;

    int ret = open_segment_muxer(t, seg);
    if (ret == 0)
    {
        t->active_seg_index = idx;
        t->seg_start_time_ms = av_gettime_relative() / 1000;
        t->seg_head++;

        fprintf(stderr, "[gateway] Yeni segment: idx=%d num=%d\n", idx, seg->num);
    }

    pthread_mutex_unlock(&t->mutex);
    return ret;
}

// Sesi decode->resample->encode boru hattından geçirip muxer'a gönderir
static int push_and_encode_audio(transcoder_t *t, AVFrame *in_frame)
{
    int ret = 0;
    AVFrame *cfrm = NULL;

    if (t->cleanup_requested)
    {
        return -1;
    }

    if (in_frame)
    {
        // Gerekliyse sesi yeniden örnekle (resample)
        if (t->swr_ctx)
        {
            cfrm = av_frame_alloc();
            if (!cfrm)
                return AVERROR(ENOMEM);
            cfrm->channel_layout = t->a_enc_ctx->channel_layout;
            cfrm->channels = t->a_enc_ctx->channels;
            cfrm->format = t->a_enc_ctx->sample_fmt;
            cfrm->sample_rate = t->a_enc_ctx->sample_rate;
            cfrm->nb_samples = in_frame->nb_samples;
            if ((ret = av_frame_get_buffer(cfrm, 0)) < 0)
                goto done;
            if ((ret = swr_convert_frame(t->swr_ctx, cfrm, in_frame)) < 0)
                goto done;
            if ((ret = av_audio_fifo_write(t->fifo, (void **)cfrm->data, cfrm->nb_samples)) < cfrm->nb_samples)
            {
                ret = AVERROR_UNKNOWN;
                goto done;
            }
        }
        else
        {
            if ((ret = av_audio_fifo_write(t->fifo, (void **)in_frame->data, in_frame->nb_samples)) < in_frame->nb_samples)
            {
                ret = AVERROR_UNKNOWN;
                goto done;
            }
        }
    }

    AVPacket *pkt = av_packet_alloc();
    AVFrame *efr = av_frame_alloc();
    if (!pkt || !efr)
    {
        ret = AVERROR(ENOMEM);
        goto done2;
    }

    // FIFO buffer'da yeterli veri oldukça enkod et
    while (av_audio_fifo_size(t->fifo) >= t->a_enc_ctx->frame_size || (!in_frame && av_audio_fifo_size(t->fifo) > 0))
    {
        if (t->cleanup_requested)
        {
            ret = -1;
            break;
        }

        efr->nb_samples = t->a_enc_ctx->frame_size;
        if (av_audio_fifo_size(t->fifo) < efr->nb_samples)
            efr->nb_samples = av_audio_fifo_size(t->fifo);

        efr->channel_layout = t->a_enc_ctx->channel_layout;
        efr->channels = t->a_enc_ctx->channels;
        efr->format = t->a_enc_ctx->sample_fmt;
        efr->sample_rate = t->a_enc_ctx->sample_rate;
        if ((ret = av_frame_get_buffer(efr, 0)) < 0)
            break;
        if (av_audio_fifo_read(t->fifo, (void **)efr->data, efr->nb_samples) < efr->nb_samples)
        {
            ret = AVERROR_UNKNOWN;
            break;
        }

        efr->pts = t->a_next_pts;
        t->a_next_pts += efr->nb_samples;

        if ((ret = avcodec_send_frame(t->a_enc_ctx, efr)) < 0)
            break;

        while ((ret = avcodec_receive_packet(t->a_enc_ctx, pkt)) == 0)
        {
            AVStream *out_ast = t->ofmt_ctx ? t->ofmt_ctx->streams[1] : NULL;
            if (out_ast)
            {
                av_packet_rescale_ts(pkt, t->a_enc_ctx->time_base, out_ast->time_base);

                // PTS offset uygula
                if (pkt->pts != AV_NOPTS_VALUE)
                    pkt->pts += t->audio_pts_offset;
                if (pkt->dts != AV_NOPTS_VALUE)
                    pkt->dts += t->audio_pts_offset;
            }
            pkt->stream_index = 1;

            pthread_mutex_lock(&t->mutex);
            if (t->ofmt_ctx && t->segment_initialized && !t->cleanup_requested)
            {
                int wret = av_interleaved_write_frame(t->ofmt_ctx, pkt);
                if (wret < 0)
                    log_averr("write audio packet", wret);
                else if (pkt->pts != AV_NOPTS_VALUE)
                    t->last_audio_pts = pkt->pts;
            }
            pthread_mutex_unlock(&t->mutex);
            av_packet_unref(pkt);
        }
        av_frame_unref(efr);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF)
            ret = 0;
        if (!in_frame)
            break;
    }

done2:
    if (pkt)
        av_packet_free(&pkt);
    if (efr)
        av_frame_free(&efr);
done:
    if (cfrm)
        av_frame_free(&cfrm);
    return ret;
}

// Her bir yayın için ayrı bir thread'de çalışan ana transcode döngüsü
static void *transcode_loop(void *arg)
{
    transcoder_t *t = (transcoder_t *)arg;
    AVPacket *pkt = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    if (!pkt || !frame)
    {
        t->thread_running = 0;
        return NULL;
    }

    int64_t last_seg_ms = 0;
    int pending_cut = 0;          // Segment kesme isteği
    int waiting_for_keyframe = 1; // Başlangıç için ilk keyframe'i bekle

    fprintf(stderr, "[gateway] Transcode loop başlatıldı: %s\n", t->input_url);

    // Ana döngü: Giriş akışından paketleri oku
    while (running && !t->cleanup_requested && av_read_frame(t->ifmt_ctx, pkt) >= 0)
    {
        int64_t now_ms = av_gettime_relative() / 1000;
        if (!waiting_for_keyframe && !pending_cut && (now_ms - last_seg_ms) >= G_SEG_MS)
        {
            pending_cut = 1; // Zaman doldu, bir sonraki keyframe'de kes
        }

        // --- VIDEO PAKETİ İŞLEME ---
        if (pkt->stream_index == t->video_stream_index)
        {
            AVStream *in_st = t->ifmt_ctx->streams[pkt->stream_index];
            int is_key = (pkt->flags & AV_PKT_FLAG_KEY);

            // Eğer bitstream filtresi varsa (örn. h264_mp4toannexb), paketi önce ona gönder
            if (t->v_bsf)
            {
                if (av_bsf_send_packet(t->v_bsf, pkt) == 0)
                {
                    AVPacket *out_pkt = av_packet_alloc();
                    while (av_bsf_receive_packet(t->v_bsf, out_pkt) == 0)
                    {
                        is_key = (out_pkt->flags & AV_PKT_FLAG_KEY);

                        // İlk keyframe'i bulduysak ilk segmenti başlat
                        if (waiting_for_keyframe && is_key)
                        {
                            if (start_new_segment(t) == 0)
                            {
                                last_seg_ms = t->seg_start_time_ms;
                                waiting_for_keyframe = 0;
                            }
                        }

                        // Kesme isteği varsa ve keyframe geldiyse, segmenti değiştir
                        if (!waiting_for_keyframe && pending_cut && is_key)
                        {
                            if (start_new_segment(t) == 0)
                            {
                                last_seg_ms = t->seg_start_time_ms;
                                pending_cut = 0;
                            }
                        }

                        // Segment yazmaya hazırsa paketi yaz
                        if (!waiting_for_keyframe && t->ofmt_ctx && t->segment_initialized)
                        {
                            if (out_pkt->pts != AV_NOPTS_VALUE)
                                out_pkt->pts += t->video_pts_offset;
                            if (out_pkt->dts != AV_NOPTS_VALUE)
                                out_pkt->dts += t->video_pts_offset;

                            av_packet_rescale_ts(out_pkt, in_st->time_base, t->ofmt_ctx->streams[0]->time_base);
                            out_pkt->stream_index = 0;

                            pthread_mutex_lock(&t->mutex);
                            if (!t->cleanup_requested)
                            {
                                int wret = av_interleaved_write_frame(t->ofmt_ctx, out_pkt);
                                if (wret < 0)
                                    log_averr("write video packet", wret);
                                else if (out_pkt->pts != AV_NOPTS_VALUE)
                                    t->last_video_pts = out_pkt->pts;
                            }
                            pthread_mutex_unlock(&t->mutex);
                        }
                        av_packet_unref(out_pkt);
                    }
                    if (out_pkt)
                        av_packet_free(&out_pkt);
                }
            }
            else
            {
                // Bitstream filtresi yoksa doğrudan işle
                is_key = (pkt->flags & AV_PKT_FLAG_KEY);
                if (waiting_for_keyframe && is_key)
                {
                    if (start_new_segment(t) == 0)
                    {
                        last_seg_ms = t->seg_start_time_ms;
                        waiting_for_keyframe = 0;
                    }
                }

                // Kesme isteği varsa ve keyframe geldiyse, segmenti değiştir
                if (!waiting_for_keyframe && pending_cut && is_key)
                {
                    if (start_new_segment(t) == 0)
                    {
                        last_seg_ms = t->seg_start_time_ms;
                        pending_cut = 0;
                    }
                }

                // Segment yazmaya hazırsa paketi yaz
                if (!waiting_for_keyframe && t->ofmt_ctx && t->segment_initialized)
                {
                    if (pkt->pts != AV_NOPTS_VALUE)
                        pkt->pts += t->video_pts_offset;
                    if (pkt->dts != AV_NOPTS_VALUE)
                        pkt->dts += t->video_pts_offset;

                    av_packet_rescale_ts(pkt, in_st->time_base, t->ofmt_ctx->streams[0]->time_base);
                    pkt->stream_index = 0;

                    pthread_mutex_lock(&t->mutex);
                    if (!t->cleanup_requested)
                    {
                        int wret = av_interleaved_write_frame(t->ofmt_ctx, pkt);
                        if (wret < 0)
                            log_averr("write video packet", wret);
                        else if (pkt->pts != AV_NOPTS_VALUE)
                            t->last_video_pts = pkt->pts;
                    }
                    pthread_mutex_unlock(&t->mutex);
                }
            }
        }
        // --- SES PAKETİ İŞLEME ---
        else if (pkt->stream_index == t->audio_stream_index)
        {
            // Video başlamadan sesi işleme
            if (!waiting_for_keyframe)
            {
                if (avcodec_send_packet(t->a_dec_ctx, pkt) == 0)
                {
                    while (avcodec_receive_frame(t->a_dec_ctx, frame) == 0)
                    {
                        if (push_and_encode_audio(t, frame) < 0)
                            break;
                        av_frame_unref(frame);
                    }
                }
            }
        }
        av_packet_unref(pkt);
        t->last_access = time(NULL);
    }

    fprintf(stderr, "[gateway] Transcode loop sona erdi: %s\n", t->input_url);

    // --- Akış Sonu ve Temizlik ---
    // Encoder ve decoder'lardaki kalan frame'leri boşalt (flush)
    if (t->a_dec_ctx && !t->cleanup_requested)
    {
        avcodec_send_packet(t->a_dec_ctx, NULL);
        while (avcodec_receive_frame(t->a_dec_ctx, frame) == 0)
        {
            push_and_encode_audio(t, frame);
            av_frame_unref(frame);
        }
        push_and_encode_audio(t, NULL); // FIFO'daki kalanı işle
    }

    if (t->a_enc_ctx && !t->cleanup_requested)
    {
        avcodec_send_frame(t->a_enc_ctx, NULL); // Encoder'ı flush et
        AVPacket *fp = av_packet_alloc();
        if (fp)
        {
            while (avcodec_receive_packet(t->a_enc_ctx, fp) == 0)
            {
                fp->stream_index = 1;
                pthread_mutex_lock(&t->mutex);
                if (t->ofmt_ctx && t->segment_initialized && !t->cleanup_requested)
                    av_interleaved_write_frame(t->ofmt_ctx, fp);
                pthread_mutex_unlock(&t->mutex);
                av_packet_unref(fp);
            }
            av_packet_free(&fp);
        }
    }

    // Son segmenti düzgünce kapat
    pthread_mutex_lock(&t->mutex);
    close_segment_muxer(t);
    pthread_mutex_unlock(&t->mutex);

    // Belleği serbest bırak
    if (pkt)
        av_packet_free(&pkt);
    if (frame)
        av_frame_free(&frame);

    t->thread_running = 0;
    return NULL;
}

// Ses için decoder, resampler ve encoder'ı açar ve ayarlar
static int open_audio_codec(transcoder_t *t, enum AVCodecID dec_id, AVCodecParameters *apar)
{
    // Audio decoder
    const AVCodec *dec = avcodec_find_decoder(dec_id);
    if (!dec)
    {
        fprintf(stderr, "Audio decoder bulunamadı: %d\n", dec_id);
        return -1;
    }

    t->a_dec_ctx = avcodec_alloc_context3(dec);
    if (!t->a_dec_ctx)
    {
        return -1;
    }

    if (avcodec_parameters_to_context(t->a_dec_ctx, apar) < 0)
    {
        avcodec_free_context(&t->a_dec_ctx);
        return -1;
    }

    if (avcodec_open2(t->a_dec_ctx, dec, NULL) < 0)
    {
        avcodec_free_context(&t->a_dec_ctx);
        return -1;
    }

    // Audio encoder - libfdk_aac varsa onu kullan, yoksa built-in AAC
    const AVCodec *enc = avcodec_find_encoder_by_name("libfdk_aac");
    if (!enc)
    {
        enc = avcodec_find_encoder(AV_CODEC_ID_AAC);
        if (!enc)
        {
            fprintf(stderr, "AAC encoder bulunamadı\n");
            avcodec_free_context(&t->a_dec_ctx);
            return -1;
        }
    }

    t->a_enc_ctx = avcodec_alloc_context3(enc);
    if (!t->a_enc_ctx)
    {
        avcodec_free_context(&t->a_dec_ctx);
        return -1;
    }

    int out_sr = G_AAC_SR;
    int out_ch = (G_AAC_CH <= 1) ? 1 : 2;
    uint64_t out_layout = (out_ch == 1) ? AV_CH_LAYOUT_MONO : AV_CH_LAYOUT_STEREO;

    t->a_enc_ctx->sample_rate = out_sr;
    t->a_enc_ctx->channel_layout = out_layout;
    t->a_enc_ctx->channels = out_ch;
    t->a_enc_ctx->bit_rate = G_AAC_BR;
    t->a_enc_ctx->time_base = (AVRational){1, out_sr};
    t->a_enc_ctx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    t->a_enc_ctx->sample_fmt = (enc && strcmp(enc->name, "libfdk_aac") == 0) ? AV_SAMPLE_FMT_S16 : AV_SAMPLE_FMT_FLTP;

    if (avcodec_open2(t->a_enc_ctx, enc, NULL) < 0)
    {
        avcodec_free_context(&t->a_dec_ctx);
        avcodec_free_context(&t->a_enc_ctx);
        return -1;
    }

    // Resampler setup
    int in_rate = t->a_dec_ctx->sample_rate;
    int in_ch = t->a_dec_ctx->channels;
    uint64_t in_layout = t->a_dec_ctx->channel_layout ? t->a_dec_ctx->channel_layout : av_get_default_channel_layout(in_ch);
    enum AVSampleFormat in_fmt = t->a_dec_ctx->sample_fmt;

    if (in_rate != out_sr || in_layout != out_layout || in_fmt != t->a_enc_ctx->sample_fmt)
    {
        t->swr_ctx = swr_alloc_set_opts(NULL, out_layout, t->a_enc_ctx->sample_fmt, out_sr, in_layout, in_fmt, in_rate, 0, NULL);
        if (!t->swr_ctx || swr_init(t->swr_ctx) < 0)
        {
            avcodec_free_context(&t->a_dec_ctx);
            avcodec_free_context(&t->a_enc_ctx);
            return -1;
        }
    }
    else
    {
        t->swr_ctx = NULL;
    }

    // Audio FIFO
    t->fifo = av_audio_fifo_alloc(t->a_enc_ctx->sample_fmt, out_ch, AUDIO_FIFO_SIZE);
    if (!t->fifo)
    {
        if (t->swr_ctx)
            swr_free(&t->swr_ctx);
        avcodec_free_context(&t->a_dec_ctx);
        avcodec_free_context(&t->a_enc_ctx);
        return -1;
    }

    return 0;
}

// --- TRANSCODER YÖNETİMİ ---

// Gelen URL için bir transcoder başlatır
static transcoder_t *start_transcoder(const char *url)
{
    transcoder_t *t = (transcoder_t *)calloc(1, sizeof(transcoder_t));
    if (!t)
    {
        fprintf(stderr, "Transcoder için bellek ayrılamadı\n");
        return NULL;
    }

    av_strlcpy(t->input_url, url, sizeof(t->input_url));
    pthread_mutex_init(&t->mutex, NULL);
    t->active_seg_index = -1;
    t->last_access = time(NULL);
    t->thread_running = 0;
    t->cleanup_requested = 0;

    // Input açma parametreleri
    AVDictionary *opts = NULL;
    av_dict_set(&opts, "reconnect", "1", 0);
    av_dict_set(&opts, "reconnect_streamed", "1", 0);
    av_dict_set(&opts, "reconnect_on_network_error", "1", 0);
    av_dict_set(&opts, "rw_timeout", "10000000", 0); // 10s timeout
    av_dict_set(&opts, "user_agent", "HLS-Gateway/1.0", 0);
    av_dict_set(&opts, "buffer_size", "65536", 0);

    fprintf(stderr, "[gateway] Input açılıyor: %s\n", url);

    if (avformat_open_input(&t->ifmt_ctx, url, NULL, &opts) < 0)
    {
        fprintf(stderr, "Input açılamadı: %s\n", url);
        av_dict_free(&opts);
        cleanup_transcoder(t);
        return NULL;
    }
    av_dict_free(&opts);

    if (avformat_find_stream_info(t->ifmt_ctx, NULL) < 0)
    {
        fprintf(stderr, "Stream info bulunamadı: %s\n", url);
        cleanup_transcoder(t);
        return NULL;
    }

    // Stream indekslerini bul
    t->video_stream_index = av_find_best_stream(t->ifmt_ctx, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    t->audio_stream_index = av_find_best_stream(t->ifmt_ctx, AVMEDIA_TYPE_AUDIO, -1, t->video_stream_index, NULL, 0);

    if (t->video_stream_index < 0)
    {
        fprintf(stderr, "Video stream bulunamadı: %s\n", url);
        cleanup_transcoder(t);
        return NULL;
    }

    if (t->audio_stream_index < 0)
    {
        fprintf(stderr, "Audio stream bulunamadı: %s\n", url);
        cleanup_transcoder(t);
        return NULL;
    }

    fprintf(stderr, "[gateway] Streamler bulundu - Video: %d, Audio: %d\n", t->video_stream_index, t->audio_stream_index);

    // Audio codec'leri aç
    if (open_audio_codec(t, t->ifmt_ctx->streams[t->audio_stream_index]->codecpar->codec_id, t->ifmt_ctx->streams[t->audio_stream_index]->codecpar) < 0)
    {
        fprintf(stderr, "Audio codec açılamadı: %s\n", url);
        cleanup_transcoder(t);
        return NULL;
    }

    // Video için bitstream filtresini ayarla
    t->v_bsf = NULL;
    enum AVCodecID v_id = t->ifmt_ctx->streams[t->video_stream_index]->codecpar->codec_id;
    const AVBitStreamFilter *f = NULL;
    if (v_id == AV_CODEC_ID_H264)
        f = av_bsf_get_by_name("h264_mp4toannexb");
    else if (v_id == AV_CODEC_ID_HEVC)
        f = av_bsf_get_by_name("hevc_mp4toannexb");

    if (f)
    {
        if (av_bsf_alloc(f, &t->v_bsf) == 0)
        {
            avcodec_parameters_copy(t->v_bsf->par_in, t->ifmt_ctx->streams[t->video_stream_index]->codecpar);
            t->v_bsf->time_base_in = t->ifmt_ctx->streams[t->video_stream_index]->time_base;
            if (av_bsf_init(t->v_bsf) < 0)
            {
                av_bsf_free(&t->v_bsf);
                t->v_bsf = NULL;
            }
        }
    }

    // Thread başlat
    t->thread_running = 1;
    if (pthread_create(&t->thread, NULL, transcode_loop, t) != 0)
    {
        fprintf(stderr, "Thread başlatılamadı: %s\n", url);
        t->thread_running = 0;
        cleanup_transcoder(t);
        return NULL;
    }

    fprintf(stderr, "[gateway] Transcoder başlatıldı: %s\n", url);
    return t;
}

// Gereksiz stream'leri temizler
static void evict_lru_if_needed()
{
    if (stream_count < MAX_STREAMS)
        return;

    int idx = -1;
    time_t oldest = LLONG_MAX;
    for (int i = 0; i < stream_count; i++)
    {
        if (stream_map[i].t && stream_map[i].t->last_access < oldest)
        {
            oldest = stream_map[i].t->last_access;
            idx = i;
        }
    }

    if (idx >= 0)
    {
        fprintf(stderr, "[gateway] LRU eviction: %s\n", stream_map[idx].url);
        cleanup_transcoder(stream_map[idx].t);
        memmove(&stream_map[idx], &stream_map[idx + 1], (--stream_count - idx) * sizeof(stream_entry_t));
    }
}

// Gelen URL'ye göre mevcut transcoder'ı bulur veya yenisini oluşturur
static transcoder_t *get_or_create_transcoder(const char *url)
{
    unsigned int h = hash_str(url);

    pthread_mutex_lock(&map_mutex);

    // Önce mevcut olanı kontrol et
    for (int i = 0; i < stream_count; i++)
    {
        if (stream_map[i].hash == h && strcmp(stream_map[i].url, url) == 0)
        {
            if (stream_map[i].t && stream_map[i].t->thread_running && !stream_map[i].t->cleanup_requested)
            {
                stream_map[i].t->last_access = time(NULL);
                transcoder_t *ret = stream_map[i].t;
                pthread_mutex_unlock(&map_mutex);
                return ret;
            }
        }
    }

    // Yer yoksa en eski olanı temizle
    evict_lru_if_needed();

    if (stream_count >= MAX_STREAMS)
    {
        pthread_mutex_unlock(&map_mutex);
        return NULL;
    }

    // Yeni transcoder oluştur
    transcoder_t *t = start_transcoder(url);
    if (!t)
    {
        pthread_mutex_unlock(&map_mutex);
        return NULL;
    }

    // Map'e ekle
    stream_map[stream_count].hash = h;
    stream_map[stream_count].t = t;
    av_strlcpy(stream_map[stream_count].url, url, sizeof(stream_map[stream_count].url));
    stream_count++;

    pthread_mutex_unlock(&map_mutex);
    return t;
}

// --- HTTP HANDLER'LARI (libevent) ---

// .m3u8 playlist dosyasını oluşturan ve gönderen handler
static void m3u8_handler(struct evhttp_request *req)
{
    const char *uri = evhttp_request_get_uri(req);
    fprintf(stderr, "[gateway] M3U8 request: %s\n", uri);

    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    if (!decoded)
    {
        evhttp_send_error(req, 400, "Bad Request");
        return;
    }

    const char *query = evhttp_uri_get_query(decoded);
    if (!query)
    {
        evhttp_send_error(req, 400, "Missing query");
        evhttp_uri_free(decoded);
        return;
    }

    const char *q = strstr(query, "q=");
    if (!q)
    {
        evhttp_send_error(req, 400, "q= required");
        evhttp_uri_free(decoded);
        return;
    }

    char encoded[1024] = {0};
    av_strlcpy(encoded, q + 2, sizeof(encoded));
    char input_url[1024];
    url_decode(input_url, encoded);

    fprintf(stderr, "[gateway] Decoded URL: %s\n", input_url);

    transcoder_t *t = get_or_create_transcoder(input_url);
    if (!t)
    {
        evhttp_send_error(req, 500, "Cannot start transcoder");
        evhttp_uri_free(decoded);
        return;
    }

    // M3U8 playlist oluştur
    char m3u8[4096] = {0};
    int targetdur = (G_SEG_MS + 999) / 1000;
    snprintf(m3u8, sizeof(m3u8), "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:%d\n", targetdur);

    pthread_mutex_lock(&t->mutex);

    // Mevcut segmentlerin en küçük numarasını bul
    int first_num = -1;
    int segment_count = 0;
    for (int i = 0; i < MAX_SEGMENTS; i++)
    {
        if (t->segments[i].size > 0 && t->segments[i].ready)
        {
            if (first_num < 0 || t->segments[i].num < first_num)
            {
                first_num = t->segments[i].num;
            }
            segment_count++;
        }
    }

    if (first_num < 0)
    {
        first_num = 0;
    }

    char line[256];
    snprintf(line, sizeof(line), "#EXT-X-MEDIA-SEQUENCE:%d\n", first_num);
    strncat(m3u8, line, sizeof(m3u8) - strlen(m3u8) - 1);

    // Segmentleri sıralı olarak ekle (max 10 segment)
    int added_segments = 0;
    for (int n = first_num; n < first_num + MAX_SEGMENTS && added_segments < 10; n++)
    {
        for (int i = 0; i < MAX_SEGMENTS; i++)
        {
            if (t->segments[i].size > 0 && t->segments[i].ready && t->segments[i].num == n)
            {
                snprintf(line, sizeof(line), "#EXTINF:%.3f,\nseg_%03d.ts?h=%x\n",
                         (double)G_SEG_MS / 1000.0, t->segments[i].num, hash_str(input_url));
                strncat(m3u8, line, sizeof(m3u8) - strlen(m3u8) - 1);
                added_segments++;
                break;
            }
        }
    }

    pthread_mutex_unlock(&t->mutex);

    // Response gönder
    struct evbuffer *buf = evbuffer_new();
    if (!buf)
    {
        evhttp_send_error(req, 500, "Memory allocation failed");
        evhttp_uri_free(decoded);
        return;
    }

    evbuffer_add(buf, m3u8, strlen(m3u8));

    struct evkeyvalq *out = evhttp_request_get_output_headers(req);
    evhttp_add_header(out, "Content-Type", "application/vnd.apple.mpegurl");
    evhttp_add_header(out, "Cache-Control", "no-cache, no-store, must-revalidate");
    evhttp_add_header(out, "Pragma", "no-cache");
    evhttp_add_header(out, "Expires", "0");
    evhttp_add_header(out, "Access-Control-Allow-Origin", "*");
    evhttp_add_header(out, "Access-Control-Expose-Headers", "*");

    evhttp_send_reply(req, 200, "OK", buf);
    evbuffer_free(buf);
    evhttp_uri_free(decoded);
}

// İstenen .ts segmentini bellekten bulup gönderen handler
static void segment_handler(struct evhttp_request *req)
{
    const char *uri = evhttp_request_get_uri(req);

    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    if (!decoded)
    {
        evhttp_send_error(req, 400, "Bad Request");
        return;
    }

    int num = -1;
    const char *path = evhttp_uri_get_path(decoded);
    if (!path || sscanf(path, "/seg_%d.ts", &num) != 1)
    {
        evhttp_send_error(req, 400, "Invalid segment path");
        evhttp_uri_free(decoded);
        return;
    }

    const char *query = evhttp_uri_get_query(decoded);
    const char *h_str = query ? strstr(query, "h=") : NULL;
    if (!h_str)
    {
        evhttp_send_error(req, 400, "h= parameter required");
        evhttp_uri_free(decoded);
        return;
    }

    unsigned int target_hash = (unsigned int)strtoul(h_str + 2, NULL, 16);

    // Hash ile transcoder'ı bul
    transcoder_t *t = NULL;
    pthread_mutex_lock(&map_mutex);
    for (int i = 0; i < stream_count; i++)
    {
        if (stream_map[i].t && hash_str(stream_map[i].url) == target_hash)
        {
            t = stream_map[i].t;
            t->last_access = time(NULL);
            break;
        }
    }
    pthread_mutex_unlock(&map_mutex);

    if (!t)
    {
        fprintf(stderr, "[gateway] Stream bulunamadı hash: %x\n", target_hash);
        evhttp_send_error(req, 404, "Stream not found");
        evhttp_uri_free(decoded);
        return;
    }

    // Segmenti bul
    mem_segment_t *found = NULL;
    pthread_mutex_lock(&t->mutex);
    for (int i = 0; i < MAX_SEGMENTS; i++)
    {
        if (t->segments[i].num == num && t->segments[i].size > 0 && t->segments[i].ready)
        {
            found = &t->segments[i];
            break;
        }
    }
    pthread_mutex_unlock(&t->mutex);

    if (!found)
    {
        fprintf(stderr, "[gateway] Segment bulunamadı: %d\n", num);
        evhttp_send_error(req, 404, "Segment not found");
        evhttp_uri_free(decoded);
        return;
    }

    fprintf(stderr, "[gateway] Segment servis ediliyor: %d (boyut=%zu)\n", num, found->size);

    // Response header'ları
    struct evkeyvalq *out = evhttp_request_get_output_headers(req);
    evhttp_add_header(out, "Content-Type", "video/MP2T");
    evhttp_add_header(out, "Cache-Control", "public, max-age=3600");
    evhttp_add_header(out, "Access-Control-Allow-Origin", "*");
    evhttp_add_header(out, "Access-Control-Expose-Headers", "*");

    // HEAD request için sadece header'ları gönder
    if (evhttp_request_get_command(req) == EVHTTP_REQ_HEAD)
    {
        char cl[32];
        snprintf(cl, sizeof(cl), "%zu", found->size);
        evhttp_add_header(out, "Content-Length", cl);
        struct evbuffer *empty = evbuffer_new();
        evhttp_send_reply(req, 200, "OK", empty);
        if (empty)
            evbuffer_free(empty);
        evhttp_uri_free(decoded);
        return;
    }

    // Segment verisini gönder
    struct evbuffer *buf = evbuffer_new();
    if (!buf)
    {
        evhttp_send_error(req, 500, "Memory allocation failed");
        evhttp_uri_free(decoded);
        return;
    }

    evbuffer_add(buf, found->data, found->size);
    evhttp_send_reply(req, 200, "OK", buf);
    evbuffer_free(buf);
    evhttp_uri_free(decoded);
}

// Gelen isteğin yoluna göre doğru handler'a yönlendiren ana handler
static void generic_handler(struct evhttp_request *req, void *arg)
{
    const char *uri = evhttp_request_get_uri(req);
    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    if (!decoded)
    {
        evhttp_send_error(req, 400, "Bad Request");
        return;
    }

    const char *path = evhttp_uri_get_path(decoded);
    if (!path)
    {
        evhttp_send_error(req, 404, "Not Found");
        evhttp_uri_free(decoded);
        return;
    }

    // Sağlık kontrolü endpoint'i
    if (strcmp(path, "/health") == 0)
    {
        struct evbuffer *buf = evbuffer_new();
        if (buf)
        {
            evbuffer_add_printf(buf, "OK - Aktif stream sayisi: %d", stream_count);
            evhttp_add_header(evhttp_request_get_output_headers(req), "Content-Type", "text/plain");
            evhttp_send_reply(req, 200, "OK", buf);
            evbuffer_free(buf);
        }
        else
        {
            evhttp_send_error(req, 500, "Memory allocation failed");
        }
        evhttp_uri_free(decoded);
        return;
    }

    // Status endpoint'i
    if (strcmp(path, "/status") == 0)
    {
        struct evbuffer *buf = evbuffer_new();
        if (buf)
        {
            evbuffer_add_printf(buf, "{\n");
            evbuffer_add_printf(buf, "  \"active_streams\": %d,\n", stream_count);
            evbuffer_add_printf(buf, "  \"max_streams\": %d,\n", MAX_STREAMS);
            evbuffer_add_printf(buf, "  \"segment_duration_ms\": %d,\n", G_SEG_MS);
            evbuffer_add_printf(buf, "  \"audio_bitrate\": %d,\n", G_AAC_BR);
            evbuffer_add_printf(buf, "  \"audio_samplerate\": %d,\n", G_AAC_SR);
            evbuffer_add_printf(buf, "  \"audio_channels\": %d\n", G_AAC_CH);
            evbuffer_add_printf(buf, "}\n");
            evhttp_add_header(evhttp_request_get_output_headers(req), "Content-Type", "application/json");
            evhttp_send_reply(req, 200, "OK", buf);
            evbuffer_free(buf);
        }
        else
        {
            evhttp_send_error(req, 500, "Memory allocation failed");
        }
        evhttp_uri_free(decoded);
        return;
    }

    // Playlist ve segment isteklerini ilgili fonksiyonlara yönlendir
    if (strcmp(path, "/m3u8") == 0)
    {
        m3u8_handler(req);
    }
    else if (strncmp(path, "/seg_", 5) == 0)
    {
        segment_handler(req);
    }
    else
    {
        evhttp_send_error(req, 404, "Not Found");
    }

    evhttp_uri_free(decoded);
}

// --- SUNUCU YÖNETİMİ ---

// Zaman aşımına uğrayan yayınları temizleyen periyodik thread
static void *cleanup_thread(void *arg)
{
    while (running)
    {
        sleep(30);

        if (!running)
            break;

        time_t now = time(NULL);
        pthread_mutex_lock(&map_mutex);

        for (int i = 0; i < stream_count; i++)
        {
            if (!stream_map[i].t)
                continue;

            // Timeout kontrolü
            if (now - stream_map[i].t->last_access > STREAM_TIMEOUT_SEC)
            {
                fprintf(stderr, "[gateway] Stream timeout: %s (son erişim: %ld saniye önce)\n",
                        stream_map[i].url, now - stream_map[i].t->last_access);

                cleanup_transcoder(stream_map[i].t);
                memmove(&stream_map[i], &stream_map[i + 1], (--stream_count - i) * sizeof(stream_entry_t));
                i--; // Dizin kaydı nedeniyle bir geriye git
            }
        }

        pthread_mutex_unlock(&map_mutex);
    }

    fprintf(stderr, "[gateway] Cleanup thread sonlandırıldı\n");
    return NULL;
}

// SIGCHLD signal handler - çocuk proseslerin zombie olmasını önler
static void sigchld_handler(int sig)
{
    while (waitpid(-1, NULL, WNOHANG) > 0)
        ;
}

// Bir işçi (worker) prosesinin ana döngüsü
static int run_one_worker(void)
{
    fprintf(stderr, "[gateway] Worker (PID %d) başlatılıyor...\n", getpid());

    // libevent için temel olay döngüsünü oluştur
    base = event_base_new();
    if (!base)
    {
        fprintf(stderr, "event_base_new() başarısız.\n");
        return 1;
    }

    // Yeni bir HTTP sunucusu oluştur
    struct evhttp *http = evhttp_new(base);
    if (!http)
    {
        fprintf(stderr, "evhttp_new() başarısız.\n");
        event_base_free(base);
        return 1;
    }

    // HTTP sunucu ayarları
    evhttp_set_allowed_methods(http, EVHTTP_REQ_GET | EVHTTP_REQ_HEAD);
    evhttp_set_max_headers_size(http, 8192);
    evhttp_set_max_body_size(http, 0); // GET/HEAD için body yok
    evhttp_set_timeout(http, 30);      // 30 saniye connection timeout

    // HTTP sunucusunu belirtilen port ve adreste dinlemeye başla
    if (evhttp_bind_socket(http, "0.0.0.0", PORT) != 0)
    {
        fprintf(stderr, "Port %d üzerinde bind hatası: %s\n", PORT, strerror(errno));
        evhttp_free(http);
        event_base_free(base);
        return 1;
    }

    // Gelen tüm istekler için genel handler fonksiyonunu ayarla
    evhttp_set_gencb(http, generic_handler, NULL);

    // Zaman aşımı kontrolü için temizlik thread'ini başlat
    pthread_t cleanup_tid;
    if (pthread_create(&cleanup_tid, NULL, cleanup_thread, NULL) != 0)
    {
        fprintf(stderr, "Cleanup thread başlatılamadı\n");
        evhttp_free(http);
        event_base_free(base);
        return 1;
    }

    // Worker'ın hazır olduğunu bildir
    printf("Worker (PID %d) hazır: http://localhost:%d\n", getpid(), PORT);
    printf("Ayarlar - SEG_MS=%d, AAC=%dk@%dHz/%s, MAX_STREAMS=%d\n",
           G_SEG_MS, G_AAC_BR / 1000, G_AAC_SR,
           G_AAC_CH == 1 ? "mono" : "stereo", MAX_STREAMS);

    // libevent olay döngüsünü başlat (bu fonksiyon program sonlanana kadar dönmez)
    event_base_dispatch(base);

    fprintf(stderr, "[gateway] Worker (PID %d) sonlandırılıyor...\n", getpid());

    // Cleanup thread'ini sonlandır
    pthread_cancel(cleanup_tid);
    pthread_join(cleanup_tid, NULL);

    // Aktif transcoder'ları temizle
    pthread_mutex_lock(&map_mutex);
    for (int i = 0; i < stream_count; i++)
    {
        if (stream_map[i].t)
        {
            cleanup_transcoder(stream_map[i].t);
        }
    }
    stream_count = 0;
    pthread_mutex_unlock(&map_mutex);

    // Kaynakları serbest bırak
    evhttp_free(http);
    event_base_free(base);

    return 0;
}

// --- ANA FONKSİYON ---
int main()
{
    printf("=== HLS Gateway v2.0 ===\n");

    // Ortam değişkenlerinden ayarları oku, yoksa varsayılanları kullan
    G_SEG_MS = getenv_int("SEG_MS", 1000);
    G_AAC_BR = getenv_int("AAC_BR", 96000);
    G_AAC_SR = getenv_int("AAC_SR", 48000);
    G_AAC_CH = getenv_int("AAC_CH", 2);
    G_WORKERS = getenv_int("WORKERS", 1);

    // Ayar validasyonu
    if (G_SEG_MS < 500 || G_SEG_MS > 10000)
    {
        fprintf(stderr, "Geçersiz SEG_MS değeri: %d (500-10000 arasında olmalı)\n", G_SEG_MS);
        return 1;
    }

    if (G_AAC_BR < 32000 || G_AAC_BR > 320000)
    {
        fprintf(stderr, "Geçersiz AAC_BR değeri: %d (32000-320000 arasında olmalı)\n", G_AAC_BR);
        return 1;
    }

    if (G_AAC_CH < 1 || G_AAC_CH > 2)
    {
        fprintf(stderr, "Geçersiz AAC_CH değeri: %d (1 veya 2 olmalı)\n", G_AAC_CH);
        return 1;
    }

    if (G_WORKERS < 1 || G_WORKERS > 16)
    {
        fprintf(stderr, "Geçersiz WORKERS değeri: %d (1-16 arasında olmalı)\n", G_WORKERS);
        return 1;
    }

    printf("Konfigürasyon:\n");
    printf("  - Segment süresi: %d ms\n", G_SEG_MS);
    printf("  - Audio bitrate: %d bps\n", G_AAC_BR);
    printf("  - Audio sample rate: %d Hz\n", G_AAC_SR);
    printf("  - Audio kanallar: %d (%s)\n", G_AAC_CH, G_AAC_CH == 1 ? "mono" : "stereo");
    printf("  - Worker sayısı: %d\n", G_WORKERS);
    printf("  - Maksimum eşzamanlı stream: %d\n", MAX_STREAMS);
    printf("  - Stream timeout: %d saniye\n", STREAM_TIMEOUT_SEC);

    // Signal handler'ları kaydet
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGCHLD, sigchld_handler);
    signal(SIGPIPE, SIG_IGN); // Broken pipe'ları yoksay

    // FFmpeg için ağ kütüphanesini başlat
    avformat_network_init();

    printf("FFmpeg network kütüphanesi başlatıldı\n");

    // Eğer sadece bir işçi isteniyorsa, fork yapmadan doğrudan çalıştır
    if (G_WORKERS <= 1)
    {
        printf("Tek worker modunda çalışılıyor...\n");
        return run_one_worker();
    }

    // Birden fazla işçi isteniyorsa, her biri için yeni bir proses oluştur (fork)
    printf("%d adet worker oluşturuluyor...\n", G_WORKERS);

    pid_t worker_pids[G_WORKERS];
    int started_workers = 0;

    for (int i = 0; i < G_WORKERS; i++)
    {
        pid_t pid = fork();
        if (pid == 0)
        {
            // Bu blok sadece child (çocuk) proses tarafından çalıştırılır
            return run_one_worker();
        }
        else if (pid > 0)
        {
            // Parent proses - worker PID'sini sakla
            worker_pids[started_workers++] = pid;
            printf("Worker %d başlatıldı (PID: %d)\n", i + 1, pid);
        }
        else
        {
            // Fork hatası
            perror("fork");
            fprintf(stderr, "Worker %d başlatılamadı\n", i + 1);
            // Başlatılan worker'ları sonlandır
            for (int j = 0; j < started_workers; j++)
            {
                kill(worker_pids[j], SIGTERM);
            }
            return 1;
        }
    }

    printf("Tüm worker'lar başlatıldı. Ana proses bekleme modunda...\n");

    // Ana proses, çocuk proseslerin sonlanmasını bekler
    while (running)
    {
        pause(); // Sinyal gelene kadar bekle
    }

    printf("Sonlandırma sinyali alındı. Worker'lar kapatılıyor...\n");

    // Tüm worker'lara SIGTERM gönder
    for (int i = 0; i < started_workers; i++)
    {
        kill(worker_pids[i], SIGTERM);
    }

    // Worker'ların sonlanmasını bekle (timeout ile)
    int timeout = 10; // 10 saniye timeout
    while (timeout > 0)
    {
        int all_done = 1;
        for (int i = 0; i < started_workers; i++)
        {
            if (kill(worker_pids[i], 0) == 0)
            { // Proses hala yaşıyor
                all_done = 0;
                break;
            }
        }
        if (all_done)
            break;

        sleep(1);
        timeout--;
    }

    // Hala yaşayan worker'lara SIGKILL gönder
    if (timeout <= 0)
    {
        printf("Bazı worker'lar graceful shutdown yapmadı, zorla kapatılıyor...\n");
        for (int i = 0; i < started_workers; i++)
        {
            kill(worker_pids[i], SIGKILL);
        }
    }

    printf("Tüm worker'lar kapatıldı. Program sonlandırılıyor.\n");
    avformat_network_deinit();
    return 0;
}