#!/bin/bash
# entrypoint.sh

set -e

DOMAIN="${DOMAIN:-hls.yourdomain.com}"
EMAIL="${EMAIL:-admin@yourdomain.com}"
WORKERS="${WORKERS:-2}"
SEG_MS="${SEG_MS:-1000}"
AAC_BR="${AAC_BR:-96000}"
AAC_SR="${AAC_SR:-44100}"
AAC_CH="${AAC_CH:-1}"

CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
CERT_PEM="$CERT_DIR/fullchain.pem"
KEY_PEM="$CERT_DIR/privkey.pem"

# Sertifika yoksa oluştur (test modu)
if [ ! -f "$CERT_PEM" ]; then
    echo "Sertifika yok, Let's Encrypt ile alınıyor (test modu)..."
    certbot certonly --standalone \
        --non-interactive \
        --agree-tos \
        --email "$EMAIL" \
        --domain "$DOMAIN" \
        --dry-run  # Gerçek sertifika almak için bu satırı kaldır
fi

# Gerçek sertifika al (dry-run sonrası)
if [ ! -f "$CERT_PEM" ] && [ -z "$CERTBOT_DRY_RUN" ]; then
    echo "Gerçek sertifika alınıyor..."
    certbot certonly --standalone \
        --non-interactive \
        --agree-tos \
        --email "$EMAIL" \
        --domain "$DOMAIN"
fi

# Sertifikaları kopyala
cp "$CERT_PEM" /var/lib/hls-gateway/cert.pem
cp "$KEY_PEM" /var/lib/hls-gateway/key.pem

# Uygulamayı çalıştır
echo "HLS Gateway başlatılıyor..."
WORKERS=$WORKERS SEG_MS=$SEG_MS AAC_BR=$AAC_BR AAC_SR=$AAC_SR AAC_CH=$AAC_CH \
exec hls_gateway