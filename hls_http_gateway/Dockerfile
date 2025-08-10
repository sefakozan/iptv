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
    libevent-2.1-7 \
    ffmpeg \
    apt-utils\ 
    libssl-dev \
    zlib1g-dev \
    libnghttp2-dev \
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
COPY src/hls_http_gateway_video.c .

# Dockerfile içindeki ilgili RUN satırını güncelleyin:
RUN gcc hls_http_gateway_video.c -o hls_http_gateway -lavformat -lavcodec -lavutil -lswresample -levent -lpthread -lavdevice -lavfilter -lpostproc -lswscale -lm \
    && apt-get purge -y build-essential pkg-config \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Varsayılan ayarlar
# ENV HLS_PORT=5001
# ENV HLS_MAX_STREAMS=20
# ENV HLS_MAX_SEGMENTS=8
# ENV HLS_TIMEOUT_SEC=300

# Port
EXPOSE 5001

# Sağlık kontrolü
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${HLS_PORT}/ || exit 1

# Başlatıcı
ENTRYPOINT ["/app/hls_http_gateway"]