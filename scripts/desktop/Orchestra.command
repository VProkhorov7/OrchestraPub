#!/bin/zsh -l
# Двойной клик: запускает Orchestra и открывает панель в браузере.
# Если служба уже работает, просто открывает панель. Окно Терминала со службой НЕ закрывайте (закрытие = остановка).
# Проверка без побочных эффектов: ORCHESTRA_DRY=1 ORCHESTRA_PORT=7791 ./Orchestra.command
# Папка с репозиторием: по умолчанию ~/Developer/Orchestra, иначе задайте ORCHESTRA_REPO.
REPO="${ORCHESTRA_REPO:-$HOME/Developer/Orchestra}"
PORT="${ORCHESTRA_PORT:-7777}"
HOST="127.0.0.1"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
# Открыть панель: если вкладка с ней уже есть в Яндекс.Браузере — показать её и обновить, иначе открыть новую.
open_panel() {
  local url="$1"
  if [ -n "$ORCHESTRA_DRY" ]; then echo "[dry-run] open_panel $url"; return; fi
  local found
  found=$(osascript - "$HOST:$PORT" <<'OSA' 2>/dev/null
on run argv
  set needle to item 1 of argv
  if application "Yandex" is not running then return "no"
  tell application "Yandex"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if URL of t contains needle then
          set active tab index of w to i
          set index of w to 1
          reload t
          activate
          return "yes"
        end if
      end repeat
    end repeat
  end tell
  return "no"
end run
OSA
)
  [ "$found" = "yes" ] || open "$url"
}

run() { if [ -n "$ORCHESTRA_DRY" ]; then echo "[dry-run] $*"; else "$@"; fi; }

cd "$REPO" || { echo "Нет папки $REPO (диск подключён?)"; read -k1 "?Нажмите любую клавишу…"; exit 1; }

TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/Orchestra/serve.json')))['token'])" 2>/dev/null)
URL="http://$HOST:$PORT/?token=$TOKEN"

if curl -s -m 2 -o /dev/null "http://$HOST:$PORT/"; then
  echo "Orchestra уже работает на порту $PORT: открываю панель."
  open_panel "$URL"
  # Служба уже работает: окно Терминала не нужно, закрываю его (только это окно, по tty).
  if [ -z "$ORCHESTRA_DRY" ] && [ "$TERM_PROGRAM" = "Apple_Terminal" ]; then
    MYTTY=$(tty)
    nohup osascript -e "delay 1" -e "tell application \"Terminal\" to close (every window whose tty of selected tab is \"$MYTTY\")" >/dev/null 2>&1 &
    disown
  fi
  exit 0
fi

# Сборка, если её нет или исходники новее.
if [ ! -f dist/server/serve.js ] || [ -n "$(find src -newer dist/server/serve.js -name '*.ts' -print -quit 2>/dev/null)" ]; then
  echo "Собираю Orchestra…"
  [ -d node_modules ] || run npm install --no-audit --no-fund
  run npm run build || { echo "Сборка не удалась: npm run build"; read -k1 "?Нажмите любую клавишу…"; exit 1; }
  run chmod +x dist/memory/cli.js dist/mcp/server.js dist/doctor/cli.js
fi

# CodexBar (лимиты Claude) должен работать в фоне.
pgrep -x CodexBar >/dev/null || run open -g -a CodexBar

echo "Orchestra: $URL"
echo "Служба работает в этом окне. Закройте окно или нажмите Ctrl+C, чтобы остановить."
if [ -z "$ORCHESTRA_DRY" ]; then (sleep 3; open_panel "$URL") & fi
run exec node dist/server/serve.js --host "$HOST" --port "$PORT"
