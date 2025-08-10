// multi_hls_gateway_final.c
// ✅ Üretim seviyesi, çoklu işçi, ENV destekli, derlenebilir HLS gateway

#include <event2/event.h>
#include <event2/http.h>
#include <event2/http_struct.h>
#include <event2/buffer.h>
#include <event2/keyvalq_struct.h>
#include <event2/bufferevent_ssl.h>
#include <openssl/ssl.h>
#include <openssl/err.h>

#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavutil/opt.h>
#include <libavutil/avstring.h>
#include <libavutil/channel_layout.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/time.h>
#include <libswresample/swresample.h>

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

#ifndef MAX
#define MAX(a,b) ((a)>(b)?(a):(b))
#endif

#define PORT 5001
#define MAX_STREAMS 256
#define MAX_SEGMENTS 24
#define IO_BUF_SIZE 65536
#define SEGMENT_PREALLOC (2 * 1024 * 1024)
#define STREAM_TIMEOUT_SEC 300

static int G_SEG_MS = 1000;
static int G_AAC_BR = 96000;
static int G_AAC_SR = 48000;
static int G_AAC_CH = 2;
static int G_WORKERS = 1;
static int G_USE_TLS = 0;

typedef struct {
    uint8_t *data;
    size_t size;
    size_t cap;
    int num;
    AVIOContext *avio;
    uint8_t *avio_buf;
} mem_segment_t;

typedef struct {
    char input_url[512];
    int video_stream_index;
    int audio_stream_index;

    AVFormatContext *ifmt_ctx;
    AVCodecContext  *a_dec_ctx;
    AVCodecContext  *a_enc_ctx;
    SwrContext      *swr_ctx;
    AVAudioFifo     *fifo;

    AVFormatContext *ofmt_ctx;
    int active_seg_index;
    int64_t seg_start_time_ms;
    int64_t a_next_pts;
    AVBSFContext   *v_bsf;

    mem_segment_t segments[MAX_SEGMENTS];
    int seg_head;

    pthread_mutex_t mutex;
    pthread_t thread;

    time_t last_access;
    int64_t video_pts_base;
    int64_t audio_pts_base;
    int segment_initialized;
} transcoder_t;

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

static int getenv_int(const char *k, int defv) {
    const char *v = getenv(k);
    if (!v || !*v) return defv;
    char *e = NULL;
    long x = strtol(v, &e, 10);
    if (e == v || *e != '\0') return defv;
    if (x < INT_MIN || x > INT_MAX) return defv;
    return (int)x;
}

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

static unsigned int hash_str(const char *s) {
    unsigned int h = 5381;
    unsigned char c;
    while ((c = (unsigned char)*s++) != 0) h = ((h << 5) + h) + c;
    return h;
}

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

static inline void log_averr(const char *what, int err) {
    if (err >= 0) return;
    char msg[256];
    av_strerror(err, msg, sizeof(msg));
    fprintf(stderr, "[gateway][fferr] %s: (%d) %s\n", what, err, msg);
}

static int open_segment_muxer(transcoder_t *t, mem_segment_t *seg) {
    int ret = avformat_alloc_output_context2(&t->ofmt_ctx, NULL, "mpegts", NULL);
    if (ret < 0 || !t->ofmt_ctx) return AVERROR_UNKNOWN;

    // MPEG-TS özel ayarlar
    av_opt_set(t->ofmt_ctx->priv_data, "mpegts_flags", "resend_headers+initial_discontinuity", 0);
    av_opt_set(t->ofmt_ctx->priv_data, "flush_packets", "1", 0);
    // Önemli: Bu ayarlar olmadan paketler yazılmayabilir
    av_opt_set(t->ofmt_ctx->priv_data, "mpegts_copyts", "1", 0);

    AVStream *vst = avformat_new_stream(t->ofmt_ctx, NULL);
    if (!vst) return AVERROR(ENOMEM);
    
    if (t->v_bsf && t->v_bsf->par_out && t->v_bsf->par_out->codec_id == AV_CODEC_ID_H264) {
        if ((ret = avcodec_parameters_copy(vst->codecpar, t->v_bsf->par_out)) < 0) return ret;
    } else {
        if ((ret = avcodec_parameters_copy(vst->codecpar, t->ifmt_ctx->streams[t->video_stream_index]->codecpar)) < 0) return ret;
    }
    
    vst->time_base = (AVRational){1, 90000};
    vst->codecpar->codec_tag = 0;

    AVStream *ast = avformat_new_stream(t->ofmt_ctx, NULL);
    if (!ast) return AVERROR(ENOMEM);
    
    if ((ret = avcodec_parameters_from_context(ast->codecpar, t->a_enc_ctx)) < 0) return ret;
    ast->codecpar->codec_tag = 0;
    ast->time_base = (AVRational){1, t->a_enc_ctx->sample_rate};

    seg->size = 0;
    if (!seg->avio_buf) seg->avio_buf = (uint8_t*)av_malloc(IO_BUF_SIZE);
    if (!seg->avio_buf) return AVERROR(ENOMEM);
    seg->avio = avio_alloc_context(seg->avio_buf, IO_BUF_SIZE, 1, seg, NULL, seg_write_cb, NULL);
    if (!seg->avio) return AVERROR(ENOMEM);
    t->ofmt_ctx->pb = seg->avio;
    t->ofmt_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;

    // Header yazmadan önce segmenti başlat
    t->segment_initialized = 0;
    
    if ((ret = avformat_write_header(t->ofmt_ctx, NULL)) < 0) {
        log_averr("avformat_write_header", ret);
        return ret;
    }
    
    // Header'ı hemen flush et
    if (t->ofmt_ctx->pb) {
        avio_flush(t->ofmt_ctx->pb);
    }
    
    t->segment_initialized = 1;
    fprintf(stderr, "[gateway] segment %d started (size=%zu)\n", seg->num, seg->size);
    return 0;
}

