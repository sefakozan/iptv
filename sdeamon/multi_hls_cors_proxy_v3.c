// HLS CORS Proxy (HTTPS) - multi-worker, in-memory cache, event-driven fetcher
// CPU Optimizasyonlu Versiyon

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
#include <sched.h>
#include <sys/mman.h>

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
#define IO_CHUNK 65536  // 64KB chunk size

static int G_WORKERS = 1;      // ENV: WORKERS
static int G_FETCH_TIMEOUT_MS = 8000; // ENV: FETCH_TIMEOUT_MS

// Cache bucket sayısı (hash tablosu için)
#define CACHE_HASH_SIZE 2048

typedef struct {
  char url[1024];
  uint8_t *data;
  size_t size;
  time_t ts;
  int in_use;  // Reference counting
} cache_item_t;

// Hash tabanlı cache buckets
typedef struct {
  cache_item_t *items;
  int count;
  int capacity;
  pthread_mutex_t mutex;
} cache_bucket_t;

static cache_bucket_t g_cache_buckets[CACHE_HASH_SIZE];
static pthread_mutex_t g_global_cache_mutex = PTHREAD_MUTEX_INITIALIZER;

// Connection pooling
#define CONNECTION_POOL_SIZE 64
typedef struct {
  struct evhttp_connection **connections;
  int *in_use;
  int size;
  pthread_mutex_t mutex;
} conn_pool_t;

static conn_pool_t g_conn_pool = {0};

// Memory pool for proxy contexts
#define CTX_POOL_SIZE 1024
typedef struct {
  void **blocks;
  int *in_use;
  int total_blocks;
  size_t block_size;
  pthread_mutex_t mutex;
} mem_pool_t;

static mem_pool_t *g_ctx_pool = NULL;

static struct event_base *base;
static SSL_CTX *g_ssl_ctx = NULL;
static SSL_CTX *g_ssl_client_ctx = NULL;
static struct evdns_base *g_dns = NULL;

// Performance statistics
typedef struct {
  uint64_t requests_served;
  uint64_t cache_hits;
  uint64_t cache_misses;
  uint64_t bytes_transferred;
  uint64_t redirects_handled;
} perf_stats_t;

static perf_stats_t g_stats = {0};
static pthread_mutex_t g_stats_mutex = PTHREAD_MUTEX_INITIALIZER;

// Forward declarations
static void send_cors_preflight(struct evhttp_request *req);
static void m3u8_handler(struct evhttp_request *req);
static void segment_handler(struct evhttp_request *req);
static int rewrite_m3u8(const char *base_url, const char *src, size_t src_len, struct evbuffer *out);
static void add_cors_headers(struct evhttp_request *req);
static int restart_upstream(struct proxy_ctx *cx, const char *full_url);

// Memory pool functions
static mem_pool_t* create_mem_pool(size_t block_size, int num_blocks) {
  mem_pool_t *pool = calloc(1, sizeof(mem_pool_t));
  if (!pool) return NULL;
  
  pool->blocks = calloc(num_blocks, sizeof(void*));
  pool->in_use = calloc(num_blocks, sizeof(int));
  pool->block_size = block_size;
  pool->total_blocks = num_blocks;
  pthread_mutex_init(&pool->mutex, NULL);
  
  for (int i = 0; i < num_blocks; i++) {
    pool->blocks[i] = malloc(block_size);
  }
  return pool;
}

static void* pool_malloc(mem_pool_t *pool, size_t size) {
  if (!pool || size > pool->block_size) {
    return malloc(size);  // Fallback to regular malloc
  }
  
  pthread_mutex_lock(&pool->mutex);
  for (int i = 0; i < pool->total_blocks; i++) {
    if (!pool->in_use[i]) {
      pool->in_use[i] = 1;
      pthread_mutex_unlock(&pool->mutex);
      return pool->blocks[i];
    }
  }
  pthread_mutex_unlock(&pool->mutex);
  
  return malloc(size);  // Pool exhausted, fallback
}

