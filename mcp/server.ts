#!/usr/bin/env -S npx tsx
/**
 * Stdio MCP server exposing the local library to Claude Desktop / Claude Code.
 *
 * The tool surface and handlers live in `library-server.ts`, shared with the
 * Streamable HTTP transport mounted on the app server
 * (`server/routes/mcp-http.ts`); this entry only owns the stdio transport.
 *
 * Single execution path: every tool forwards over HTTP to the StashBase
 * app server on :8090 (`/api/library/*` endpoints, absolute member paths). In
 * V1 this MCP host does not start StashBase itself; the desktop app must
 * already be running.
 *
 * Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):
 *   {
 *     "mcpServers": {
 *       "stashbase": {
 *         "command": "npx",
 *         "args": ["tsx", "/absolute/path/to/StashBase/mcp/server.ts"]
 *       }
 *     }
 *   }
 */
// Must come FIRST — silences console.log/info/warn/debug to stderr so
// no later import can corrupt the stdio JSON-RPC stream. See module.
import './stdio-guard.ts';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLibraryMcpServer } from './library-server.ts';

function parsePortArg(argv: string[], fallback: number): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--port=')) return Number(a.slice(7)) || fallback;
    if (a === '--port') return Number(argv[i + 1]) || fallback;
  }
  return fallback;
}
// Use 127.0.0.1 explicitly — the server binds to the IPv4 loopback and
// `localhost` resolves to ::1 first on dual-stack hosts, which would
// make every web call fail with ECONNREFUSED.
const WEB_BASE = `http://127.0.0.1:${parsePortArg(process.argv.slice(2), 8090)}`;

const server = createLibraryMcpServer({
  webBase: WEB_BASE,
  windowId: process.env.STASHBASE_WINDOW_ID,
});

async function main() {
  await server.connect(new StdioServerTransport());
  process.stderr.write('[StashBase] MCP server ready (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`[StashBase] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
