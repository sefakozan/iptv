// multi_hls_gateway_http_only.c
// ✅ Sadece HTTP üzerinden hizmet veren, sadeleştirilmiş HLS gateway.
// ✅ Video (passthrough) ve ses (transcode) işler.
// ✅ Anlaşılırlığı artırmak için detaylı yorumlar eklenmiştir.

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


// --- Global Ayarlar ve Tanımlar ---
#define PORT 5001                     // Sunucunun çalışacağı port
#define MAX_STREAMS 256               // Eş zamanlı desteklenecek maksimum yayın sayısı
#define MAX_SEGMENTS 48               // Her yayın için bellekte tutulacak maksimum segment sayısı
#define IO_BUF_SIZE 65536             // FFmpeg I/O buffer boyutu
#define SEGMENT_PREALLOC (2 * 1024 * 1024) // Her segment için başlangıçta ayrılacak bellek (2MB)
#define STREAM_TIMEOUT_SEC 300        // Bir yayına hiç istek gelmezse ne kadar süre sonra sonlandırılacağı (saniye)

// Ortam değişkenleriyle (environment variables) değiştirilebilen global ayarlar
static int G_SEG_MS = 1000;   // Her bir .ts segmentinin milisaniye cinsinden süresi
static int G_AAC_BR = 96000;  // Ses için hedef bitrate (bits per second)
static int G_AAC_SR = 48000;  // Ses için hedef örnekleme oranı (sample rate)
static int G_AAC_CH = 2;      // Ses için hedef kanal sayısı (1: mono, 2: stereo)
static int G_WORKERS = 1;     // Çalışacak işçi (worker/process) sayısı

// Bellekte tutulan bir HLS segmentini temsil eden yapı
typedef struct {
    uint8_t *data;      // Segmentin binary verisi
    size_t size;        // Verinin mevcut boyutu
    size_t cap;         // Veri için ayrılmış toplam kapasite
    int num;            // Segmentin sıralı numarası (örn: seg_001.ts -> num=1)
    AVIOContext *avio;  // FFmpeg'in belleğe yazmak için kullandığı I/O context'i
    uint8_t *avio_buf;  // AVIO context'i için tampon bellek
} mem_segment_t;

// Her bir canlı yayın için tüm durumu (state) yöneten ana yapı
typedef struct {
    char input_url[512];        // Gelen kaynak yayının URL'si
    int video_stream_index;     // Kaynaktaki video akışının indeksi
    int audio_stream_index;     // Kaynaktaki ses akışının indeksi

    // FFmpeg context'leri
    AVFormatContext *ifmt_ctx;  // Giriş (Input) format context'i
    AVCodecContext  *a_dec_ctx; // Ses decoder context'i
    AVCodecContext  *a_enc_ctx; // Ses encoder context'i (AAC)
    SwrContext      *swr_ctx;   // Ses yeniden örnekleme (resample) context'i
    AVAudioFifo     *fifo;      // Ham ses verisi için FIFO (First-In-First-Out) buffer'ı

    AVFormatContext *ofmt_ctx;  // Çıkış (Output) format context'i (MPEG-TS)
    AVBSFContext    *v_bsf;     // Video bitstream filtresi (örn: h264_mp4toannexb)

    // Segment yönetimi
    mem_segment_t segments[MAX_SEGMENTS]; // Segmentler için ring buffer
    int seg_head;               // Bir sonraki yazılacak segmentin numarası
    int active_seg_index;       // Şu an yazılmakta olan segmentin `segments` dizisindeki indeksi
    int64_t seg_start_time_ms;  // Mevcut segmentin başladığı zaman

    // Zaman damgası (timestamp) yönetimi
    int64_t a_next_pts;         // Bir sonraki ses paketinin PTS (Presentation Timestamp) değeri
    int64_t video_pts_base;     // Her segment için video PTS'ini sıfırlamak için temel değer
    int64_t audio_pts_base;     // Her segment için ses PTS'ini sıfırlamak için temel değer

    // Thread ve senkronizasyon
    pthread_mutex_t mutex;      // Bu yapıya erişimi senkronize etmek için mutex
    pthread_t thread;           // Transcoding işlemini yapan iş parçacığı (thread)

    time_t last_access;         // Bu yayına en son ne zaman istek geldiği (timeout için)
} transcoder_t;

