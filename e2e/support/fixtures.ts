import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type FixtureMembership = 'empty' | 'one-folder' | 'two-folders';

export interface AppFixture {
  root: string;
  home: string;
  configFile: string;
  userData: string;
  localData: string;
  folderHome: string;
  artifacts: string;
  port: number;
  env: Record<string, string>;
  workspaces: {
    projectA: string;
    projectB: string;
  };
  cleanup(): Promise<void>;
}

// Avoid the OS ephemeral-client ranges used by Chromium and runner services.
// `listen(0)` returns a currently free ephemeral port but releases it before
// Electron launches, allowing an outbound connection to claim it before the
// child server binds. This bounded application range makes that handoff
// deterministic while still probing every candidate before use.
export const E2E_PORT_MIN = 18_000;
export const E2E_PORT_MAX = 31_999;
const E2E_PORT_SPAN = E2E_PORT_MAX - E2E_PORT_MIN + 1;
let nextPortCandidate = E2E_PORT_MIN + (process.pid % E2E_PORT_SPAN);

function takePortCandidate(): number {
  const candidate = nextPortCandidate;
  nextPortCandidate = candidate >= E2E_PORT_MAX ? E2E_PORT_MIN : candidate + 1;
  return candidate;
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve(true);
      });
    });
  });
}

async function reservePort(): Promise<number> {
  for (let attempt = 0; attempt < E2E_PORT_SPAN; attempt += 1) {
    const candidate = takePortCandidate();
    if (await canBindPort(candidate)) return candidate;
  }
  throw new Error(`could not reserve an E2E port in ${E2E_PORT_MIN}-${E2E_PORT_MAX}`);
}

export function serverLogFileForPlatform(
  fixture: Pick<AppFixture, 'home' | 'userData'>,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'darwin'
    ? path.join(fixture.home, 'Library', 'Logs', 'StashBase', 'server.log')
    : path.join(fixture.userData, 'logs', 'server.log');
}

function writeSource(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function assertSafeScratchRoot(root: string): void {
  const expectedPrefix = path.join(os.tmpdir(), 'stashbase-e2e-');
  if (!root.startsWith(expectedPrefix) || root === expectedPrefix) {
    throw new Error(`refusing to clean unsafe E2E scratch root: ${root}`);
  }
}

const PRIVATE_ENVIRONMENT_NAMES = new Set([
  'SSH_AUTH_SOCK',
  'GPG_AGENT_INFO',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
]);
const PRIVATE_ENVIRONMENT_NAME = /(?:^|_)(?:API_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|ACCESS_?KEY|PRIVATE_?KEY)(?:$|_)/i;

/** Keep OS/process launch context while excluding credentials, developer CLI
 * state, and StashBase/runtime overrides. Individual tests add their fake
 * runtime override only after this boundary has been created. */
export function safeInheritedEnvironment(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => {
      const [name, value] = entry;
      if (value === undefined) return false;
      if (PRIVATE_ENVIRONMENT_NAMES.has(name) || PRIVATE_ENVIRONMENT_NAME.test(name)) return false;
      if (name.startsWith('STASHBASE_')) return false;
      if (/^(?:CODEX|CLAUDE|ANTHROPIC|OPENAI|AWS|AZURE)_/.test(name)) return false;
      return true;
    }),
  );
}

export async function createAppFixture(
  options: { membership?: FixtureMembership } = {},
): Promise<AppFixture> {
  const membership = options.membership ?? 'one-folder';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-e2e-'));
  const home = path.join(root, 'home');
  const userData = path.join(root, 'electron-user-data');
  const localData = path.join(root, 'local-data');
  const folderHome = path.join(root, 'folder-home');
  const artifacts = path.join(root, 'artifacts');
  const projectA = path.join(root, 'workspaces', 'project-alpha');
  const projectB = path.join(root, 'workspaces', 'project-beta');
  const configFile = path.join(home, '.stashbase', 'config.json');

  for (const directory of [home, userData, localData, folderHome, artifacts, projectA, projectB]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  writeSource(
    path.join(projectA, 'Welcome.md'),
    '# Welcome to Project Alpha\n\nAlpha smoke fixture content.\n',
  );
  writeSource(
    path.join(projectA, 'Second Note.md'),
    '# Second Alpha Note\n\nOpened through Quick Open.\n',
  );
  writeSource(
    path.join(projectA, 'nested', 'Details.md'),
    '# Nested Details\n\nNested alpha fixture.\n',
  );
  writeSource(
    path.join(projectA, 'data.json'),
    '{\n  "fixture": "alpha",\n  "enabled": true\n}\n',
  );
  writeSource(
    path.join(projectB, 'Notes.md'),
    '# Project Beta Notes\n\nBeta smoke fixture content.\n',
  );
  writeSource(
    path.join(projectB, 'Welcome.md'),
    '# Welcome to Project Beta\n\nDuplicate relative-name fixture.\n',
  );

  const memberPaths = membership === 'empty'
    ? []
    : membership === 'one-folder'
      ? [projectA]
      : [projectA, projectB];
  const config = {
    builtinSeeded: true,
    recentFolders: memberPaths.map((memberPath, index) => ({
      path: memberPath,
      openedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    })),
    appearance: {
      theme: 'light',
      uiScale: 'default',
      readingTextSize: 'default',
    },
  };
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const port = await reservePort();
  const env: Record<string, string> = {
    ...safeInheritedEnvironment(),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(root, 'app-data'),
    LOCALAPPDATA: path.join(root, 'local-app-data'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    STASHBASE_LOCAL_DATA_ROOT: localData,
    STASHBASE_FOLDER_HOME: folderHome,
    STASHBASE_E2E_USER_DATA: userData,
    STASHBASE_E2E_ARTIFACTS: artifacts,
    // Keep ordinary journeys independent of developer-installed Agents. The
    // credential-free Agent journey opts into its fake executable explicitly.
    STASHBASE_AGENT_DEBUG: '1',
    STASHBASE_AGENT_DISCOVERY_POLICY: 'managed-only',
    // Pin the Gallery's index upstream to an unreachable port: the daemon
    // proxy fails fast, the renderer falls back to its bundled snapshot,
    // and journeys/screenshots never follow the published index.
    STASHBASE_GALLERY_INDEX_URL: 'http://127.0.0.1:9/gallery.json',
    TZ: 'UTC',
    LANG: 'en_US.UTF-8',
  };

  let cleaned = false;
  return {
    root,
    home,
    configFile,
    userData,
    localData,
    folderHome,
    artifacts,
    port,
    env,
    workspaces: { projectA, projectB },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      assertSafeScratchRoot(root);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
