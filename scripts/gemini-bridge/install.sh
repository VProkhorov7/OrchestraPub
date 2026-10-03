#!/bin/bash
# Устанавливает мост LiteLLM (Claude Code <-> Gemini) в ~/orchestra-gemini-bridge.
# Версия LiteLLM закреплена: 1.82.7 и 1.82.8 были заражены (март 2026), 1.82.6 — последняя подтверждённая чистая.
set -e
DIR="${BRIDGE_DIR:-$HOME/orchestra-gemini-bridge}"
SRC="$(cd "$(dirname "$0")" && pwd)"
LITELLM_VERSION="1.82.6"

command -v python3 >/dev/null || { echo "Нет python3. Установите Python (python.org) и повторите."; exit 1; }

mkdir -p "$DIR"
python3 -m venv "$DIR/venv"
"$DIR/venv/bin/pip" install -q --disable-pip-version-check "litellm[proxy]==$LITELLM_VERSION"
if find "$DIR/venv" -name litellm_init.pth | grep -q .; then
  echo "ОПАСНО: найден litellm_init.pth. Удалите $DIR и не запускайте мост."; exit 1
fi
cp "$SRC/config.yaml" "$DIR/config.yaml"

if [ ! -f "$DIR/.env" ]; then
  echo
  echo "Вставьте ключ Gemini из aistudio.google.com/apikey (вводимый текст не виден), затем Enter:"
  read -rs GEMINI_KEY
  echo
  [ -n "$GEMINI_KEY" ] || { echo "Ключ пустой, установка прервана."; exit 1; }
  MASTER="sk-$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
  umask 077
  printf 'GEMINI_API_KEY=%s\nLITELLM_MASTER_KEY=%s\n' "$GEMINI_KEY" "$MASTER" > "$DIR/.env"
fi

echo
echo "Готово. Установлено в $DIR"
echo "Пароль моста для Orchestra (поле «Ключ»):"
grep '^LITELLM_MASTER_KEY=' "$DIR/.env" | cut -d= -f2
echo "Дальше: scripts/gemini-bridge/start.sh"
