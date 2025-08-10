// multi_hls_gateway.c
// Ubuntu 24.04 + FFmpeg 5.1 (apt) + libevent + HTTP + çoklu akış
// Derle: gcc multi_hls_gateway.c -o hls_gateway -levent -lavformat -lavcodec -lavutil -lswresample -lpthread -lz

#include <event2/event.h>
#include <event2/http.h>
#include <event2/buffer.h>
#include <event2/keyvalq_struct.h>

#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/avstring.h>
#include <libavutil/time.h>  // av_gettime_relative() için
#include <libswresample/swresample.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>
#include <ctype.h>

#ifndef MAX
#define MAX(a,b) ((a)>(b)?(a):(b))
#endif

#define PORT 5001
#define MAX_STREAMS 256
#define MAX_SEGMENTS 4
#define IO_BUF_SIZE 32768
#define SEGMENT_PREALLOC (2 * 1024 * 1024)
#define STREAM_TIMEOUT_SEC 300

// === Bellek Segmenti ===
typedef struct {
    uint8_t *data;
    size_t size;
    size_t cap;
    int num;
    AVIOContext *avio;
    uint8_t *avio_buf;
} mem_segment_t;

// === Transcoder ===
typedef struct {
    char input_url[512];
    int video_stream_index;
    int audio_stream_index;

    AVFormatContext *ifmt_ctx;
    AVCodecContext  *a_dec_ctx;
    AVCodecContext  *a_enc_ctx;
    SwrContext      *swr_ctx;

    // Audio buffer (AVAudioFifo yerine)
    uint8_t **audio_buf;
    int audio_buf_samples;
    int audio_buf_capacity;
    int audio_channels;
    int audio_sample_rate;

    AVFormatContext *ofmt_ctx;
    int active_seg_index;
    int64_t seg_start_time_ms;
    int64_t a_next_pts;

    mem_segment_t segments[MAX_SEGMENTS];
    int seg_head;

    pthread_mutex_t mutex;
    pthread_t thread;

    time_t last_access;
} transcoder_t;

// === Akış Haritası ===
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
static void url_decode(char *dst, const char *src) {
    char a, b;
    while (*src) {
        if (*src == '%' && src[1] && src[2]) {
            a = toupper((unsigned char)src[1]);
            b = toupper((unsigned char)src[2]);
            if (isxdigit((unsigned char)a) && isxdigit((unsigned char)b)) {
                *dst++ = ((a <= '9' ? a - '0' : a - 'A' + 10) << 4) | (b <= '9' ? b - '0' : b - 'A' + 10);
                src += 3; continue;
            }
        }
        *dst++ = *src++;
    }
    *dst = '\0';
}

// === Hash ===
static unsigned int hash_str(const char *s) {
    unsigned int h = 5381;
    unsigned char c;
    while ((c = (unsigned char)*s++) != 0) h = ((h << 5) + h) + c;
    return h;
}

// === AVIO write callback ===
static int seg_write_cb(void *opaque, uint8_t *buf, int buf_size) {
    mem_segment_t *seg = (mem_segment_t*)opaque;
    if (buf_size <= 0) return 0;
    size_t need = seg->size + (size_t)buf_size;
    if (need > seg->cap) {
        size_t new_cap = seg->cap ? seg->cap : SEGMENT_PREALLOC;
        while (new_cap < need) new_cap <<= 1;
        uint8_t *p = (uint8_t*)av_realloc(seg->data, new_cap);
        if (!p) return AVERROR(ENOMEM);
        seg->data = p;
        seg->cap = new_cap;
    }
    memcpy(seg->data + seg->size, buf, buf_size);
    seg->size += (size_t)buf_size;
    return buf_size;
}

