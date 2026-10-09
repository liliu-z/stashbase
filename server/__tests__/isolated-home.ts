import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-agent-test-home-'));

process.env.HOME = isolatedRoot;
process.env.USERPROFILE = isolatedRoot;
process.env.LOCALAPPDATA = path.join(isolatedRoot, 'LocalAppData');
process.env.XDG_DATA_HOME = path.join(isolatedRoot, 'xdg-data');
process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(isolatedRoot, 'stashbase-data');
delete process.env.CODEX_HOME;
delete process.env.CLAUDE_CONFIG_DIR;

process.once('exit', () => {
  try { fs.rmSync(isolatedRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});
