import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export function run(
  cmd: string,
  args: string[],
  cwd: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, env: opts.env ?? process.env },
      (err, stdout, stderr) => {
        // A missing binary comes back as code 'ENOENT'; report it like a shell would (127).
        if ((err as any)?.code === 'ENOENT') {
          // spawn reports ENOENT for a missing working directory too: say which one it is.
          if (!fs.existsSync(cwd)) return resolve({ code: 128, stdout: '', stderr: `working directory does not exist: ${cwd}`, timedOut: false });
          return resolve({ code: 127, stdout: '', stderr: `${cmd}: command not found`, timedOut: false });
        }
        // execFile only kills the child itself on timeout; a signal from outside leaves `killed` false.
        const timedOut = !!(err && (err as any).killed);
        const code = err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut });
      },
    );
  });
}

async function git(args: string[], cwd: string) {
  const r = await run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Synchronous git for short housekeeping steps; returns stdout, '' on failure. Memory hooks are off. */
export function runSync(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ORCHESTRA_MEMORY_OFF: '1' } }).toString().trim();
  } catch {
    return '';
  }
}

export async function isRepo(dir: string): Promise<boolean> {
  const r = await run('git', ['rev-parse', '--is-inside-work-tree'], dir);
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function currentBranch(repo: string): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
}

export async function headSha(repo: string): Promise<string> {
  return git(['rev-parse', 'HEAD'], repo);
}

/**
 * Uncommitted changes, not counting project memory (.memory/, the wiki journal, CHANGELOG.md):
 * hooks append to the log between commits, and that must not block a run.
 */
export async function isDirty(repo: string): Promise<boolean> {
  const out = (await run('git', ['status', '--porcelain', '-z', '--untracked-files=all'], repo)).stdout;
  let ignore = ['.memory/', 'wiki/JOURNAL.md', 'CHANGELOG.md'];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, '.memory', 'config.json'), 'utf8'));
    ignore = ['.memory/', cfg.journal ?? 'wiki/JOURNAL.md', cfg.changelog ?? 'CHANGELOG.md'];
  } catch {
    /* no memory in this repo */
  }
  return out
    .split('\0')
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3))
    .some((f) => !ignore.some((i) => f === i || f.startsWith(i)));
}

/** Create an isolated worktree on a fresh branch from the repo's HEAD. */
export async function createWorktree(repo: string, worktreeDir: string, branch: string): Promise<string> {
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
  await git(['worktree', 'add', '-b', branch, worktreeDir, 'HEAD'], repo);
  return headSha(worktreeDir);
}

/** Commit whatever the worker left uncommitted so the diff is complete. */
export async function commitAll(worktree: string, message: string): Promise<boolean> {
  if (!(await git(['status', '--porcelain'], worktree)).length) return false; // every change counts here, memory files too
  await git(['add', '-A'], worktree);
  const r = await run(
    'git',
    ['-c', 'user.name=orchestra', '-c', 'user.email=orchestra@localhost', 'commit', '-q', '-m', message],
    worktree,
    { env: { ...process.env, ORCHESTRA_MEMORY_OFF: '1' } }, // worker commits are logged by the engine, not by the repo's hooks
  );
  return r.code === 0;
}

export async function diffStat(worktree: string, baseSha: string): Promise<string> {
  return git(['diff', '--stat', `${baseSha}..HEAD`], worktree);
}

export async function fullDiff(worktree: string, baseSha: string): Promise<string> {
  return git(['diff', `${baseSha}..HEAD`], worktree);
}

/**
 * Merge a task branch into the repo's current branch.
 * Returns {ok:false, conflict} and leaves the repo clean on conflict.
 */
export async function mergeBranch(
  repo: string,
  branch: string,
  message: string,
): Promise<{ ok: boolean; output: string }> {
  const r = await run(
    'git',
    ['-c', 'user.name=orchestra', '-c', 'user.email=orchestra@localhost', 'merge', '--no-ff', '--no-edit', '-m', message, branch],
    repo,
  );
  if (r.code === 0) return { ok: true, output: r.stdout };
  const conflicts = await run('git', ['diff', '--name-only', '--diff-filter=U'], repo);
  await run('git', ['merge', '--abort'], repo);
  return { ok: false, output: `Merge conflict in:\n${conflicts.stdout}\n${r.stderr || r.stdout}` };
}

export async function removeWorktree(repo: string, worktreeDir: string, branch: string, deleteBranch: boolean) {
  await run('git', ['worktree', 'remove', '--force', worktreeDir], repo);
  if (deleteBranch) await run('git', ['branch', '-D', branch], repo);
  await run('git', ['worktree', 'prune'], repo);
}

export async function listFiles(repo: string, subdir = '.'): Promise<string> {
  return git(['ls-files', '--', subdir], repo);
}

// ---------- merge lock ----------

const inProcess = new Map<string, Promise<unknown>>();

/**
 * Serialize merges into one repository: across runs in this process (a promise chain)
 * and across processes (the app, `orchestra serve`, stdio MCP servers) with a lock file in the git dir.
 */
export async function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repo);
  const prev = inProcess.get(key) ?? Promise.resolve();
  const job = prev.catch(() => {}).then(() => withFileLock(repo, fn));
  inProcess.set(key, job);
  try {
    return await job;
  } finally {
    if (inProcess.get(key) === job) inProcess.delete(key);
  }
}

async function withFileLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const common = (await run('git', ['rev-parse', '--git-common-dir'], repo)).stdout.trim() || '.git';
  const lock = path.join(path.resolve(repo, common), 'orchestra-merge.lock');
  const started = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > 10 * 60_000) fs.rmSync(lock, { force: true }); // left by a crashed process
      } catch {
        /* vanished between the two calls */
      }
      if (Date.now() - started > 120_000) throw new Error('репозиторий занят другим слиянием больше 2 минут');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
