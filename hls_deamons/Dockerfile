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
        libavfilter-dev \
        libavdevice-dev \
        libswscale-dev \
        libpostproc-dev \
        wget \
        && \
    rm -rf /var/lib/apt/lists/*

# 3. Kaynak kodu kopyala ve uygulamayı derle
COPY src /app/src
WORKDIR /app

RUN gcc /app/src/multi_hls_gateway.c -o /app/hls_gateway \
    -levent \
    -lavformat -lavcodec -lavutil -lswresample -lswscale -lavfilter -lavdevice \
    -lpostproc -lm \
    -lpthread -lz

EXPOSE 5001
CMD ["./app/hls_gateway"]