static void pool_free(mem_pool_t *pool, void *ptr) {
  if (!pool || !ptr) {
    free(ptr);
    return;
  }
  
  pthread_mutex_lock(&pool->mutex);
  for (int i = 0; i < pool->total_blocks; i++) {
    if (pool->blocks[i] == ptr) {
      pool->in_use[i] = 0;
      pthread_mutex_unlock(&pool->mutex);
      return;
    }
  }
  pthread_mutex_unlock(&pool->mutex);
  
  free(ptr);  // Not in pool, regular free
}

// Connection pool functions
static void init_connection_pool(int pool_size) {
  g_conn_pool.connections = calloc(pool_size, sizeof(struct evhttp_connection*));
  g_conn_pool.in_use = calloc(pool_size, sizeof(int));
  g_conn_pool.size = pool_size;
  pthread_mutex_init(&g_conn_pool.mutex, NULL);
}

static struct evhttp_connection* get_connection_from_pool() {
  pthread_mutex_lock(&g_conn_pool.mutex);
  for (int i = 0; i < g_conn_pool.size; i++) {
    if (!g_conn_pool.in_use[i] && g_conn_pool.connections[i]) {
      g_conn_pool.in_use[i] = 1;
      pthread_mutex_unlock(&g_conn_pool.mutex);
      return g_conn_pool.connections[i];
    }
  }
  pthread_mutex_unlock(&g_conn_pool.mutex);
  return NULL;
}

static void return_connection_to_pool(struct evhttp_connection *conn) {
  if (!conn) return;
  
  pthread_mutex_lock(&g_conn_pool.mutex);
  for (int i = 0; i < g_conn_pool.size; i++) {
    if (g_conn_pool.connections[i] == conn) {
      g_conn_pool.in_use[i] = 0;
      pthread_mutex_unlock(&g_conn_pool.mutex);
      return;
    }
  }
  pthread_mutex_unlock(&g_conn_pool.mutex);
  
  // Not in pool, free it
  evhttp_connection_free(conn);
}

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

// Safe strlcpy
static size_t s_strlcpy(char *dst, const char *src, size_t size) {
  size_t len = src ? strlen(src) : 0;
  if (size) {
    size_t cpy = (len >= size) ? size - 1 : len;
    if (cpy) memcpy(dst, src, cpy);
    dst[cpy] = 0;
  }
  return len;
}

// CORS helpers
static void send_cors_preflight(struct evhttp_request *req) {
  struct evkeyvalq *out = evhttp_request_get_output_headers(req);
  evhttp_add_header(out, "Access-Control-Allow-Origin", "*");
  evhttp_add_header(out, "Access-Control-Allow-Methods", "GET, OPTIONS");
  evhttp_add_header(out, "Access-Control-Allow-Headers", "*");
  evhttp_add_header(out, "Access-Control-Max-Age", "600");
  evhttp_send_reply(req, 204, "No Content", NULL);
}

static void add_cors_headers(struct evhttp_request *req) {
  struct evkeyvalq *out = evhttp_request_get_output_headers(req);
  evhttp_add_header(out, "Access-Control-Allow-Origin", "*");
  evhttp_add_header(out, "Access-Control-Expose-Headers", "*");
}

// URL resolution
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

// Cache functions with hash table
static int cache_hash(const char *url) {
  unsigned long hash = 5381;
  int c;
  while ((c = *url++))
    hash = ((hash << 5) + hash) + c;
  return hash % CACHE_HASH_SIZE;
}

static cache_item_t* cache_find(const char *url) {
  int bucket_idx = cache_hash(url);
  cache_bucket_t *bucket = &g_cache_buckets[bucket_idx];
  
  pthread_mutex_lock(&bucket->mutex);
  for (int i = 0; i < bucket->count; i++) {
    if (strcmp(bucket->items[i].url, url) == 0) {
      bucket->items[i].ts = time(NULL); // Refresh timestamp
      bucket->items[i].in_use = 1;      // Mark as in use
      pthread_mutex_unlock(&bucket->mutex);
      
      pthread_mutex_lock(&g_stats_mutex);
      g_stats.cache_hits++;
      pthread_mutex_unlock(&g_stats_mutex);
      
      return &bucket->items[i];
    }
  }
  pthread_mutex_unlock(&bucket->mutex);
  
  pthread_mutex_lock(&g_stats_mutex);
  g_stats.cache_misses++;
  pthread_mutex_unlock(&g_stats_mutex);
  
  return NULL;
}

