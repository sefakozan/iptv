// multi_hls_gateway.c
#include <event2/event.h>
#include <event2/http.h>
#include <event2/buffer.h>
#include <event2/keyvalq_struct.h>
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <nghttp2/nghttp2.h>

#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/avstring.h>
#include <libswresample/swresample.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>

#define PORT 5001
#define MAX_STREAMS 50
#define MAX_SEGMENTS 10
#define SEGMENT_DURATION_MS 2000
#define STREAM_TIMEOUT_SEC 600  // 10 dakika

// === Bellek Üzerinde Segment ===
typedef struct {
    uint8_t *data;
    size_t size;
    int num;
    int64_t pts_start, pts_end;
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

    AVFormatContext *ofmt_ctx;
    uint8_t *ts_buffer;
    int ts_buf_size;

    mem_segment_t segments[MAX_SEGMENTS];
    int seg_head;
    int64_t seg_start_time;

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

// === URL Decode ===
void url_decode(char *dst, const char *src) {
    char a, b;
    while (*src) {
        if (*src == '%' && src[1] && src[2]) {
            a = toupper(src[1]), b = toupper(src[2]);
            if (isxdigit(a) && isxdigit(b)) {
                *dst++ = ((a <= '9') ? a - '0' : a - 'A' + 10) << 4 | (b <= '9' ? b - '0' : b - 'A' + 10);
                src += 3; continue;
            }
        }
        *dst++ = *src++;
    }
    *dst = '\0';
}

// === Hash Fonksiyonu ===
unsigned int hash_str(const char *s) {
    unsigned int h = 5381;
    while (*s) h = ((h << 5) + h) + *s++;
    return h;
}

// === Yeni Segment Başlat ===
int start_new_segment(transcoder_t *t) {
    pthread_mutex_lock(&t->mutex);

    int idx = t->seg_head % MAX_SEGMENTS;
    free(t->segments[idx].data);
    memset(&t->segments[idx], 0, sizeof(mem_segment_t));

    avformat_free_context(&t->ofmt_ctx);
    avformat_alloc_output_context2(&t->ofmt_ctx, NULL, "mpegts", NULL);
    if (!t->ofmt_ctx) {
        pthread_mutex_unlock(&t->mutex);
        return -1;
    }

    // Video stream
    AVStream *vst = avformat_new_stream(t->ofmt_ctx, NULL);
    avcodec_parameters_copy(vst->codecpar, t->ifmt_ctx->streams[t->video_stream_index]->codecpar);
    vst->time_base = (AVRational){1, 90000};

    // Audio stream (AAC)
    AVStream *ast = avformat_new_stream(t->ofmt_ctx, NULL);
    ast->codecpar->codec_id = AV_CODEC_ID_AAC;
    ast->codecpar->codec_type = AVMEDIA_TYPE_AUDIO;
    ast->codecpar->sample_rate = 48000;
    ast->codecpar->channel_layout = AV_CH_LAYOUT_STEREO;
    ast->codecpar->channels = 2;
    ast->codecpar->sample_fmt = AV_SAMPLE_FMT_FLTP;
    ast->codecpar->bit_rate = 128000;
    ast->time_base = (AVRational){1, 48000};

    if (avio_open_dyn_buf(&t->ofmt_ctx->pb) < 0) {
        pthread_mutex_unlock(&t->mutex);
        return -1;
    }
    avformat_write_header(t->ofmt_ctx, NULL);

    t->seg_start_time = av_gettime() / 1000;
    t->seg_head++;
    pthread_mutex_unlock(&t->mutex);
    return 0;
}

// === Ses Transcode ===
void encode_audio_frame(transcoder_t *t, AVFrame *frame) {
    uint8_t *s16;
    av_samples_alloc(&s16, NULL, 2, frame->nb_samples, AV_SAMPLE_FMT_S16, 0);
    swr_convert(t->swr_ctx, &s16, frame->nb_samples, (const uint8_t**)frame->data, frame->nb_samples);
    av_audio_fifo_write(t->fifo, (void**)&s16, frame->nb_samples);
    av_freep(&s16);

    AVFrame *enc_frame = av_frame_alloc();
    AVPacket *pkt = av_packet_alloc();
    while (av_audio_fifo_size(t->fifo) >= t->a_enc_ctx->frame_size) {
        enc_frame->nb_samples = t->a_enc_ctx->frame_size;
        enc_frame->format = t->a_enc_ctx->sample_fmt;
        enc_frame->channel_layout = t->a_enc_ctx->channel_layout;
        enc_frame->sample_rate = t->a_enc_ctx->sample_rate;
        av_frame_get_buffer(enc_frame, 0);
        av_audio_fifo_read(t->fifo, (void**)enc_frame->data, t->a_enc_ctx->frame_size);

        avcodec_send_frame(t->a_enc_ctx, enc_frame);
        while (avcodec_receive_packet(t->a_enc_ctx, pkt) == 0) {
            pkt->stream_index = 1;
            av_interleaved_write_frame(t->ofmt_ctx, pkt);
        }
    }
    av_frame_free(&enc_frame);
    av_packet_free(&pkt);
}

// === Transkod Döngüsü ===
void* transcode_loop(void *arg) {
    transcoder_t *t = (transcoder_t*)arg;
    AVPacket *pkt = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();

    while (av_read_frame(t->ifmt_ctx, pkt) >= 0) {
        int64_t now_ms = av_gettime() / 1000;

        if (pkt->stream_index == t->video_stream_index) {
            AVStream *in_st = t->ifmt_ctx->streams[pkt->stream_index];
            int64_t pts_ms = av_rescale_q(pkt->pts, in_st->time_base, (AVRational){1, 1000});

            if (now_ms - t->seg_start_time >= SEGMENT_DURATION_MS) {
                start_new_segment(t);
            }

            pkt->stream_index = 0;
            av_packet_rescale_ts(pkt, in_st->time_base, t->ofmt_ctx->streams[0]->time_base);
            av_interleaved_write_frame(t->ofmt_ctx, pkt);
        } else if (pkt->stream_index == t->audio_stream_index) {
            if (avcodec_send_packet(t->a_dec_ctx, pkt) == 0) {
                while (avcodec_receive_frame(t->a_dec_ctx, frame) == 0) {
                    encode_audio_frame(t, frame);
                }
            }
        }
        av_packet_unref(pkt);

        // Erişim zamanını güncelle
        pthread_mutex_lock(&map_mutex);
        t->last_access = time(NULL);
        pthread_mutex_unlock(&map_mutex);
    }

    // Flush
    avcodec_send_packet(t->a_dec_ctx, NULL);
    while (avcodec_receive_frame(t->a_dec_ctx, frame) == 0) {
        encode_audio_frame(t, frame);
    }
    encode_audio_frame(t, NULL);

    av_write_trailer(t->ofmt_ctx);
    uint8_t *buf;
    int len = avio_close_dyn_buf(t->ofmt_ctx->pb, &buf);
    int idx = t->seg_head % MAX_SEGMENTS;
    t->segments[idx].data = malloc(len);
    memcpy(t->segments[idx].data, buf, len);
    t->segments[idx].size = len;
    t->segments[idx].num = t->seg_head;
    av_free(buf);

    avformat_free_context(t->ofmt_ctx);
    avformat_close_input(&t->ifmt_ctx);
    avcodec_free_context(&t->a_dec_ctx);
    avcodec_free_context(&t->a_enc_ctx);
    swr_free(&t->swr_ctx);
    av_audio_fifo_free(t->fifo);
    av_frame_free(&frame);
    av_packet_free(&pkt);

    // Haritadan kaldır
    pthread_mutex_lock(&map_mutex);
    for (int i = 0; i < stream_count; i++) {
        if (stream_map[i].t == t) {
            free(stream_map[i].t);
            memmove(&stream_map[i], &stream_map[i+1], (--stream_count - i) * sizeof(stream_entry_t));
            break;
        }
    }
    pthread_mutex_unlock(&map_mutex);

    return NULL;
}

// === Yeni Transcoder Başlat ===
transcoder_t* start_transcoder(const char *url) {
    transcoder_t *t = calloc(1, sizeof(transcoder_t));
    if (!t) return NULL;

    strcpy(t->input_url, url);
    t->last_access = time(NULL);
    pthread_mutex_init(&t->mutex, NULL);

    if (avformat_open_input(&t->ifmt_ctx, url, NULL, NULL) < 0) goto fail;
    if (avformat_find_stream_info(t->ifmt_ctx, NULL) < 0) goto fail;

    t->video_stream_index = av_find_best_stream(t->ifmt_ctx, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    t->audio_stream_index = -1;
    for (int i = 0; i < t->ifmt_ctx->nb_streams; i++) {
        if (t->ifmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO &&
            t->ifmt_ctx->streams[i]->codecpar->codec_id == AV_CODEC_ID_MP2) {
            t->audio_stream_index = i; break;
        }
    }
    if (t->audio_stream_index == -1) goto fail;

    // MP2 decode
    AVCodec *dec = avcodec_find_decoder(AV_CODEC_ID_MP2);
    t->a_dec_ctx = avcodec_alloc_context3(dec);
    avcodec_parameters_to_context(t->a_dec_ctx, t->ifmt_ctx->streams[t->audio_stream_index]->codecpar);
    if (avcodec_open2(t->a_dec_ctx, dec, NULL) < 0) goto fail;

    // AAC encode
    AVCodec *enc = avcodec_find_encoder(AV_CODEC_ID_AAC);
    t->a_enc_ctx = avcodec_alloc_context3(enc);
    t->a_enc_ctx->sample_rate = 48000;
    t->a_enc_ctx->channel_layout = AV_CH_LAYOUT_STEREO;
    t->a_enc_ctx->channels = 2;
    t->a_enc_ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;
    t->a_enc_ctx->bit_rate = 128000;
    t->a_enc_ctx->time_base = (AVRational){1, 48000};
    if (avcodec_open2(t->a_enc_ctx, enc, NULL) < 0) goto fail;

    // Swr
    t->swr_ctx = swr_alloc_set_opts(NULL,
        AV_CH_LAYOUT_STEREO, AV_SAMPLE_FMT_FLTP, 48000,
        AV_CH_LAYOUT_STEREO, AV_SAMPLE_FMT_S16, 48000, 0, NULL);
    swr_init(t->swr_ctx);

    // FIFO
    t->fifo = av_audio_fifo_alloc(AV_SAMPLE_FMT_S16, 2, 1024);

    start_new_segment(t);
    pthread_create(&t->thread, NULL, transcode_loop, t);
    return t;

fail:
    if (t->ifmt_ctx) avformat_close_input(&t->ifmt_ctx);
    free(t);
    return NULL;
}

// === Akış Bul veya Oluştur ===
transcoder_t* get_or_create_transcoder(const char *url) {
    unsigned int h = hash_str(url);

    pthread_mutex_lock(&map_mutex);
    for (int i = 0; i < stream_count; i++) {
        if (stream_map[i].hash == h && strcmp(stream_map[i].url, url) == 0) {
            stream_map[i].t->last_access = time(NULL);
            pthread_mutex_unlock(&map_mutex);
            return stream_map[i].t;
        }
    }

    if (stream_count >= MAX_STREAMS) {
        pthread_mutex_unlock(&map_mutex);
        return NULL;
    }

    transcoder_t *t = start_transcoder(url);
    if (!t) {
        pthread_mutex_unlock(&map_mutex);
        return NULL;
    }

    stream_map[stream_count].hash = h;
    stream_map[stream_count].t = t;
    strcpy(stream_map[stream_count].url, url);
    stream_count++;
    pthread_mutex_unlock(&map_mutex);
    return t;
}

// === /m3u8?q=... Handler ===
void m3u8_handler(struct evhttp_request *req, void *arg) {
    const char *uri = evhttp_request_get_uri(req);
    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    if (!decoded) {
        evhttp_send_error(req, 400, "Bad Request");
        return;
    }

    const char *query = evhttp_uri_get_query(decoded);
    if (!query) {
        evhttp_send_error(req, 400, "Missing query");
        evhttp_uri_free(decoded);
        return;
    }

    const char *q = strstr(query, "q=");
    if (!q) {
        evhttp_send_error(req, 400, "q= required");
        evhttp_uri_free(decoded);
        return;
    }

    char encoded[1024];
    strncpy(encoded, q + 2, sizeof(encoded) - 1);
    char input_url[1024];
    url_decode(input_url, encoded);

    transcoder_t *t = get_or_create_transcoder(input_url);
    if (!t) {
        evhttp_send_error(req, 500, "Cannot start transcoder");
        evhttp_uri_free(decoded);
        return;
    }

    // index.m3u8 oluştur
    char m3u8[2048] = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n";
    pthread_mutex_lock(&t->mutex);
    for (int i = 0; i < MAX_SEGMENTS; i++) {
        int idx = (t->seg_head - MAX_SEGMENTS + i + MAX_SEGMENTS) % MAX_SEGMENTS;
        if (t->segments[idx].size) {
            char line[128];
            sprintf(line, "#EXTINF:2.0,\nseg_%03d.ts?h=%x\n", t->segments[idx].num, hash_str(input_url));
            strcat(m3u8, line);
        }
    }
    strcat(m3u8, "#EXT-X-ENDLIST\n");
    pthread_mutex_unlock(&t->mutex);

    struct evbuffer *buf = evbuffer_new();
    evbuffer_add_printf(buf, "%s", m3u8);
    evhttp_add_header(evhttp_request_get_output_headers(req), "Content-Type", "application/vnd.apple.mpegurl");
    evhttp_send_reply(req, 200, "OK", buf);
    evbuffer_free(buf);
    evhttp_uri_free(decoded);
}

// === /seg_XXX.ts?h=... Handler ===
void segment_handler(struct evhttp_request *req, void *arg) {
    const char *uri = evhttp_request_get_uri(req);
    int num;
    if (sscanf(uri, "/seg_%d.ts", &num) != 1) {
        evhttp_send_error(req, 400, "Invalid segment");
        return;
    }

    // hash al
    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    const char *query = evhttp_uri_get_query(decoded);
    const char *h_str = NULL;
    if (query) h_str = strstr(query, "h=");
    if (!h_str) {
        evhttp_send_error(req, 400, "h= required");
        evhttp_uri_free(decoded);
        return;
    }
    unsigned int target_hash = strtol(h_str + 2, NULL, 16);

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
        if (t->segments[i].num == num) {
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
void* cleanup_thread(void *arg) {
    while (1) {
        sleep(60);
        time_t now = time(NULL);
        pthread_mutex_lock(&map_mutex);
        for (int i = 0; i < stream_count; i++) {
            if (now - stream_map[i].t->last_access > STREAM_TIMEOUT_SEC) {
                printf("Akış zaman aşımına uğradı: %s\n", stream_map[i].url);
                // FFmpeg thread’i otomatik sonlanır
                free(stream_map[i].t);
                memmove(&stream_map[i], &stream_map[i+1], (--stream_count - i) * sizeof(stream_entry_t));
                i--;
            }
        }
        pthread_mutex_unlock(&map_mutex);
    }
    return NULL;
}

// === Ana Fonksiyon ===
int main() {
    av_register_all();
    SSL_load_error_strings();
    ERR_load_SSL_strings();
    OpenSSL_add_ssl_algorithms();

    base = event_base_new();
    struct evhttp *http = evhttp_new(base);

    SSL_CTX *ssl_ctx = SSL_CTX_new(TLS_server_method());
    if (SSL_CTX_use_certificate_file(ssl_ctx, "cert.pem", SSL_FILETYPE_PEM) <= 0 ||
        SSL_CTX_use_PrivateKey_file(ssl_ctx, "key.pem", SSL_FILETYPE_PEM) <= 0) {
        fprintf(stderr, "Sertifika hatası. 'cert.pem' ve 'key.pem' oluşturun.\n");
        return 1;
    }

    evhttp_set_bevcb(http, [](struct event_base *base, void *arg) -> struct bufferevent* {
        return bufferevent_openssl_socket_new(base, -1, SSL_new(ssl_ctx),
            BUFFEREVENT_SSL_ACCEPTING, BEV_OPT_CLOSE_ON_FREE);
    }, NULL);

    evhttp_set_allowed_methods(http, EVHTTP_REQ_GET);
    evhttp_set_max_headers_size(http, 8192);

    evhttp_set_cb(http, "/m3u8", m3u8_handler, NULL);
    evhttp_set_cb(http, "/seg_", segment_handler, NULL);

    if (evhttp_bind_socket(http, "0.0.0.0", PORT) < 0) {
        fprintf(stderr, "Bağlantı hatası\n");
        return 1;
    }

    // Temizlik thread'i
    pthread_t cleanup_tid;
    pthread_create(&cleanup_tid, NULL, cleanup_thread, NULL);

    printf("🚀 Çoklu HLS Gateway Başladı\n");
    printf("🔗 https://localhost:%d/m3u8?q=http%%3A%%2F%%2F185.234.111.229%%3A8000%%2Fplay%%2Fa01y\n", PORT);

    event_base_dispatch(base);

    evhttp_free(http);
    event_base_free(base);
    SSL_CTX_free(ssl_ctx);
    return 0;
}