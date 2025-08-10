// HLS CORS Proxy (HTTPS) - multi-worker, in-memory cache, event-driven fetcher

#include <event2/event.h>
#include <event2/http.h>
#include <event2/http_struct.h>
#include <event2/buffer.h>
#include <event2/keyvalq_struct.h>
#include <event2/bufferevent_ssl.h>
#include <event2/dns.h>

#include <openssl/ssl.h>
#include <openssl/err.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>
#include <ctype.h>
#include <errno.h>

#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#ifndef MAX
#define MAX(a,b) ((a)>(b)?(a):(b))
#endif

#define PORT 5002
#define MAX_CACHE_ITEMS 1024
#define STREAM_TIMEOUT_SEC 300
#define IO_CHUNK 32768

static int G_WORKERS = 1;      // ENV: WORKERS
static int G_FETCH_TIMEOUT_MS = 8000; // ENV: FETCH_TIMEOUT_MS

typedef struct {
  unsigned int hash;
  char url[1024];
  uint8_t *data;
  size_t size;
  time_t ts;
} cache_item_t;

static cache_item_t g_cache[MAX_CACHE_ITEMS];
static int g_cache_count = 0;
static pthread_mutex_t g_cache_mutex = PTHREAD_MUTEX_INITIALIZER;

static struct event_base *base;
static SSL_CTX *g_ssl_ctx = NULL;
static SSL_CTX *g_ssl_client_ctx = NULL;
static struct evdns_base *g_dns = NULL;

// Forward declarations
static void send_cors_preflight(struct evhttp_request *req);
static void m3u8_handler(struct evhttp_request *req);
static void segment_handler(struct evhttp_request *req);
static int rewrite_m3u8(const char *base_url, const char *src, size_t src_len, struct evbuffer *out);

// Utils
static int getenv_int(const char *k, int defv) {
  const char *v = getenv(k);
  if (!v || !*v) return defv;
  char *e = NULL; long x = strtol(v, &e, 10);
  if (e && *e) return defv;
  return (int)x;
}
static unsigned int hash_str(const char *s) {
  unsigned int h=5381; unsigned char c;
  while ((c=(unsigned char)*s++)!=0) h=((h<<5)+h)+c;
  return h;
}
static void url_decode(char *dst, const char *src) {
  char a,b;
  while (*src) {
    if (*src=='%' && src[1] && src[2]) {
      a=toupper((unsigned char)src[1]); b=toupper((unsigned char)src[2]);
      if (isxdigit((unsigned char)a) && isxdigit((unsigned char)b)) {
        *dst++ = ((a<='9'?a-'0':a-'A'+10)<<4) | (b<='9'?b-'0':b-'A'+10);
        src+=3; continue;
      }
    } else if (*src=='+') {
      *dst++=' '; src++; continue;
    }
    *dst++=*src++;
  }
  *dst='\0';
}
static void url_encode(char *dst, size_t dstsz, const char *src) {
  static const char hex[]="0123456789ABCDEF";
  size_t di=0;
  for (; *src && di+4<dstsz; ++src) {
    unsigned char c = (unsigned char)*src;
    if (isalnum(c) || c=='-'||c=='_'||c=='.'||c=='~') {
      dst[di++]=c;
    } else if (c==' ') {
      dst[di++]='+';
    } else {
      dst[di++]='%'; dst[di++]=hex[(c>>4)&0xF]; dst[di++]=hex[c&0xF];
    }
  }
  if (di<dstsz) dst[di]=0; else dst[dstsz-1]=0;
}

// CORS preflight helper (used by general_cb)
static void send_cors_preflight(struct evhttp_request *req) {
  struct evkeyvalq *out = evhttp_request_get_output_headers(req);
  evhttp_add_header(out, "Access-Control-Allow-Origin", "*");
  evhttp_add_header(out, "Access-Control-Allow-Methods", "GET, OPTIONS");
  evhttp_add_header(out, "Access-Control-Allow-Headers", "*");
  evhttp_add_header(out, "Access-Control-Max-Age", "600");
  evhttp_send_reply(req, 204, "No Content", NULL);
}