static void cache_put(const char *url, uint8_t *data, size_t size) {
  int bucket_idx = cache_hash(url);
  cache_bucket_t *bucket = &g_cache_buckets[bucket_idx];
  
  pthread_mutex_lock(&bucket->mutex);
  
  // Check if already exists
  for (int i = 0; i < bucket->count; i++) {
    if (strcmp(bucket->items[i].url, url) == 0) {
      if (bucket->items[i].data) free(bucket->items[i].data);
      bucket->items[i].data = data;
      bucket->items[i].size = size;
      bucket->items[i].ts = time(NULL);
      bucket->items[i].in_use = 0;
      pthread_mutex_unlock(&bucket->mutex);
      return;
    }
  }
  
  // Add new item
  if (bucket->count >= bucket->capacity) {
    // Find oldest unused item
    int oldest_idx = -1;
    time_t oldest_time = time(NULL);
    
    for (int i = 0; i < bucket->count; i++) {
      if (!bucket->items[i].in_use && bucket->items[i].ts < oldest_time) {
        oldest_time = bucket->items[i].ts;
        oldest_idx = i;
      }
    }
    
    if (oldest_idx >= 0) {
      // Replace oldest item
      if (bucket->items[oldest_idx].data) free(bucket->items[oldest_idx].data);
      s_strlcpy(bucket->items[oldest_idx].url, url, sizeof(bucket->items[oldest_idx].url));
      bucket->items[oldest_idx].data = data;
      bucket->items[oldest_idx].size = size;
      bucket->items[oldest_idx].ts = time(NULL);
      bucket->items[oldest_idx].in_use = 0;
    } else if (bucket->count < MAX_CACHE_ITEMS) {
      // Expand bucket
      cache_item_t *new_items = realloc(bucket->items, (bucket->count + 1) * sizeof(cache_item_t));
      if (new_items) {
        bucket->items = new_items;
        bucket->capacity = bucket->count + 1;
        s_strlcpy(bucket->items[bucket->count].url, url, sizeof(bucket->items[bucket->count].url));
        bucket->items[bucket->count].data = data;
        bucket->items[bucket->count].size = size;
        bucket->items[bucket->count].ts = time(NULL);
        bucket->items[bucket->count].in_use = 0;
        bucket->count++;
      } else {
        free(data); // Failed to expand, free the data
      }
    } else {
      free(data); // Bucket full, can't add
    }
  } else {
    // Add to existing slot
    s_strlcpy(bucket->items[bucket->count].url, url, sizeof(bucket->items[bucket->count].url));
    bucket->items[bucket->count].data = data;
    bucket->items[bucket->count].size = size;
    bucket->items[bucket->count].ts = time(NULL);
    bucket->items[bucket->count].in_use = 0;
    bucket->count++;
  }
  
  pthread_mutex_unlock(&bucket->mutex);
}

static void cache_cleanup_expired() {
  time_t now = time(NULL);
  
  for (int bucket_idx = 0; bucket_idx < CACHE_HASH_SIZE; bucket_idx++) {
    cache_bucket_t *bucket = &g_cache_buckets[bucket_idx];
    pthread_mutex_lock(&bucket->mutex);
    
    for (int i = 0; i < bucket->count;) {
      if (now - bucket->items[i].ts > STREAM_TIMEOUT_SEC && !bucket->items[i].in_use) {
        if (bucket->items[i].data) free(bucket->items[i].data);
        // Shift items
        memmove(&bucket->items[i], &bucket->items[i+1], (bucket->count-i-1)*sizeof(cache_item_t));
        bucket->count--;
      } else {
        i++;
      }
    }
    
    pthread_mutex_unlock(&bucket->mutex);
  }
}

