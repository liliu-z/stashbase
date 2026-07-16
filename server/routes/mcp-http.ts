/**
 * Streamable HTTP transport for the library MCP server.
 *
 * URL-only MCP clients — self-hosted agent platforms in Docker, web-based
 * agents, anything that cannot spawn a local stdio process — attach at
 * `POST /mcp` on the app server. Transport plumbing only: each request gets
 * a stateless server instance from the shared factory in
 * `mcp/library-server.ts`, whose handlers forward to the same
 * `/api/library/*` routes the stdio shim uses.
 *
 * Reachability stays local. The app server binds to the IPv4 loopback, and
 * every `/mcp` request must carry `Authorization: Bearer <token>`. The token
 * defends the URL surface that stdio never had: a spawned shim is reachable
 * only by whoever spawned it, while a loopback URL can be probed by any
 * local process, so possession of the token file marks a caller as the
 * local user. It is generated on first use into
 * `~/.stashbase/mcp-http-token` (0600). Same-machine Docker clients reach
 * the endpoint as `http://host.docker.internal:<port>/mcp` with that token.
 *
 * Stateless mode (no session ids): the tool surface is pure request /
 * response, so there are no server-initiated streams to resume — GET (SSE)
 * and DELETE (session teardown) answer 405.
 */
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLibraryMcpServer } from '../../mcp/library-server.ts';
import { logger, errorMessage } from '../log.ts';

const log = logger('mcp-http');

const TOKEN_FILE = path.join(os.homedir(), '.stashbase', 'mcp-http-token');

export function mount(app: express.Express, port: number): void {
  const webBase = `http://127.0.0.1:${port}`;
  // Create the token at boot, not on first request: the user configures
  // their client by copying the token file, which must exist as soon as
  // the endpoint does.
  const token = ensureToken();

  app.post('/mcp', (req, res) => {
    void handleMcpPost(req, res, webBase, token);
  });
  app.get('/mcp', (_req, res) => sendMethodNotAllowed(res));
  app.delete('/mcp', (_req, res) => sendMethodNotAllowed(res));
}

async function handleMcpPost(
  req: express.Request,
  res: express.Response,
  webBase: string,
  token: string,
): Promise<void> {
  if (!bearerTokenMatches(req.header('authorization'), token)) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: `Unauthorized. Pass "Authorization: Bearer <token>" with the token from ${TOKEN_FILE}.` },
      id: null,
    });
    return;
  }
  const server = createLibraryMcpServer({ webBase });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: unknown) {
    log.warn(`request failed: ${errorMessage(err)}`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'internal error' },
        id: null,
      });
    }
  }
}

function sendMethodNotAllowed(res: express.Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. The StashBase MCP endpoint is stateless: send JSON-RPC over POST.' },
    id: null,
  });
}

function bearerTokenMatches(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length).trim());
  const expected = Buffer.from(token);
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

function ensureToken(): string {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch { /* missing or unreadable — regenerate below */ }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  log.info(`generated MCP HTTP token at ${TOKEN_FILE}`);
  return token;
}
