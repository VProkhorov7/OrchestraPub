#!/bin/zsh -l
# Orchestra: запуск, перезапуск и остановка службы одним файлом. Двойной клик.
#
#   Orchestra.command            запустить службу (если не работает) и открыть панель      (действие up)
#   Orchestra-restart.command    перезапустить службу; пока идут задачи воркеров — не трогает, спросит (restart)
#   Orchestra-stop.command       остановить службу и не запускать при входе                (stop)
# На рабочем столе это переходники, а настоящий файл один: scripts/desktop/Orchestra.command <действие>.
# Действие можно задать и вручную: Orchestra.command status
#
# Служба живёт под launchd (стартует при входе, не зависит от окон Терминала). Этот файл только управляет ею:
# сам находит репозиторий, пересобирает при изменениях в src/, чинит файл агента, если папка переехала,
# открывает панель в уже открытой вкладке и закрывает своё окно Терминала.
# Поставить на рабочий стол (три маленьких переходника):  scripts/desktop/install.sh
# Проверка без побочных эффектов: ORCHESTRA_DRY=1 ./Orchestra.command

export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
SELF="${0:A}"
REPO="${ORCHESTRA_REPO:-${SELF:h:h:h}}"
[ -f "$REPO/package.json" ] || REPO="$(cat "$HOME/.orchestra-repo" 2>/dev/null)"

pause() { [ -n "$ORCHESTRA_DRY" ] || { echo; read -k1 "?Нажмите любую клавишу…"; }; }
fail() { echo "$*"; pause; exit 1; }

[ -f "$REPO/package.json" ] || fail "Не нашёл папку Orchestra. Поставьте ярлыки скриптом scripts/desktop/install.sh или задайте ORCHESTRA_REPO."
command -v node >/dev/null 2>&1 || fail "Не найден Node.js. Установите: brew install node"
cd "$REPO" || fail "Нет папки $REPO (диск подключён?)"

ACTION="${1:-up}"                      # up | restart | stop | status

# --- сборка, если нет или исходники новее
REBUILT=
if [ ! -f dist/server/ctl.js ] || [ -n "$(find src -name '*.ts' -newer dist/server/ctl.js -print -quit 2>/dev/null)" ]; then
  echo "Собираю Orchestra…"
  if [ -z "$ORCHESTRA_DRY" ]; then
    [ -d node_modules ] || npm install --no-audit --no-fund || fail "npm install не удался"
    npm run build >/dev/null || fail "Сборка не удалась: npm run build"
    chmod +x dist/memory/cli.js dist/mcp/server.js dist/doctor/cli.js dist/server/*.js 2>/dev/null
  else echo "[dry-run] npm run build"; fi
  REBUILT=1
fi

# --- открыть панель: показать уже открытую вкладку (и обновить её), иначе новая
open_panel() {
  local url="$1" needle b found
  needle="${${url%%\?*}#http://}"        # 127.0.0.1:7777/ — без токена
  if [ -n "$ORCHESTRA_DRY" ]; then echo "[dry-run] открыть панель $url"; return; fi
  for b in "Yandex" "Google Chrome" "Brave Browser" "Microsoft Edge" "Chromium" "Arc"; do
    [ -d "/Applications/$b.app" ] || [ -d "$HOME/Applications/$b.app" ] || continue
    found=$(osascript 2>/dev/null <<OSA
if application "$b" is not running then return "no"
tell application "$b"
  repeat with w in windows
    set i to 0
    repeat with t in tabs of w
      set i to i + 1
      if URL of t contains "$needle" then
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
OSA
)
    [ "$found" = "yes" ] && return
  done
  open "$url"
}

# --- закрыть своё окно Терминала (только его, по tty)
close_window() {
  [ -n "$ORCHESTRA_DRY" ] || [ -n "$ORCHESTRA_KEEP" ] && return
  [ "$TERM_PROGRAM" = "Apple_Terminal" ] || return
  local t; t=$(tty)
  nohup osascript -e "delay 1" -e "tell application \"Terminal\" to close (every window whose tty of selected tab is \"$t\")" >/dev/null 2>&1 &
  disown
}

ctl() {
  if [ -n "$ORCHESTRA_DRY" ]; then echo "[dry-run] orchestra-ctl $*"; return 0; fi
  node dist/server/ctl.js "$@"
}

# --- действие
OUT=$(ctl "$ACTION" ${ORCHESTRA_FORCE:+--force} 2>&1); RC=$?
# после пересборки работающая служба ещё на старом коде: поменялось — перезапустим (если не заняты воркеры)
if [ "$ACTION" = up ] && [ -n "$REBUILT" ] && [ $RC -eq 0 ]; then
  OUT2=$(ctl restart 2>&1); RC2=$?
  if [ $RC2 -eq 3 ]; then OUT="$OUT"$'\n'"Код обновлён, но идут задачи воркеров: перезапустите службу позже (Orchestra-restart.command)."
  else OUT="$OUT2"; RC=$RC2; fi
fi
print -r -- "$OUT" | grep -v '^URL '
URL=$(print -r -- "$OUT" | sed -n 's/^URL //p' | tail -1)

if [ $RC -eq 3 ] && [ "$ACTION" = restart ] && [ -z "$ORCHESTRA_DRY" ]; then
  read -q "?Перезапустить всё равно, оборвав задачи? [y/N] " && { echo; OUT=$(ctl restart --force 2>&1); RC=$?; print -r -- "$OUT" | grep -v '^URL '; URL=$(print -r -- "$OUT" | sed -n 's/^URL //p' | tail -1); } || { echo; echo "Оставил как есть."; }
fi

if [ -n "$URL" ] && { [ $RC -eq 0 ] || [ "$ACTION" = up ]; }; then open_panel "$URL"; fi
if [ $RC -eq 0 ]; then close_window; else pause; fi
exit $RC
