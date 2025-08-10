# multi_hls_gateway build and run

This document explains how to build and run multi_hls_gateway_v5.c with good performance.

## Dependencies

Required libraries:
- FFmpeg: libavformat, libavcodec, libavutil, libswresample (optionally libfdk-aac)
- libevent and libevent_openssl
- OpenSSL (libssl, libcrypto)
- pthreads

Use pkg-config for flags and libs.

### Ubuntu/WSL (Debian-based)
```bash
sudo apt update
sudo apt install -y build-essential pkg-config \
  libevent-dev libssl-dev \
  libavformat-dev libavcodec-dev libavutil-dev libswresample-dev \
  libfdk-aac-dev  # optional
```

### Windows (MSYS2 MinGW64 shell)
```bash
# In MSYS2 MinGW64 shell (blue prompt)
pacman -S --needed mingw-w64-x86_64-toolchain mingw-w64-x86_64-pkgconf \
  mingw-w64-x86_64-ffmpeg mingw-w64-x86_64-libevent mingw-w64-x86_64-openssl
```

## Build

Assumes current dir is d:\repos-serdar\iptv (or the same folder in WSL).

Source: sdeamon/multi_hls_gateway_v5.c  
Output: build/multi_hls_gateway (or .exe on Windows)

Create build dir:
```bash
mkdir -p build
```

### Linux (gcc)
```bash
gcc -std=c11 -O3 -DNDEBUG -flto -fno-plt -pipe -march=native -mtune=native \
  $(pkg-config --cflags libavformat libavcodec libavutil libswresample libevent_openssl openssl) \
  sdeamon/multi_hls_gateway_v5.c -o build/multi_hls_gateway \
  $(pkg-config --libs libavformat libavcodec libavutil libswresample libevent_openssl openssl) \
  -Wl,-O1,--as-needed -pthread
```

### Linux (clang)
```bash
clang -std=c11 -O3 -DNDEBUG -flto=full -pipe -march=native -mtune=native \
  $(pkg-config --cflags libavformat libavcodec libavutil libswresample libevent_openssl openssl) \
  sdeamon/multi_hls_gateway_v5.c -o build/multi_hls_gateway \
  $(pkg-config --libs libavformat libavcodec libavutil libswresample libevent_openssl openssl) \
  -Wl,-O1,--as-needed -pthread
```

If libevent_openssl.pc is missing, replace its pkg-config with: `-levent_openssl -levent -lssl -lcrypto`.

### Windows (MSYS2 MinGW64)
Inside MinGW64 shell:
```bash
gcc -std=c11 -O3 -DNDEBUG -flto -pipe -march=native \
  $(pkg-config --cflags libavformat libavcodec libavutil libswresample libevent_openssl openssl) \
  sdeamon/multi_hls_gateway_v5.c -o build/multi_hls_gateway.exe \
  $(pkg-config --libs libavformat libavcodec libavutil libswresample libevent_openssl openssl) \
  -lws2_32 -lcrypt32 -lbcrypt
```
Note: Copy required DLLs (ffmpeg, libevent, openssl) next to the exe or ensure they’re on PATH.

## TLS certificate

Create a self-signed cert for local testing:
```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=localhost"
```
Place cert.pem and key.pem next to the binary working directory.

## Run

Environment variables (defaults):
- SEG_MS: segment duration ms (default 1000; clamp 200–2000)
- AAC_BR: AAC bitrate bps (default 96000)
- AAC_SR: AAC sample rate (44100 or 48000; default 44100)
- AAC_CH: channels 1 or 2 (default 1)
- WORKERS: number of worker processes (default 1)

Examples:
```bash
# Single worker
SEG_MS=1000 AAC_BR=96000 AAC_SR=44100 AAC_CH=1 WORKERS=1 ./build/multi_hls_gateway

# Multi-worker on 8-core
SEG_MS=1000 AAC_BR=96000 AAC_SR=48000 AAC_CH=1 WORKERS=8 ./build/multi_hls_gateway
```

Test:
- Playlist: https://localhost:5001/m3u8?q=<url-encoded-input>
- Segments are auto-referenced in the playlist

## Performance tips

- Set WORKERS to number of physical cores (2–8 typical). Linux benefits from SO_REUSEPORT.
- Increase file descriptors for many streams:
  ```bash
  ulimit -n 1048576
  ```
- Kernel backlog and buffers (Linux):
  ```bash
  sudo sysctl -w net.core.somaxconn=1024
  sudo sysctl -w net.core.rmem_max=1048576
  sudo sysctl -w net.core.wmem_max=1048576
  ```
- Pin workers if needed:
  ```bash
  taskset -c 0-7 ./build/multi_hls_gateway
  ```
- Prefer libfdk_aac runtime if available for efficiency; otherwise native AAC is auto-configured.
- Keep SEG_MS at 500–1000 for latency/overhead balance.

## Troubleshooting

- Link errors: ensure you link libevent_openssl, ssl, crypto, pthreads.
- Missing pkg-config entries: install -dev packages or replace pkg-config with direct -l flags.
- TLS errors: verify cert.pem/key.pem paths and permissions.
