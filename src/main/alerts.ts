import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { Alert, AppConfig } from './types';

/**
 * Alerts: what the watchdogs report. Kept in <home>/alerts.json (newest first, 200 at most), so a problem that
 * happened while nobody looked is still there in the panel. The same problem is not raised twice inside the cool-down.
 * Where it goes: the panel (bell and toast), the macOS notification centre, and an optional webhook.
 * ORCHESTRA_NOTIFY_CMD replaces the macOS notifier in tests (called with level, title, text).
 */

const KEEP = 200;
export const DEFAULT_COOLDOWN_MS = 10 * 60_000;
type Level = Alert['level'];
const RANK: Record<Level, number> = { info: 0, warn: 1, error: 2 };

export interface RaiseInput {
  key: string;
  level: Level;
  title: string;
  text: string;
  runId?: string;
}

export function readAlerts(file: string): Alert[] {
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function writeAlerts(file: string, list: Alert[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list.slice(0, KEEP), null, 1));
  fs.renameSync(tmp, file);
}

/** Append one alert to the file without a running Alerts object (used by the external watchdog). */
export function appendAlert(file: string, a: RaiseInput): Alert {
  const alert: Alert = { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, ts: Date.now(), ...a };
  writeAlerts(file, [alert, ...readAlerts(file)]);
  return alert;
}

/** macOS notification. The text goes through argv, so it cannot break out of the script. */
export function notifyMac(level: Level, title: string, text: string): void {
  const custom = process.env.ORCHESTRA_NOTIFY_CMD;
  if (custom) {
    execFile(custom, [level, title, text], () => {});
    return;
  }
  if (process.platform !== 'darwin') return;
  execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, text.slice(0, 200)], () => {});
}

function postWebhook(url: string, a: Alert) {
  if (!/^https?:\/\//.test(url)) return;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  fetch(url, { method: 'POST', body: `${a.title}\n${a.text}`, signal: ac.signal }).catch(() => {}).finally(() => clearTimeout(t));
}

/** Send an alert to the outside world according to the settings (not to the panel). */
export function deliver(cfg: Pick<AppConfig, 'notify'> | undefined, a: Alert) {
  const n = cfg?.notify ?? {};
  if (n.macos !== false && RANK[a.level] >= RANK[n.macosLevel ?? 'error']) notifyMac(a.level, a.title, a.text);
  if (n.webhook) postWebhook(n.webhook, a);
}

export class Alerts {
  private last = new Map<string, number>();
  private active = new Set<string>();

  constructor(
    private file: string,
    private cfg: () => AppConfig,
    private emit: (a: Alert) => void,
    private now: () => number = Date.now,
  ) {}

  list(): Alert[] {
    return readAlerts(this.file);
  }

  /** Raise an alert unless the same key was raised inside the cool-down. Returns it, or null when it was a repeat. */
  raise(a: RaiseInput, cooldownMs = DEFAULT_COOLDOWN_MS): Alert | null {
    const t = this.now();
    if (this.active.has(a.key) && t - (this.last.get(a.key) ?? 0) < cooldownMs) return null;
    this.last.set(a.key, t);
    this.active.add(a.key);
    const alert = appendAlert(this.file, a);
    this.emit(alert);
    try {
      deliver(this.cfg(), alert);
    } catch {
      /* a failing notifier must never break the watchdog */
    }
    return alert;
  }

  /** The problem went away: the next occurrence is raised at once, and an «ok again» note is left (not notified). */
  clear(key: string, okTitle?: string, okText = '') {
    if (!this.active.delete(key)) return;
    this.last.delete(key);
    if (okTitle) {
      const alert = appendAlert(this.file, { key: `ok:${key}`, level: 'info', title: okTitle, text: okText });
      this.emit(alert);
    }
  }

  /** Empty the list (the «clear» button); active problems may be raised again at once. */
  clearAll() {
    writeAlerts(this.file, []);
    this.active.clear();
    this.last.clear();
  }

  isActive(key: string) {
    return this.active.has(key);
  }
}