// Upstream client context
typedef struct proxy_ctx {
  struct evhttp_request *down_req;
  struct evhttp_connection *up_conn;
  struct evhttp_request *up_req;
  int is_m3u8;
  int started;
  struct evbuffer *agg;
  int do_cache;
  char cache_key[2048];
  uint8_t *cbuf;
  size_t csize, ccap;
  int redirects;
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
    // Zero-copy buffer transfer
    if (!cx->started) {
      struct evkeyvalq *out = evhttp_request_get_output_headers(cx->down_req);
      add_cors_headers(cx->down_req);
      const char *ct = evhttp_find_header(evhttp_request_get_input_headers(up), "Content-Type");
      evhttp_add_header(out, "Content-Type", ct ? ct : "video/MP2T");
      evhttp_send_reply_start(cx->down_req, 200, "OK");
      cx->started = 1;
    }
    
    // Direct buffer transfer - no copying
    evhttp_send_reply_chunk(cx->down_req, in);
    
    // Async cache append
    if (cx->do_cache) {
      if (cx->csize + n > cx->ccap) {
        size_t ncap = cx->ccap ? cx->ccap : 128*1024;
        while (ncap < cx->csize + n) ncap <<= 1;
        uint8_t *nb = (uint8_t*)realloc(cx->cbuf, ncap);
        if (nb) { cx->cbuf=nb; cx->ccap=ncap; }
      }
      if (cx->cbuf && cx->csize + n <= cx->ccap) {
        (void)evbuffer_copyout(in, cx->cbuf + cx->csize, n);
        cx->csize += n;
      }
    }
  }
}

static void upstream_done_cb(struct evhttp_request *up, void *arg) {
  proxy_ctx_t *cx = (proxy_ctx_t*)arg;
  
  // Handle redirects (3xx)
  int code = evhttp_request_get_response_code(up);
  if (code>=301 && code<=308) {
    const char *loc = evhttp_find_header(evhttp_request_get_input_headers(up), "Location");
    if (loc && *loc) {
      char absu[2048];
      if (strncasecmp(loc,"http://",7)==0 || strncasecmp(loc,"https://",8)==0) {
        s_strlcpy(absu, loc, sizeof(absu));
      } else {
        resolve_url(absu, sizeof(absu), cx->cache_key[0]?cx->cache_key:"", loc);
      }
      if (restart_upstream(cx, absu) == 0) {
        pthread_mutex_lock(&g_stats_mutex);
        g_stats.redirects_handled++;
        pthread_mutex_unlock(&g_stats_mutex);
        return;
      }
    }
  }

  if (cx->is_m3u8) {
    size_t len = cx->agg ? evbuffer_get_length(cx->agg) : 0;
    const unsigned char *ptr = cx->agg ? evbuffer_pullup(cx->agg, -1) : NULL;
    struct evbuffer *outb = evbuffer_new();
    if (ptr && len) {
      const char *base_url = cx->cache_key[0] ? cx->cache_key : "";
      rewrite_m3u8(base_url, (const char*)ptr, len, outb);
    }
    add_cors_headers(cx->down_req);
    struct evkeyvalq *out = evhttp_request_get_output_headers(cx->down_req);
    evhttp_add_header(out, "Content-Type", "application/vnd.apple.mpegurl");
    evhttp_send_reply(cx->down_req, 200, "OK", outb);
    if (outb) evbuffer_free(outb);
  } else {
    if (!cx->started) {
      struct evkeyvalq *out = evhttp_request_get_output_headers(cx->down_req);
      add_cors_headers(cx->down_req);
      const char *ct = evhttp_find_header(evhttp_request_get_input_headers(up), "Content-Type");
      evhttp_add_header(out, "Content-Type", ct ? ct : "video/MP2T");
      evhttp_send_reply_start(cx->down_req, 200, "OK");
    }
    evhttp_send_reply_end(cx->down_req);
    if (cx->do_cache && cx->cbuf && cx->csize>0) {
      uint8_t *copy = (uint8_t*)malloc(cx->csize);
      if (copy) {
        memcpy(copy, cx->cbuf, cx->csize);
        cache_put(cx->cache_key, copy, cx->csize);
      }
    }
  }
  
  // Cleanup
  if (cx->agg) evbuffer_free(cx->agg);
  if (cx->up_conn) return_connection_to_pool(cx->up_conn);
  if (cx->cbuf) free(cx->cbuf);
  pool_free(g_ctx_pool, cx);
  
  pthread_mutex_lock(&g_stats_mutex);
  g_stats.requests_served++;
  pthread_mutex_unlock(&g_stats_mutex);
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
  if (cx->up_conn) return_connection_to_pool(cx->up_conn);
  if (cx->cbuf) free(cx->cbuf);
  pool_free(g_ctx_pool, cx);
}