// URL hash'ine göre transcoder'ları tutan harita yapısı
typedef struct {
    unsigned int hash;
    transcoder_t *t;
    char url[512];
} stream_entry_t;

static stream_entry_t stream_map[MAX_STREAMS];
static int stream_count = 0;
static pthread_mutex_t map_mutex = PTHREAD_MUTEX_INITIALIZER;
static struct event_base *base; // libevent için ana event base


// --- YARDIMCI FONKSİYONLAR ---

// Ortam değişkeninden integer değer okuyan güvenli fonksiyon
static int getenv_int(const char *k, int defv) {
    const char *v = getenv(k);
    if (!v || !*v) return defv;
    char *e = NULL;
    long x = strtol(v, &e, 10);
    if (e == v || *e != '\0' || x < INT_MIN || x > INT_MAX) return defv;
    return (int)x;
}

// URL-encoded bir string'i çözer (örn: %2F -> /)
static void url_decode(char *dst, const char *src) { /* ... implementasyon ... */ }

// String için basit bir hash değeri üretir
static unsigned int hash_str(const char *s) { /* ... implementasyon ... */ }

// FFmpeg hata kodlarını okunabilir string'e çevirir ve loglar
static inline void log_averr(const char *what, int err) { /* ... implementasyon ... */ }


// --- FFmpeg İŞLEMLERİ ---

// FFmpeg'in veriyi doğrudan bellekteki segment'e yazmasını sağlayan callback
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

// Yeni bir .ts segmenti için FFmpeg muxer'ını açar ve ayarlar
static int open_segment_muxer(transcoder_t *t, mem_segment_t *seg) { /* ... implementasyon ... */ }

// Aktif segment muxer'ını düzgün bir şekilde kapatır
static void close_segment_muxer(transcoder_t *t) { /* ... implementasyon ... */ }

// Eski segmenti kapatıp yenisini başlatan ana fonksiyon
static int start_new_segment(transcoder_t *t) { /* ... implementasyon ... */ }

// Sesi decode->resample->encode boru hattından geçirip muxer'a gönderir
static int push_and_encode_audio(transcoder_t *t, AVFrame *in_frame) { /* ... implementasyon ... */ }

// Her bir yayın için ayrı bir thread'de çalışan ana transcode döngüsü
static void* transcode_loop(void *arg) { /* ... implementasyon (video/audio paketlerini okur, işler ve yazar) ... */ }

// Ses için decoder, resampler ve encoder'ı açar ve ayarlar
static int open_audio_codec(transcoder_t *t, enum AVCodecID dec_id, AVCodecParameters *apar) { /* ... implementasyon ... */ }


// --- TRANSCODER YÖNETİMİ ---

// Gelen URL için bir transcoder başlatır
static transcoder_t* start_transcoder(const char *url) { /* ... implementasyon ... */ }

// Lazımsa en eski yayını sonlandırır
static void evict_lru_if_needed() { /* ... implementasyon ... */ }

// Gelen URL'ye göre mevcut transcoder'ı bulur veya yenisini oluşturur
static transcoder_t* get_or_create_transcoder(const char *url) { /* ... implementasyon ... */ }


// --- HTTP HANDLER'LARI (libevent) ---

// .m3u8 playlist dosyasını oluşturan ve gönderen handler
static void m3u8_handler(struct evhttp_request *req) { /* ... implementasyon ... */ }

// İstenen .ts segmentini bellekten bulup gönderen handler
static void segment_handler(struct evhttp_request *req) { /* ... implementasyon ... */ }

// Gelen isteğin yoluna göre doğru handler'a yönlendiren ana handler
static void generic_handler(struct evhttp_request *req, void *arg) {
    const char *uri = evhttp_request_get_uri(req);
    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    if (!decoded) { evhttp_send_error(req, 400, "Bad Request"); return; }

    const char *path = evhttp_uri_get_path(decoded);
    if (!path) { evhttp_send_error(req, 404, "Not Found"); evhttp_uri_free(decoded); return; }

    fprintf(stderr, "[HTTP] Gelen istek yolu: %s\n", path);

    // Sağlık kontrolü endpoint'i
    if (strcmp(path, "/health") == 0) {
        struct evbuffer *buf = evbuffer_new();
        evbuffer_add_printf(buf, "ok");
        evhttp_add_header(evhttp_request_get_output_headers(req), "Content-Type", "text/plain");
        evhttp_send_reply(req, 200, "OK", buf);
        evbuffer_free(buf);
        evhttp_uri_free(decoded);
        return;
    }

    // Playlist ve segment isteklerini ilgili fonksiyonlara yönlendir
    if (strcmp(path, "/m3u8") == 0) { m3u8_handler(req); }
    else if (strncmp(path, "/seg_", 5) == 0) { segment_handler(req); }
    else { evhttp_send_error(req, 404, "Not Found"); }

    evhttp_uri_free(decoded);
}


