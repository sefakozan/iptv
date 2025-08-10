#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>
#include <pthread.h>

#define HLS_DIR "/tmp/hls_output"
#define HLS_PLAYLIST "stream.m3u8"
#define HLS_SEGMENT_PREFIX "segment"
#define HLS_SEGMENT_DURATION 6
#define PORT 8000
#define BUFFER_SIZE 4096
#define MAX_URL_LENGTH 1024

AVFormatContext *input_ctx = NULL, *output_ctx = NULL;
AVCodecContext *audio_dec_ctx = NULL, *audio_enc_ctx = NULL;
int server_fd = -1;
int ffmpeg_running = 0;
pthread_t ffmpeg_thread;

void cleanup()
{
  if (audio_enc_ctx)
  {
    avcodec_free_context(&audio_enc_ctx);
  }
  if (audio_dec_ctx)
  {
    avcodec_free_context(&audio_dec_ctx);
  }
  if (output_ctx)
  {
    av_write_trailer(output_ctx);
    avio_closep(&output_ctx->pb);
    avformat_free_context(output_ctx);
    output_ctx = NULL;
  }
  if (input_ctx)
  {
    avformat_close_input(&input_ctx);
    input_ctx = NULL;
  }
  if (server_fd >= 0)
  {
    close(server_fd);
    server_fd = -1;
  }
  DIR *dir = opendir(HLS_DIR);
  if (dir)
  {
    struct dirent *entry;
    while ((entry = readdir(dir)))
    {
      if (entry->d_type == DT_REG)
      {
        char path[256];
        snprintf(path, sizeof(path), "%s/%s", HLS_DIR, entry->d_name);
        unlink(path);
      }
    }
    closedir(dir);
    rmdir(HLS_DIR);
  }
  ffmpeg_running = 0;
  printf("Cleanup completed\n");
}

void signal_handler(int sig)
{
  printf("\nShutting down...\n");
  cleanup();
  exit(0);
}

int setup_audio_codec(AVStream *in_stream, AVStream *out_stream)
{
  int ret;
  const AVCodec *dec_codec = avcodec_find_decoder(in_stream->codecpar->codec_id);
  const AVCodec *enc_codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
  if (!dec_codec || !enc_codec)
  {
    fprintf(stderr, "Codec not found: decoder=%p, encoder=%p\n", dec_codec, enc_codec);
    return AVERROR(ENOSYS);
  }

  audio_dec_ctx = avcodec_alloc_context3(dec_codec);
  audio_enc_ctx = avcodec_alloc_context3(enc_codec);
  if (!audio_dec_ctx || !audio_enc_ctx)
  {
    fprintf(stderr, "Failed to allocate codec contexts\n");
    return AVERROR(ENOMEM);
  }

  if ((ret = avcodec_parameters_to_context(audio_dec_ctx, in_stream->codecpar)) < 0)
  {
    fprintf(stderr, "Failed to copy decoder parameters: %s\n", av_err2str(ret));
    return ret;
  }

  if ((ret = avcodec_open2(audio_dec_ctx, dec_codec, NULL)) < 0)
  {
    fprintf(stderr, "Failed to open decoder: %s\n", av_err2str(ret));
    return ret;
  }

  audio_enc_ctx->sample_rate = in_stream->codecpar->sample_rate;
  if ((ret = av_channel_layout_copy(&audio_enc_ctx->ch_layout, &in_stream->codecpar->ch_layout)) < 0)
  {
    fprintf(stderr, "Failed to copy channel layout: %s\n", av_err2str(ret));
    return ret;
  }
  audio_enc_ctx->bit_rate = 192000;
  audio_enc_ctx->sample_fmt = enc_codec->sample_fmts ? enc_codec->sample_fmts[0] : AV_SAMPLE_FMT_FLTP;
  if ((ret = avcodec_open2(audio_enc_ctx, enc_codec, NULL)) < 0)
  {
    fprintf(stderr, "Failed to open encoder: %s\n", av_err2str(ret));
    return ret;
  }

  if ((ret = avcodec_parameters_from_context(out_stream->codecpar, audio_enc_ctx)) < 0)
  {
    fprintf(stderr, "Failed to copy encoder parameters: %s\n", av_err2str(ret));
    return ret;
  }

  out_stream->time_base = (AVRational){1, audio_enc_ctx->sample_rate};
  return 0;
}

