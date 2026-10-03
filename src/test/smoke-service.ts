/**
 * launchd plist stability: ProgramArguments uses a stable node symlink (e.g. /opt/homebrew/bin/node)
 * that survives `brew upgrade node`, not the versioned Cellar path process.execPath reports under Homebrew.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { stableNodePath, plistText } from '../main/service';
import { tmpdir, check } from './helpers';

(async () => {
  const tmp = tmpdir('orch-plist-');

  const cellarNode = path.join(tmp, 'Cellar', 'node', '1.0', 'bin', 'node');
  fs.mkdirSync(path.dirname(cellarNode), { recursive: true });
  fs.writeFileSync(cellarNode, '#!/bin/sh\necho node 1.0\n');

  const binNode = path.join(tmp, 'bin', 'node');
  fs.mkdirSync(path.dirname(binNode), { recursive: true });
  fs.symlinkSync(path.join('..', 'Cellar', 'node', '1.0', 'bin', 'node'), binNode);

  const otherNode = path.join(tmp, 'other', 'node');
  fs.mkdirSync(path.dirname(otherNode), { recursive: true });
  fs.writeFileSync(otherNode, '#!/bin/sh\necho other\n');

  // a) a stable symlink that resolves to the running node wins, and stays the symlink path
  check(stableNodePath(cellarNode, [binNode]) === binNode, 'a: stable symlink path returned');
  // b) a candidate resolving to a different file is not the running node
  check(stableNodePath(cellarNode, [otherNode]) === cellarNode, 'b: unrelated candidate falls back to execPath');
  // c) a missing candidate falls back to execPath
  check(stableNodePath(cellarNode, [path.join(tmp, 'missing', 'node')]) === cellarNode, 'c: missing candidate falls back to execPath');
  // d) the first valid candidate wins over later ones
  check(stableNodePath(cellarNode, [path.join(tmp, 'missing', 'node'), binNode]) === binNode, 'd: first valid candidate wins');

  // e) the plist text uses the stable path and is well-formed
  const text = plistText('127.0.0.1', 7777, binNode);
  const argStart = text.indexOf('<key>ProgramArguments</key><array>');
  const firstArg = text.indexOf('<string>', argStart);
  const firstArgEnd = text.indexOf('</string>', firstArg);
  const firstArgValue = text.slice(firstArg + '<string>'.length, firstArgEnd);
  check(firstArgValue === binNode, `e1: first ProgramArguments string is ${binNode}: ${firstArgValue}`);
  check(/--port<\/string><string>7777<\/string>/.test(text), 'e2: --port followed by 7777');
  check(text.includes('RunAtLoad') && text.includes('KeepAlive'), 'e3: RunAtLoad and KeepAlive present');
  check(!text.includes('Cellar'), 'e4: no Cellar path in the plist');

  // plutil -lint on macOS when available (a malformed plist would still contain all the substrings above)
  if (process.platform === 'darwin') {
    const plistFile = path.join(tmp, 'agent.plist');
    fs.writeFileSync(plistFile, text);
    try {
      execFileSync('plutil', ['-lint', plistFile], { stdio: 'pipe' });
    } catch (e: any) {
      if (e.code !== 'ENOENT') check(false, 'e5: plutil -lint failed: ' + e.message);
      // ENOENT: plutil not installed, skip this one assertion
    }
  }

  console.log('SMOKE-SERVICE OK', tmp);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
