#!/bin/zsh -l
# Безопасный перезапуск Orchestra: НЕ останавливает службу, если в ней сейчас идут задачи воркеров
# (перезапуск убивает воркеров и стирает список задач, как уже случалось).
# Принудительно (на свой риск): ORCHESTRA_FORCE=1 ./Orchestra-restart.command
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
RUNS="${ORCHESTRA_RUNS:-$HOME/Library/Application Support/Orchestra/runs}"

BUSY=$(node -e '
const fs = require("fs"), dir = process.argv[1];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const out = [];
for (const d of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  let s; try { s = JSON.parse(fs.readFileSync(dir + "/" + d + "/run.json", "utf8")).state; } catch { continue; }
  if (s.status !== "running" || !alive(s.pid)) continue;
  const run = (s.tasks || []).filter((t) => t.status === "running" || t.status === "queued");
  if (run.length) out.push(d + "  " + s.repo + "  задач в работе: " + run.map((t) => t.id + "(" + t.providerId + ")").join(", "));
}
console.log(out.join("\n"));
' "$RUNS")

if [ -n "$BUSY" ] && [ -z "$ORCHESTRA_FORCE" ]; then
  echo "НЕ ПЕРЕЗАПУСКАЮ: сейчас идут задачи воркеров:"
  echo "$BUSY"
  echo
  echo "Дождитесь их окончания (панель → вкладка «Воркеры») и запустите этот файл снова."
  read -k1 "?Нажмите любую клавишу…"; exit 1
fi

echo "Останавливаю службу…"
if [ -n "$ORCHESTRA_DRY" ]; then echo "[dry-run] остановил бы службу и запустил Orchestra.command"; exit 0; fi
pkill -f "dist/server/serve.js --host 127.0.0.1 --port 7777"
sleep 2
exec "$HOME/Desktop/Orchestra.command"
