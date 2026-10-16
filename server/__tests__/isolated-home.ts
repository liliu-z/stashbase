/**
 * Points every home-derived location at a temporary directory, so a host test
 * never reads or writes the developer's own ~/.stashbase config, app data or
 * agent settings. `test:server`, `test:agent` and `test:mcp` preload it with
 * `--import`; test workers and the processes they spawn inherit it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Also suppress descendants whose launchers strip test-runner markers.
process.env.STASHBASE_TELEMETRY_DISABLED = '1';

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
