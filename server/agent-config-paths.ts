import os from 'node:os';
import path from 'node:path';

/** Provider configuration identity must match the environment used to launch its CLI. */
export function claudeConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

export function codexConfigPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
}

/** Antigravity keeps the configuration its CLI, IDE and app share under
 * `~/.gemini/config`; it has no directory override (`GEMINI_HOME` does not
 * move it). */
function antigravityConfigDir(): string {
  return path.join(os.homedir(), '.gemini', 'config');
}

export function antigravityMcpConfigPath(): string {
  return path.join(antigravityConfigDir(), 'mcp_config.json');
}

export function antigravityHooksPath(): string {
  return path.join(antigravityConfigDir(), 'hooks.json');
}
