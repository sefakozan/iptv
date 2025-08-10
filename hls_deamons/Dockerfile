FROM ubuntu:24.04

# Gerekli paketler
RUN apt-get update && \
    apt-get install -y \
        libevent-dev \
        libavformat-dev \
        libavcodec-dev \
        libavutil-dev \
        libswresample-dev \
        zlib1g-dev \
        build-essential \
    && \
    rm -rf /var/lib/apt/lists/*

# Kodu kopyala ve derle
COPY src/multi_hls_gateway.c /app/
WORKDIR /app
RUN gcc multi_hls_gateway.c -o hls_gateway \
    -I/usr/include/x86_64-linux-gnu \
    -I/usr/include/x86_64-linux-gnu/libavutil \
    -I/usr/include/x86_64-linux-gnu/libavformat \
    -I/usr/include/x86_64-linux-gnu/libavcodec \
    -I/usr/include/x86_64-linux-gnu/libswresample \
    -levent \
    -lavformat -lavcodec -lavutil -lswresample \
    -lpthread -lz

# Port
EXPOSE 5001

# Çalıştır
CMD ["/app/hls_gateway"]
