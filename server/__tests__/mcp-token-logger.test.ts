import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  estimateTokens,
  canonicalize,
  checkAndRecordDuplicateCall,
  checkAndRecordFileRead,
  calculatePrettyPrintOverhead,
  logToolCall,
  resetSessionState,
  findProjectRoot,
  getLogFilePath,
} from '../../mcp/token-logger.ts';
import {
  analyzeMcpLogLines,
  formatSummaryMarkdown,
  resolveLogPath,
} from '../../scripts/analyze-mcp-logs.ts';
import { createProjectMcpServer } from '../../mcp/project-server.ts';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

test('estimateTokens calculates character count and 4-char heuristic', () => {
  assert.deepEqual(estimateTokens(''), { charCount: 0, estTokens: 0 });
  assert.deepEqual(estimateTokens('abcd'), { charCount: 4, estTokens: 1 });
  assert.deepEqual(estimateTokens('abcde'), { charCount: 5, estTokens: 2 });
  assert.deepEqual(estimateTokens('12345678'), { charCount: 8, estTokens: 2 });
});

test('canonicalize sorts keys deterministically', () => {
  const obj1 = { z: 1, a: 2, m: { y: 10, b: 20 } };
  const obj2 = { a: 2, z: 1, m: { b: 20, y: 10 } };
  assert.equal(JSON.stringify(canonicalize(obj1)), JSON.stringify(canonicalize(obj2)));
  assert.deepEqual(canonicalize([obj1]), canonicalize([obj2]));
  assert.equal(canonicalize(null), null);
  assert.equal(canonicalize(42), 42);
});

test('checkAndRecordDuplicateCall detects repeated calls with same args', () => {
  resetSessionState();

  const first = checkAndRecordDuplicateCall('read_file', { path: '/a/b.md', offset: 1 });
  assert.equal(first, false, 'first call is not duplicate');

  const second = checkAndRecordDuplicateCall('read_file', { offset: 1, path: '/a/b.md' });
  assert.equal(second, true, 'identical call with different key order is duplicate');

  const differentArgs = checkAndRecordDuplicateCall('read_file', { path: '/a/c.md' });
  assert.equal(differentArgs, false, 'different args is not duplicate');

  const differentTool = checkAndRecordDuplicateCall('list_directory', { path: '/a/b.md', offset: 1 });
  assert.equal(differentTool, false, 'different tool is not duplicate');
});

test('checkAndRecordFileRead detects unchanged content re-reads', () => {
  resetSessionState();

  const readPayload = JSON.stringify({
    path: '/project/notes/doc.md',
    content: 'hello world from stashbase',
  });

  const first = checkAndRecordFileRead('read_file', { path: '/project/notes/doc.md' }, readPayload);
  assert.equal(first, false, 'initial read is not marked as unchanged re-read');

  const second = checkAndRecordFileRead('read_file', { path: '/project/notes/doc.md' }, readPayload);
  assert.equal(second, true, 'subsequent read with identical content is marked unchanged re-read');

  const changedPayload = JSON.stringify({
    path: '/project/notes/doc.md',
    content: 'hello world updated',
  });
  const third = checkAndRecordFileRead('read_file', { path: '/project/notes/doc.md' }, changedPayload);
  assert.equal(third, false, 'read with modified content is not unchanged re-read');

  const nonRead = checkAndRecordFileRead('write_file', { path: '/project/notes/doc.md' }, changedPayload);
  assert.equal(nonRead, false, 'non-read tools are ignored');
});

test('calculatePrettyPrintOverhead measures difference from compact JSON', () => {
  const data = { message: 'hello', count: 42, items: [1, 2, 3] };
  const pretty = JSON.stringify(data, null, 2);
  const prettyTokens = estimateTokens(pretty).estTokens;

  const overhead = calculatePrettyPrintOverhead(pretty, prettyTokens);
  assert.ok(overhead >= 0, 'overhead should be non-negative');

  const nonJsonOverhead = calculatePrettyPrintOverhead('plain text not json', 10);
  assert.equal(nonJsonOverhead, 0, 'non-JSON has zero overhead');
});