static void close_segment_muxer(transcoder_t *t) {
    if (!t->ofmt_ctx) return;
    
    // Tüm paketleri flush et
    if (t->ofmt_ctx->pb) {
        av_write_trailer(t->ofmt_ctx);
        avio_flush(t->ofmt_ctx->pb);
    }
    
    if (t->ofmt_ctx->pb) {
        AVIOContext *pb = t->ofmt_ctx->pb;
        t->ofmt_ctx->pb = NULL;
        avio_context_free(&pb);
        if (t->active_seg_index >= 0 && t->active_seg_index < MAX_SEGMENTS) {
            mem_segment_t *cur = &t->segments[t->active_seg_index];
            cur->avio = NULL;
            cur->avio_buf = NULL;
        }
    }
    avformat_free_context(t->ofmt_ctx);
    t->ofmt_ctx = NULL;
    t->segment_initialized = 0;
}

static int start_new_segment(transcoder_t *t) {
    pthread_mutex_lock(&t->mutex);
    if (t->active_seg_index >= 0 && t->ofmt_ctx) close_segment_muxer(t);

    int idx = t->seg_head % MAX_SEGMENTS;
    mem_segment_t *seg = &t->segments[idx];

    if (seg->data) { av_free(seg->data); seg->data = NULL; seg->size = 0; seg->cap = 0; }
    if (seg->avio) { avio_context_free(&seg->avio); seg->avio = NULL; }
    seg->avio_buf = NULL;
    seg->num = t->seg_head;

    int ret = open_segment_muxer(t, seg);
    if (ret == 0) {
        t->active_seg_index = idx;
        t->seg_start_time_ms = av_gettime_relative() / 1000;
        t->seg_head++;
        t->video_pts_base = 0;
        t->audio_pts_base = 0;
        fprintf(stderr, "[gateway] active segment index=%d num=%d size=%zu\n", idx, seg->num, seg->size);
    }
    pthread_mutex_unlock(&t->mutex);
    return ret;
}

