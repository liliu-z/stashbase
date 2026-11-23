#!/usr/bin/env -S npx tsx
/**
 * Stdio MCP server exposing the local project to Claude Desktop and the Claude CLI.
 *
 * The tool surface and handlers live in `project-server.ts`, shared with the
 * Streamable HTTP transport mounted on the app server
 * (`server/routes/mcp-http.ts`); this entry only owns the stdio transport.
 *
 * Single execution path: every tool forwards over HTTP to the StashBase
 * app server on :8090 (`/api/project/*` endpoints, absolute member paths). In
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

import { readAppConfigStrict } from '../server/app-config.ts';
import { createNativeDiagnostics, telemetryAvailable } from '../server/native-diagnostics.ts';
import packageInfo from '../package.json' with { type: 'json' };
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProjectMcpServer } from './project-server.ts';
import { parsePortArg } from '../shared/port-arg.ts';

// Use 127.0.0.1 explicitly — the server binds to the IPv4 loopback and
// `localhost` resolves to ::1 first on dual-stack hosts, which would
// make every web call fail with ECONNREFUSED.
const WEB_BASE = `http://127.0.0.1:${parsePortArg(process.argv.slice(2), 8090)}`;

const server = createProjectMcpServer({
  webBase: WEB_BASE,
  windowId: process.env.STASHBASE_WINDOW_ID,
  // Set only when a built-in panel session spawned this host: lets
  // `create_project` attribute the call to that live session.
  agentSessionId: process.env.STASHBASE_AGENT_SESSION_ID,
  // Set only by a Default chat that enabled model tools.
});

async function main() {
  await server.connect(new StdioServerTransport());
  process.stderr.write('[StashBase] MCP server ready (stdio)\n');
}

const configPath = process.env.STASHBASE_DIAGNOSTICS_CONFIG;
const diagnostics = createNativeDiagnostics({
  available: telemetryAvailable() && Boolean(configPath && process.env.STASHBASE_DIAGNOSTICS_ROOT),
  distribution: process.env.STASHBASE_PACKAGED === '1' ? 'packaged' : 'source',
  version: packageInfo.version, directory: process.env.STASHBASE_DIAGNOSTICS_ROOT,
  // The launcher pins the host's paths, even under Default Agent's private home.
  read: () => readAppConfigStrict(configPath),
});
server.onerror = (error) => diagnostics.record(error, 'mcp-connection', { process: 'mcp-stdio', stage: 'protocol' });
process.on('uncaughtExceptionMonitor', (error) => diagnostics.record(error, 'mcp-connection', { process: 'mcp-stdio' }));
main().catch((err) => {
  diagnostics.record(err, 'mcp-connection', { process: 'mcp-stdio', stage: 'connect' });
  process.stderr.write(`[StashBase] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