// Resolve relative HLS URI against base
static void split_base(const char *base, char *scheme, size_t ssz, char *hostport, size_t hsz, char *dir, size_t dsz) {
  const char *p = strstr(base, "://");
  if (!p) { s_strlcpy(scheme, "http", ssz); s_strlcpy(hostport, "", hsz); s_strlcpy(dir, base, dsz); return; }
  s_strlcpy(scheme, "", ssz); s_strlcpy(hostport, "", hsz); s_strlcpy(dir, "", dsz);
  size_t slen = (size_t)(p - base);
  if (slen+1<ssz) { memcpy(scheme, base, slen); scheme[slen]=0; }
  p += 3;
  const char *slash = strchr(p, '/');
  if (slash) {
    size_t hlen = (size_t)(slash - p);
    if (hlen+1<hsz) { memcpy(hostport, p, hlen); hostport[hlen]=0; }
    const char *last_slash = strrchr(slash, '/');
    if (last_slash) {
      size_t dlen = (size_t)(last_slash - p);
      if (dlen+1<dsz) { memcpy(dir, p, dlen); dir[dlen]=0; }
    } else {
      size_t dlen = (size_t)(slash - p);
      if (dlen+1<dsz) { memcpy(dir, p, dlen); dir[dlen]=0; }
    }
  } else {
    s_strlcpy(hostport, p, hsz);
    s_strlcpy(dir, p, dsz);
  }
}
static void resolve_url(char *out, size_t osz, const char *base, const char *rel) {
  if (!rel || !*rel) { s_strlcpy(out, base, osz); return; }
  if (strncasecmp(rel, "http://", 7)==0 || strncasecmp(rel, "https://", 8)==0) { s_strlcpy(out, rel, osz); return; }
  char scheme[16], hostport[256], dir[1024];
  split_base(base, scheme, sizeof(scheme), hostport, sizeof(hostport), dir, sizeof(dir));
  if (rel[0]=='/') { snprintf(out, osz, "%s://%s%s", scheme[0]?scheme:"http", hostport, rel); return; }
  if (rel[0]=='.' && rel[1]=='/') rel+=2;
  snprintf(out, osz, "%s://%s/%s/%s", scheme[0]?scheme:"http", hostport, dir, rel);
}

// Cache
static cache_item_t* cache_find(const char *url) {
  unsigned int h = hash_str(url);
  for (int i=0;i<g_cache_count;i++) {
    if (g_cache[i].hash==h && strcmp(g_cache[i].url,url)==0) return &g_cache[i];
  }
  return NULL;
}
static void cache_put(const char *url, uint8_t *data, size_t size) {
  unsigned int h = hash_str(url);
  // Replace existing
  for (int i=0;i<g_cache_count;i++) {
    if (g_cache[i].hash==h && strcmp(g_cache[i].url,url)==0) {
      if (g_cache[i].data) free(g_cache[i].data);
      g_cache[i].data=data; g_cache[i].size=size; g_cache[i].ts=time(NULL);
      return;
    }
  }
  // Evict oldest if full
  if (g_cache_count>=MAX_CACHE_ITEMS) {
    int idx=0; time_t oldest=g_cache[0].ts;
    for (int i=1;i<g_cache_count;i++) if (g_cache[i].ts < oldest) { oldest=g_cache[i].ts; idx=i; }
    if (g_cache[idx].data) free(g_cache[idx].data);
    // Shift tail over idx
    memmove(&g_cache[idx], &g_cache[idx+1], (g_cache_count-idx-1)*sizeof(cache_item_t));
    g_cache_count--;
  }
  cache_item_t *it = &g_cache[g_cache_count++];
  it->hash = h; s_strlcpy(it->url, url, sizeof(it->url));
  it->data = data; it->size=size; it->ts=time(NULL);
}
static void cache_cleanup_expired() {
  time_t now = time(NULL);
  for (int i=0;i<g_cache_count;) {
    if (now - g_cache[i].ts > STREAM_TIMEOUT_SEC) {
      if (g_cache[i].data) free(g_cache[i].data);
      memmove(&g_cache[i], &g_cache[i+1], (g_cache_count-i-1)*sizeof(cache_item_t));
      g_cache_count--;
    } else i++;
  }
}

