import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger, errorMessage } from './log.ts';

const log = logger('agent-rules');

/** Claude gates each session cwd behind its folder-trust dialog. A
 *  headless SDK session can never show that dialog — it just hangs at
 *  "working" until the user runs `claude` in a terminal and accepts —
 *  and Claude Code offers no trust flag or env override (the only
 *  narrow mechanism is the per-project `hasTrustDialogAccepted` flag in
 *  `~/.claude.json`). Adding a folder to the StashBase library is the
 *  user's explicit trust act, so pre-accept trust for the session
 *  folder before connecting.
 *
 *  Conservative merge: only this one project's flag is touched, every
 *  other key is preserved, and an unreadable or malformed config is
 *  left alone (the CLI owns that file). */
export function ensureClaudeFolderTrust(
  folderRoot: string,
  configFile = path.join(os.homedir(), '.claude.json'),
): void {
  try {
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configFile)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      config = parsed as Record<string, unknown>;
    }
    const projects = asRecord(config.projects) ?? {};
    const entry = asRecord(projects[folderRoot]) ?? {};
    if (entry.hasTrustDialogAccepted === true) return;
    projects[folderRoot] = { ...entry, hasTrustDialogAccepted: true };
    config.projects = projects;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  } catch (err: unknown) {
    // Never block the session on this — worst case the user trusts the
    // folder once in a terminal, which is exactly today's behaviour.
    log.warn(`could not pre-trust ${folderRoot} for Claude: ${errorMessage(err)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
