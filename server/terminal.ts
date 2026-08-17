/**
 * Agent CLI registry. The supported CLIs (Claude Code, Codex) are
 * enumerated here with their install hints; the chat panel surfaces
 * them via `/api/terminal/clis`.
 *
 * The CLIs themselves run through structured agent bridges (Claude Agent
 * SDK in server/agent.ts, Codex app-server in server/codex-agent.ts),
 * not a PTY — this module no longer bridges a shell.
 */

function codexInstallHint(): string {
  if (process.platform === 'win32') return 'irm https://chatgpt.com/codex/install.ps1 | iex';
  return 'curl -fsSL https://chatgpt.com/codex/install.sh | sh';
}

function claudeInstallHint(): string {
  if (process.platform === 'win32') return 'irm https://claude.ai/install.ps1 | iex';
  return 'curl -fsSL https://claude.ai/install.sh | bash';
}

/** Registry of supported AI CLIs. Adding a new one = one entry here +
 *  it surfaces in the renderer's launchers automatically. `installHint`
 *  is the copy-paste command shown when the binary is missing; `bin` is
 *  what we probe on PATH. */
export interface CliDef {
  id: string;
  label: string;
  vendor: string;
  bin: string;           // PATH name we probe
  /** Argv that would be appended after `bin` to launch the CLI. Retained
   *  in the registry so `/api/terminal/clis` can expose a full launch
   *  command, though the structured chat panel doesn't shell out. */
  launchArgs: string[];
  install: string[];     // argv for `npm install -g ...` style invocation
  installHint: string;   // human-readable install command
}

export const CLIS: Record<string, CliDef> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    bin: 'claude',
    // No launch flags — Claude Code doesn't accept `--theme` on the
    // CLI. Its theme lives in `~/.claude/settings.json` (or the
    // project-local `.claude/settings.local.json`) and is also
    // switchable in-app via the `/theme` slash command.
    launchArgs: [],
    install: ['install', '-g', '@anthropic-ai/claude-code'],
    installHint: claudeInstallHint(),
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    bin: 'codex',
    // Codex doesn't yet expose a CLI-level theme flag; it (mostly)
    // honours COLORFGBG from the spawn env. Track upstream and add
    // a flag here if/when one appears.
    launchArgs: [],
    install: ['install', '-g', '@openai/codex'],
    installHint: codexInstallHint(),
  },
};

/** Full shell command that would launch a CLI: `<bin> <args…>`.
 *  Surfaced via `/api/terminal/clis` for completeness. */
export function launchCommandFor(cli: CliDef): string {
  return [cli.bin, ...cli.launchArgs].join(' ');
}
