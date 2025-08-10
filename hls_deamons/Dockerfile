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

# Dockerfile içindeki ilgili RUN satırını güncelleyin:
RUN gcc multi_hls_gateway.c -o hls_gateway -levent -lavformat -lavcodec -lavutil -lswresample -lpthread -lz -latomic -O2 -Wno-deprecated-declarations \
    && apt-get purge -y build-essential pkg-config \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Varsayılan ayarlar
ENV HLS_PORT=5001
ENV HLS_MAX_STREAMS=20
ENV HLS_MAX_SEGMENTS=8
ENV HLS_TIMEOUT_SEC=300

# Port
EXPOSE 5001

# Sağlık kontrolü
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${HLS_PORT}/ || exit 1

# Başlatıcı
ENTRYPOINT ["/app/hls_gateway"]