// === Segment muxer aç ===
static int open_segment_muxer(transcoder_t *t) {
    int ret = avformat_alloc_output_context2(&t->ofmt_ctx, NULL, "mpegts", NULL);
    if (ret < 0 || !t->ofmt_ctx) return AVERROR_UNKNOWN;

    // Video stream
    AVStream *vst = avformat_new_stream(t->ofmt_ctx, NULL);
    if (!vst) return AVERROR(ENOMEM);
    if ((ret = avcodec_parameters_copy(vst->codecpar, t->ifmt_ctx->streams[t->video_stream_index]->codecpar)) < 0) return ret;
    vst->time_base = (AVRational){1, 90000};

    // Audio stream (AAC)
    AVStream *ast = avformat_new_stream(t->ofmt_ctx, NULL);
    if (!ast) return AVERROR(ENOMEM);
    ast->codecpar->codec_id = AV_CODEC_ID_AAC;
    ast->codecpar->codec_type = AVMEDIA_TYPE_AUDIO;
    ast->codecpar->sample_rate = 48000;
    ast->codecpar->channels = 2;
    
    #if LIBAVUTIL_VERSION_INT >= AV_VERSION_INT(57, 28, 100)
    av_channel_layout_default(&ast->codecpar->ch_layout, 2);
    #else
    ast->codecpar->channel_layout = AV_CH_LAYOUT_STEREO;
    #endif
    
    ast->codecpar->format = AV_SAMPLE_FMT_FLTP;
    ast->codecpar->bit_rate = 128000;
    ast->time_base = (AVRational){1, 48000};

    // Segment için AVIO context
    mem_segment_t *seg = &t->segments[t->active_seg_index];
    seg->size = 0;
    if (!seg->avio_buf) seg->avio_buf = (uint8_t*)av_malloc(IO_BUF_SIZE);
    if (!seg->avio_buf) return AVERROR(ENOMEM);
    seg->avio = avio_alloc_context(seg->avio_buf, IO_BUF_SIZE, 1, seg, NULL, seg_write_cb, NULL);
    if (!seg->avio) return AVERROR(ENOMEM);
    t->ofmt_ctx->pb = seg->avio;
    t->ofmt_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;

    if ((ret = avformat_write_header(t->ofmt_ctx, NULL)) < 0) return ret;
    return 0;
}

static void close_segment_muxer(transcoder_t *t) {
    if (!t->ofmt_ctx) return;
    av_write_trailer(t->ofmt_ctx);
    if (t->ofmt_ctx->pb) {
        AVIOContext *pb = t->ofmt_ctx->pb;
        t->ofmt_ctx->pb = NULL;
        avio_context_free(&pb);
    }
    avformat_free_context(t->ofmt_ctx);
    t->ofmt_ctx = NULL;
}

static int start_new_segment(transcoder_t *t) {
    pthread_mutex_lock(&t->mutex);
    if (t->active_seg_index >= 0 && t->ofmt_ctx) close_segment_muxer(t);

    int idx = t->seg_head % MAX_SEGMENTS;
    mem_segment_t *seg = &t->segments[idx];

    if (seg->data) { av_free(seg->data); seg->data = NULL; seg->size = 0; seg->cap = 0; }
    if (seg->avio) { avio_context_free(&seg->avio); seg->avio = NULL; }
    seg->num = t->seg_head;

    t->active_seg_index = idx;
    int ret = open_segment_muxer(t);
    if (ret == 0) {
        t->seg_start_time_ms = av_gettime_relative() / 1000;  // ✅ FFmpeg 5.1 uyumlu
        t->seg_head++;
    }
    pthread_mutex_unlock(&t->mutex);
    return ret;
}

