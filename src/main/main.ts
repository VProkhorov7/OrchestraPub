import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { AppConfig, Plan } from './types';
import { Doctor, DoctorMode, discoverProjects } from './doctor';
import { Hub } from './hub';
import { fixPath } from './paths';

fixPath();

let win: BrowserWindow | null = null;
const hub = new Hub(app.getPath('userData'), (ev) => win?.webContents.send('orch:event', ev));

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    title: 'Orchestra',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(app.getAppPath(), 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  hub.init();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
// Runs stay marked "running" on disk; the next launch turns them into "interrupted" and offers to continue.
app.on('before-quit', () => hub.freezeAll());

// ---------- IPC: a thin layer over Hub ----------

ipcMain.handle('config:get', () => hub.config());
ipcMain.handle('config:save', (_e, cfg: AppConfig) => {
  hub.saveConfig(cfg);
  return true;
});
ipcMain.handle('catalog:list', () => hub.catalog());
ipcMain.handle('roles:list', () => hub.roles());
ipcMain.handle('health:get', () => hub.health);
ipcMain.handle('health:check', async (_e, id?: string) => {
  await hub.refreshHealth(id);
  return hub.health;
});
ipcMain.handle('env:check', () => hub.envCheck());

ipcMain.handle('repo:select', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('goal:attach', async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: 'Текст', extensions: ['md', 'txt', 'rst', 'json', 'yaml', 'yml'] }],
  });
  if (r.canceled) return null;
  const file = r.filePaths[0];
  const text = fs.readFileSync(file, 'utf8');
  if (text.length > 200_000) throw new Error('Файл слишком большой (лимит 200 КБ)');
  return { name: path.basename(file), text };
});

ipcMain.handle('plan:triage', (_e, args: { goal: string }) => hub.triage(args.goal));
ipcMain.handle('plan:make', (_e, args: { repo: string; goal: string; choice?: string }) => hub.makePlan(args.repo, args.goal, args.choice));
ipcMain.handle('run:start', (_e, args: { repo: string; goal: string; plan?: Plan; choice?: string }) =>
  hub.start(args.repo, args.goal, args.plan, args.choice),
);
ipcMain.handle('run:cancel', (_e, runId?: string) => hub.cancel(runId));
ipcMain.handle('run:state', (_e, runId?: string) => hub.state(runId));

ipcMain.handle('memory:status', (_e, repo: string) => hub.memoryStatus(repo));
ipcMain.handle('memory:init', (_e, repo: string, project?: string) => hub.memoryInit(repo, project));
ipcMain.handle('memory:digest', (_e, repo: string) => hub.memoryDigest(repo));
ipcMain.handle('memory:changelog', (_e, repo: string, release?: string) => hub.memoryChangelog(repo, release));
const doctor = new Doctor({ home: hub.home, config: () => hub.config(), saveConfig: (c) => hub.saveConfig(c), health: () => hub.health });
ipcMain.handle('doctor:report', () => doctor.report());
ipcMain.handle('doctor:plan', (_e, mode: DoctorMode) => doctor.plan(mode));
ipcMain.handle('doctor:apply', (_e, mode: DoctorMode) => doctor.apply(mode));
ipcMain.handle('doctor:undo', () => doctor.undo());
ipcMain.handle('doctor:projects', async (_e, projects: string[], roots?: string[]) => {
  doctor.setProjects(projects, roots);
  return doctor.report();
});
ipcMain.handle('doctor:discover', (_e, roots: string[]) => discoverProjects(roots));
ipcMain.handle('tariff:get', () => hub.tariff());
ipcMain.handle('schedule:list', () => hub.scheduled());
ipcMain.handle('schedule:add', (_e, a: { repo: string; goal: string; plan?: Plan; choice?: string }) => hub.schedule(a.repo, a.goal, a.plan, a.choice));
ipcMain.handle('schedule:remove', (_e, id: string) => hub.unschedule(id));
ipcMain.handle('schedule:now', (_e, id: string) => hub.startScheduledNow(id));
ipcMain.handle('runs:list', () => hub.listRuns());
ipcMain.handle('runs:load', (_e, runId: string) => hub.state(runId));
ipcMain.handle('runs:delete', (_e, runId: string) => {
  hub.deleteRun(runId);
  return true;
});
ipcMain.handle('runs:resume', (_e, runId: string) => hub.resume(runId));

ipcMain.handle('task:merge', (_e, runId: string, id: string) => hub.merge(runId, id));
ipcMain.handle('task:discard', (_e, runId: string, id: string) => hub.discard(runId, id));
ipcMain.handle('task:openWorktree', async (_e, runId: string, id: string) => {
  const wt = hub.worktreeOf(runId, id);
  const r = await hub.openWorktree(runId, id, false); // finds out why it cannot be opened
  if (wt && r.path && !r.opened && !r.message.startsWith('Рабочей папки') && !r.message.startsWith('The working folder')) {
    const err = await shell.openPath(wt);
    return err ? err : undefined;
  }
  return r.opened ? undefined : r.message;
});