static int push_and_encode_audio(transcoder_t *t, AVFrame *in_frame) {
    int ret = 0;
    AVFrame *cfrm = NULL;

    if (in_frame) {
        if (t->swr_ctx) {
            cfrm = av_frame_alloc();
            if (!cfrm) return AVERROR(ENOMEM);
            cfrm->channel_layout = t->a_enc_ctx->channel_layout;
            cfrm->channels = t->a_enc_ctx->channels;
            cfrm->format = t->a_enc_ctx->sample_fmt;
            cfrm->sample_rate = t->a_enc_ctx->sample_rate;
            cfrm->nb_samples = in_frame->nb_samples;
            if ((ret = av_frame_get_buffer(cfrm, 0)) < 0) goto done;
            if ((ret = swr_convert_frame(t->swr_ctx, cfrm, in_frame)) < 0) goto done;

            if ((ret = av_audio_fifo_realloc(t->fifo, av_audio_fifo_size(t->fifo) + cfrm->nb_samples)) < 0) goto done;
            if ((ret = av_audio_fifo_write(t->fifo, (void**)cfrm->data, cfrm->nb_samples)) < cfrm->nb_samples) { ret = AVERROR_UNKNOWN; goto done; }
        } else {
            if ((ret = av_audio_fifo_realloc(t->fifo, av_audio_fifo_size(t->fifo) + in_frame->nb_samples)) < 0) goto done;
            if ((ret = av_audio_fifo_write(t->fifo, (void**)in_frame->data, in_frame->nb_samples)) < in_frame->nb_samples) { ret = AVERROR_UNKNOWN; goto done; }
        }
    }

    AVPacket *pkt = av_packet_alloc();
    AVFrame *efr = av_frame_alloc();
    if (!pkt || !efr) { ret = AVERROR(ENOMEM); goto done2; }

    while (av_audio_fifo_size(t->fifo) >= t->a_enc_ctx->frame_size || (!in_frame && av_audio_fifo_size(t->fifo) > 0)) {
        if (av_audio_fifo_size(t->fifo) < t->a_enc_ctx->frame_size && !in_frame) {
            // Flush için frame boyutunu ayarla
            efr->nb_samples = av_audio_fifo_size(t->fifo);
        } else {
            efr->nb_samples = t->a_enc_ctx->frame_size;
        }
        
        efr->channel_layout = t->a_enc_ctx->channel_layout;
        efr->channels = t->a_enc_ctx->channels;
        efr->format = t->a_enc_ctx->sample_fmt;
        efr->sample_rate = t->a_enc_ctx->sample_rate;
        if ((ret = av_frame_get_buffer(efr, 0)) < 0) break;

        ret = av_audio_fifo_read(t->fifo, (void**)efr->data, efr->nb_samples);
        if (ret < efr->nb_samples && in_frame) { ret = AVERROR_UNKNOWN; break; }

        efr->pts = t->a_next_pts;
        t->a_next_pts += efr->nb_samples;

        if ((ret = avcodec_send_frame(t->a_enc_ctx, efr)) < 0) break;
        while ((ret = avcodec_receive_packet(t->a_enc_ctx, pkt)) == 0) {
            AVStream *out_ast = t->ofmt_ctx ? t->ofmt_ctx->streams[1] : NULL;
            if (out_ast) {
                av_packet_rescale_ts(pkt, t->a_enc_ctx->time_base, out_ast->time_base);
                // PTS/DTS ayarlamaları
                if (pkt->pts != AV_NOPTS_VALUE) {
                    pkt->pts += t->audio_pts_base;
                }
                if (pkt->dts != AV_NOPTS_VALUE) {
                    pkt->dts += t->audio_pts_base;
                }
            }
            pkt->stream_index = 1;
            
            pthread_mutex_lock(&t->mutex);
            if (t->ofmt_ctx && t->segment_initialized) {
                size_t before = t->segments[t->active_seg_index].size;
                int wret = av_interleaved_write_frame(t->ofmt_ctx, pkt);
                if (wret < 0) {
                    log_averr("write audio packet", wret);
                } else {
                    size_t after = t->segments[t->active_seg_index].size;
                    if (after > before) {
                        // Başarılı yazma, base'i güncelle
                        if (pkt->pts != AV_NOPTS_VALUE && pkt->duration > 0) {
                            t->audio_pts_base = pkt->pts + pkt->duration;
                        }
                    }
                }
                // Her paketten sonra flush
                avio_flush(t->ofmt_ctx->pb);
            }
            pthread_mutex_unlock(&t->mutex);
            av_packet_unref(pkt);
        }
        av_frame_unref(efr);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) ret = 0;
        if (!in_frame) break; // Flush modunda sadece bir kere
    }

done2:
    if (pkt) av_packet_free(&pkt);
    if (efr) av_frame_free(&efr);
done:
    if (cfrm) av_frame_free(&cfrm);
    return ret;
}

