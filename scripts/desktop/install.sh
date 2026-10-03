#!/bin/zsh
# Ставит на рабочий стол ярлыки Orchestra / Orchestra-restart / Orchestra-stop.
# Это маленькие файлы-переходники: каждый запускает scripts/desktop/Orchestra.command из этого репозитория с нужным действием.
# Путь к репозиторию записывается один раз в ~/.orchestra-repo; переехали папкой — запустите install.sh снова.
# Старые файлы с этими именами (не наши) не удаляются, а откладываются рядом с суффиксом .old.
set -e
HERE="${0:A:h}"
REPO="${HERE:h:h}"
DEST="${1:-$HOME/Desktop}"
print -r -- "$REPO" > "$HOME/.orchestra-repo"
stub() { # имя действие
  local target="$DEST/$1.command"
  if [ -e "$target" ] && ! grep -q "orchestra-launcher-stub" "$target" 2>/dev/null; then mv "$target" "$target.old"; fi
  rm -f "$target"
  cat > "$target" <<STUB
#!/bin/zsh -l
# orchestra-launcher-stub (создан scripts/desktop/install.sh)
R="\${ORCHESTRA_REPO:-\$(cat "\$HOME/.orchestra-repo" 2>/dev/null)}"
[ -x "\$R/scripts/desktop/Orchestra.command" ] || { echo "Не нашёл Orchestra (\$R). Запустите scripts/desktop/install.sh из папки репозитория."; read -k1 "?Нажмите любую клавишу…"; exit 1; }
exec "\$R/scripts/desktop/Orchestra.command" $2 "\$@"
STUB
  chmod +x "$target"
  echo "  $target"
}
stub Orchestra up
stub Orchestra-restart restart
stub Orchestra-stop stop
echo "Готово ($REPO). Запуск: двойной клик по Orchestra.command."
