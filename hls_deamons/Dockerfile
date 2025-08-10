# Dockerfile
FROM ubuntu:22.04 AS builder

# 1. Paketleri güncelle ve gerekli araçları kur
RUN apt-get update && \
    apt-get install -y \
        build-essential \
        wget \
        git \
        ca-certificates \
        pkg-config \
        yasm \
        nasm \
        libssl-dev \
        libnghttp2-dev \
        libevent-dev \
        zlib1g-dev \
        libbz2-dev \
        libx264-dev \
        libx265-dev \
        libvpx-dev \
        libopus-dev \
        libmp3lame-dev \
        libfdk-aac-dev \
        && \
    rm -rf /var/lib/apt/lists/*

# 2. FFmpeg 5.1 kaynaktan derle
RUN cd /tmp && \
    wget https://ffmpeg.org/releases/ffmpeg-5.1.tar.xz && \
    tar xf ffmpeg-5.1.tar.xz && \
    cd ffmpeg-5.1 && \
    ./configure \
        --enable-shared \
        --disable-static \
        --enable-libssl \
        --enable-libnghttp2 \
        --enable-libmp3lame \
        --enable-libfdk-aac \
        --enable-libopus \
        --enable-libvpx \
        --enable-libx264 \
        --enable-libx265 \
        --enable-gpl \
        --enable-nonfree \
        --prefix=/usr/local && \
    make -j$(nproc) && \
    make install && \
    ldconfig

# 3. Kaynak kodu kopyala ve uygulamayı derle
COPY src /app/src
WORKDIR /app

RUN gcc /app/src/multi_hls_gateway.c -o /app/hls_gateway \
    -I/usr/local/include \
    -L/usr/local/lib \
    -levent -levent_openssl \
    -lssl -lcrypto \
    -lnghttp2 \
    -lavformat -lavcodec -lavutil -lswresample \
    -lpthread -lz \
    -Wl,-rpath,/usr/local/lib

# ————————————————————————————————————————————————————————
# 2. Aşama: Çalıştırılabilir İmaj
# ————————————————————————————————————————————————————————

FROM ubuntu:22.04

# Gerekli runtime kütüphaneleri
RUN apt-get update && \
    apt-get install -y \
        libevent-2.1-7 \
        libevent-openssl-2.1-7 \
        libssl3 \
        libnghttp2-14 \
        libavformat58 \
        libavcodec58 \
        libavutil56 \
        libswresample3 \
        ca-certificates \
        && \
    rm -rf /var/lib/apt/lists/*

# FFmpeg runtime kütüphanelerini kopyala
COPY --from=builder /usr/local/lib/libav* /usr/local/lib/
COPY --from=builder /usr/local/lib/libsw* /usr/local/lib/
RUN ldconfig /usr/local/lib

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
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]