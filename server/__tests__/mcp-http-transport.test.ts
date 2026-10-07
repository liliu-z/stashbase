import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { mount } from '../routes/mcp-http.ts';
import { createDockerMcpApp, createMcpHttpService } from '../mcp-http-service.ts';
import type { McpHttpSettingsStore } from '../mcp-http-settings.ts';
import { createProjectOperations } from '../project-operations/index.ts';
import { applyLineRange } from '../project-file-reader.ts';

const initRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};

const listRequest = {
  jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
};

const callRequest = {
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'list_projects', arguments: {} },
};

test('HTTP transport enforces the live Settings token and preserves the shared tool surface', async () => {
  let token = 'a'.repeat(64);
  let configured = false;
  let searchInput: Record<string, unknown> | undefined;
  let stdioSearchBody: Record<string, unknown> | undefined;
  let readInput: { path: unknown; range: unknown } | undefined;
  let stdioReadQuery: Record<string, unknown> | undefined;
  let createProjectInput: Record<string, unknown> | undefined;
  let stdioCreateProjectBody: Record<string, unknown> | undefined;
  let stdioCreateProjectAttribution: string | undefined;
  const app = express();
  app.use(express.json());
  app.get('/api/project/info', (_req, res) => {
    res.json({ folder_home: '/tmp', folders: [] });
  });
  app.get('/api/project/file', (req, res) => {
    stdioReadQuery = req.query as Record<string, unknown>;
    res.json(applyLineRange({
      path: String(req.query.path),
      format: 'md',
      content: 'one\ntwo\nthree\n',
      version: 'v1',
    }, {
      offset: req.query.offset == null ? undefined : Number(req.query.offset),
      limit: req.query.limit == null ? undefined : Number(req.query.limit),
    }));
  });
  app.post('/api/project/search', (req, res) => {
    stdioSearchBody = req.body as Record<string, unknown>;
    res.json({ mode: req.body.mode ?? 'keyword', folder: req.body.folder, hits: [] });
  });
  app.post('/api/project/create-project', (req, res) => {
    stdioCreateProjectBody = req.body as Record<string, unknown>;
    stdioCreateProjectAttribution = req.header('x-stashbase-agent-session-id') ?? undefined;
    res.json({ path: '/tmp/Project', name: 'Project', registered: true, note: 'ok' });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  mount(app, {
    webBase: base,
    getToken: () => token,
    operations: createProjectOperations({
      hasEmbeddingKey: () => configured,
      getProjectInfo: () => ({ folder_home: '/tmp', folders: [] }),
      normalizeSearchScope: async (_folder, pathPrefix) => ({
        folderRoot: '/tmp',
        pathPrefix: typeof pathPrefix === 'string' ? pathPrefix : undefined,
      }),
      retrieval: { search: async (input) => {
        searchInput = input as unknown as Record<string, unknown>;
        return {
          evidence: [],
          availability: { state: 'ready' as const },
          truncated: false,
        };
      } },
      createProject: async (input) => {
        createProjectInput = input as unknown as Record<string, unknown>;
        return { path: '/tmp/Project', name: 'Project', registered: true, note: 'ok' };
      },
      read: async (path, range) => {
        readInput = { path, range };
        return applyLineRange({
          path: String(path),
          format: 'md',
          content: 'one\ntwo\nthree\n',
          version: 'v1',
        }, range);
      },
    }),
  });

  try {
    const unauthorized = await post(base, initRequest);
    assert.equal(unauthorized.status, 401);

    const initialized = await post(base, initRequest, token);
    assert.equal(initialized.status, 200);
    assert.equal(initialized.body.result.serverInfo.name, 'stashbase');

    const listed = await post(base, listRequest, token);
    assert.equal(listed.status, 200);
    assert.ok(listed.body.result.tools.every((tool: any) => tool.name !== 'suggest_edits'));
    const searchTool = listed.body.result.tools.find((tool: any) => tool.name === 'search_project');
    assert.deepEqual(
      searchTool.inputSchema.properties.types.items.enum,
      ['notes', 'data', 'pdf', 'image', 'docx'],
    );
    assert.deepEqual(searchTool.inputSchema.properties.mode.enum, ['semantic', 'keyword']);
    assert.equal(searchTool.inputSchema.properties.scope, undefined);
    assert.match(searchTool.description, /Every request searches one Folder/);
    for (const name of ['read_file', 'write_file', 'edit_file']) {
      const tool = listed.body.result.tools.find((candidate: any) => candidate.name === name);
      assert.match(tool.description, /Markdown.*HTML.*JSON.*(?:plain text|plain-text)/i);
    }
    const createProjectTool = listed.body.result.tools.find((tool: any) => tool.name === 'create_project');
    assert.deepEqual(createProjectTool.inputSchema.required, ['name']);
    for (const name of ['write_file', 'edit_file']) {
      const tool = listed.body.result.tools.find((candidate: any) => candidate.name === name);
      assert.match(tool.description, /Markdown, HTML, JSON, or UTF-8 plain-text/);
    }
    assert.match(
      listed.body.result.tools.find((tool: any) => tool.name === 'read_file').description,
      /Generic Workbench-only files are not listed or readable through MCP/,
    );
    const readTool = listed.body.result.tools.find((tool: any) => tool.name === 'read_file');
    assert.equal(readTool.inputSchema.properties.offset.minimum, 1);
    assert.equal(readTool.inputSchema.properties.limit.minimum, 1);

    const called = await post(base, callRequest, token);
    assert.equal(called.status, 200);

    const read = await post(base, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'read_file',
        arguments: { path: '/tmp/notes.md', offset: 1 },
      },
    }, token);
    assert.equal(read.status, 200);
    assert.deepEqual(readInput, { path: '/tmp/notes.md', range: { offset: 1, limit: undefined } });
    const readPayload = JSON.parse(read.body.result.content[0].text);
    assert.equal(readPayload.partial, true);
    assert.equal('version' in readPayload, false);

    readInput = undefined;
    const invalidRead = await post(base, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'read_file',
        arguments: { path: '/tmp/notes.md', limit: 0 },
      },
    }, token);
    assert.equal(invalidRead.status, 200);
    assert.match(invalidRead.body.error.message, /limit must be a positive integer/);
    assert.equal(readInput, undefined);

    const searched = await post(base, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'search_project',
        arguments: {
          query: 'ExactMatch',
          mode: 'keyword',
          folder: '/tmp',
          path_prefix: '/tmp/notes',
          types: ['pdf', 'docx'],
          case_strict: true,
          whole_word: true,
          top_k: 3,
        },
      },
    }, token);
    assert.equal(searched.status, 200);
    assert.deepEqual(searchInput, {
      mode: 'grep',
      query: 'ExactMatch',
      topK: 3,
      folderRoot: '/tmp',
      pathPrefix: '/tmp/notes',
      types: ['pdf', 'docx'],
      caseStrict: true,
      wholeWord: true,
    });
    const searchPayload = JSON.parse(searched.body.result.content[0].text);
    assert.equal(searchPayload.mode, 'keyword');
    assert.equal(searchPayload.top_k, 3);
    assert.deepEqual(searchPayload.types, ['pdf', 'docx']);

    for (const hasKey of [false, true, false]) {
      configured = hasKey;
      const automatic = await post(base, {
        jsonrpc: '2.0', id: 40, method: 'tools/call',
        params: { name: 'search_project', arguments: { query: 'draft', folder: '/tmp' } },
      }, token);
      assert.equal(automatic.status, 200);
      assert.equal(searchInput?.mode, hasKey ? 'hybrid' : 'grep');
      assert.equal(JSON.parse(automatic.body.result.content[0].text).mode, hasKey ? 'semantic' : 'keyword');
    }

    const invalidSearch = await post(base, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'search_project',
        arguments: { query: 'paper', types: ['spreadsheet'] },
      },
    }, token);
    assert.equal(invalidSearch.status, 200);
    assert.equal(invalidSearch.body.result.isError, true);
    assert.match(invalidSearch.body.result.content[0].text, /unknown search type/i);

    const invalidMode = await post(base, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'search_project',
        arguments: { query: 'paper', mode: 'typo' },
      },
    }, token);
    assert.equal(invalidMode.status, 200);
    assert.equal(invalidMode.body.result.isError, true);
    assert.match(invalidMode.body.result.content[0].text, /unknown search mode/i);

    // External project creation forwards only the requested directory fields.
    const created = await post(base, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'create_project',
        arguments: { name: 'Project', location: '/tmp' },
      },
    }, token);
    assert.equal(created.status, 200);
    assert.equal(JSON.parse(created.body.result.content[0].text).registered, true);
    assert.deepEqual(createProjectInput, { name: 'Project', location: '/tmp' });

    const stdio = await runStdio(address.port);
    assert.equal(stdio.initialized.result.serverInfo.name, 'stashbase');
    assert.deepEqual(stdio.listed.result.tools, listed.body.result.tools);
    assert.deepEqual(stdio.called.result, called.body.result);
    assert.deepEqual(stdioSearchBody, {
      query: 'diagram',
      top_k: 4,
      folder: '/tmp',
      types: ['image'],
      mode: 'keyword',
      case_strict: true,
      whole_word: true,
    });
    const stdioPayload = JSON.parse(stdio.searched.result.content[0].text);
    assert.equal(stdioPayload.mode, 'keyword');
    assert.equal(stdioPayload.top_k, 4);
    assert.deepEqual(stdioPayload.types, ['image']);
    const automaticStdio = await runStdio(address.port, true);
    assert.equal('mode' in (stdioSearchBody ?? {}), false);
    assert.equal(JSON.parse(automaticStdio.searched.result.content[0].text).mode, 'keyword');
    assert.deepEqual(stdioReadQuery, { path: '/tmp/notes.md', offset: '2', limit: '1' });
    const stdioReadPayload = JSON.parse(stdio.read.result.content[0].text);
    assert.deepEqual(stdioReadPayload, {
      path: '/tmp/notes.md',
      format: 'md',
      content: 'two\n',
      partial: true,
      totalLines: 3,
      nextOffset: 3,
    });
    // The stdio host forwards its session identity for project permission checks.
    assert.equal(JSON.parse(stdio.createdProject.result.content[0].text).registered, true);
    assert.deepEqual(stdioCreateProjectBody, { name: 'StdioProject' });
    assert.equal(stdioCreateProjectAttribution, 'session-attr-42');

    token = 'b'.repeat(64);
    assert.equal((await post(base, initRequest, 'a'.repeat(64))).status, 401);
    assert.equal((await post(base, initRequest, token)).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Docker-facing app exposes only the MCP transport', async () => {
  const app = createDockerMcpApp({
    webBase: 'http://127.0.0.1:9',
    getToken: () => 'a'.repeat(64),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(health.status, 404);
    const mcp = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST' });
    assert.equal(mcp.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('production Docker listener binds host interfaces and reports its actual port', async () => {
  const token = 'a'.repeat(64);
  let current = { token, dockerAccess: true, dockerPort: 8091 };
  const settings: McpHttpSettingsStore = {
    ensure: () => ({ ...current }),
    current: () => ({ ...current }),
    rotateToken: () => ({ ...current }),
    setDockerAccess: (enabled) => (current = { ...current, dockerAccess: enabled }),
    setDockerPort: (dockerPort) => (current = { ...current, dockerPort }),
  };
  const service = createMcpHttpService({ webPort: 9, dockerPort: 0, settings });
  try {
    await service.start();
    const status = service.status();
    assert.equal(status.dockerActive, true);
    assert.ok(status.dockerPort > 0);
    const response = await fetch(`http://127.0.0.1:${status.dockerPort}/mcp`, { method: 'POST' });
    assert.equal(response.status, 401);
  } finally {
    await service.close();
  }
});

async function post(base: string, body: unknown, token?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitForJsonLines(read: () => string, count: number): Promise<any[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const lines = read().trim().split('\n').filter(Boolean);
    if (lines.length >= count) return lines.slice(0, count).map((line) => JSON.parse(line));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${count} JSON lines: ${read()}`);
}

async function runStdio(port: number, omitMode = false): Promise<{
  initialized: any;
  listed: any;
  called: any;
  searched: any;
  read: any;
  createdProject: any;
}> {
  const { spawn } = await import('node:child_process');
  const entry = fileURLToPath(new URL('../../mcp/server.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', entry, '--port', String(port)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // A built-in panel session spawns the MCP host with its attribution id;
    // the host must forward it as the request header, never as a tool arg.
    env: { ...process.env, STASHBASE_AGENT_SESSION_ID: 'session-attr-42' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdin.write(`${JSON.stringify(initRequest)}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify(listRequest)}\n`);
  child.stdin.write(`${JSON.stringify(callRequest)}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'search_project',
      arguments: {
        query: 'diagram',
        ...(omitMode ? {} : { mode: 'keyword' }),
        folder: '/tmp',
        types: ['image'],
        case_strict: true,
        whole_word: true,
        top_k: 4,
      },
    },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'read_file',
      arguments: { path: '/tmp/notes.md', offset: 2, limit: 1 },
    },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'create_project',
      arguments: { name: 'StdioProject' },
    },
  })}\n`);

  try {
    const lines = await waitForJsonLines(() => stdout, 6);
    const byId = new Map(lines.map((line) => [line.id, line]));
    return {
      initialized: byId.get(1),
      listed: byId.get(2),
      called: byId.get(3),
      searched: byId.get(4),
      read: byId.get(5),
      createdProject: byId.get(6),
    };
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\nstderr: ${stderr}`);
  } finally {
    child.kill();
  }
}