int setup_ffmpeg(const char *input_url)
{
  int ret;

  if ((ret = avformat_open_input(&input_ctx, input_url, NULL, NULL)) < 0)
  {
    fprintf(stderr, "Could not open input: %s\n", av_err2str(ret));
    return ret;
  }

  if ((ret = avformat_find_stream_info(input_ctx, NULL)) < 0)
  {
    fprintf(stderr, "Could not find stream info: %s\n", av_err2str(ret));
    return ret;
  }

  mkdir(HLS_DIR, 0755);

  if ((ret = avformat_alloc_output_context2(&output_ctx, NULL, "hls", HLS_DIR "/" HLS_PLAYLIST)) < 0)
  {
    fprintf(stderr, "Could not create output context: %s\n", av_err2str(ret));
    return ret;
  }

  av_opt_set_int(output_ctx->priv_data, "hls_time", HLS_SEGMENT_DURATION, 0);
  av_opt_set_int(output_ctx->priv_data, "hls_list_size", 10, 0);
  av_opt_set(output_ctx->priv_data, "hls_segment_filename", HLS_DIR "/" HLS_SEGMENT_PREFIX "%03d.ts", 0);
  av_opt_set(output_ctx->priv_data, "hls_flags", "delete_segments", 0);

  for (unsigned int i = 0; i < input_ctx->nb_streams; i++)
  {
    AVStream *in_stream = input_ctx->streams[i];
    AVStream *out_stream = avformat_new_stream(output_ctx, NULL);
    if (!out_stream)
    {
      fprintf(stderr, "Failed to allocate output stream\n");
      return AVERROR(ENOMEM);
    }

    if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO)
    {
      avcodec_parameters_copy(out_stream->codecpar, in_stream->codecpar);
      out_stream->time_base = in_stream->time_base;
    }
    else if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO)
    {
      if ((ret = setup_audio_codec(in_stream, out_stream)) < 0)
      {
        return ret;
      }
    }
    else
    {
      continue; // Skip EPG data
    }
  }

  if (!(output_ctx->oformat->flags & AVFMT_NOFILE))
  {
    if ((ret = avio_open(&output_ctx->pb, HLS_DIR "/" HLS_PLAYLIST, AVIO_FLAG_WRITE)) < 0)
    {
      fprintf(stderr, "Could not open output file: %s\n", av_err2str(ret));
      return ret;
    }
  }

  if ((ret = avformat_write_header(output_ctx, NULL)) < 0)
  {
    fprintf(stderr, "Error writing header: %s\n", av_err2str(ret));
    return ret;
  }

  return 0;
}