// Upstream client context and helpers
typedef struct {
  struct evhttp_request *down_req;
  struct evhttp_connection *up_conn;
  struct evhttp_request *up_req;
  int is_m3u8;
  int started; // downstream reply started
  struct evbuffer *agg; // for m3u8
  // caching for segments
  int do_cache;
  char cache_key[2048];
  uint8_t *cbuf;
  size_t csize, ccap;
} proxy_ctx_t;

static int parse_url_full(const char *url, char *scheme, size_t ssz, char *host, size_t hsz, int *port, char *pathq, size_t psz) {
  struct evhttp_uri *u = evhttp_uri_parse(url);
  if (!u) return -1;
  const char *sch = evhttp_uri_get_scheme(u);
  const char *hst = evhttp_uri_get_host(u);
  int prt = evhttp_uri_get_port(u);
  const char *pth = evhttp_uri_get_path(u);
  const char *qry = evhttp_uri_get_query(u);
  if (!sch || !hst) { evhttp_uri_free(u); return -1; }
  s_strlcpy(scheme, sch, ssz);
  s_strlcpy(host, hst, hsz);
  if (prt <= 0) prt = (strcasecmp(sch,"https")==0)?443:80;
  *port = prt;
  if (!pth || !*pth) pth = "/";
  if (qry && *qry) snprintf(pathq, psz, "%s?%s", pth, qry);
  else s_strlcpy(pathq, pth, psz);
  evhttp_uri_free(u);
  return 0;
}

// Upstream callbacks
static void upstream_header_cb(struct evhttp_request *up, void *arg) {
  proxy_ctx_t *cx = (proxy_ctx_t*)arg;
  if (cx->is_m3u8 || cx->started) return;
  // Start downstream reply with CORS + content-type
  struct evkeyvalq *out = evhttp_request_get_output_headers(cx->down_req);
  add_cors_headers(cx->down_req);
  const char *ct = evhttp_find_header(evhttp_request_get_input_headers(up), "Content-Type");
  evhttp_add_header(out, "Content-Type", ct ? ct : "video/MP2T");
  evhttp_send_reply_start(cx->down_req, 200, "OK");
  cx->started = 1;
}

static void upstream_chunk_cb(struct evhttp_request *up, void *arg) {
  proxy_ctx_t *cx = (proxy_ctx_t*)arg;
  struct evbuffer *in = evhttp_request_get_input_buffer(up);
  size_t n = evbuffer_get_length(in);
  if (!n) return;

  if (cx->is_m3u8) {
    if (!cx->agg) cx->agg = evbuffer_new();
    evbuffer_remove_buffer(in, cx->agg, (ssize_t)n);
  } else {
    struct evbuffer *outb = evbuffer_new();
    evbuffer_remove_buffer(in, outb, (ssize_t)n);
    evhttp_send_reply_chunk(cx->down_req, outb);
    // cache append
    if (cx->do_cache) {
      if (cx->csize + n > cx->ccap) {
        size_t ncap = cx->ccap ? cx->ccap : 128*1024;
        while (ncap < cx->csize + n) ncap <<= 1;
        uint8_t *nb = (uint8_t*)realloc(cx->cbuf, ncap);
        if (nb) { cx->cbuf=nb; cx->ccap=ncap; }
      }
      if (cx->cbuf && cx->csize + n <= cx->ccap) {
        unsigned char *p = evbuffer_pullup(outb, -1);
        memcpy(cx->cbuf + cx->csize, p, n);
        cx->csize += n;
      }
    }
    evbuffer_free(outb);
  }
}

