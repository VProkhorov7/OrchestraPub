// tsc writes files as 644; the "bin" entries of package.json must stay executable (the tests run them directly).
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
for (const rel of Object.values(pkg.bin)) fs.chmodSync(new URL('../' + rel, import.meta.url), 0o755);
