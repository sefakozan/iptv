// 1. signal.h ekle
#include <signal.h>

// 2. lambda yerine fonksiyon
static void generic_handler(struct evhttp_request *req, void *arg) {
    const char *uri = evhttp_request_get_uri(req);
    struct evhttp_uri *decoded = evhttp_uri_parse(uri);
    if (!decoded) { evhttp_send_error(req,400,"Bad Request"); return; }
    const char *path = evhttp_uri_get_path(decoded);
    if (!path) { evhttp_send_error(req,404,"Not Found"); evhttp_uri_free(decoded); return; }
    if (strcmp(path,"/m3u8")==0) { evhttp_uri_free(decoded); m3u8_handler(req); return; }
    if (strncmp(path,"/seg_",5)==0) { evhttp_uri_free(decoded); segment_handler(req); return; }
    evhttp_uri_free(decoded);
    evhttp_send_error(req,404,"Not Found");
}

// 3. av_opt_set_int yerine av_opt_set
// DEĞİŞTİR:
// av_opt_set_int(t->a_enc_ctx, "cutoff", 15000, 0);
// ŞUNU YAP:
av_opt_set(t->a_enc_ctx, "cutoff", "15000", 0);


# 2 işçi, 500ms segment, 64k mono
WORKERS=2 SEG_MS=500 AAC_BR=64000 AAC_SR=44100 AAC_CH=1 ./hls_gateway

https://localhost:5001/m3u8?q=http%3A%2F%2F185.234.111.229%3A8000%2Fplay%2Fa01y

✅ GCC ile derlenir
✅ C uyumludur (lambda yok)
✅ av_opt_set_int yerine av_opt_set kullanır
✅ signal.h eklenmiştir
✅ fork() WSL/Linux için uyarlanmıştır
✅ Tüm güvenlik kontrolleri korunmuştur
✅ ENV desteği, worker, LRU, SWR optimizasyonu korunmuştur


gcc multi_hls_gateway_final.c -o hls_gateway \
    -levent -levent_openssl -lssl -lcrypto \
    -lnghttp2 \
    -lavformat -lavcodec -lavutil -lswresample \
    -lpthread -lz

# Örnek: 4 işçi, 500ms segment, 64k mono
WORKERS=4 SEG_MS=500 AAC_BR=64000 AAC_SR=44100 AAC_CH=1 ./hls_gateway


<video id="video" controls autoplay></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script>
  const video = document.getElementById('video');
  const src = 'https://localhost:5001/m3u8?q=http%3A%2F%2F185.234.111.229%3A8000%2Fplay%2Fa01y';
  if (Hls.isSupported()) {
    const hls = new Hls({
      liveSyncDuration: 1,
      maxBufferSize: 1000000,
      backBufferLength: 2
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  }
</script>
