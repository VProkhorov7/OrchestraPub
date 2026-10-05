/** A worker cannot wait for an answer: it stops. This finds out whether it stopped on a question. */
const WAITING = /\?\s*$|нужн\w+ (ваш|разрешени)|жду (ваш|разрешени|ответ|ok)|\bneed your\b|\bpermission\b|\bapprove\b|\bconfirm\b|разрешени/i;
const MARKER = /^\s*NEEDS_ANSWER:\s*(.+)$/m;

export function findQuestion(result: string, lastLogLine = ''): { question: string; explicit: boolean } | null {
  const m = MARKER.exec(result ?? '');
  if (m) return { question: m[1].trim().slice(0, 300), explicit: true };
  const last = lastLogLine.trim();
  if (WAITING.test(last)) return { question: last.slice(0, 300), explicit: false };
  return null;
}
