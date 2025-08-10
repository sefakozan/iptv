gcc -O3 -march=native -flto -DNDEBUG -o hls-proxy proxy.c \
    -levent -levent_openssl -lssl -lcrypto -lpthread


Hash Tabanlı Cache: O(1) lookup süresi için hash tablosu
Connection Pooling: Tekrar kullanılabilir bağlantı havuzu
Memory Pool: Proxy context'leri için memory pool
Zero-Copy Buffer Transfer: Buffer kopyalama yerine referans
CPU Affinity: Her worker'ın farklı CPU core kullanması
Optimize Event Loop: High-performance event base configuration
Reference Counting: Cache item'ları için kullanım takibi
Async Cache Operations: Asenkron cache işlemleri
Performance Monitoring: Gerçek zamanlı performans izleme
Batch Processing: Çoklu event işleme