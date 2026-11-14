import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HookCallbackMatcher, HookInput, Query } from '@anthropic-ai/claude-agent-sdk';
import type { WebSocket } from 'ws';
import { AgentSession } from './agent.ts';
import { nativeWriteTargetsProject, projectNativeWriteGuard } from './agent-native-write-guard.ts';
import { DIRECTORY_LINK } from './__tests__/filesystem-links.ts';

function fixture(t: TestContext): { project: string; outside: string } {
  // Deliberately unresolved: macOS temp paths reach /private/var through /var.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-native-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(project, 'drafts'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, 'note.md'), 'project note');
  return { project, outside };
}

function write(file: string): Record<string, unknown> {
  return { file_path: file, content: 'draft' };
}

function preToolUse(tool: string, input: Record<string, unknown>, cwd: string): HookInput {
  return {
    hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'tool-1',
    session_id: 'session', transcript_path: '', cwd,
  };
}

async function decide(guard: HookCallbackMatcher, input: HookInput): Promise<unknown> {
  return guard.hooks[0]!(input, 'tool-1', { signal: new AbortController().signal });
}

test('native writes that resolve inside the project are routed to project file tools', async (t) => {
  const { project, outside } = fixture(t);
  const inside = (tool: string, input: Record<string, unknown>, cwd = project) =>
    nativeWriteTargetsProject(tool, input, project, cwd);

  assert.equal(await inside('Write', write(path.join(project, 'note.md'))), true);
  assert.equal(await inside('Edit', { file_path: path.join(project, 'note.md'), old_string: 'a', new_string: 'b' }), true);
  assert.equal(await inside('MultiEdit', { file_path: path.join(project, 'note.md'), edits: [] }), true);
  assert.equal(await inside('NotebookEdit', { notebook_path: path.join(project, 'analysis.ipynb') }), true);
  assert.equal(await inside('Write', write(path.join(project, 'drafts', 'new.md'))), true, 'a new file in an existing project directory');
  assert.equal(await inside('Write', write(path.join(project, 'later', 'deeper', 'new.md'))), true, 'a new nested directory');
  assert.equal(await inside('Write', write('note.md')), true, 'a relative path resolves against the tool cwd');
  assert.equal(await inside('Write', write(path.join('..', 'project', 'drafts', 'x.md')), outside), true);
  assert.equal(await inside('Write', write(fs.realpathSync.native(path.join(project, 'note.md')))), true, 'the canonical spelling of an aliased project');

  assert.equal(await inside('Write', write(path.join(outside, 'draft.txt'))), false);
  assert.equal(await inside('Write', write(path.join(outside, 'new', 'draft.txt'))), false);
  assert.equal(await inside('Write', write('draft.txt'), outside), false);
  assert.equal(await inside('Write', write(path.join('..', 'outside', 'draft.txt'))), false);
  assert.equal(await inside('Write', write(`${project}-sibling${path.sep}draft.txt`)), false, 'a sibling sharing the name prefix');
  assert.equal(await inside('Read', { file_path: path.join(project, 'note.md') }), false, 'only write tools are routed');
  assert.equal(await inside('Write', {}), false);

  const variant = project.replace(/project$/, 'PROJECT');
  if (fs.existsSync(variant)) {
    assert.equal(await inside('Write', write(path.join(variant, 'note.md'))), true, 'letter case on a case-insensitive volume');
  }
});

test('links decide by where a native write would land', async (t) => {
  const { project, outside } = fixture(t);
  const inside = (file: string) => nativeWriteTargetsProject('Write', write(file), project);
  try { fs.symlinkSync(project, path.join(outside, 'into-project'), DIRECTORY_LINK); }
  catch { t.skip('directory links unavailable'); return; }
  fs.symlinkSync(outside, path.join(project, 'escape'), DIRECTORY_LINK);

  assert.equal(await inside(path.join(outside, 'into-project', 'note.md')), true);
  assert.equal(await inside(path.join(outside, 'into-project', 'drafts', 'new.md')), true);
  assert.equal(await inside(path.join(project, 'escape', 'draft.txt')), false, 'a requested external file keeps runtime permissions');
  // Same-project guard through the link, not only through its spelling.
  assert.equal(await nativeWriteTargetsProject('Write', write(path.join(project, 'note.md')), path.join(outside, 'into-project')), true);
  if (process.platform === 'win32') return;
  fs.symlinkSync(path.join(project, 'note.md'), path.join(outside, 'alias.md'));
  fs.symlinkSync(path.join(project, 'drafts', 'later.md'), path.join(outside, 'pending.md'));
  fs.symlinkSync(path.join(outside, 'loop-b'), path.join(outside, 'loop-a'));
  fs.symlinkSync(path.join(outside, 'loop-a'), path.join(outside, 'loop-b'));
  assert.equal(await inside(path.join(outside, 'alias.md')), true);
  assert.equal(await inside(path.join(outside, 'pending.md')), true, 'a dangling link that would create a project file');
  assert.equal(await inside(path.join(outside, 'loop-a')), false, 'a link cycle stays on the runtime path');
});

test('the PreToolUse guard denies in-project native writes and leaves external ones to the runtime', async (t) => {
  const { project, outside } = fixture(t);
  const guard = projectNativeWriteGuard(project);
  assert.equal(guard.matcher, 'Write|Edit|MultiEdit|NotebookEdit');

  const denied = await decide(guard, preToolUse('Write', write(path.join(project, 'drafts', 'new.md')), project)) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput?.permissionDecisionReason ?? '', /`edit_file`.*`write_file`/);
  assert.deepEqual(await decide(guard, preToolUse('Write', write(path.join(outside, 'draft.txt')), project)), {});
  assert.deepEqual(await decide(guard, preToolUse('Write', write('draft.txt'), outside)), {}, 'relative to the tool cwd');
});

test('Claude sessions install the guard for their bound project', async (t) => {
  const { project } = fixture(t);
  let hooks: { PreToolUse?: HookCallbackMatcher[] } | undefined;
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send() {}, close() {} });
  const session = new AgentSession(
    ws as unknown as WebSocket, 'native-write-guard-window', undefined, undefined, 'acceptEdits', undefined, undefined,
    ((request: { options: { hooks?: typeof hooks } }) => {
      hooks = request.options.hooks;
      return {
        async *[Symbol.asyncIterator]() {},
        supportedModels: async () => [],
        supportedCommands: async () => [],
        setModel: async () => {},
        setPermissionMode: async () => {},
        interrupt: async () => {},
      } as unknown as Query;
    }) as never,
    () => '/fake/claude',
    undefined,
    project,
  );
  t.after(() => session.dispose());
  session.begin();
  for (let i = 0; i < 20 && !hooks; i++) await new Promise((resolve) => setImmediate(resolve));

  const [guard] = hooks?.PreToolUse ?? [];
  assert.ok(guard, 'Claude must receive the PreToolUse guard');
  const result = await decide(guard, preToolUse('Write', write(path.join(project, 'note.md')), project)) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
});
