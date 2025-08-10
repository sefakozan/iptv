# Dockerfile for HLS Gateway
# Ubuntu 24.04 + FFmpeg 5.1 (apt) + libevent + HTTP + çoklu akış

FROM ubuntu:24.04

# Ortam ayarları
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Europe/Istanbul

# Gerekli paketler
RUN apt-get update && apt-get install -y \
    build-essential \
    libavformat-dev \
    libavcodec-dev \
    libavutil-dev \
    libswresample-dev \
    libevent-dev \
    libssl-dev \
    zlib1g-dev \
    certbot \
    && rm -rf /var/lib/apt/lists/*

# Uygulama dizini
WORKDIR /app

# Kaynak kodu kopyala
COPY src/multi_hls_gateway.c .

# Derle (eksik -lz bayrağı eklendi)
RUN gcc multi_hls_gateway.c -o hls_gateway -levent -lavformat -lavcodec -lavutil -lswresample -lpthread -lz

# entrypoint.sh kopyala ve çalıştırılabilir yap
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Çalışma dizini
WORKDIR /var/lib/hls-gateway

# Port
EXPOSE 5001

# Başlatıcı
ENTRYPOINT ["/entrypoint.sh"]