static void upstream_done_cb(struct evhttp_request *up, void *arg) {
  proxy_ctx_t *cx = (proxy_ctx_t*)arg;
  if (cx->is_m3u8) {
    size_t len = cx->agg ? evbuffer_get_length(cx->agg) : 0;
    const unsigned char *ptr = cx->agg ? evbuffer_pullup(cx->agg, -1) : NULL;
    struct evbuffer *outb = evbuffer_new();
    if (ptr && len) {
      // Rewriter needs base url; extract from Host header & request URI
      // We saved nothing; but upstream URL was passed via Host+path; client supplied full URL in query and we decoded into cache_key for seg; for m3u8 we can pass full in cache_key too.
      const char *base_url = cx->cache_key[0] ? cx->cache_key : "";
      rewrite_m3u8(base_url, (const char*)ptr, len, outb);
    }
    add_cors_headers(cx->down_req);
    struct evkeyvalq *out = evhttp_request_get_output_headers(cx->down_req);
    evhttp_add_header(out, "Content-Type", "application/vnd.apple.mpegurl");
    evhttp_send_reply(cx->down_req, 200, "OK", outb);
    evbuffer_free(outb);
  } else {
    if (!cx->started) {
      struct evkeyvalq *out = evhttp_request_get_output_headers(cx->down_req);
      add_cors_headers(cx->down_req);
      evhttp_add_header(out, "Content-Type", "video/MP2T");
      evhttp_send_reply_start(cx->down_req, 200, "OK");
    }
    evhttp_send_reply_end(cx->down_req);
    // store cache if collected
    if (cx->do_cache && cx->cbuf && cx->csize>0) {
      uint8_t *copy = (uint8_t*)malloc(cx->csize);
      if (copy) {
        memcpy(copy, cx->cbuf, cx->csize);
        pthread_mutex_lock(&g_cache_mutex);
        cache_put(cx->cache_key, copy, cx->csize);
        pthread_mutex_unlock(&g_cache_mutex);
      }
    }
  }
  if (cx->agg) evbuffer_free(cx->agg);
  if (cx->up_conn) evhttp_connection_free(cx->up_conn);
  if (cx->cbuf) free(cx->cbuf);
  free(cx);
}

static void upstream_error_cb(enum evhttp_request_error err, void *arg) {
  proxy_ctx_t *cx = (proxy_ctx_t*)arg;
  if (!cx) return;
  if (!cx->is_m3u8) {
    if (!cx->started) {
      evhttp_send_error(cx->down_req, 502, "Upstream error");
    } else {
      evhttp_send_reply_end(cx->down_req);
    }
  } else {
    evhttp_send_error(cx->down_req, 502, "Upstream error");
  }
  if (cx->agg) evbuffer_free(cx->agg);
  if (cx->up_conn) evhttp_connection_free(cx->up_conn);
  if (cx->cbuf) free(cx->cbuf);
  free(cx);
}