// Restart upstream on redirect
static int restart_upstream(proxy_ctx_t *cx, const char *full_url) {
  if (++cx->redirects > 5) return -1;
  if (cx->up_conn) { return_connection_to_pool(cx->up_conn); cx->up_conn=NULL; cx->up_req=NULL; }

  char scheme[8], host[256], pathq[2048]; int port=0;
  if (parse_url_full(full_url, scheme, sizeof(scheme), host, sizeof(host), &port, pathq, sizeof(pathq))<0) return -1;

  struct bufferevent *bev = NULL;
  if (strcasecmp(scheme,"https")==0) {
    SSL *ssl = SSL_new(g_ssl_client_ctx);
    bev = bufferevent_openssl_socket_new(base, -1, ssl, BUFFEREVENT_SSL_CONNECTING, BEV_OPT_CLOSE_ON_FREE);
  } else {
    bev = bufferevent_socket_new(base, -1, BEV_OPT_CLOSE_ON_FREE);
  }
  if (!bev) return -1;

  struct timeval tv = { .tv_sec = G_FETCH_TIMEOUT_MS/1000, .tv_usec = (G_FETCH_TIMEOUT_MS%1000)*1000 };
  bufferevent_set_timeouts(bev, &tv, &tv);

  struct evhttp_connection *conn = evhttp_connection_base_bufferevent_new(base, g_dns, bev, host, (unsigned short)port);
  if (!conn) { bufferevent_free(bev); return -1; }
  evhttp_connection_set_timeout(conn, MAX(1, G_FETCH_TIMEOUT_MS/1000));
  cx->up_conn = conn;

  struct evhttp_request *upreq = evhttp_request_new(upstream_done_cb, cx);
  if (!upreq) { evhttp_connection_free(conn); cx->up_conn=NULL; return -1; }
  cx->up_req = upreq;

  evhttp_request_set_header_cb(upreq, upstream_header_cb);
  evhttp_request_set_chunked_cb(upreq, upstream_chunk_cb);
  evhttp_request_set_error_cb(upreq, upstream_error_cb);

  struct evkeyvalq *hdr = evhttp_request_get_output_headers(upreq);
  evhttp_add_header(hdr, "Host", host);
  evhttp_add_header(hdr, "Connection", "keep-alive");
  evhttp_add_header(hdr, "User-Agent", "mhls-proxy/2.0");
  evhttp_add_header(hdr, "Accept-Encoding", "identity");

  if (cx->is_m3u8) s_strlcpy(cx->cache_key, full_url, sizeof(cx->cache_key));

  int result = evhttp_make_request(conn, upreq, EVHTTP_REQ_GET, pathq);
  if (result != 0) {
    evhttp_connection_free(conn);
    cx->up_conn = NULL;
    cx->up_req = NULL;
    return -1;
  }
  return 0;
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

  struct timeval tv = { .tv_sec = G_FETCH_TIMEOUT_MS/1000, .tv_usec = (G_FETCH_TIMEOUT_MS%1000)*1000 };
  bufferevent_set_timeouts(bev, &tv, &tv);

  struct evhttp_connection *conn = evhttp_connection_base_bufferevent_new(base, g_dns, bev, host, (unsigned short)port);
  if (!conn) { bufferevent_free(bev); return -1; }
  evhttp_connection_set_timeout(conn, MAX(1, G_FETCH_TIMEOUT_MS/1000));

  proxy_ctx_t *cx = (proxy_ctx_t*)pool_malloc(g_ctx_pool, sizeof(*cx));
  if (!cx) { evhttp_connection_free(conn); return -1; }
  memset(cx, 0, sizeof(*cx));
  
  cx->down_req = down_req;
  cx->up_conn = conn;
  cx->is_m3u8 = is_m3u8;
  cx->do_cache = do_cache;
  cx->redirects = 0;
  if (cache_key) s_strlcpy(cx->cache_key, cache_key, sizeof(cx->cache_key));

  struct evhttp_request *upreq = evhttp_request_new(upstream_done_cb, cx);
  if (!upreq) { evhttp_connection_free(conn); pool_free(g_ctx_pool, cx); return -1; }
  cx->up_req = upreq;

  evhttp_request_set_header_cb(upreq, upstream_header_cb);
  evhttp_request_set_chunked_cb(upreq, upstream_chunk_cb);
  evhttp_request_set_error_cb(upreq, upstream_error_cb);

  struct evkeyvalq *hdr = evhttp_request_get_output_headers(upreq);
  evhttp_add_header(hdr, "Host", host);
  evhttp_add_header(hdr, "Connection", "keep-alive");
  evhttp_add_header(hdr, "User-Agent", "mhls-proxy/2.0");
  evhttp_add_header(hdr, "Accept-Encoding", "identity");

  if (evhttp_make_request(conn, upreq, EVHTTP_REQ_GET, pathq) != 0) {
    evhttp_connection_free(conn);
    pool_free(g_ctx_pool, cx);
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
    while (j<(int)src_len && (src[j]=='\n' || src[j]=='\r')) j++;
    i=j;

    if (line[0]=='#') {
      char *p = strstr(line, "URI=\"");
      if (p) {
        p += 5;
        char *end = strchr(p, '"');
        if (end) {
          char orig[2048]; int ulen = (int)(end - p); if (ulen>(int)sizeof(orig)-1) ulen=(int)sizeof(orig)-1;
          memcpy(orig, p, ulen); orig[ulen]=0;
          char absu[2048]; resolve_url(absu, sizeof(absu), base_url, orig);
          char enc[4096]; url_encode(enc, sizeof(enc), absu);
          
          struct evbuffer *tmp = evbuffer_new();
          if (!tmp) continue;
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
      evbuffer_add_printf(out, "%s\n", line);
      continue;
    }

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

  // Cache lookup
  cache_item_t *it = cache_find(target);
  if (it) {
    struct evbuffer *buf = evbuffer_new();
    if (buf) {
      evbuffer_add_reference(buf, it->data, it->size, NULL, NULL);
      add_cors_headers(req);
      struct evkeyvalq *out = evhttp_request_get_output_headers(req);
      evhttp_add_header(out, "Content-Type", "video/MP2T");
      evhttp_send_reply(req, 200, "OK", buf);
      evbuffer_free(buf);
    }
    evhttp_uri_free(decoded);
    return;
  }

  // Stream proxy + cache fill
  if (start_upstream_request(req, target, 0, 1, target) != 0) {
    evhttp_send_error(req,502,"Upstream start failed");
  }
  evhttp_uri_free(decoded);
}

// Cleanup thread
static void* cleanup_thread(void *arg) {
  while (1) {
    sleep(30);
    cache_cleanup_expired();
  }
  return NULL;
}

// Performance monitoring thread
static void* monitor_thread(void *arg) {
  while (1) {
    sleep(60); // Her dakika
    pthread_mutex_lock(&g_stats_mutex);
    printf("Stats - Requests: %lu, Cache Hits: %lu, Misses: %lu, Redirects: %lu\n",
           g_stats.requests_served, g_stats.cache_hits, g_stats.cache_misses, g_stats.redirects_handled);
    pthread_mutex_unlock(&g_stats_mutex);
  }
  return NULL;
}

// libevent OpenSSL bufferevent creator
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

// CPU affinity setting
static void set_cpu_affinity(int worker_id) {
  cpu_set_t cpuset;
  CPU_ZERO(&cpuset);
  CPU_SET(worker_id % sysconf(_SC_NPROCESSORS_ONLN), &cpuset);
  sched_setaffinity(0, sizeof(cpuset), &cpuset);
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
  // CPU affinity
  static int worker_counter = 0;
  set_cpu_affinity(worker_counter++);
  
  // Optimized event base config
  struct event_config *cfg = event_config_new();
  event_config_set_flag(cfg, EVENT_BASE_FLAG_NO_CACHE_TIME);
  event_config_set_flag(cfg, EVENT_BASE_FLAG_EPOLL_USE_CHANGELIST);
  
  base = event_base_new_with_config(cfg);
  event_config_free(cfg);
  
  if (!base) return 1;
  
  g_dns = evdns_base_new(base, 1);
  struct evhttp *http = evhttp_new(base);

  g_ssl_ctx = SSL_CTX_new(TLS_server_method());
  if (!g_ssl_ctx || SSL_CTX_use_certificate_file(g_ssl_ctx, "cert.pem", SSL_FILETYPE_PEM) <= 0 ||
      SSL_CTX_use_PrivateKey_file(g_ssl_ctx, "key.pem", SSL_FILETYPE_PEM) <= 0) {
    fprintf(stderr, "Sertifika hatası. 'cert.pem' ve 'key.pem' oluşturun.\n");
    return 1;
  }
  
  g_ssl_client_ctx = SSL_CTX_new(TLS_client_method());
  if (!g_ssl_client_ctx) {
    fprintf(stderr, "SSL client context oluşturulamadı.\n");
    return 1;
  }
  SSL_CTX_set_session_cache_mode(g_ssl_client_ctx, SSL_SESS_CACHE_CLIENT);

  // Initialize pools
  init_connection_pool(CONNECTION_POOL_SIZE);
  g_ctx_pool = create_mem_pool(sizeof(proxy_ctx_t), CTX_POOL_SIZE);
  
  // Initialize cache buckets
  for (int i = 0; i < CACHE_HASH_SIZE; i++) {
    g_cache_buckets[i].items = NULL;
    g_cache_buckets[i].count = 0;
    g_cache_buckets[i].capacity = 0;
    pthread_mutex_init(&g_cache_buckets[i].mutex, NULL);
  }

  evhttp_set_bevcb(http, bevcb, NULL);
  evhttp_set_allowed_methods(http, EVHTTP_REQ_GET | EVHTTP_REQ_OPTIONS);
  evhttp_set_max_headers_size(http, 8192);

  int fd = create_listener_socket("0.0.0.0", PORT);
  if (fd < 0) { fprintf(stderr, "Bind hata: %s\n", strerror(errno)); return 1; }
  if (evhttp_accept_socket(http, fd) != 0) { fprintf(stderr, "evhttp_accept_socket hata\n"); return 1; }

  evhttp_set_gencb(http, general_cb, NULL);

  pthread_t cleanup_tid, monitor_tid;
  pthread_create(&cleanup_tid, NULL, cleanup_thread, NULL);
  pthread_create(&monitor_tid, NULL, monitor_thread, NULL);

  printf("CORS Proxy PID %d ready on https://localhost:%d (WORKERS=%d)\n", getpid(), PORT, G_WORKERS);

  event_base_dispatch(base);

  evhttp_free(http);
  if (g_dns) evdns_base_free(g_dns, 1);
  event_base_free(base);
  if (g_ssl_client_ctx) SSL_CTX_free(g_ssl_client_ctx);
  if (g_ssl_ctx) SSL_CTX_free(g_ssl_ctx);
  
  return 0;
}

int main() {
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