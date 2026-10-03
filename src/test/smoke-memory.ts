/**
 * Project memory end to end:
 *  1. init: files, rules in CLAUDE.md/AGENTS.md, Claude Code hooks, git hooks; idempotent
 *  2. CLI: facts, decisions, log, context, session-end (journal + JSON), changelog, digest
 *  3. git hooks: memory travels with every commit (message captured); pre-push adds a memory commit if needed
 *  4. Claude Code hooks: session start context, edit/command logging, 35-minute reminder, auto close
 *  5. an Orchestra run in a repo with memory: briefing reaches orchestrator and workers, merges logged,
 *     journal entry from the final report, memory committed; uncommitted memory does not block a run
 *  6. MCP memory tools over stdio
 *  7. fresh digest and stage CHANGELOG written by the cheapest working model
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { execFileSync, spawnSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProjectMemory } from '../memory/store';
import { setupRepo } from '../memory/setup';
import { freshDigest, stageChangelog } from '../memory/summarize';
import { Hub, parseReport } from '../main/hub';
import { fromPreset } from '../main/catalog';
import { tmpdir, sh, makeRepo, makeFakeClaude, fakeApi, toolUse, check, testConfig } from './helpers';

const CLI = path.join(__dirname, '..', 'memory', 'cli.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shim(dir: string) {
  const f = path.join(dir, 'orchestra-memory');
  fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  fs.chmodSync(f, 0o755);
  return dir;
}

(async () => {
  const tmp = tmpdir('orch-memory-');
  const bin = shim(fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true }) ?? path.join(tmp, 'bin'));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORCHESTRA_AUTHOR: 'alice' } as NodeJS.ProcessEnv;
  delete env.ORCHESTRA_MEMORY_OFF;
  delete env.CLAUDECODE;
  const repo = makeRepo(tmp);
  const bare = path.join(tmp, 'origin.git');
  sh('git', ['init', '-q', '--bare', bare], tmp);
  sh('git', ['remote', 'add', 'origin', bare], repo);
  const run = (args: string[], input?: string) => execFileSync(CLI, args, { cwd: repo, env, input, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  const gitE = (args: string[]) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });

  // 1. init
  setupRepo(repo, { project: 'Demo' });
  setupRepo(repo, { project: 'Demo' });
  for (const f of ['.memory/config.json', '.memory/facts.json', '.memory/logic.json', 'wiki/README.md', 'wiki/JOURNAL.md', 'CHANGELOG.md', 'CLAUDE.md', 'AGENTS.md', '.claude/settings.json', '.githooks/pre-commit', '.githooks/pre-push', '.claude/commands/orchestra.md', '.claude/agents/scout.md', '.claude/agents/applier.md', '.claude/agents/reviewer.md', 'wiki/INVARIANTS.md'])
    check(fs.existsSync(path.join(repo, f)), 'init created ' + f);
  check(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8').split('orchestra-memory:start').length === 2, 'rules block written once');
  const hooks = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8')).hooks;
  check(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd'].every((k) => hooks[k]?.length === 1), 'Claude hooks installed once each');
  check(/model: haiku/.test(fs.readFileSync(path.join(repo, '.claude/agents/scout.md'), 'utf8')), 'scout role pinned to the cheap model');
  check(JSON.parse(fs.readFileSync(path.join(repo, '.memory/config.json'), 'utf8')).prodGuard?.enabled === true, 'prod guard settings written');
  check(sh('git', ['config', 'core.hooksPath'], repo).trim() === '.githooks', 'git hooks path set');

  // 3a. first commit through the hook carries memory
  check(gitE(['add', '-A']).status === 0 && gitE(['commit', '-q', '-m', 'подключить память проекта']).status === 0, 'commit ok');
  check(!sh('git', ['status', '--porcelain'], repo).trim(), 'tree clean after commit (memory went into the commit)');

  // 2. CLI
  run(['add-fact', 'Деплой идёт через Cloudflare Workers из main', '--tags', 'deploy,cloudflare', '--files', 'wrangler.jsonc']);
  run(['add-decision', '--title', 'Одна ветка', '--decision', 'коммитим в main', '--why', 'один разработчик', '--alt', 'git flow', '--facts', 'F-0001']);
  let noWhy = false;
  try {
    run(['log', '--type', 'feature', '--files', 'src/export.ts', 'Добавлен экспорт в CSV']);
  } catch (e: any) {
    noWhy = /--why/.test(String(e.stderr));
  }
  check(noWhy, 'log of a feature without --why is refused');
  run(['log', '--type', 'feature', '--why', 'нужно для отчётов', '--files', 'src/export.ts', 'Добавлен экспорт в CSV']);
  run(['log', '--type', 'cleanup', '--why', 'дубли в таблице мешали отчёту, причина пока не найдена', 'Удалены дубли заказов вручную']);
  const ctx = run(['context', 'как устроен деплой на cloudflare']);
  check(ctx.includes('F-0001') && ctx.includes('D-0001') && ctx.includes('Почему: один разработчик'), 'context: fact + linked decision with reason');
  fs.writeFileSync(path.join(repo, 'hello.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'wiki', 'deploy.md'), '# Деплой\n');
  run(['session-start', '--goal', 'экспорт']);
  let twoNext = false;
  try {
    run(['session-end', '--summary', 'x', '--next', 'a', '--next', 'b']);
  } catch (e: any) {
    twoNext = /ровно одна/.test(String(e.stderr));
  }
  check(twoNext, 'session-end refuses two next tasks');
  let fourGates = false;
  try {
    run(['session-end', '--summary', 'x', '--gate', '1', '--gate', '2', '--gate', '3', '--gate', '4']);
  } catch (e: any) {
    fourGates = /не больше 3/.test(String(e.stderr));
  }
  check(fourGates, 'session-end refuses a fourth gate');
  const endOut = run(['session-end', '--summary', 'Сделан экспорт в CSV, описан деплой.', '--done', 'экспорт CSV', '--why', 'нужно для отчётов', '--gate', 'прогнать e2e', '--next', 'тесты', '--details', '{"tests":"ok"}']);
  check(!endOut.includes('Внимание'), 'wiki updated → no warning');
  const journal = fs.readFileSync(path.join(repo, 'wiki', 'JOURNAL.md'), 'utf8');
  check(journal.includes('Сделан экспорт в CSV') && journal.includes('**Следующая задача:** тесты') && journal.includes('- [ ] прогнать e2e') && journal.includes('hello.txt'), 'human journal entry: gate + one next task');
  const m = new ProjectMemory(repo);
  const end = m.readLog({ types: ['session_end'] }).pop()!;
  check((end.details as any).extra?.tests === 'ok' && end.files!.includes('wiki/deploy.md'), 'detailed JSON session record');
  const draft = run(['changelog', '--draft']);
  check(draft.includes('Добавлен экспорт в CSV') && !draft.includes('дубли заказов'), 'changelog draft lists the feature, not the cleanup');
  fs.writeFileSync(path.join(tmp, 'cl.md'), '### Added\n- Экспорт данных в CSV\n### Security\n- Ключи вынесены из кода\n');
  run(['changelog', '--write', path.join(tmp, 'cl.md'), '--release', 'Этап 1']);
  const cl = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
  check(/## \[Unreleased\]\n\n## \[Этап 1\] - \d{4}-\d{2}-\d{2}\n\n### Added\n- Экспорт данных в CSV\n\n### Security/.test(cl), 'CHANGELOG release block:\n' + cl);
  check(run(['changelog', '--draft']).includes('значимых событий нет'), 'changelog position remembered');
  check(run(['digest']).includes('[feature] alice: Добавлен экспорт в CSV'), 'digest lists recent work');

  // 3b. commit message captured, memory staged, push flow
  gitE(['add', 'hello.txt', 'wiki/deploy.md']);
  check(gitE(['commit', '-q', '-m', 'экспорт в CSV']).status === 0, 'second commit');
  check(!sh('git', ['status', '--porcelain'], repo).trim(), 'memory + journal + changelog went with the commit');
  check(m.readLog({ types: ['commit'] }).some((e) => e.description === 'коммит: экспорт в CSV'), 'commit message captured in the log');
  run(['log', '--type', 'note', 'заметка после коммита']);
  const p1 = gitE(['push', '-q', 'origin', 'HEAD:main']);
  check(p1.status !== 0 && p1.stderr.includes('Повторите git push'), 'pre-push adds a memory commit and asks to push again');
  check(sh('git', ['log', '-1', '--format=%s'], repo).includes('chore(memory)'), 'memory commit made');
  check(gitE(['push', '-q', 'origin', 'HEAD:main']).status === 0, 'second push goes through');
  check(sh('git', ['--git-dir', bare, 'show', 'main:.memory/facts.json'], tmp).includes('F-0001'), 'memory is on the remote');

  // 4. Claude Code hooks
  const hook = (name: string, payload: object) => run(['hook', name], JSON.stringify({ cwd: repo, session_id: 'cc-1', ...payload }));
  const start = JSON.parse(hook('session-start', { source: 'startup' }));
  check(start.hookSpecificOutput.hookEventName === 'SessionStart' && start.hookSpecificOutput.additionalContext.includes('D-0001'), 'session start gives memory context');
  hook('tool', { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'a.ts') } });
  hook('tool', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  hook('tool', { tool_name: 'Bash', tool_input: { command: 'git status' } });
  const log = m.readLog({ limit: 5 });
  check(log.some((e) => e.type === 'edit' && e.files?.[0] === 'src/a.ts') && log.some((e) => e.type === 'command' && e.description === 'npm test') && !log.some((e) => e.description === 'git status'), 'edits and commands logged, noise skipped');
  const sf = path.join(repo, '.git', 'orchestra-memory-session.json');
  const sess = JSON.parse(fs.readFileSync(sf, 'utf8'));
  sess.start = new Date(Date.now() - 40 * 60_000).toISOString();
  fs.writeFileSync(sf, JSON.stringify(sess));
  const p = JSON.parse(hook('prompt', { prompt: 'как у нас деплой на cloudflare?' }));
  check(p.hookSpecificOutput.additionalContext.includes('Микросессия идёт 40 мин') && p.hookSpecificOutput.additionalContext.includes('F-0001'), 'reminder after 35 min + relevant memory');
  check(!hook('prompt', { prompt: 'ещё' }).includes('Микросессия'), 'reminder not repeated immediately');
  check(hook('prompt', { prompt: 'дай свежую выжимку' }).includes('Запрос выжимки'), '«дай свежую выжимку» gets the latest log');
  fs.writeFileSync(path.join(repo, 'src-a.txt'), 'x');
  hook('session-end', { reason: 'other' });
  check(fs.readFileSync(path.join(repo, 'wiki', 'JOURNAL.md'), 'utf8').includes('запись автоматическая'), 'unclosed session closed automatically');
  gitE(['add', '-A']);
  gitE(['commit', '-q', '-m', 'сессия агента']);

  // 4b. prod guard (PreToolUse)
  const guard = (tool: string, input: object, extraEnv: object = {}) => {
    const o = execFileSync(CLI, ['hook', 'guard'], { cwd: repo, env: { ...env, ...extraEnv }, input: JSON.stringify({ cwd: repo, tool_name: tool, tool_input: input }) }).toString();
    return o ? JSON.parse(o).hookSpecificOutput : null;
  };
  check(guard('Bash', { command: 'npx wrangler deploy' })?.permissionDecision === 'deny', 'guard: wrangler deploy refused');
  check(guard('Bash', { command: 'npx wrangler d1 execute vo-press --remote --file x.sql' })?.permissionDecision === 'deny', 'guard: --remote refused');
  check(guard('Bash', { command: 'npx wrangler d1 execute vo-press --local --file x.sql' }) === null, 'guard: --local passes');
  check(guard('Bash', { command: 'npm test && git status' }) === null, 'guard: ordinary commands pass');
  check(guard('Bash', { command: 'git push --force origin main' })?.permissionDecision === 'deny', 'guard: force push refused');
  check(guard('Write', { file_path: path.join(repo, '.git', 'orchestra-prod-allow.json') })?.permissionDecision === 'deny', 'guard: agent cannot write the permission file');
  check(guard('Bash', { command: 'echo {} > .memory/briefs/approvals.json' })?.permissionDecision === 'deny', 'guard: agent cannot fake a brief approval');
  // CI on push to main deploys → push of main is guarded, a feature branch is not
  fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.github', 'workflows', 'deploy.yml'), 'on:\n  push: { branches: [main] }\njobs:\n  d:\n    steps:\n      - run: npx wrangler deploy\n');
  const cfgPath = path.join(repo, '.memory', 'config.json');
  const mc = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  delete mc.prodGuard.pushDeploys;
  fs.writeFileSync(cfgPath, JSON.stringify(mc));
  check(guard('Bash', { command: 'git push origin main' })?.permissionDecision === 'deny', 'guard: push to main deploys → refused');
  check(guard('Bash', { command: 'git push origin feature-x' }) === null, 'guard: push of another branch passes');
  // owner's phrase opens a window; a worker never gets it; revoke closes it
  const g = JSON.parse(hook('prompt', { prompt: 'Разрешаю прод, выкладывай' })).hookSpecificOutput.additionalContext;
  check(/разрешил команды к проду/.test(g), 'owner phrase grants a window');
  check(guard('Bash', { command: 'npx wrangler deploy' }) === null, 'guard: allowed within the window');
  check(guard('Bash', { command: 'npx wrangler deploy' }, { ORCHESTRA_WORKER: '1', ORCHESTRA_MEMORY_OFF: '1' })?.permissionDecision === 'deny', 'guard: a worker is refused even within the window');
  hook('prompt', { prompt: 'запрещаю прод' });
  check(guard('Bash', { command: 'npx wrangler deploy' })?.permissionDecision === 'deny', 'guard: revoked');
  check(m.readLog({ types: ['guard'] }).length >= 3, 'guard decisions are in the log');

  // 4c. brief from /orchestra: completeness, owner approval bound to the content
  const bdir = path.join(repo, '.memory', 'briefs');
  fs.mkdirSync(bdir, { recursive: true });
  const bf = path.join(bdir, '2026-09-28-export.md');
  const full = '# Экспорт\n\n**Цель** — выгрузка в CSV.\n\n**Что уже известно** — F-0001.\n\n**Границы** — прод не трогаем.\n\n**Подзадачи**\n- [ ] код\n- [ ] wiki\n\n**Готово, когда** — файл открывается в Excel.\n\n**Как проверить** — npm test.\n\n**Вопросы** — нет.\n';
  fs.writeFileSync(bf, full.replace('**Как проверить** — npm test.', '**Как проверить** — TODO'));
  const bc = (f = bf) => spawnSync(process.execPath, [CLI, 'brief', 'check', f], { cwd: repo, env, encoding: 'utf8' });
  check(bc().status === 1 && /заглушки/.test(bc().stdout), 'brief with TODO is not ready');
  const early = JSON.parse(hook('prompt', { prompt: 'утверждаю' })).hookSpecificOutput.additionalContext;
  check(/не утверждён/.test(early), 'approval of an incomplete brief is refused and explained');
  fs.writeFileSync(bf, full);
  check(bc().status === 1 && /не утверждён/.test(bc().stdout), 'complete brief still needs the owner');
  check(/утвердил бриф/.test(JSON.parse(hook('prompt', { prompt: 'Утверждаю, делай вариант А' })).hookSpecificOutput.additionalContext), 'owner approval recorded');
  check(bc().status === 0, 'approved brief is ready');
  fs.writeFileSync(bf, full.replace('- [ ] код', '- [x] код'));
  check(bc().status === 0, 'ticking a subtask keeps the approval');
  fs.writeFileSync(bf, full.replace('прод не трогаем', 'можно выкладывать'));
  check(bc().status === 1 && /изменён после утверждения/.test(bc().stdout), 'changing the brief resets the approval');

  gitE(['add', '.github']);
  gitE(['commit', '-q', '-m', 'ci']);

  // 5. an Orchestra run in the repo, through the Hub
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const argLog = path.join(tmp, 'args.jsonl');
  process.env.FAKE_ARGLOG = argLog;
  const cfg = testConfig(makeFakeClaude(tmp), { providers: [fromPreset('deepseek', { token: 'k' })] });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  run(['log', '--type', 'note', 'незакоммиченная запись памяти']); // must not block the run
  const api = await fakeApi([
    toolUse('a1', 'memory_add_fact', { text: 'hello.txt хранит приветствие', tags: ['hello'] }),
    toolUse('a2', 'delegate', { provider: 'deepseek', role: 'docs', title: 'Обновить приветствие', spec: 'Change hello.txt' }),
    toolUse('a3', 'wait_for', {}),
    toolUse('a4', 'merge_task', { task_id: 't01' }),
    toolUse('a5', 'finish', { report: 'Приветствие обновлено воркером DeepSeek.\n\nСделано:\n- обновлено приветствие\n\nДальше:\n- добавить тест' }),
  ]);
  const hub = new Hub(home, () => {});
  hub.health = { deepseek: { light: 'green', text: '', checkedAt: 0 } };
  const runId = await hub.start(repo, 'Обнови приветствие в hello.txt');
  for (let i = 0; i < 100 && ['idle', 'running'].includes(hub.state(runId)!.status); i++) await sleep(200);
  await sleep(300);
  api.close();
  const st = hub.state(runId)!;
  check(st.status === 'done' && st.tasks[0].status === 'merged', `run finished: ${st.status} ${st.stopReason ?? ''}`);
  check(JSON.stringify(api.requests[0].messages[0]).includes('PROJECT MEMORY') && JSON.stringify(api.requests[0].messages[0]).includes('F-0001'), 'orchestrator got the memory briefing');
  check(!JSON.stringify(api.requests[0].messages[0]).includes('[task] запуск'), 'own run not shown as already done');
  check(api.requests[0].tools.some((t: any) => t.name === 'memory_add_decision'), 'orchestrator has memory tools');
  const workerArgs = fs.readFileSync(argLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((a: string[]) => a.includes('stream-json'));
  check(workerArgs && workerArgs[1].includes('Project memory relevant to this task'), 'worker brief includes memory');
  check(m.facts().some((f) => f.text === 'hello.txt хранит приветствие' && f.author === 'orchestra'), 'orchestrator recorded a fact');
  const types = m.readLog({ limit: 30 }).map((e) => e.type);
  check(types.includes('task') && types.includes('docs'), 'delegation and merge logged: ' + types.join(','));
  const j2 = fs.readFileSync(path.join(repo, 'wiki', 'JOURNAL.md'), 'utf8');
  check(j2.includes('Приветствие обновлено воркером DeepSeek.') && j2.includes('добавить тест'), 'journal entry from the final report');
  check(sh('git', ['log', '-1', '--format=%s'], repo).includes(`chore(memory): запуск ${runId}`), 'memory committed after the run');
  check(!sh('git', ['status', '--porcelain', '--', '.memory', 'wiki', 'CHANGELOG.md'], repo).trim(), 'no memory left uncommitted');
  const pr = parseReport('Коротко: всё сделано.\n\n**Сделано:**\n- a\n- b\n\n**Дальше:**\n- c');
  check(pr.summary === 'Коротко: всё сделано.' && pr.done.join() === 'a,b' && pr.next.join() === 'c', 'report parsing');
  hub.stop();

  // 6. MCP memory tools (stdio server)
  const mhome = path.join(tmp, 'mhome');
  fs.mkdirSync(mhome);
  fs.writeFileSync(path.join(mhome, 'config.json'), JSON.stringify(cfg));
  const client = new Client({ name: 't', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'server.js'), '--repo', repo], env: { ...env, ORCHESTRA_HOME: mhome } as Record<string, string>, stderr: 'pipe' }));
  const call = async (name: string, args: any) => ((await client.callTool({ name, arguments: args })) as any).content[0].text as string;
  check((await call('memory_add_decision', { title: 'Экспорт', decision: 'CSV, не XLSX', why: 'проще и хватает' })).startsWith('D-0002'), 'decision via MCP');
  check((await call('memory_context', { task: 'экспорт csv' })).includes('D-0002'), 'context via MCP');
  check((await call('memory_session_end', { summary: 'MCP-сессия', done: ['решение по экспорту'] })).startsWith('session closed'), 'session end via MCP');
  await client.close();

  // 7. summaries by the cheapest model
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const prompt = JSON.parse(b).messages[0].content as string;
      const text = prompt.startsWith('Сделай запись для CHANGELOG') ? '{"Added": ["Экспорт в CSV"], "Fixed": ["Опечатка в приветствии"]}' : '- Сделан экспорт в CSV\n- Обновлено приветствие';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const scfg = testConfig('claude', { providers: [fromPreset('glm-plan', { token: 'k', baseUrl: `http://127.0.0.1:${(srv.address() as any).port}` })] });
  const dg = await freshDigest(scfg, repo);
  check(dg.text.includes('Сделан экспорт') && dg.by.includes('GLM'), 'fresh digest by the cheapest model: ' + dg.by + ' / ' + dg.text.slice(0, 300));
  m.log({ type: 'fix', author: 'alice', description: 'исправлена опечатка' });
  const sc = await stageChangelog(scfg, repo, 'Этап 2');
  check(sc.sections.Fixed?.[0] === 'Опечатка в приветствии' && fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8').includes('## [Этап 2]'), 'stage changelog written');
  srv.close();

  console.log(`\nSMOKE-MEMORY OK ${tmp}`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
