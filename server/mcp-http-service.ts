/**
 * Owns the two Streamable HTTP MCP listener lifecycles.
 *
 * The primary app server remains loopback-only and mounts `/mcp` directly.
 * Docker access is explicit opt-in: it opens a second server on `0.0.0.0`
 * whose Express app contains only the token-gated MCP route. The rest of the
 * StashBase API is never exposed by that listener.
 */
import express from 'express';
import http from 'node:http';
import { logger, errorMessage } from './log.ts';
import {
  DEFAULT_MCP_DOCKER_PORT,
  mcpHttpSettings,
  type McpHttpSettingsStore,
} from './mcp-http-settings.ts';
import { mount as mountMcpHttpTransport } from './routes/mcp-http.ts';
import type { McpHttpStatus } from '../shared/mcp.ts';

const log = logger('mcp-http-service');

export interface DockerMcpListener {
  port: number;
  close(): Promise<void>;
}

export interface DockerMcpListenerOptions {
  host: string;
  port: number;
  webBase: string;
  getToken(): string;
}

export type DockerMcpListenerFactory = (
  options: DockerMcpListenerOptions,
) => Promise<DockerMcpListener>;

export interface McpHttpService {
  mountLoopback(app: express.Express): void;
  start(): Promise<void>;
  close(): Promise<void>;
  status(): McpHttpStatus;
  rotateToken(): McpHttpStatus;
  setDockerAccess(enabled: boolean): Promise<McpHttpStatus>;
  setDockerPort(port: number): Promise<McpHttpStatus>;
}

export interface McpHttpServiceOptions {
  webPort: number;
  dockerPort?: number;
  settings?: McpHttpSettingsStore;
  openDockerListener?: DockerMcpListenerFactory;
}

export function createMcpHttpService(options: McpHttpServiceOptions): McpHttpService {
  const webPort = options.webPort;
  const dockerPortOverride = options.dockerPort;
  const settings = options.settings ?? mcpHttpSettings;
  const openDockerListener = options.openDockerListener ?? openProductionDockerListener;
  const webBase = `http://127.0.0.1:${webPort}`;
  let started = false;
  let dockerListener: DockerMcpListener | null = null;
  let dockerError: string | undefined;
  let settingsError: string | undefined;
  let transitionTail = Promise.resolve();

  try {
    settings.ensure();
  } catch (err: unknown) {
    settingsError = errorMessage(err);
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = transitionTail.then(operation, operation);
    transitionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function readSettings() {
    try {
      const current = settings.current();
      settingsError = undefined;
      return current;
    } catch (err: unknown) {
      // Preserve the actionable initialization failure (for example a
      // malformed config file) instead of replacing it with the less useful
      // "settings are not initialized" error from current().
      settingsError ??= errorMessage(err);
      throw err;
    }
  }

  function ensureSettings() {
    try {
      const current = settings.ensure();
      settingsError = undefined;
      return current;
    } catch (err: unknown) {
      settingsError = errorMessage(err);
      throw err;
    }
  }

  function getToken(): string {
    return readSettings().token;
  }

  function mountLoopback(app: express.Express): void {
    mountMcpHttpTransport(app, { webBase, getToken });
  }

  async function createDockerListener(port: number): Promise<DockerMcpListener> {
    return openDockerListener({
      host: '0.0.0.0',
      port,
      webBase,
      getToken,
    });
  }

  async function start(): Promise<void> {
    return enqueue(async () => {
      if (started) return;
      started = true;
      let current;
      try {
        current = ensureSettings();
      } catch {
        return;
      }
      if (!current.dockerAccess) return;
      if (dockerListener) return;
      try {
        dockerListener = await createDockerListener(dockerPortOverride ?? current.dockerPort);
        dockerError = undefined;
        log.info(`Docker MCP listener active on port ${dockerListener.port}`);
      } catch (err: unknown) {
        dockerError = errorMessage(err);
        log.warn(`Docker MCP listener failed: ${dockerError}`);
      }
    });
  }

  async function close(): Promise<void> {
    return enqueue(async () => {
      const listener = dockerListener;
      started = false;
      if (listener) await listener.close();
      dockerListener = null;
    });
  }

  function status(): McpHttpStatus {
    let current;
    try {
      current = readSettings();
    } catch {
      // A malformed/unreadable config fails closed, but status remains a
      // recovery point: once the user repairs the file, the next poll can
      // initialize settings without requiring an app restart.
      try {
        current = ensureSettings();
      } catch {
        current = null;
      }
    }
    const dockerPort = dockerListener?.port ?? dockerPortOverride ?? current?.dockerPort ?? DEFAULT_MCP_DOCKER_PORT;
    return {
      loopbackUrl: `${webBase}/mcp`,
      dockerUrl: `http://host.docker.internal:${dockerPort}/mcp`,
      dockerPort,
      token: current?.token ?? null,
      dockerAccess: current?.dockerAccess ?? false,
      dockerActive: dockerListener !== null,
      ...(dockerError ? { dockerError } : {}),
      ...(settingsError ? { settingsError } : {}),
    };
  }

  function rotateToken(): McpHttpStatus {
    settings.rotateToken();
    settingsError = undefined;
    return status();
  }

  async function setDockerAccess(enabled: boolean): Promise<McpHttpStatus> {
    return enqueue(async () => {
      const current = ensureSettings();
      if (enabled) {
        if (dockerListener) {
          if (!current.dockerAccess) settings.setDockerAccess(true);
          return status();
        }
        if (!started) {
          settings.setDockerAccess(true);
          return status();
        }
        const candidate = await createDockerListener(dockerPortOverride ?? current.dockerPort);
        try {
          settings.setDockerAccess(true);
        } catch (err: unknown) {
          try {
            await candidate.close();
          } catch (closeErr: unknown) {
            dockerListener = candidate;
            dockerError = `config write failed and listener rollback failed: ${errorMessage(closeErr)}`;
          }
          throw err;
        }
        dockerListener = candidate;
        dockerError = undefined;
        log.info(`Docker MCP listener active on port ${candidate.port}`);
        return status();
      }

      settings.setDockerAccess(false);
      const listener = dockerListener;
      if (listener) {
        try {
          await listener.close();
        } catch (err: unknown) {
          dockerError = errorMessage(err);
          throw err;
        }
      }
      dockerListener = null;
      dockerError = undefined;
      return status();
    });
  }

  async function setDockerPort(port: number): Promise<McpHttpStatus> {
    return enqueue(async () => {
      const current = ensureSettings();
      if (current.dockerAccess || dockerListener) {
        throw new Error('Disable Docker access before changing the MCP port.');
      }
      settings.setDockerPort(port);
      dockerError = undefined;
      return status();
    });
  }

  return { mountLoopback, start, close, status, rotateToken, setDockerAccess, setDockerPort };
}

async function openProductionDockerListener(
  options: DockerMcpListenerOptions,
): Promise<DockerMcpListener> {
  const app = createDockerMcpApp(options);
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, options.host);
  });
  return {
    port: typeof server.address() === 'object' && server.address()
      ? (server.address() as import('node:net').AddressInfo).port
      : options.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
      // Disable retires this listener, including incomplete request bodies.
      // Waiting for clients to finish would block every later transition.
      server.closeAllConnections();
    }),
  };
}

export function createDockerMcpApp(
  options: Pick<DockerMcpListenerOptions, 'webBase' | 'getToken'>,
): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));
  mountMcpHttpTransport(app, {
    webBase: options.webBase,
    getToken: options.getToken,
  });
  return app;
}
