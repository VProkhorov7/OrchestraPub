/**
 * The desktop launcher's service control (orchestra-ctl): which runs count as busy, and when the launchd agent
 * file no longer matches this checkout. Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { busyRuns, plistCurrent, servePort } from '../server/ctl';
import { plistText, plistPath } from '../main/service';
import { tmpdir, check } from './helpers';

const home = tmpdir('orch-ctl-');
const agents = tmpdir('orch-agents-');
process.env.ORCHESTRA_LAUNCH_AGENTS = agents;

const run = (id: string, state: object) => {
  fs.mkdirSync(path.join(home, 'runs', id), { recursive: true });
  fs.writeFileSync(path.join(home, 'runs', id, 'run.json'), JSON.stringify({ version: 1, state: { runId: id, repo: '/r', ...state } }));
};
check(busyRuns(home).length === 0, 'no runs folder: nothing busy');
run('a', { status: 'done', source: 'app', tasks: [{ id: 't01', status: 'running', providerId: 'x' }] });
run('b', { status: 'running', source: 'mcp', tasks: [{ id: 't01', status: 'merged', providerId: 'x' }] });
check(busyRuns(home).length === 0, 'a finished run and an idle MCP session are not busy');
run('c', { status: 'running', source: 'mcp', tasks: [{ id: 't01', status: 'running', providerId: 'glm' }] });
run('d', { status: 'running', source: 'app', tasks: [] });
const busy = busyRuns(home).map((b) => b.runId).sort().join();
check(busy === 'c,d', `an MCP session with a running worker and a going app run are busy: ${busy}`);
fs.writeFileSync(path.join(home, 'runs', 'c', 'run.json'), '{broken');
check(busyRuns(home).map((b) => b.runId).join() === 'd', 'a half-written run file is skipped');

fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ serve: { host: '0.0.0.0', port: 7799 } }));
check(servePort(home).port === 7799 && servePort(path.join(home, 'nope')).port === 7777, 'serve host and port come from config, default 7777');

check(!plistCurrent('127.0.0.1', 7777), 'no agent file: not current');
fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
fs.writeFileSync(plistPath(), plistText('127.0.0.1', 7777));
check(plistCurrent('127.0.0.1', 7777), 'a freshly written agent file is current');
fs.writeFileSync(plistPath(), plistText('127.0.0.1', 7777).replace(/<key>PATH<\/key><string>[^<]*<\/string>/, '<key>PATH</key><string>/somewhere/else</string>'));
check(plistCurrent('127.0.0.1', 7777), 'a different PATH inside does not make it stale');
check(!plistCurrent('127.0.0.1', 7788), 'another port: stale');
fs.writeFileSync(plistPath(), plistText('127.0.0.1', 7777).replace(/(<array><string>[^<]*<\/string><string>)[^<]*(<\/string>)/, '$1/old/place/serve.js$2'));
check(!plistCurrent('127.0.0.1', 7777), 'the agent pointing at a folder that moved: stale');

// ---- every config save keeps the previous file
import { ConfigStore } from '../main/config';
const cs = new ConfigStore(path.join(home, 'cfgtest', 'config.json'));
const base = cs.load();
cs.save(base);
check(!fs.existsSync(path.join(home, 'cfgtest', 'config-backups')), 'the first save has nothing to back up');
for (let i = 0; i < 35; i++) cs.save({ ...base, runBudgetUsd: i + 100 });
const bk = fs.readdirSync(path.join(home, 'cfgtest', 'config-backups'));
check(bk.length === 30, `the last 30 backups are kept: ${bk.length}`);
check(JSON.parse(fs.readFileSync(path.join(home, 'cfgtest', 'config-backups', bk.sort()[bk.length - 1]), 'utf8')).runBudgetUsd >= 100, 'a backup holds an earlier version');
cs.save({ ...base, runBudgetUsd: 134 });
check(fs.readdirSync(path.join(home, 'cfgtest', 'config-backups')).length === 30, 'saving the same content again adds nothing');

console.log('SMOKE-CTL OK');