// === Ses transcode ===
static int push_and_encode_audio(transcoder_t *t, AVFrame *in_frame) {
    int ret = 0;
    AVFrame *out_frame = NULL;
    AVPacket *pkt = NULL;

    if (in_frame) {
        // Ses dönüşümü
        out_frame = av_frame_alloc();
        if (!out_frame) return AVERROR(ENOMEM);
        
        #if LIBAVUTIL_VERSION_INT >= AV_VERSION_INT(57, 28, 100)
        av_channel_layout_default(&out_frame->ch_layout, 2);
        #else
        out_frame->channel_layout = AV_CH_LAYOUT_STEREO;
        out_frame->channels = 2;
        #endif
        
        out_frame->format = AV_SAMPLE_FMT_FLTP;
        out_frame->sample_rate = 48000;
        out_frame->nb_samples = in_frame->nb_samples;
        
        if ((ret = av_frame_get_buffer(out_frame, 0)) < 0) goto end;

        if ((ret = swr_convert(t->swr_ctx, (uint8_t**)out_frame->data, out_frame->nb_samples,
                               (const uint8_t**)in_frame->data, in_frame->nb_samples)) < 0) goto end;

        out_frame->pts = t->a_next_pts;
        t->a_next_pts += out_frame->nb_samples;
    }

    // Encode
    if ((ret = avcodec_send_frame(t->a_enc_ctx, in_frame ? out_frame : NULL)) < 0) goto end;

    pkt = av_packet_alloc();
    if (!pkt) { ret = AVERROR(ENOMEM); goto end; }

    while ((ret = avcodec_receive_packet(t->a_enc_ctx, pkt)) == 0) {
        pkt->stream_index = 1;
        pthread_mutex_lock(&t->mutex);
        if (t->ofmt_ctx) {
            av_packet_rescale_ts(pkt, t->a_enc_ctx->time_base, t->ofmt_ctx->streams[1]->time_base);
            av_interleaved_write_frame(t->ofmt_ctx, pkt);
        }
        pthread_mutex_unlock(&t->mutex);
        av_packet_unref(pkt);
    }

    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) ret = 0;

end:
    if (out_frame) av_frame_free(&out_frame);
    if (pkt) av_packet_free(&pkt);
    return ret;
}