static void* transcode_loop(void *arg) {
    transcoder_t *t = (transcoder_t*)arg;
    AVPacket *pkt = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    if (!pkt || !frame) return NULL;

    int64_t last_seg_ms = 0;
    int pending_cut = 0;
    int waiting_for_keyframe = 1;
    int64_t video_frame_count = 0;
    
    while (av_read_frame(t->ifmt_ctx, pkt) >= 0) {
        int64_t now_ms = av_gettime_relative() / 1000;
        if (!waiting_for_keyframe && !pending_cut && (now_ms - last_seg_ms) >= G_SEG_MS) pending_cut = 1;

        if (pkt->stream_index == t->video_stream_index) {
            AVStream *in_st = t->ifmt_ctx->streams[pkt->stream_index];
            int is_key = 0;
            AVPacket *out_pkt = NULL;
            
            if (t->v_bsf) {
                if (av_bsf_send_packet(t->v_bsf, pkt) == 0) {
                    out_pkt = av_packet_alloc();
                    while (av_bsf_receive_packet(t->v_bsf, out_pkt) == 0) {
                        is_key = (out_pkt->flags & AV_PKT_FLAG_KEY);
                        
                        if (waiting_for_keyframe && is_key) {
                            if (start_new_segment(t) == 0) {
                                last_seg_ms = t->seg_start_time_ms;
                                waiting_for_keyframe = 0;
                                video_frame_count = 0;
                            }
                        }
                        
                        if (!waiting_for_keyframe && pending_cut && is_key) {
                            // Önceki segmenti kapat
                            pthread_mutex_lock(&t->mutex);
                            close_segment_muxer(t);
                            pthread_mutex_unlock(&t->mutex);
                            
                            // Yeni segment başlat
                            if (start_new_segment(t) == 0) {
                                last_seg_ms = t->seg_start_time_ms;
                                pending_cut = 0;
                                video_frame_count = 0;
                            }
                        }
                        
                        if (!waiting_for_keyframe && t->ofmt_ctx && t->segment_initialized) {
                            // Video zaman damgası ayarlamaları
                            if (out_pkt->pts != AV_NOPTS_VALUE) {
                                out_pkt->pts += t->video_pts_base;
                            }
                            if (out_pkt->dts != AV_NOPTS_VALUE) {
                                out_pkt->dts += t->video_pts_base;
                            }
                            
                            av_packet_rescale_ts(out_pkt, in_st->time_base, t->ofmt_ctx->streams[0]->time_base);
                            out_pkt->stream_index = 0;
                            
                            pthread_mutex_lock(&t->mutex);
                            size_t before = t->segments[t->active_seg_index].size;
                            int wret = av_interleaved_write_frame(t->ofmt_ctx, out_pkt);
                            if (wret < 0) {
                                log_averr("write video packet", wret);
                            } else {
                                size_t after = t->segments[t->active_seg_index].size;
                                if (after > before) {
                                    // Başarılı yazma, base'i güncelle
                                    if (out_pkt->pts != AV_NOPTS_VALUE && out_pkt->duration > 0) {
                                        t->video_pts_base = out_pkt->pts + out_pkt->duration;
                                    }
                                    video_frame_count++;
                                }
                            }
                            // Her paketten sonra flush
                            avio_flush(t->ofmt_ctx->pb);
                            pthread_mutex_unlock(&t->mutex);
                        }
                        av_packet_unref(out_pkt);
                    }
                    if (out_pkt) av_packet_free(&out_pkt);
                }
            } else {
                is_key = (pkt->flags & AV_PKT_FLAG_KEY);
                
                if (waiting_for_keyframe && is_key) {
                    if (start_new_segment(t) == 0) {
                        last_seg_ms = t->seg_start_time_ms;
                        waiting_for_keyframe = 0;
                        video_frame_count = 0;
                    }
                }
                
                if (!waiting_for_keyframe && pending_cut && is_key) {
                    // Önceki segmenti kapat
                    pthread_mutex_lock(&t->mutex);
                    close_segment_muxer(t);
                    pthread_mutex_unlock(&t->mutex);
                    
                    // Yeni segment başlat
                    if (start_new_segment(t) == 0) {
                        last_seg_ms = t->seg_start_time_ms;
                        pending_cut = 0;
                        video_frame_count = 0;
                    }
                }
                
                if (!waiting_for_keyframe && t->ofmt_ctx && t->segment_initialized) {
                    // Video zaman damgası ayarlamaları
                    if (pkt->pts != AV_NOPTS_VALUE) {
                        pkt->pts += t->video_pts_base;
                    }
                    if (pkt->dts != AV_NOPTS_VALUE) {
                        pkt->dts += t->video_pts_base;
                    }
                    
                    av_packet_rescale_ts(pkt, in_st->time_base, t->ofmt_ctx->streams[0]->time_base);
                    pkt->stream_index = 0;
                    
                    pthread_mutex_lock(&t->mutex);
                    size_t before = t->segments[t->active_seg_index].size;
                    int wret = av_interleaved_write_frame(t->ofmt_ctx, pkt);
                    if (wret < 0) {
                        log_averr("write video packet (no bsf)", wret);
                    } else {
                        size_t after = t->segments[t->active_seg_index].size;
                        if (after > before) {
                            // Başarılı yazma, base'i güncelle
                            if (pkt->pts != AV_NOPTS_VALUE && pkt->duration > 0) {
                                t->video_pts_base = pkt->pts + pkt->duration;
                            }
                            video_frame_count++;
                        }
                    }
                    // Her paketten sonra flush
                    avio_flush(t->ofmt_ctx->pb);
                    pthread_mutex_unlock(&t->mutex);
                }
            }
        } else if (pkt->stream_index == t->audio_stream_index) {
            if (!waiting_for_keyframe) {
                if (avcodec_send_packet(t->a_dec_ctx, pkt) == 0) {
                    while (avcodec_receive_frame(t->a_dec_ctx, frame) == 0) {
                        push_and_encode_audio(t, frame);
                        av_frame_unref(frame);
                    }
                }
            }
        }
        av_packet_unref(pkt);
        t->last_access = time(NULL);
    }

    // Flush işlemleri
    avcodec_send_packet(t->a_dec_ctx, NULL);
    while (avcodec_receive_frame(t->a_dec_ctx, frame) == 0) {
        push_and_encode_audio(t, frame);
        av_frame_unref(frame);
    }
    push_and_encode_audio(t, NULL);
    
    avcodec_send_frame(t->a_enc_ctx, NULL);
    AVPacket *fp = av_packet_alloc();
    while (avcodec_receive_packet(t->a_enc_ctx, fp) == 0) {
        AVStream *out_ast = t->ofmt_ctx ? t->ofmt_ctx->streams[1] : NULL;
        if (out_ast) {
            av_packet_rescale_ts(fp, t->a_enc_ctx->time_base, out_ast->time_base);
        }
        fp->stream_index = 1;
        pthread_mutex_lock(&t->mutex);
        if (t->ofmt_ctx && t->segment_initialized) {
            av_interleaved_write_frame(t->ofmt_ctx, fp);
            avio_flush(t->ofmt_ctx->pb);
        }
        pthread_mutex_unlock(&t->mutex);
        av_packet_unref(fp);
    }
    if (fp) av_packet_free(&fp);

    // Son segmenti kapat
    pthread_mutex_lock(&t->mutex);
    close_segment_muxer(t);
    pthread_mutex_unlock(&t->mutex);

    if (pkt) av_packet_free(&pkt);
    if (frame) av_frame_free(&frame);

    if (t->ifmt_ctx) avformat_close_input(&t->ifmt_ctx);
    if (t->a_dec_ctx) avcodec_free_context(&t->a_dec_ctx);
    if (t->a_enc_ctx) avcodec_free_context(&t->a_enc_ctx);
    if (t->v_bsf) av_bsf_free(&t->v_bsf);
    if (t->swr_ctx) swr_free(&t->swr_ctx);
    if (t->fifo) av_audio_fifo_free(t->fifo);

    return NULL;
}