void *process_stream(void *arg)
{
  AVPacket *pkt = av_packet_alloc();
  AVFrame *frame = av_frame_alloc();
  if (!pkt || !frame)
  {
    fprintf(stderr, "Failed to allocate packet or frame\n");
    if (pkt)
      av_packet_free(&pkt);
    if (frame)
      av_frame_free(&frame);
    return NULL;
  }

  while (ffmpeg_running && av_read_frame(input_ctx, pkt) >= 0)
  {
    int ret;
    AVStream *in_stream = input_ctx->streams[pkt->stream_index];
    if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_DATA)
    {
      av_packet_unref(pkt);
      continue; // Skip EPG data
    }

    AVStream *out_stream = output_ctx->streams[pkt->stream_index];

    if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO)
    {
      if ((ret = avcodec_send_packet(audio_dec_ctx, pkt)) < 0)
      {
        fprintf(stderr, "Error decoding audio packet: %s\n", av_err2str(ret));
        av_packet_unref(pkt);
        continue;
      }

      while (ret >= 0)
      {
        ret = avcodec_receive_frame(audio_dec_ctx, frame);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF)
          break;
        if (ret < 0)
        {
          fprintf(stderr, "Error receiving audio frame: %s\n", av_err2str(ret));
          break;
        }

        if ((ret = avcodec_send_frame(audio_enc_ctx, frame)) < 0)
        {
          fprintf(stderr, "Error sending audio frame: %s\n", av_err2str(ret));
          break;
        }

        AVPacket *enc_pkt = av_packet_alloc();
        if (!enc_pkt)
        {
          fprintf(stderr, "Failed to allocate encoded packet\n");
          break;
        }

        while (ret >= 0)
        {
          ret = avcodec_receive_packet(audio_enc_ctx, enc_pkt);
          if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF)
            break;
          if (ret < 0)
          {
            fprintf(stderr, "Error encoding audio packet: %s\n", av_err2str(ret));
            break;
          }

          enc_pkt->stream_index = pkt->stream_index;
          enc_pkt->pts = av_rescale_q_rnd(enc_pkt->pts, audio_enc_ctx->time_base, out_stream->time_base, AV_ROUND_NEAR_INF);
          enc_pkt->dts = av_rescale_q_rnd(enc_pkt->dts, audio_enc_ctx->time_base, out_stream->time_base, AV_ROUND_NEAR_INF);
          enc_pkt->duration = av_rescale_q(enc_pkt->duration, audio_enc_ctx->time_base, out_stream->time_base);
          enc_pkt->pos = -1;

          if ((ret = av_interleaved_write_frame(output_ctx, enc_pkt)) < 0)
          {
            fprintf(stderr, "Error writing audio frame: %s\n", av_err2str(ret));
          }
          av_packet_unref(enc_pkt);
        }
        av_packet_free(&enc_pkt);
      }
    }
    else
    {
      pkt->pts = av_rescale_q_rnd(pkt->pts, in_stream->time_base, out_stream->time_base, AV_ROUND_NEAR_INF);
      pkt->dts = av_rescale_q_rnd(pkt->dts, in_stream->time_base, out_stream->time_base, AV_ROUND_NEAR_INF);
      pkt->duration = av_rescale_q(pkt->duration, in_stream->time_base, out_stream->time_base);
      pkt->pos = -1;

      if ((ret = av_interleaved_write_frame(output_ctx, pkt)) < 0)
      {
        fprintf(stderr, "Error writing video frame: %s\n", av_err2str(ret));
      }
    }
    av_packet_unref(pkt);
  }

  av_packet_free(&pkt);
  av_frame_free(&frame);
  return NULL;
}

char *parse_url_param(const char *query)
{
  if (!query)
    return NULL;
  char *url_start = strstr(query, "url=");
  if (!url_start)
    return NULL;
  url_start += 4;
  char *url_end = strchr(url_start, '&');
  size_t url_len = url_end ? (size_t)(url_end - url_start) : strlen(url_start);
  if (url_len >= MAX_URL_LENGTH)
    return NULL;

  char *url = malloc(url_len + 1);
  if (!url)
    return NULL;
  strncpy(url, url_start, url_len);
  url[url_len] = '\0';
  return url;
}

