# Dockerfile for HLS Gateway
# Ubuntu 24.04 + FFmpeg 5.1 (apt) + libevent + HTTP + çoklu akış

FROM ubuntu:24.04

# Ortam ayarları
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Europe/Istanbul

# Build argümanları
ARG BUILD_DEPS="build-essential pkg-config"
ARG RUNTIME_DEPS="\
    libavformat-dev \
    libavcodec-dev \
    libavutil-dev \
    libswresample-dev \
    libavdevice-dev \
    libavfilter-dev \
    libswscale-dev \
    libpostproc-dev \
    libevent-dev \
    libssl-dev \
    zlib1g-dev \
    curl"

# Gerekli paketleri yükle
RUN apt-get update && apt-get install -y \
    ${BUILD_DEPS} \
    ${RUNTIME_DEPS} \
    && rm -rf /var/lib/apt/lists/*

# Uygulama dizini
WORKDIR /app

# Kaynak kodu kopyala
COPY src/multi_hls_gateway.c .

# Derle ve gereksiz paketleri kaldır
RUN gcc multi_hls_gateway.c -o hls_gateway -levent -lavformat -lavcodec -lavutil -lswresample -lpthread -lz \
    && apt-get purge -y ${BUILD_DEPS} \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Port
EXPOSE 5001

# Sağlık kontrolü
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:5001/ || exit 1

# Başlatıcı
ENTRYPOINT ["/app/hls_gateway"]