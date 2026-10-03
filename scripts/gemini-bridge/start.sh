#!/bin/bash
# Запускает мост на http://127.0.0.1:4000 (только с этого компьютера). Остановка: Ctrl+C.
DIR="${BRIDGE_DIR:-$HOME/orchestra-gemini-bridge}"
[ -f "$DIR/.env" ] || { echo "Сначала выполните install.sh"; exit 1; }
set -a; . "$DIR/.env"; set +a
cd "$DIR" && exec venv/bin/litellm --config config.yaml --host 127.0.0.1 --port 4000