static int start_upstream_request(struct evhttp_request *down_req, const char *full_url, int is_m3u8, int do_cache, const char *cache_key) {
  char scheme[8], host[256], pathq[2048];
  int port=0;
  if (parse_url_full(full_url, scheme, sizeof(scheme), host, sizeof(host), &port, pathq, sizeof(pathq))<0)
    return -1;

  struct bufferevent *bev = NULL;
  if (strcasecmp(scheme,"https")==0) {
    SSL *ssl = SSL_new(g_ssl_client_ctx);
    bev = bufferevent_openssl_socket_new(base, -1, ssl, BUFFEREVENT_SSL_CONNECTING, BEV_OPT_CLOSE_ON_FREE);
  } else {
    bev = bufferevent_socket_new(base, -1, BEV_OPT_CLOSE_ON_FREE);
  }
  if (!bev) return -1;

  struct evhttp_connection *conn = evhttp_connection_base_bufferevent_new(base, g_dns, bev, host, (unsigned short)port);
  if (!conn) { bufferevent_free(bev); return -1; }
  evhttp_connection_set_timeout(conn, MAX(1, G_FETCH_TIMEOUT_MS/1000));

  proxy_ctx_t *cx = (proxy_ctx_t*)calloc(1, sizeof(*cx));
  if (!cx) { evhttp_connection_free(conn); return -1; }
  cx->down_req = down_req;
  cx->up_conn = conn;
  cx->is_m3u8 = is_m3u8;
  cx->do_cache = do_cache;
  if (cache_key) s_strlcpy(cx->cache_key, cache_key, sizeof(cx->cache_key));

  struct evhttp_request *upreq = evhttp_request_new(upstream_done_cb, cx);
  if (!upreq) { evhttp_connection_free(conn); free(cx); return -1; }
  cx->up_req = upreq;

  evhttp_request_set_header_cb(upreq, upstream_header_cb);
  evhttp_request_set_chunked_cb(upreq, upstream_chunk_cb);
  evhttp_request_set_error_cb(upreq, upstream_error_cb);

  struct evkeyvalq *hdr = evhttp_request_get_output_headers(upreq);
  evhttp_add_header(hdr, "Host", host);
  evhttp_add_header(hdr, "Connection", "keep-alive");
  evhttp_add_header(hdr, "User-Agent", "mhls-proxy/2.0");

  if (evhttp_make_request(conn, upreq, EVHTTP_REQ_GET, pathq) != 0) {
    evhttp_connection_free(conn);
    free(cx);
    return -1;
  }
  return 0;
}

// Playlist rewriter
static int rewrite_m3u8(const char *base_url, const char *src, size_t src_len, struct evbuffer *out) {
  char line[4096];
  int i=0, pending_variant=0;
  while (i < (int)src_len) {
    int j=i; while (j<(int)src_len && src[j]!='\n' && src[j]!='\r') j++;
    int l = j-i; if (l >= (int)sizeof(line)) l = (int)sizeof(line)-1;
    memcpy(line, src+i, l); line[l]=0;
    // advance
    while (j<(int)src_len && (src[j]=='\n' || src[j]=='\r')) j++;
    i=j;

    if (line[0]=='#') {
      // Rewrite URI="..." occurrences in tags (e.g., EXT-X-KEY, EXT-X-MAP)
      char *p = strstr(line, "URI=\"");
      if (p) {
        p += 5; // after URI="
        char *end = strchr(p, '"');
        if (end) {
          char orig[2048]; int ulen = (int)(end - p); if (ulen>(int)sizeof(orig)-1) ulen=(int)sizeof(orig)-1;
          memcpy(orig, p, ulen); orig[ulen]=0;
          char absu[2048]; resolve_url(absu, sizeof(absu), base_url, orig);
          char enc[4096]; url_encode(enc, sizeof(enc), absu);
          // Build rewritten line into buffer
          struct evbuffer *tmp = evbuffer_new();
          evbuffer_add(tmp, line, (size_t)(p - line));
          const char *prefix = strstr(line, "#EXT-X-MAP") ? "/seg?u=" : "/seg?u=";
          evbuffer_add_printf(tmp, "%s%s", prefix, enc);
          evbuffer_add_printf(tmp, "\"%s", end+1);
          size_t newlen = evbuffer_get_length(tmp);
          unsigned char *flat = evbuffer_pullup(tmp, -1);
          evbuffer_add(out, flat, newlen);
          evbuffer_add_printf(out, "\n");
          evbuffer_free(tmp);
          continue;
        }
      }
      if (!strncmp(line, "#EXT-X-STREAM-INF", 17)) {
        pending_variant = 1;
      }
      // pass-through tag
      evbuffer_add_printf(out, "%s\n", line);
      continue;
    }

    // URI line (segment or child playlist)
    char absu[2048]; resolve_url(absu, sizeof(absu), base_url, line);
    char enc[4096]; url_encode(enc, sizeof(enc), absu);
    if (pending_variant || strstr(line, ".m3u8")) {
      evbuffer_add_printf(out, "/m3u8?q=%s\n", enc);
      pending_variant = 0;
    } else {
      evbuffer_add_printf(out, "/seg?u=%s\n", enc);
    }
  }
  return 0;
}