static int open_audio_codec(transcoder_t *t, enum AVCodecID dec_id, AVCodecParameters *apar) {
    const AVCodec *dec = avcodec_find_decoder(dec_id);
    if (!dec) return -1;
    t->a_dec_ctx = avcodec_alloc_context3(dec);
    if (!t->a_dec_ctx) return -1;
    if (avcodec_parameters_to_context(t->a_dec_ctx, apar) < 0) return -1;
    if (avcodec_open2(t->a_dec_ctx, dec, NULL) < 0) return -1;

    const AVCodec *enc = avcodec_find_encoder_by_name("libfdk_aac");
    if (!enc) enc = avcodec_find_encoder(AV_CODEC_ID_AAC);

    t->a_enc_ctx = avcodec_alloc_context3(enc);
    if (!t->a_enc_ctx) return -1;

    int out_sr = G_AAC_SR;
    int out_ch = (G_AAC_CH <= 1) ? 1 : 2;
    int64_t out_layout = (out_ch == 1) ? AV_CH_LAYOUT_MONO : AV_CH_LAYOUT_STEREO;

    t->a_enc_ctx->sample_rate = out_sr;
    t->a_enc_ctx->channel_layout = out_layout;
    t->a_enc_ctx->channels = out_ch;
    t->a_enc_ctx->bit_rate = G_AAC_BR;
    t->a_enc_ctx->time_base = (AVRational){1, out_sr};
    t->a_enc_ctx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    if (enc && strcmp(enc->name, "libfdk_aac") == 0) {
        t->a_enc_ctx->sample_fmt = AV_SAMPLE_FMT_S16;
        av_opt_set(t->a_enc_ctx->priv_data, "profile", "aac_low", 0);
        av_opt_set(t->a_enc_ctx->priv_data, "afterburner", "0", 0);
    } else {
        t->a_enc_ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;
        av_opt_set(t->a_enc_ctx->priv_data, "profile", "aac_low", 0);
        av_opt_set(t->a_enc_ctx->priv_data, "cutoff", "18000", 0);
    }

    if (avcodec_open2(t->a_enc_ctx, enc, NULL) < 0) return -1;

    int in_rate = t->a_dec_ctx->sample_rate ? t->a_dec_ctx->sample_rate : out_sr;
    int in_ch = t->a_dec_ctx->channels ? t->a_dec_ctx->channels : 2;
    int64_t in_layout = t->a_dec_ctx->channel_layout ? t->a_dec_ctx->channel_layout : av_get_default_channel_layout(in_ch);
    enum AVSampleFormat in_fmt = t->a_dec_ctx->sample_fmt;

    int need_swr = 0;
    if (in_rate != out_sr) need_swr = 1;
    if ((in_layout != out_layout) || (in_ch != out_ch)) need_swr = 1;
    if (in_fmt != t->a_enc_ctx->sample_fmt) need_swr = 1;

    if (need_swr) {
        t->swr_ctx = swr_alloc_set_opts(NULL,
            out_layout, t->a_enc_ctx->sample_fmt, out_sr,
            in_layout,  in_fmt,                   in_rate, 0, NULL);
        if (!t->swr_ctx || swr_init(t->swr_ctx) < 0) return -1;
    } else {
        t->swr_ctx = NULL;
    }

    t->fifo = av_audio_fifo_alloc(t->a_enc_ctx->sample_fmt, out_ch, 1024);
    if (!t->fifo) return -1;

    return 0;
}

