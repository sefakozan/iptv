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

mkdir -p /var/lib/hls-gateway

# Sertifika elde etme: önce mevcut ise kullan, değilse opsiyonel certbot, son çare self-signed
if [ -f "$CERT_PEM" ] && [ -f "$KEY_PEM" ]; then
    echo "Let's Encrypt sertifikaları bulundu."
    cp "$CERT_PEM" /var/lib/hls-gateway/cert.pem
    cp "$KEY_PEM" /var/lib/hls-gateway/key.pem
else
    if [ -z "$DISABLE_CERTBOT" ]; then
        echo "Let's Encrypt deneniyor... (başarısız olursa self-signed)"
        set +e
        certbot certonly --standalone \
            --non-interactive \
            --agree-tos \
            --email "$EMAIL" \
            --domain "$DOMAIN" \
            ${CERTBOT_DRY_RUN:+--dry-run}
        CB_RC=$?
        set -e
    else
        CB_RC=1
    fi

    if [ $CB_RC -eq 0 ] && [ -f "$CERT_PEM" ] && [ -f "$KEY_PEM" ]; then
        echo "Let's Encrypt başarıyla alındı."
        cp "$CERT_PEM" /var/lib/hls-gateway/cert.pem
        cp "$KEY_PEM" /var/lib/hls-gateway/key.pem
    else
        echo "Self-signed sertifika oluşturuluyor..."
        openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
            -subj "/CN=${DOMAIN}" \
            -keyout /var/lib/hls-gateway/key.pem \
            -out /var/lib/hls-gateway/cert.pem
    fi
fi

# Çalışma dizinini sertifika dizinine al ki uygulama cert.pem/key.pem'i bulsun
cd /var/lib/hls-gateway

# Uygulamayı çalıştır
echo "HLS Gateway başlatılıyor..."
WORKERS=$WORKERS SEG_MS=$SEG_MS AAC_BR=$AAC_BR AAC_SR=$AAC_SR AAC_CH=$AAC_CH \
exec hls_gateway