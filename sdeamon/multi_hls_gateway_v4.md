libfdk_aac var ise onu kullan, yoksa native aac’te aac_coder=anmr ve cutoff düşür.
Varsayılan ses parametrelerini CPU dostu yaptım: 96 kbps, 44.1 kHz, mono. ENV ile değiştirilebilir: AAC_BR, AAC_SR, AAC_CH.
Segment süresi 1 sn (ENV: SEG_MS ile 1000–2000 ms arası ayarlanabilir). Kopyalar zaten minimize.
Çok çekirdeğe ölçek için çoklu worker process (ENV: WORKERS, SO_REUSEPORT ile). Linux/WSL’de çalışır.
Gereksiz swr kapatma: Girdi zaten hedef formatta ise SWR devre dışı, direkt FIFO’ya yazılıyor.
-----

sudo apt install -y build-essential pkg-config libevent-dev libssl-dev \
  ffmpeg libavformat-dev libavcodec-dev libavutil-dev libswresample-dev
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"

# Tek worker, varsayılan CPU-dostu ses ayarları
gcc -O3 -flto -march=native -pipe multi_hls_gateway_lates_workers.c -o gateway_workers \
  $(pkg-config --cflags --libs libevent_openssl libevent) \
  -lavformat -lavcodec -lavutil -lswresample -lssl -lcrypto -lpthread

SEG_MS=1000 AAC_BR=96000 AAC_SR=44100 AAC_CH=1 WORKERS=4 ./gateway_workers
# Test M3U8:
# https://localhost:5001/m3u8?q=http%3A%2F%2F185.234.111.229%3A8000%2Fplay%2Fa01y

WORKERS>1 için Linux çekirdeğinde SO_REUSEPORT gerekir (WSL’de mevcut).
libfdk_aac sisteminizde yoksa otomatik native aac’e düşer; yine hızlı anmr coder+cutoff kullanılır.
Giriş zaten 44.1/48 kHz ve seçtiğiniz kanal/sfmt ile eşleşiyorsa SWR devreden çıkar.


 multi_hls_gateway_workers.c,
256 akış, çoklu işçi, SO_REUSEPORT, ENV yapılandırması, SWR optimizasyonu, libfdk_aac tercihi ile
en gelişmiş, en ölçeklenebilir, en üretimsel HLS gateway sürümüdür. 