void send_file(int client_fd, const char *file_path, const char *method)
{
  int fd = open(file_path, O_RDONLY);
  if (fd < 0)
  {
    char response[] = "HTTP/1.1 404 Not Found\r\n\r\n";
    write(client_fd, response, strlen(response));
    return;
  }

  struct stat st;
  fstat(fd, &st);

  char header[256];
  const char *content_type = strstr(file_path, ".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";

  if (strcmp(method, "HEAD") == 0)
  {
    snprintf(header, sizeof(header), "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %ld\r\n\r\n",
             content_type, st.st_size);
    write(client_fd, header, strlen(header));
  }
  else if (strcmp(method, "GET") == 0)
  {
    snprintf(header, sizeof(header), "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %ld\r\n\r\n",
             content_type, st.st_size);
    write(client_fd, header, strlen(header));

    char buffer[BUFFER_SIZE];
    ssize_t bytes;
    while ((bytes = read(fd, buffer, BUFFER_SIZE)) > 0)
    {
      write(client_fd, buffer, bytes);
    }
  }

  close(fd);
}

void handle_client(int client_fd)
{
  char buffer[BUFFER_SIZE];
  int bytes_read = read(client_fd, buffer, BUFFER_SIZE - 1);
  if (bytes_read < 0)
  {
    close(client_fd);
    return;
  }
  buffer[bytes_read] = '\0';

  char *method = strtok(buffer, " ");
  char *path = strtok(NULL, " ");
  if (!method || !path)
  {
    close(client_fd);
    return;
  }

  char *query = strchr(path, '?');
  if (query)
    *query++ = '\0';

  char file_path[256];
  snprintf(file_path, sizeof(file_path), "%s/%s", HLS_DIR, path[0] == '/' ? path + 1 : path);

  if (strcmp(path, "/stream") == 0 && query)
  {
    char *input_url = parse_url_param(query);
    if (input_url)
    {
      if (!ffmpeg_running)
      {
        if (setup_ffmpeg(input_url) == 0)
        {
          ffmpeg_running = 1;
          pthread_create(&ffmpeg_thread, NULL, process_stream, NULL);
          pthread_detach(ffmpeg_thread);
          char response[256];
          snprintf(response, sizeof(response), "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nHLS stream available at /%s", HLS_PLAYLIST);
          write(client_fd, response, strlen(response));
        }
        else
        {
          char response[] = "HTTP/1.1 500 Internal Server Error\r\n\r\nFailed to start FFmpeg\n";
          write(client_fd, response, strlen(response));
        }
        free(input_url);
      }
      else
      {
        char response[] = "HTTP/1.1 409 Conflict\r\n\r\nFFmpeg already running\n";
        write(client_fd, response, strlen(response));
      }
    }
    else
    {
      char response[] = "HTTP/1.1 400 Bad Request\r\n\r\nInvalid or missing URL parameter\n";
      write(client_fd, response, strlen(response));
    }
  }
  else if (strstr(file_path, HLS_PLAYLIST) || strstr(file_path, HLS_SEGMENT_PREFIX))
  {
    send_file(client_fd, file_path, method);
  }
  else
  {
    char response[] = "HTTP/1.1 404 Not Found\r\n\r\n";
    write(client_fd, response, strlen(response));
  }

  close(client_fd);
}

void start_server()
{
  server_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (server_fd < 0)
  {
    perror("Socket creation failed");
    exit(1);
  }

  struct sockaddr_in server_addr = {0};
  server_addr.sin_family = AF_INET;
  server_addr.sin_addr.s_addr = INADDR_ANY;
  server_addr.sin_port = htons(PORT);

  int opt = 1;
  setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

  if (bind(server_fd, (struct sockaddr *)&server_addr, sizeof(server_addr)) < 0)
  {
    perror("Bind failed");
    exit(1);
  }

  if (listen(server_fd, 10) < 0)
  {
    perror("Listen failed");
    exit(1);
  }

  printf("Server running at http://localhost:%d/\n", PORT);
  printf("Start stream with: http://localhost:%d/stream?url=<input_url>\n", PORT);
  printf("Access HLS at: http://localhost:%d/%s\n", PORT, HLS_PLAYLIST);

  while (1)
  {
    struct sockaddr_in client_addr;
    socklen_t client_len = sizeof(client_addr);
    int client_fd = accept(server_fd, (struct sockaddr *)&client_addr, &client_len);
    if (client_fd < 0)
    {
      perror("Accept failed");
      continue;
    }
    handle_client(client_fd);
  }
}

int main()
{
  signal(SIGINT, signal_handler);
  signal(SIGTERM, signal_handler);
  start_server();
  cleanup();
  return 0;
}