// Handlers
static void m3u8_handler(struct evhttp_request *req) {
  const char *uri = evhttp_request_get_uri(req);
  struct evhttp_uri *decoded = evhttp_uri_parse(uri);
  if (!decoded) { evhttp_send_error(req,400,"Bad Request"); return; }
  const char *query = evhttp_uri_get_query(decoded);
  if (!query) { evhttp_send_error(req,400,"Missing query"); evhttp_uri_free(decoded); return; }
  const char *q = strstr(query,"q=");
  if (!q) { evhttp_send_error(req,400,"q= required"); evhttp_uri_free(decoded); return; }

  char encoded[2048]={0}; s_strlcpy(encoded, q+2, sizeof(encoded));
  char upstream[2048]; url_decode(upstream, encoded);

  // Start upstream async fetch; cache_key keeps base_url for rewrite
  if (start_upstream_request(req, upstream, 1, 0, upstream) != 0) {
    evhttp_send_error(req,502,"Upstream start failed");
  }
  evhttp_uri_free(decoded);
}

static void segment_handler(struct evhttp_request *req) {
  const char *uri = evhttp_request_get_uri(req);
  struct evhttp_uri *decoded = evhttp_uri_parse(uri);
  if (!decoded) { evhttp_send_error(req,400,"Bad Request"); return; }
  const char *query = evhttp_uri_get_query(decoded);
  const char *u = (query? strstr(query,"u="):NULL);
  if (!u) { evhttp_send_error(req,400,"u= required"); evhttp_uri_free(decoded); return; }

  char encoded[2048]={0}; s_strlcpy(encoded, u+2, sizeof(encoded));
  char target[2048]; url_decode(target, encoded);

  // cache lookup
  pthread_mutex_lock(&g_cache_mutex);
  cache_item_t *it = cache_find(target);
  if (it) {
    it->ts = time(NULL);
    struct evbuffer *buf = evbuffer_new();
    evbuffer_add(buf, it->data, it->size);
    add_cors_headers(req);
    struct evkeyvalq *out = evhttp_request_get_output_headers(req);
    evhttp_add_header(out, "Content-Type", "video/MP2T");
    evhttp_send_reply(req, 200, "OK", buf);
    evbuffer_free(buf);
    pthread_mutex_unlock(&g_cache_mutex);
    evhttp_uri_free(decoded);
    return;
  }
  pthread_mutex_unlock(&g_cache_mutex);

  // streamed proxy + fill cache
  if (start_upstream_request(req, target, 0, 1, target) != 0) {
    evhttp_send_error(req,502,"Upstream start failed");
  }
  evhttp_uri_free(decoded);
}

// Cleanup thread
static void* cleanup_thread(void *arg) {
  while (1) {
    sleep(30);
    pthread_mutex_lock(&g_cache_mutex);
    cache_cleanup_expired();
    pthread_mutex_unlock(&g_cache_mutex);
  }
  return NULL;
}

// libevent OpenSSL bufferevent creator (used by evhttp_set_bevcb)
static struct bufferevent* bevcb(struct event_base *base, void *arg) {
  SSL *ssl = SSL_new(g_ssl_ctx);
  return bufferevent_openssl_socket_new(base, -1, ssl, BUFFEREVENT_SSL_ACCEPTING, BEV_OPT_CLOSE_ON_FREE);
}

// Listener with SO_REUSEPORT
static int create_listener_socket(const char *addr, int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  #ifdef SO_REUSEPORT
  setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof(one));
  #endif
  struct sockaddr_in sin; memset(&sin, 0, sizeof(sin));
  sin.sin_family = AF_INET;
  sin.sin_port = htons((uint16_t)port);
  sin.sin_addr.s_addr = inet_addr(addr);
  if (bind(fd, (struct sockaddr*)&sin, sizeof(sin)) < 0) { close(fd); return -1; }
  if (listen(fd, 512) < 0) { close(fd); return -1; }
  return fd;
}