static transcoder_t* start_transcoder(const char *url) {
    transcoder_t *t = (transcoder_t*)calloc(1, sizeof(transcoder_t));
    if (!t) return NULL;

    av_strlcpy(t->input_url, url, sizeof(t->input_url));
    pthread_mutex_init(&t->mutex, NULL);
    t->active_seg_index = -1;
    t->a_next_pts = 0;
    t->last_access = time(NULL);
    t->video_pts_base = 0;
    t->audio_pts_base = 0;
    t->segment_initialized = 0;

    AVDictionary *opts = NULL;
    av_dict_set(&opts, "reconnect", "1", 0);
    av_dict_set(&opts, "reconnect_streamed", "1", 0);
    av_dict_set(&opts, "reconnect_on_network_error", "1", 0);
    av_dict_set(&opts, "rw_timeout", "15000000", 0);
    av_dict_set(&opts, "timeout", "15000000", 0);
    av_dict_set(&opts, "user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36", 0);

    int oret = avformat_open_input(&t->ifmt_ctx, url, NULL, &opts);
    if (oret < 0) {
        fprintf(stderr, "[gateway] avformat_open_input FAILED (%d) url=%s\n", oret, url);
        av_dict_free(&opts);
        free(t);
        return NULL;
    }
    av_dict_free(&opts);
    if (avformat_find_stream_info(t->ifmt_ctx, NULL) < 0) { 
        if (t->ifmt_ctx) avformat_close_input(&t->ifmt_ctx); 
        free(t); 
        return NULL; 
    }

    t->video_stream_index = av_find_best_stream(t->ifmt_ctx, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    t->audio_stream_index = -1;
    for (unsigned i = 0; i < t->ifmt_ctx->nb_streams; i++) {
        if (t->ifmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) { 
            t->audio_stream_index = (int)i; 
            break; 
        }
    }
    if (t->audio_stream_index < 0 || t->video_stream_index < 0) { 
        if (t->ifmt_ctx) avformat_close_input(&t->ifmt_ctx); 
        free(t); 
        return NULL; 
    }

    if (open_audio_codec(t, t->ifmt_ctx->streams[t->audio_stream_index]->codecpar->codec_id, t->ifmt_ctx->streams[t->audio_stream_index]->codecpar) < 0) {
        if (t->ifmt_ctx) avformat_close_input(&t->ifmt_ctx); 
        free(t); 
        return NULL;
    }

    t->v_bsf = NULL;
    enum AVCodecID v_id = t->ifmt_ctx->streams[t->video_stream_index]->codecpar->codec_id;
    const AVBitStreamFilter *f = NULL;
    if (v_id == AV_CODEC_ID_H264) {
        f = av_bsf_get_by_name("h264_mp4toannexb");
    } else if (v_id == AV_CODEC_ID_HEVC) {
        f = av_bsf_get_by_name("hevc_mp4toannexb");
    }
    if (f) {
        if (av_bsf_alloc(f, &t->v_bsf) == 0) {
            if (avcodec_parameters_copy(t->v_bsf->par_in, t->ifmt_ctx->streams[t->video_stream_index]->codecpar) < 0) { 
                av_bsf_free(&t->v_bsf); 
                t->v_bsf = NULL; 
            }
            t->v_bsf->time_base_in = t->ifmt_ctx->streams[t->video_stream_index]->time_base;
            if (av_bsf_init(t->v_bsf) < 0) { 
                av_bsf_free(&t->v_bsf); 
                t->v_bsf = NULL; 
            }
        }
    }

    if (pthread_create(&t->thread, NULL, transcode_loop, t) != 0) {
        if (t->ifmt_ctx) avformat_close_input(&t->ifmt_ctx);
        if (t->a_dec_ctx) avcodec_free_context(&t->a_dec_ctx);
        if (t->a_enc_ctx) avcodec_free_context(&t->a_enc_ctx);
        if (t->swr_ctx) swr_free(&t->swr_ctx);
        if (t->v_bsf) av_bsf_free(&t->v_bsf);
        if (t->fifo) av_audio_fifo_free(t->fifo);
        free(t);
        return NULL;
    }
    return t;
}

static void evict_lru_if_needed() {
    if (stream_count < MAX_STREAMS) return;
    int idx = -1;
    time_t oldest = LLONG_MAX;
    for (int i = 0; i < stream_count; i++) {
        if (stream_map[i].t && stream_map[i].t->last_access < oldest) {
            oldest = stream_map[i].t->last_access;
            idx = i;
        }
    }
    if (idx >= 0) {
        transcoder_t *t = stream_map[idx].t;
        for (int k = 0; k < MAX_SEGMENTS; k++) {
            if (t->segments[k].data) { 
                av_free(t->segments[k].data); 
                t->segments[k].data = NULL; 
                t->segments[k].size = 0; 
                t->segments[k].cap = 0; 
            }
            if (t->segments[k].avio) { 
                avio_context_free(&t->segments[k].avio); 
                t->segments[k].avio = NULL; 
            }
            t->segments[k].avio_buf = NULL;
        }
        free(t);
        memmove(&stream_map[idx], &stream_map[idx+1], (--stream_count - idx) * sizeof(stream_entry_t));
    }
}

static transcoder_t* get_or_create_transcoder(const char *url) {
    unsigned int h = hash_str(url);
    pthread_mutex_lock(&map_mutex);
    for (int i = 0; i < stream_count; i++) {
        if (stream_map[i].hash == h && strcmp(stream_map[i].url, url) == 0) {
            if (stream_map[i].t) stream_map[i].t->last_access = time(NULL);
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

static void m3u8_handler(struct evhttp_request *req) {
    const char *uri = evhttp_request_get_uri(req);
    fprintf(stderr, "[gateway] m3u8 request: %s\n", uri);
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
    fprintf(stderr, "[gateway] input_url: %s\n", input_url);

    transcoder_t *t = get_or_create_transcoder(input_url);
    if (!t) { evhttp_send_error(req, 500, "Cannot start transcoder"); evhttp_uri_free(decoded); return; }

    char m3u8[4096] = {0};
    int targetdur = (G_SEG_MS + 999) / 1000;
    sprintf(m3u8, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:%d\n", targetdur);

    pthread_mutex_lock(&t->mutex);
    int first_num = -1;
    for (int i = 0; i < MAX_SEGMENTS; i++) {
        if (t->segments[i].size > 0 && (first_num < 0 || t->segments[i].num < first_num)) {
            first_num = t->segments[i].num;
        }
    }
    if (first_num < 0) first_num = 0;
    char line[160];
    sprintf(line, "#EXT-X-MEDIA-SEQUENCE:%d\n", first_num);
    strcat(m3u8, line);

    // Sadece mevcut segmentleri listele
    int segment_count = 0;
    for (int n = first_num; n < first_num + MAX_SEGMENTS && segment_count < 10; n++) {
        for (int i = 0; i < MAX_SEGMENTS; i++) {
            if (t->segments[i].size > 0 && t->segments[i].num == n) {
                sprintf(line, "#EXTINF:%.3f,\nseg_%03d.ts?h=%x\n", (double)G_SEG_MS / 1000.0, t->segments[i].num, hash_str(input_url));
                strcat(m3u8, line);
                segment_count++;
                break;
            }
        }
    }
    pthread_mutex_unlock(&t->mutex);

    struct evbuffer *buf = evbuffer_new();
    evbuffer_add_printf(buf, "%s", m3u8);
    struct evkeyvalq *out = evhttp_request_get_output_headers(req);
    evhttp_add_header(out, "Content-Type", "application/vnd.apple.mpegurl");
    evhttp_add_header(out, "Access-Control-Allow-Origin", "*");
    evhttp_add_header(out, "Access-Control-Expose-Headers", "*");
    evhttp_send_reply(req, 200, "OK", buf);
    if (buf) evbuffer_free(buf);
    evhttp_uri_free(decoded);
}

static void segment_handler(struct evhttp_request *req) {
    const char *uri = evhttp_request_get_uri(req);
    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    if (!decoded) { evhttp_send_error(req, 400, "Bad Request"); return; }

    int num = -1;
    const char *path = evhttp_uri_get_path(decoded);
    if (!path || sscanf(path, "/seg_%d.ts", &num) != 1) { evhttp_send_error(req, 400, "Invalid segment"); evhttp_uri_free(decoded); return; }

    const char *query = evhttp_uri_get_query(decoded);
    const char *h_str = query ? strstr(query, "h=") : NULL;
    if (!h_str) { evhttp_send_error(req, 400, "h= required"); evhttp_uri_free(decoded); return; }
    unsigned int target_hash = (unsigned int)strtoul(h_str + 2, NULL, 16);

    transcoder_t *t = NULL;
    pthread_mutex_lock(&map_mutex);
    for (int i = 0; i < stream_count; i++) {
        if (stream_map[i].t && hash_str(stream_map[i].url) == target_hash) {
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

    struct evkeyvalq *out = evhttp_request_get_output_headers(req);
    evhttp_add_header(out, "Content-Type", "video/MP2T");
    evhttp_add_header(out, "Access-Control-Allow-Origin", "*");
    evhttp_add_header(out, "Access-Control-Expose-Headers", "*");

    if (evhttp_request_get_command(req) == EVHTTP_REQ_HEAD) {
        char cl[32];
        snprintf(cl, sizeof(cl), "%zu", found->size);
        evhttp_add_header(out, "Content-Length", cl);
        struct evbuffer *empty = evbuffer_new();
        evhttp_send_reply(req, 200, "OK", empty);
        if (empty) evbuffer_free(empty);
        evhttp_uri_free(decoded);
        return;
    }

    struct evbuffer *buf = evbuffer_new();
    evbuffer_add(buf, found->data, found->size);
    evhttp_send_reply(req, 200, "OK", buf);
    if (buf) evbuffer_free(buf);
    evhttp_uri_free(decoded);
}

static struct bufferevent* bevcb(struct event_base *base, void *arg) {
    SSL *ssl = SSL_new(g_ssl_ctx);
    return bufferevent_openssl_socket_new(base, -1, ssl, BUFFEREVENT_SSL_ACCEPTING, BEV_OPT_CLOSE_ON_FREE);
}

static void generic_handler(struct evhttp_request *req, void *arg) {
    const char *uri = evhttp_request_get_uri(req);
    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    if (!decoded) { evhttp_send_error(req, 400, "Bad Request"); return; }
    const char *path = evhttp_uri_get_path(decoded);
    if (!path) { evhttp_send_error(req, 404, "Not Found"); evhttp_uri_free(decoded); return; }
    fprintf(stderr, "[gateway] request path: %s\n", path);
    if (strcmp(path, "/health") == 0) {
        struct evbuffer *buf = evbuffer_new();
        evbuffer_add_printf(buf, "ok");
        struct evkeyvalq *out = evhttp_request_get_output_headers(req);
        evhttp_add_header(out, "Content-Type", "text/plain");
        evhttp_add_header(out, "Access-Control-Allow-Origin", "*");
        evhttp_send_reply(req, 200, "OK", buf);
        if (buf) evbuffer_free(buf);
        evhttp_uri_free(decoded);
        return;
    }
    if (strcmp(path, "/m3u8") == 0) { evhttp_uri_free(decoded); m3u8_handler(req); return; }
    if (strncmp(path, "/seg_", 5) == 0) { evhttp_uri_free(decoded); segment_handler(req); return; }
    evhttp_uri_free(decoded);
    evhttp_send_error(req, 404, "Not Found");
}

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
                    if (t->segments[k].data) { 
                        av_free(t->segments[k].data); 
                        t->segments[k].data = NULL; 
                        t->segments[k].size = 0; 
                        t->segments[k].cap = 0; 
                    }
                    if (t->segments[k].avio) { 
                        avio_context_free(&t->segments[k].avio); 
                        t->segments[k].avio = NULL; 
                    }
                    t->segments[k].avio_buf = NULL;
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

static int run_one_worker(void) {
    base = event_base_new();
    if (!base) return 1;
    struct evhttp *http = evhttp_new(base);

    if (G_USE_TLS) {
        g_ssl_ctx = SSL_CTX_new(TLS_server_method());
        if (!g_ssl_ctx || SSL_CTX_use_certificate_file(g_ssl_ctx, "cert.pem", SSL_FILETYPE_PEM) <= 0 ||
            SSL_CTX_use_PrivateKey_file(g_ssl_ctx, "key.pem", SSL_FILETYPE_PEM) <= 0) {
            fprintf(stderr, "Sertifika hatası. 'cert.pem' ve 'key.pem' oluşturun.\n");
            return 1;
        }
        evhttp_set_bevcb(http, bevcb, NULL);
    }
    evhttp_set_allowed_methods(http, EVHTTP_REQ_GET | EVHTTP_REQ_HEAD);
    evhttp_set_max_headers_size(http, 8192);

    if (evhttp_bind_socket(http, "0.0.0.0", PORT) != 0) {
        fprintf(stderr, "evhttp_bind_socket hatası: %s\n", strerror(errno));
        return 1;
    }

    evhttp_set_gencb(http, generic_handler, NULL);

    pthread_t cleanup_tid;
    pthread_create(&cleanup_tid, NULL, cleanup_thread, NULL);

    printf("Worker PID %d hazır: %s://localhost:%d (SEG_MS=%d, AAC=%dk@%dHz/%s)\n",
           getpid(), G_USE_TLS ? "https" : "http", PORT, G_SEG_MS, G_AAC_BR / 1000, G_AAC_SR, G_AAC_CH == 1 ? "mono" : "stereo");

    event_base_dispatch(base);

    evhttp_free(http);
    event_base_free(base);
    if (g_ssl_ctx) SSL_CTX_free(g_ssl_ctx);
    return 0;
}

int main() {
    G_SEG_MS = getenv_int("SEG_MS", 1000);
    if (G_SEG_MS < 200) G_SEG_MS = 200;
    if (G_SEG_MS > 2000) G_SEG_MS = 2000;
    G_AAC_BR = getenv_int("AAC_BR", 128000);
    G_AAC_SR = getenv_int("AAC_SR", 48000);
    if (G_AAC_SR != 44100 && G_AAC_SR != 48000) G_AAC_SR = 48000;
    G_AAC_CH = getenv_int("AAC_CH", 2);
    if (G_AAC_CH != 1 && G_AAC_CH != 2) G_AAC_CH = 2;
    G_WORKERS = getenv_int("WORKERS", 1);
    if (G_WORKERS < 1) G_WORKERS = 1;
    G_USE_TLS = getenv_int("USE_TLS", 1);

    avformat_network_init();
    SSL_load_error_strings();
    OpenSSL_add_ssl_algorithms();

    if (G_WORKERS == 1) {
        return run_one_worker();
    }

    for (int i = 0; i < G_WORKERS; i++) {
        pid_t pid = fork();
        if (pid == 0) {
            return run_one_worker();
        } else if (pid < 0) {
            perror("fork");
            return 1;
        }
    }

    while (1) pause();
    return 0;
}