// === Transkod döngüsü ===
static void* transcode_loop(void *arg) {
    transcoder_t *t = (transcoder_t*)arg;
    AVPacket *pkt = av_packet_alloc();
    AVFrame  *frame = av_frame_alloc();
    if (!pkt || !frame) return NULL;

    if (start_new_segment(t) < 0) goto end;
    int64_t last_seg_ms = t->seg_start_time_ms;

    while (av_read_frame(t->ifmt_ctx, pkt) >= 0) {
        int64_t now_ms = av_gettime_relative() / 1000;
        if (now_ms - last_seg_ms >= 1000) {
            start_new_segment(t);
            last_seg_ms = t->seg_start_time_ms;
        }

        if (pkt->stream_index == t->video_stream_index) {
            AVStream *in_st = t->ifmt_ctx->streams[pkt->stream_index];
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
        t->last_access = time(NULL);
    }

    // Flush
    avcodec_send_packet(t->a_dec_ctx, NULL);
    while (avcodec_receive_frame(t->a_dec_ctx, frame) == 0) {
        push_and_encode_audio(t, frame);
        av_frame_unref(frame);
    }
    push_and_encode_audio(t, NULL);
    avcodec_send_frame(t->a_enc_ctx, NULL);
    AVPacket *fp = av_packet_alloc();
    while (avcodec_receive_packet(t->a_enc_ctx, fp) == 0) {
        fp->stream_index = 1;
        pthread_mutex_lock(&t->mutex);
        if (t->ofmt_ctx) {
            av_packet_rescale_ts(fp, t->a_enc_ctx->time_base, t->ofmt_ctx->streams[1]->time_base);
            av_interleaved_write_frame(t->ofmt_ctx, fp);
        }
        pthread_mutex_unlock(&t->mutex);
        av_packet_unref(fp);
    }
    av_packet_free(&fp);

end:
    pthread_mutex_lock(&t->mutex);
    close_segment_muxer(t);
    pthread_mutex_unlock(&t->mutex);

    av_packet_free(&pkt);
    av_frame_free(&frame);

    avformat_close_input(&t->ifmt_ctx);
    avcodec_free_context(&t->a_dec_ctx);
    avcodec_free_context(&t->a_enc_ctx);
    swr_free(&t->swr_ctx);

    return NULL;
}

// === Yeni transcoder başlat ===
static transcoder_t* start_transcoder(const char *url) {
    transcoder_t *t = (transcoder_t*)calloc(1, sizeof(transcoder_t));
    if (!t) return NULL;

    av_strlcpy(t->input_url, url, sizeof(t->input_url));
    pthread_mutex_init(&t->mutex, NULL);
    t->active_seg_index = -1;
    t->a_next_pts = 0;
    t->last_access = time(NULL);

    AVDictionary *opts = NULL;
    av_dict_set(&opts, "reconnect", "1", 0);
    av_dict_set(&opts, "reconnect_streamed", "1", 0);
    av_dict_set(&opts, "reconnect_on_network_error", "1", 0);
    av_dict_set(&opts, "rw_timeout", "2000000", 0);

    if (avformat_open_input(&t->ifmt_ctx, url, NULL, &opts) < 0) { av_dict_free(&opts); free(t); return NULL; }
    av_dict_free(&opts);
    if (avformat_find_stream_info(t->ifmt_ctx, NULL) < 0) { avformat_close_input(&t->ifmt_ctx); free(t); return NULL; }

    t->video_stream_index = av_find_best_stream(t->ifmt_ctx, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    t->audio_stream_index = -1;
    for (unsigned i = 0; i < t->ifmt_ctx->nb_streams; i++) {
        if (t->ifmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) { t->audio_stream_index = (int)i; break; }
    }
    if (t->audio_stream_index < 0 || t->video_stream_index < 0) { avformat_close_input(&t->ifmt_ctx); free(t); return NULL; }

    // MP2 decode
    const AVCodec *dec = avcodec_find_decoder(t->ifmt_ctx->streams[t->audio_stream_index]->codecpar->codec_id);
    t->a_dec_ctx = avcodec_alloc_context3(dec);
    avcodec_parameters_to_context(t->a_dec_ctx, t->ifmt_ctx->streams[t->audio_stream_index]->codecpar);
    if (avcodec_open2(t->a_dec_ctx, dec, NULL) < 0) { avformat_close_input(&t->ifmt_ctx); free(t); return NULL; }

    // AAC encode
    const AVCodec *enc = avcodec_find_encoder(AV_CODEC_ID_AAC);
    t->a_enc_ctx = avcodec_alloc_context3(enc);
    t->a_enc_ctx->sample_rate = 48000;
    t->a_enc_ctx->channels = 2;
    
    #if LIBAVUTIL_VERSION_INT >= AV_VERSION_INT(57, 28, 100)
    av_channel_layout_default(&t->a_enc_ctx->ch_layout, 2);
    #else
    t->a_enc_ctx->channel_layout = AV_CH_LAYOUT_STEREO;
    #endif
    
    t->a_enc_ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;
    t->a_enc_ctx->bit_rate = 128000;
    t->a_enc_ctx->time_base = (AVRational){1, 48000};
    if (avcodec_open2(t->a_enc_ctx, enc, NULL) < 0) { avformat_close_input(&t->ifmt_ctx); free(t); return NULL; }

    // SWR
    #if LIBAVUTIL_VERSION_INT >= AV_VERSION_INT(57, 28, 100)
    SwrContext *swr = swr_alloc();
    AVChannelLayout in_ch_layout, out_ch_layout;
    av_channel_layout_default(&in_ch_layout, 2);
    av_channel_layout_default(&out_ch_layout, 2);
    av_opt_set_int(swr, "in_channel_layout", in_ch_layout.nb_channels, 0);
    av_opt_set_int(swr, "out_channel_layout", out_ch_layout.nb_channels, 0);
    av_opt_set_int(swr, "in_sample_rate", t->a_dec_ctx->sample_rate, 0);
    av_opt_set_int(swr, "out_sample_rate", 48000, 0);
    av_opt_set_sample_fmt(swr, "in_sample_fmt", t->a_dec_ctx->sample_fmt, 0);
    av_opt_set_sample_fmt(swr, "out_sample_fmt", AV_SAMPLE_FMT_FLTP, 0);
    swr_init(swr);
    t->swr_ctx = swr;
    #else
    t->swr_ctx = swr_alloc_set_opts(NULL,
        AV_CH_LAYOUT_STEREO, AV_SAMPLE_FMT_FLTP, 48000,
        AV_CH_LAYOUT_STEREO, t->a_dec_ctx->sample_fmt, t->a_dec_ctx->sample_rate, 0, NULL);
    swr_init(t->swr_ctx);
    #endif

    if (pthread_create(&t->thread, NULL, transcode_loop, t) != 0) {
        avformat_close_input(&t->ifmt_ctx);
        avcodec_free_context(&t->a_dec_ctx);
        avcodec_free_context(&t->a_enc_ctx);
        swr_free(&t->swr_ctx);
        free(t);
        return NULL;
    }
    return t;
}

// === LRU eviction ===
static void evict_lru_if_needed() {
    if (stream_count < MAX_STREAMS) return;
    int idx = -1; time_t oldest = time(NULL) + 1000;
    for (int i = 0; i < stream_count; i++) {
        if (stream_map[i].t && stream_map[i].t->last_access < oldest) {
            oldest = stream_map[i].t->last_access;
            idx = i;
        }
    }
    if (idx >= 0) {
        transcoder_t *t = stream_map[idx].t;
        for (int k = 0; k < MAX_SEGMENTS; k++) {
            if (t->segments[k].data) av_free(t->segments[k].data);
            if (t->segments[k].avio) avio_context_free(&t->segments[k].avio);
        }
        free(t);
        memmove(&stream_map[idx], &stream_map[idx+1], (--stream_count - idx) * sizeof(stream_entry_t));
    }
}

// === Akış bul veya oluştur ===
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
    evict_lru_if_needed();
    if (stream_count >= MAX_STREAMS) { pthread_mutex_unlock(&map_mutex); return NULL; }

    transcoder_t *t = start_transcoder(url);
    if (!t) { pthread_mutex_unlock(&map_mutex); return NULL; }

    stream_map[stream_count].hash = h;
    stream_map[stream_count].t = t;
    av_strlcpy(stream_map[stream_count].url, url, sizeof(stream_map[stream_count].url));
    stream_count++;
    pthread_mutex_unlock(&map_mutex);
    return t;
}

// === /m3u8 handler ===
static void m3u8_handler(struct evhttp_request *req, void *arg) {
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

    char m3u8[4096] = {0};
    strcat(m3u8, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n");

    pthread_mutex_lock(&t->mutex);
    int first_num = -1;
    for (int i = 0; i < MAX_SEGMENTS; i++) {
        if (t->segments[i].size > 0 && (first_num < 0 || t->segments[i].num < first_num)) {
            first_num = t->segments[i].num;
        }
    }
    if (first_num < 0) first_num = 0;
    char line[128];
    sprintf(line, "#EXT-X-MEDIA-SEQUENCE:%d\n", first_num);
    strcat(m3u8, line);

    for (int n = first_num; n < first_num + 100; n++) {
        for (int i = 0; i < MAX_SEGMENTS; i++) {
            if (t->segments[i].size > 0 && t->segments[i].num == n) {
                sprintf(line, "#EXTINF:1.0,\nseg_%03d.ts?h=%x\n", t->segments[i].num, hash_str(input_url));
                strcat(m3u8, line);
            }
        }
    }
    pthread_mutex_unlock(&t->mutex);

    struct evbuffer *buf = evbuffer_new();
    evbuffer_add_printf(buf, "%s", m3u8);
    evhttp_add_header(evhttp_request_get_output_headers(req), "Content-Type", "application/vnd.apple.mpegurl");
    evhttp_add_header(evhttp_request_get_output_headers(req), "Access-Control-Allow-Origin", "*");
    evhttp_send_reply(req, 200, "OK", buf);
    evbuffer_free(buf);
    evhttp_uri_free(decoded);
}

// === /seg_XXX.ts handler ===
static void segment_handler(struct evhttp_request *req, void *arg) {
    const char *uri = evhttp_request_get_uri(req);
    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    if (!decoded) { evhttp_send_error(req, 400, "Bad Request"); return; }
    const char *path = evhttp_uri_get_path(decoded);
    if (!path) { evhttp_send_error(req, 404, "Not Found"); evhttp_uri_free(decoded); return; }

    int num = -1;
    if (sscanf(path, "/seg_%d.ts", &num) != 1) { evhttp_send_error(req, 400, "Invalid segment"); evhttp_uri_free(decoded); return; }

    const char *query = evhttp_uri_get_query(decoded);
    const char *h_str = query ? strstr(query, "h=") : NULL;
    if (!h_str) { evhttp_send_error(req, 400, "h= required"); evhttp_uri_free(decoded); return; }
    unsigned int target_hash = (unsigned int)strtoul(h_str + 2, NULL, 16);

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
    if (!t) { evhttp_send_error(req, 404, "Stream not found"); evhttp_uri_free(decoded); return; }

    mem_segment_t *found = NULL;
    pthread_mutex_lock(&t->mutex);
    for (int i = 0; i < MAX_SEGMENTS; i++) {
        if (t->segments[i].num == num && t->segments[i].size > 0) {
            found = &t->segments[i];
            break;
        }
    }
    pthread_mutex_unlock(&t->mutex);
    if (!found) { evhttp_send_error(req, 404, "Segment not found"); evhttp_uri_free(decoded); return; }

    struct evbuffer *buf = evbuffer_new();
    evbuffer_add(buf, found->data, found->size);
    evhttp_add_header(evhttp_request_get_output_headers(req), "Content-Type", "video/MP2T");
    evhttp_add_header(evhttp_request_get_output_headers(req), "Access-Control-Allow-Origin", "*");
    evhttp_send_reply(req, 200, "OK", buf);
    evbuffer_free(buf);
    evhttp_uri_free(decoded);
}

// === Cleanup thread ===
static void* cleanup_thread(void *arg) {
    while (1) {
        sleep(30);
        time_t now = time(NULL);
        pthread_mutex_lock(&map_mutex);
        for (int i = 0; i < stream_count; i++) {
            if (!stream_map[i].t) continue;
            if (now - stream_map[i].t->last_access > STREAM_TIMEOUT_SEC) {
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

// === Ana fonksiyon ===
int main() {
    avformat_network_init();

    base = event_base_new();
    struct evhttp *http = evhttp_new(base);

    evhttp_set_allowed_methods(http, EVHTTP_REQ_GET);
    evhttp_set_max_headers_size(http, 8192);

    evhttp_set_cb(http, "/m3u8", m3u8_handler, NULL);
    evhttp_set_cb(http, "/seg_", segment_handler, NULL);

    if (evhttp_bind_socket(http, "0.0.0.0", PORT) < 0) {
        fprintf(stderr, "Bağlantı hatası\n");
        return 1;
    }

    pthread_t cleanup_tid;
    pthread_create(&cleanup_tid, NULL, cleanup_thread, NULL);

    printf("🚀 HTTP HLS Gateway hazır: http://localhost:%d/m3u8?q=ENCODED_URL\n", PORT);
    event_base_dispatch(base);

    evhttp_free(http);
    event_base_free(base);
    return 0;
}