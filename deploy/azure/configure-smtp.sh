#!/bin/sh
# Configura o envio de e-mails reais (SEA_SMTP_*) no .env da VM, reinicia a
# API e o worker e testa o login no servidor SMTP. A senha é digitada aqui,
# sem aparecer na tela, e só fica gravada no .env da VM.
#   ssh -t -i ~/.ssh/sea_azure seaadmin@<dominio> 'sh /opt/sea/deploy/azure/configure-smtp.sh'
set -eu
cd /opt/sea
COMPOSE="docker compose -f docker-compose.yml -f deploy/azure/docker-compose.azure.yml"

ask() { printf '%s [%s]: ' "$1" "$2" >&2; read -r v; echo "${v:-$2}"; }
HOST=$(ask "Servidor SMTP" "smtp.gmail.com")
PORT=$(ask "Porta" "587")
SECURITY=$(ask "Segurança (starttls, ssl ou none)" "starttls")
USER_NAME=$(ask "Usuário (e-mail da conta)" "")
[ -n "$USER_NAME" ] || { echo "Informe o usuário." >&2; exit 1; }
printf 'Senha (no Gmail, a senha de app de 16 letras; não aparece ao digitar): ' >&2
stty -echo; read -r PASSWORD; stty echo; echo >&2
# A senha de app do Gmail é mostrada em grupos com espaços: eles não fazem parte dela.
PASSWORD=$(printf '%s' "$PASSWORD" | tr -d ' ')
FROM=$(ask "Remetente" "SEA <$USER_NAME>")
case "$SECURITY" in starttls|ssl|none) ;; *) echo "Segurança inválida: $SECURITY" >&2; exit 1;; esac
for v in "$HOST" "$PORT" "$USER_NAME" "$PASSWORD" "$FROM"; do
  case "$v" in *"'"*) echo "Os valores não podem conter aspas simples." >&2; exit 1;; esac
done

umask 077
grep -v '^SEA_SMTP_' .env > .env.novo || true
cat >> .env.novo <<ENV
SEA_SMTP_HOST='$HOST'
SEA_SMTP_PORT='$PORT'
SEA_SMTP_SECURITY='$SECURITY'
SEA_SMTP_USER='$USER_NAME'
SEA_SMTP_PASSWORD='$PASSWORD'
SEA_SMTP_FROM='$FROM'
ENV
mv .env.novo .env
$COMPOSE up -d api celery-worker >/dev/null 2>&1
sleep 5

echo "Testando o login no servidor SMTP..."
docker exec sea-api python - <<'PY'
import smtplib, ssl
from services.notification_service import smtp_config
c = smtp_config()
ctx = ssl.create_default_context()
if c.security == "ssl":
    s = smtplib.SMTP_SSL(c.host, c.port, timeout=20, context=ctx)
else:
    s = smtplib.SMTP(c.host, c.port, timeout=20)
    if c.security == "starttls":
        s.starttls(context=ctx)
if c.user:
    s.login(c.user, c.password or "")
s.quit()
print(f"OK: login aceito em {c.host}:{c.port} ({c.security}). Remetente: {c.sender}")
PY
