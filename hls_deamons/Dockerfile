# Dockerfile
FROM ubuntu:24.04 AS builder
ENV DEBIAN_FRONTEND=noninteractive

# 1. Paketleri güncelle ve gerekli araçları kur (sistem FFmpeg kullan)
RUN apt-get update && \
    apt-get install -y \
    apt-utils \
        build-essential \
        ca-certificates \
        pkg-config \
        libssl-dev \
        libnghttp2-dev \
        libevent-dev \
        zlib1g-dev \
        libavformat-dev \
        libavcodec-dev \
        libavutil-dev \
        libswresample-dev \
        && \
    rm -rf /var/lib/apt/lists/*

# 3. Kaynak kodu kopyala ve uygulamayı derle
COPY src /app/src
WORKDIR /app

RUN gcc /app/src/multi_hls_gateway.c -o /app/hls_gateway \
    -levent -levent_openssl \
    -lssl -lcrypto \
    -lnghttp2 \
    -lavformat -lavcodec -lavutil -lswresample \
    -lpthread -lz

# ————————————————————————————————————————————————————————
# 2. Aşama: Çalıştırılabilir İmaj
# ————————————————————————————————————————————————————————

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

# Gerekli runtime kütüphaneleri
RUN apt-get update && \
    apt-get install -y \
    apt-utils \
    libevent-2.1-7 \
    libevent-openssl-2.1-7 \
    libssl3 \
    libnghttp2-14 \
    ffmpeg \
    curl \
    openssl \
        ca-certificates \
        && \
    rm -rf /var/lib/apt/lists/*

# Sertifika deposu
RUN update-ca-certificates

# Uygulamayı kopyala
COPY --from=builder /app/hls_gateway /usr/local/bin/hls_gateway

# Certbot yükle
RUN apt-get update && \
    apt-get install -y certbot && \
    rm -rf /var/lib/apt/lists/*

# Dizinler
RUN mkdir -p /etc/letsencrypt /var/lib/hls-gateway

# Volume
VOLUME ["/etc/letsencrypt"]

# Port
EXPOSE 5001

# Başlatma betiği
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# Varsayılan olarak certbot'u devre dışı bırak (compose ile override edilebilir)
ENV DISABLE_CERTBOT=1
ENV USE_TLS=0

ENTRYPOINT ["/entrypoint.sh"]