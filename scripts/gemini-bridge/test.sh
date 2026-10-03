#!/bin/bash
# Проверка: мост запущен, ключ Gemini принят. Запускайте в другом окне терминала, пока работает start.sh.
DIR="${BRIDGE_DIR:-$HOME/orchestra-gemini-bridge}"
set -a; . "$DIR/.env"; set +a
MODEL="${1:-gemini-3.8-flash}"
echo "Спрашиваю $MODEL..."
curl -s -m 60 -X POST http://127.0.0.1:4000/v1/messages \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":50,\"messages\":[{\"role\":\"user\",\"content\":\"Скажи слово: работает\"}]}"
echo
echo "Если выше есть текст ответа модели, всё хорошо. Если «API key not valid» — неверный ключ Gemini в $DIR/.env."
