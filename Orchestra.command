#!/bin/zsh -l
# Двойной клик в Finder: диагностика Orca + Orchestra и переключение режимов
# (вместе / только Orca / только Orchestra) с возможностью отменить.
cd "${0:A:h}" || exit 1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin"
if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите: brew install node"; read -k1 "?Нажмите любую клавишу…"; exit 1
fi
# Сборка, если её нет или исходники новее.
if [ ! -f dist/doctor/cli.js ] || [ -n "$(find src -newer dist/doctor/cli.js -name '*.ts' -print -quit 2>/dev/null)" ]; then
  echo "Собираю Orchestra…"
  [ -d node_modules ] || npm install --no-audit --no-fund || exit 1
  npm run build >/dev/null || { echo "Сборка не удалась: npm run build"; read -k1 "?Нажмите любую клавишу…"; exit 1; }
fi
node dist/doctor/cli.js "$@"
echo
read -k1 "?Нажмите любую клавишу, чтобы закрыть окно…"