// Router and server
static void general_cb(struct evhttp_request *req, void *arg) {
  int cmd = evhttp_request_get_command(req);
  if (cmd == EVHTTP_REQ_OPTIONS) { send_cors_preflight(req); return; }

  const char *uri = evhttp_request_get_uri(req);
  struct evhttp_uri *decoded = evhttp_uri_parse(uri);
  if (!decoded) { evhttp_send_error(req,400,"Bad Request"); return; }
  const char *path = evhttp_uri_get_path(decoded);
  if (!path) { evhttp_send_error(req,404,"Not Found"); evhttp_uri_free(decoded); return; }

  if (strcmp(path,"/m3u8")==0) { evhttp_uri_free(decoded); m3u8_handler(req); return; }
  if (strcmp(path,"/seg")==0) { evhttp_uri_free(decoded); segment_handler(req); return; }

  evhttp_uri_free(decoded);
  evhttp_send_error(req,404,"Not Found");
}

static int run_one_worker(void) {
  base = event_base_new();
  if (!base) return 1;
  // Create DNS base for async resolves
  g_dns = evdns_base_new(base, 1);
  struct evhttp *http = evhttp_new(base);

  g_ssl_ctx = SSL_CTX_new(TLS_server_method());
  if (SSL_CTX_use_certificate_file(g_ssl_ctx, "cert.pem", SSL_FILETYPE_PEM) <= 0 ||
      SSL_CTX_use_PrivateKey_file(g_ssl_ctx, "key.pem", SSL_FILETYPE_PEM) <= 0) {
    fprintf(stderr, "Sertifika hatası. 'cert.pem' ve 'key.pem' oluşturun.\n");
    return 1;
  }
  // Client-side SSL ctx for HTTPS upstream
  g_ssl_client_ctx = SSL_CTX_new(TLS_client_method());

  evhttp_set_bevcb(http, bevcb, NULL);
  evhttp_set_allowed_methods(http, EVHTTP_REQ_GET | EVHTTP_REQ_OPTIONS);
  evhttp_set_max_headers_size(http, 8192);

  int fd = create_listener_socket("0.0.0.0", PORT);
  if (fd < 0) { fprintf(stderr, "Bind hata: %s\n", strerror(errno)); return 1; }
  if (evhttp_accept_socket(http, fd) != 0) { fprintf(stderr, "evhttp_accept_socket hata\n"); return 1; }

  evhttp_set_gencb(http, general_cb, NULL);

  pthread_t cleanup_tid;
  pthread_create(&cleanup_tid, NULL, cleanup_thread, NULL);

  printf("CORS Proxy PID %d ready on https://localhost:%d (WORKERS=%d)\n", getpid(), PORT, G_WORKERS);

  event_base_dispatch(base);

  evhttp_free(http);
  if (g_dns) evdns_base_free(g_dns, 1);
  event_base_free(base);
  SSL_CTX_free(g_ssl_client_ctx);
  SSL_CTX_free(g_ssl_ctx);
  return 0;
}

int main() {
  // ENV
  G_WORKERS = getenv_int("WORKERS", 1);
  if (G_WORKERS < 1) G_WORKERS = 1;
  G_FETCH_TIMEOUT_MS = getenv_int("FETCH_TIMEOUT_MS", 8000);

  SSL_load_error_strings();
  OpenSSL_add_ssl_algorithms();

  if (G_WORKERS == 1) {
    return run_one_worker();
  }

  for (int i=0; i<G_WORKERS; i++) {
    pid_t pid = fork();
    if (pid == 0) {
      return run_one_worker();
    } else if (pid < 0) {
      perror("fork");
      return 1;
    }
  }
  while (1) pause();
  return 0;
}