// --- SUNUCU YÖNETİMİ ---

// Zaman aşımına uğrayan yayınları temizleyen periyodik thread
static void* cleanup_thread(void *arg) { /* ... implementasyon ... */ }

// Bir işçi (worker) prosesinin ana döngüsü
static int run_one_worker(void) {
    // libevent için temel olay döngüsünü oluştur
    base = event_base_new();
    if (!base) {
        fprintf(stderr, "event_base_new() basarisiz.\n");
        return 1;
    }

    // Yeni bir HTTP sunucusu oluştur
    struct evhttp *http = evhttp_new(base);
    if (!http) {
        fprintf(stderr, "evhttp_new() basarisiz.\n");
        return 1;
    }

    // Sadece GET ve HEAD metotlarına izin ver
    evhttp_set_allowed_methods(http, EVHTTP_REQ_GET | EVHTTP_REQ_HEAD);
    // Maksimum header boyutunu ayarla
    evhttp_set_max_headers_size(http, 8192);

    // HTTP sunucusunu belirtilen port ve adreste dinlemeye başla
    // 0.0.0.0: tüm ağ arayüzlerinden gelen bağlantıları kabul et demek
    if (evhttp_bind_socket(http, "0.0.0.0", PORT) != 0) {
        fprintf(stderr, "evhttp_bind_socket hatasi: %s\n", strerror(errno));
        return 1;
    }

    // Gelen tüm istekler için genel handler fonksiyonunu ayarla
    evhttp_set_gencb(http, generic_handler, NULL);

    // Zaman aşımı kontrolü için temizlik thread'ini başlat
    pthread_t cleanup_tid;
    pthread_create(&cleanup_tid, NULL, cleanup_thread, NULL);
    
    // Worker'ın hazır olduğunu bildir
    printf("Worker (PID %d) hazir: http://localhost:%d (SEG_MS=%d, AAC=%dk@%dHz/%s)\n",
           getpid(), PORT, G_SEG_MS, G_AAC_BR / 1000, G_AAC_SR, G_AAC_CH == 1 ? "mono" : "stereo");

    // libevent olay döngüsünü başlat (bu fonksiyon program sonlanana kadar dönmez)
    event_base_dispatch(base);

    // Program sonlandığında kaynakları serbest bırak
    evhttp_free(http);
    event_base_free(base);

    return 0;
}

// --- ANA FONKSİYON ---
int main() {
    // Ortam değişkenlerinden ayarları oku, yoksa varsayılanları kullan
    G_SEG_MS = getenv_int("SEG_MS", 1000);
    G_AAC_BR = getenv_int("AAC_BR", 96000);
    G_AAC_SR = getenv_int("AAC_SR", 48000);
    G_AAC_CH = getenv_int("AAC_CH", 2);
    G_WORKERS = getenv_int("WORKERS", 1);

    // FFmpeg için ağ kütüphanesini başlat
    avformat_network_init();

    // Eğer sadece bir işçi isteniyorsa, fork yapmadan doğrudan çalıştır
    if (G_WORKERS <= 1) {
        return run_one_worker();
    }

    // Birden fazla işçi isteniyorsa, her biri için yeni bir proses oluştur (fork)
    printf("%d adet isci (worker) olusturuluyor...\n", G_WORKERS);
    for (int i = 0; i < G_WORKERS; i++) {
        pid_t pid = fork();
        if (pid == 0) {
            // Bu blok sadece child (çocuk) proses tarafından çalıştırılır
            return run_one_worker();
        } else if (pid < 0) {
            // Fork hatası
            perror("fork");
            return 1;
        }
    }

    // Ana proses, çocuk proseslerin sonlanmasını bekler
    while (1) {
        pause(); // Sinyal gelene kadar bekle
    }

    return 0;
}