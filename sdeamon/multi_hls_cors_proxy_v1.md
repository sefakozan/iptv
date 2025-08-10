Link with -levent_openssl -levent -lssl -lcrypto -lpthread.
Tune WORKERS to physical cores and raise ulimit -n for many connections.


gcc -o hls-proxy proxy.c -levent -levent_openssl -lssl -lcrypto -lpthread