test('logToolCall writes JSONL records and handles errors gracefully', () => {
  resetSessionState();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-log-test-'));
  const logFile = path.join(tempDir, 'sub', 'test.jsonl');
  const prevEnv = process.env.STASHBASE_MCP_LOG_PATH;
  process.env.STASHBASE_MCP_LOG_PATH = logFile;

  try {
    const record = logToolCall({
      toolName: 'read_file',
      args: { path: '/test/note.md' },
      durationMs: 15,
      textPayload: JSON.stringify({ path: '/test/note.md', content: 'content' }, null, 2),
    });

    assert.ok(record);
    assert.equal(record?.toolName, 'read_file');
    assert.equal(record?.isDuplicateCall, false);
    assert.ok(fs.existsSync(logFile));

    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0] ?? '{}');
    assert.equal(parsed.toolName, 'read_file');
    assert.equal(parsed.durationMs, 15);
  } finally {
    process.env.STASHBASE_MCP_LOG_PATH = prevEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('analyzeMcpLogLines and formatSummaryMarkdown summarize tool usage and waste', () => {
  const lines = [
    JSON.stringify({
      timestamp: new Date().toISOString(),
      toolName: 'read_file',
      durationMs: 12,
      charCount: 400,
      estTokens: 100,
      isDuplicateCall: false,
      isUnchangedFileReread: false,
      prettyPrintOverheadTokens: 15,
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      toolName: 'read_file',
      durationMs: 8,
      charCount: 400,
      estTokens: 100,
      isDuplicateCall: true,
      isUnchangedFileReread: true,
      prettyPrintOverheadTokens: 15,
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      toolName: 'search_project',
      durationMs: 35,
      charCount: 800,
      estTokens: 200,
      isDuplicateCall: false,
      isUnchangedFileReread: false,
      prettyPrintOverheadTokens: 25,
    }),
  ];

  const analysis = analyzeMcpLogLines(lines, 'test.jsonl');
  assert.equal(analysis.totalCalls, 3);
  assert.equal(analysis.totalEstTokens, 400);
  assert.equal(analysis.totalDuplicateCalls, 1);
  assert.equal(analysis.totalUnchangedReReads, 1);
  assert.equal(analysis.totalWastedTokens, 100);
  assert.equal(analysis.totalPrettyPrintOverheadTokens, 55);

  const md = formatSummaryMarkdown(analysis);
  assert.match(md, /# MCP Token & Workflow Baseline Summary/);
  assert.match(md, /`read_file`/);
  assert.match(md, /`search_project`/);
  assert.match(md, /Duplicate Tool Calls:\*\* 1/);
  assert.match(md, /Unchanged File Re-reads:\*\* 1/);
  assert.match(md, /Wasted Tokens \(Unchanged Re-reads\):\*\* 100/);
});

test('createProjectMcpServer invokes logToolCall upon tool completion', async () => {
  resetSessionState();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-server-log-'));
  const logFile = path.join(tempDir, 'server-calls.jsonl');
  const prevEnv = process.env.STASHBASE_MCP_LOG_PATH;
  process.env.STASHBASE_MCP_LOG_PATH = logFile;

  try {
    const dummyOps = {
      info: async () => ({ folder_home: '/home', folders: [] }),
      search: async () => ({ hits: [], mode: 'keyword' as const, folder: '/home' }),
      keywordSearch: async () => ({ hits: [], mode: 'keyword' as const, folder: '/home' }),
      reindex: async () => ({ folders: [], total: 0, indexed: 0, pendingCount: 0, pending: 0, upToDate: true }),
      createProject: async () => ({ path: '/home/new' }),
      listDirectory: async () => ({ path: '/home', entries: [] }),
      read: async () => ({ path: '/home/note.md', format: 'markdown', content: 'test data' }),
      write: async () => ({ path: '/home/note.md', version: '1' }),
      edit: async () => ({ path: '/home/note.md', version: '2' }),
      move: async () => ({ path: '/home/renamed.md' }),
      delete: async () => ({ ok: true }),
    };

    const server = createProjectMcpServer({
      webBase: 'http://127.0.0.1:8090',
      operations: dummyOps as any,
    });

    const serverRecord = server as unknown as Record<string, Map<string, Function>>;
    const handler = serverRecord['_requestHandlers']?.get(CallToolRequestSchema.shape.method.value);
    assert.ok(handler, 'CallToolRequestSchema handler exists');

    const result = await handler({
      method: 'tools/call',
      params: {
        name: 'list_projects',
        arguments: {},
      },
    }, { signal: new AbortController().signal, sendNotification: async () => {} });

    assert.ok(result.content);
    assert.ok(fs.existsSync(logFile), 'log file was created');
    const content = fs.readFileSync(logFile, 'utf8').trim();
    const logged = JSON.parse(content);
    assert.equal(logged.toolName, 'list_projects');
    assert.equal(typeof logged.durationMs, 'number');
    assert.ok(logged.charCount > 0);
  } finally {
    process.env.STASHBASE_MCP_LOG_PATH = prevEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('findProjectRoot and getLogFilePath resolve to repo root from source and bundled layouts', () => {
  const repoRoot = process.cwd();
  const sourceMcpDir = path.join(repoRoot, 'mcp');
  const bundledMcpDir = path.join(repoRoot, 'dist', 'mcp');
  const expectedLog = path.join(repoRoot, 'logs', 'mcp-token-baseline.jsonl');

  const prevAppRoot = process.env.STASHBASE_APP_ROOT;
  const prevLogPath = process.env.STASHBASE_MCP_LOG_PATH;
  delete process.env.STASHBASE_APP_ROOT;
  delete process.env.STASHBASE_MCP_LOG_PATH;

  try {
    // 1. Source layout resolution
    assert.equal(findProjectRoot(sourceMcpDir), repoRoot);
    assert.equal(getLogFilePath(sourceMcpDir), expectedLog);

    // 2. Bundled dist layout resolution: must NOT resolve to dist/logs
    assert.equal(findProjectRoot(bundledMcpDir), repoRoot);
    assert.equal(getLogFilePath(bundledMcpDir), expectedLog);
    assert.ok(!getLogFilePath(bundledMcpDir).includes(path.join('dist', 'logs')));

    // 3. STASHBASE_APP_ROOT override precedence
    const customAppRoot = path.join(repoRoot, 'custom-app-root');
    process.env.STASHBASE_APP_ROOT = customAppRoot;
    assert.equal(findProjectRoot(bundledMcpDir), path.resolve(customAppRoot));
    assert.equal(getLogFilePath(bundledMcpDir), path.join(path.resolve(customAppRoot), 'logs', 'mcp-token-baseline.jsonl'));

    // 4. STASHBASE_MCP_LOG_PATH explicit override precedence over everything
    const explicitLog = path.join(repoRoot, 'custom-logs', 'test.jsonl');
    process.env.STASHBASE_MCP_LOG_PATH = explicitLog;
    assert.equal(getLogFilePath(bundledMcpDir), path.resolve(explicitLog));
    assert.equal(resolveLogPath(), path.resolve(explicitLog));
  } finally {
    if (prevAppRoot !== undefined) process.env.STASHBASE_APP_ROOT = prevAppRoot;
    else delete process.env.STASHBASE_APP_ROOT;
    if (prevLogPath !== undefined) process.env.STASHBASE_MCP_LOG_PATH = prevLogPath;
    else delete process.env.STASHBASE_MCP_LOG_PATH;
  }
});

test('resolveLogPath in analyzer matches getLogFilePath in logger', () => {
  const prevLogPath = process.env.STASHBASE_MCP_LOG_PATH;
  delete process.env.STASHBASE_MCP_LOG_PATH;

  try {
    // Default paths match
    assert.equal(resolveLogPath(), getLogFilePath());

    // Configured paths match
    const customPath = path.join(process.cwd(), 'logs', 'custom.jsonl');
    process.env.STASHBASE_MCP_LOG_PATH = customPath;
    assert.equal(resolveLogPath(), getLogFilePath());
    assert.equal(resolveLogPath(), path.resolve(customPath));
  } finally {
    if (prevLogPath !== undefined) process.env.STASHBASE_MCP_LOG_PATH = prevLogPath;
    else delete process.env.STASHBASE_MCP_LOG_PATH;
  }
});

test('CallToolRequestSchema logs thrown tool errors and propagates original error', async () => {
  resetSessionState();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-error-log-'));
  const logFile = path.join(tempDir, 'error-calls.jsonl');
  const prevEnv = process.env.STASHBASE_MCP_LOG_PATH;
  process.env.STASHBASE_MCP_LOG_PATH = logFile;

  try {
    const dummyOps = {
      info: async () => ({ folder_home: '/home', folders: [] }),
      search: async () => {
        throw new Error('Database connection failed');
      },
      keywordSearch: async () => ({ hits: [], mode: 'keyword' as const, folder: '/home' }),
      reindex: async () => ({ folders: [], total: 0, indexed: 0, pendingCount: 0, pending: 0, upToDate: true }),
      createProject: async () => ({ path: '/home/new' }),
      listDirectory: async () => ({ path: '/home', entries: [] }),
      read: async () => ({ path: '/home/note.md', format: 'markdown', content: 'test data' }),
      write: async () => ({ path: '/home/note.md', version: '1' }),
      edit: async () => ({ path: '/home/note.md', version: '2' }),
      move: async () => ({ path: '/home/renamed.md' }),
      delete: async () => ({ ok: true }),
    };

    const server = createProjectMcpServer({
      webBase: 'http://127.0.0.1:8090',
      operations: dummyOps as any,
    });

    const serverRecord = server as unknown as Record<string, Map<string, Function>>;
    const handler = serverRecord['_requestHandlers']?.get(CallToolRequestSchema.shape.method.value);
    assert.ok(handler, 'CallToolRequestSchema handler exists');

    const extra = { signal: new AbortController().signal, sendNotification: async () => {} };

    // 1. Thrown exception from missing query argument in search_project
    await assert.rejects(
      async () => {
        await handler({
          method: 'tools/call',
          params: {
            name: 'search_project',
            arguments: { query: '' },
          },
        }, extra);
      },
      (err: Error) => err.message === '`query` is required',
      'original error must be propagated to caller',
    );

    // 2. Thrown exception from unknown tool
    await assert.rejects(
      async () => {
        await handler({
          method: 'tools/call',
          params: {
            name: 'non_existent_tool',
            arguments: { foo: 'bar' },
          },
        }, extra);
      },
      (err: Error) => err.message === 'unknown tool: non_existent_tool',
      'unknown tool error must be propagated to caller',
    );

    // 3. Verify exactly 2 records were logged, one per thrown call
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'exactly two records logged for two calls');

    const first = JSON.parse(lines[0] ?? '{}');
    assert.equal(first.toolName, 'search_project');
    assert.equal(first.isError, true, 'isError must be true');
    assert.ok(first.durationMs >= 0, 'durationMs must be non-negative');
    assert.equal(first.charCount, '`query` is required'.length);
    assert.equal(first.estTokens, Math.ceil('`query` is required'.length / 4));

    const second = JSON.parse(lines[1] ?? '{}');
    assert.equal(second.toolName, 'non_existent_tool');
    assert.equal(second.isError, true, 'isError must be true');
    assert.ok(second.durationMs >= 0, 'durationMs must be non-negative');
    assert.equal(second.charCount, 'unknown tool: non_existent_tool'.length);
    assert.equal(second.estTokens, Math.ceil('unknown tool: non_existent_tool'.length / 4));

    // 4. Successful call is returned unchanged and not double-logged
    const successResult = await handler({
      method: 'tools/call',
      params: {
        name: 'list_projects',
        arguments: {},
      },
    }, extra);

    assert.ok(successResult.content, 'successful call returns response');
    const linesAfterSuccess = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(linesAfterSuccess.length, 3, 'successful call adds exactly one record');
    const third = JSON.parse(linesAfterSuccess[2] ?? '{}');
    assert.equal(third.toolName, 'list_projects');
    assert.equal(third.isError, undefined, 'successful call does not have isError true');

    // 5. Unwritable log path cannot mask or replace tool error
    process.env.STASHBASE_MCP_LOG_PATH = path.join(tempDir, 'nonexistent_dir', '\0', 'invalid.jsonl');
    await assert.rejects(
      async () => {
        await handler({
          method: 'tools/call',
          params: {
            name: 'unknown_tool_2',
            arguments: {},
          },
        }, extra);
      },
      (err: Error) => err.message === 'unknown tool: unknown_tool_2',
      'tool error must still be propagated even when logger fails',
    );
  } finally {
    process.env.STASHBASE_MCP_LOG_PATH = prevEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
