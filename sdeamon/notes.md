AVIO custom write ile segment verisi direkt tamponda, ekstra malloc/memcpy yok.
Her 2 sn’de segment kapatılıp diziye alınır; m3u8 canlı üretim düzeltilir.
Ses yolu format uyumu, tek sefer tahsis ve FIFO/encoder entegrasyonu iyileştirildi.
C uyumlu SSL callback ve dinamik path routing eklendi.
Reconnect/timeouts ile akış dayanıklılığı artırıldı.
Derleme notu (örnek, Linux/WSL):

pkg-config ile libevent_openssl ve FFmpeg dev paketleri kurulu varsayımıyla: gcc multi_hls_gateway_opt.c -o gateway_opt $(pkg-config --cflags --libs libevent_openssl libevent) -lavformat -lavcodec -lavutil -lswresample -lssl -lcrypto -lpthread
İsterseniz bu dosyayı deneyip ölçelim; CPU ve bellek kullanımında düşüş, segment gecikmesinde tutarlılık görmelisiniz.

200 eşzamanlı akış için ana darboğaz AAC encode CPU’su ve bellek (segment penceresi). Aşağıdaki yeni dosya ile:

Daha küçük HLS penceresi (4 segment x 1 sn) → bellek 2.5x–3x azalır.
Segment tamponu önceden ayrılır (pre‑alloc) → realloc/memcpy azalır.
Muxer’a ADTS (aac_latm=0), düşük gecikme seçenekleri verilir.
AAC encoder hızlı profil ayarları (libfdk_aac varsa kullan, yoksa native AAC’de hızlı “anmr” coder).
Yalnızca tek iş parçacığı/akış; gereksiz kilitler minimize.
LRU tahliye (200 üstüne çıkarsa en eski erişileni düşür).
Ek olarak donanım/OS:

CPU sizing: ~1–3%/akış (128k LC-AAC) → 200 akış için 2–6 fiziksel çekirdek önerilir.
Derleme: -O3 -march=native -flto; jemalloc/tcmalloc kullanımı tahsis yükünü düşürür.
Mümkünse libfdk_aac ile encode (daha hızlı/daha verimli).
Yeni ölçek sürümü (yan dosya):

Derleme (WSL/Ubuntu):

libfdk_aac ile:
Operasyonel ipuçları:

CPU çekirdeği/akış izleme: top/htop’da gateway_scale ve per‑thread CPU’yu izleyin.
HLS penceresi küçük olduğundan oyuncu buffer ayarlarını (hls.js maxBufferLength ~3–5s) uygun seçin.
200 stream’de RAM hesap: ~2MB x 4 segment x 200 ≈ 1.6 GB + FFmpeg/datastruct → 2–3 GB hedefleyin.



ulimit -n 200000
sysctl -w net.core.somaxconn=1024 net.core.netdev_max_backlog=2500 \
       net.ipv4.ip_local_port_range="10000 65000" \
       net.ipv4.tcp_tw_reuse=1 net.core.rmem_max=8388608 net.core.wmem_max=8388608


TLS CPU/handshake

Belirti: çok istemcide CPU artışı, handshake gecikmeleri.
Çözüm: Nginx/HAProxy ile TLS offload + keepalive/HTTP/2, gateway’i HTTP arkasına koy.
Event-loop ve kilit yarışları

Belirti: m3u8/seg istekleri bekler, mutex’lerde kuyruk.
Çözüm: m3u8’i her yeni segmentte önceden derleyip hazır string tut, handler’da sadece kopyala; kilit süresini milisaniyenin altına indir.
Thread skalası / context switch

Belirti: 300–500+ thread’te scheduler yükü, verim düşer.
Çözüm: Çok süreçli shard (SO_REUSEPORT ile 2–4 worker), core affinity (taskset), jemalloc/tcmalloc.
Hızlı kapasite ipuçları

128 kbps LC-AAC tipik CPU: ~1–3%/akış/çekirdek. 200 akış için 2–6 fiziksel çekirdek hedefleyin.
RAM: ~2 MB/akış (1s x 4 segment @ ~4–6 Mbps) + codec overhead ⇒ 200 akış ~0.5–1.5 GB.
Egress: 5 Mbps/akış x N eşzamanlı izleyici real band genişliği ihtiyacı.  



libfdk_aac kullanmak (yoksa native aac’de aac_coder=anmr, cutoff düşür).
Bitrate/samplerate/kanal azaltmak (128k→96k, 48kHz→44.1kHz, stereo→mono).
Segment süresini 1–2 sn aralığında tutup kopyaları en aza indirmek.
Aynı makinede birden çok worker process (SO_REUSEPORT) ile çekirdekleri daha verimli doldurmak.
Gereksiz swr’ı kapatmak (giriş zaten 48k stereo ise doğrudan FLTP’ye dönüştürüp ekstra yol eklememek).