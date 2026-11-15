import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { agentSessionPort } from '@/test/fakes/agent';
import { speechFixture } from '@/test/fakes/speech';

import { createAgentSessionRuntime, type AgentSessionRuntime } from './session-runtime';
import type { SpeechRecording } from './speech-port';
import { createAgentWorkspaceRuntime, type AgentWorkspaceRuntime } from './workspace-runtime';

const disposables: { dispose(): void }[] = [];
afterEach(() => {
  for (const runtime of disposables.splice(0)) runtime.dispose();
});
function dictation(runtime: AgentSessionRuntime) {
  if (!runtime.voice) throw new Error('Missing voice fixture');
  return runtime.voice;
}
function session(fixture = speechFixture()): AgentSessionRuntime {
  const runtime = createAgentSessionRuntime({
    id: 'chat',
    agent: 'codex',
    scope: { kind: 'folder', path: '/project' },
    port: agentSessionPort().port,
    voice: fixture.ports,
  });
  disposables.push(runtime);
  return runtime;
}

describe('conversation dictation', () => {
  it('locks draft mutation and sending, flushes the last audio, and appends exactly once without sending', async () => {
    const fixture = speechFixture();
    const runtime = session(fixture);
    runtime.setDraft('An existing idea.');
    await dictation(runtime).start();
    fixture.emit();
    fixture.tail(new Int16Array(3200).fill(200));
    runtime.setDraft('An accidental replacement');
    expect(await runtime.sendPrompt()).toEqual({ ok: false, reason: 'busy' });
    expect(runtime.store.getState().draft).toBe('An existing idea.');
    await dictation(runtime).stop();
    expect(fixture.speech.audio).toHaveBeenCalledTimes(2);
    expect(fixture.speech.finish).toHaveBeenCalledWith(
      expect.any(String),
      2,
      expect.any(AbortSignal),
    );
    expect(runtime.store.getState()).toMatchObject({
      draft: 'An existing idea. A dictated idea.',
      draftLocked: false,
      transcript: [],
    });
    expect(dictation(runtime).hasUnsentDraft()).toBe(true);
    await dictation(runtime).stop();
    expect(runtime.store.getState().draft).toBe('An existing idea. A dictated idea.');
  });

  it('navigation stops capture and applies completion to the original conversation', async () => {
    const fixture = speechFixture();
    let id = 0;
    const workspace: AgentWorkspaceRuntime = createAgentWorkspaceRuntime({
      createId: () => `chat-${++id}`,
      folderPath: '/project',
      port: agentSessionPort().port,
      voice: fixture.ports,
    });
    disposables.push(workspace);
    const original = workspace.activeSession();
    await dictation(original).start();
    fixture.emit();
    const next = workspace.newChat();
    expect(next).not.toBe(original);
    await waitFor(() => expect(original.store.getState().draft).toBe('A dictated idea.'));
    expect(next.store.getState().draft).toBe('');
    expect(workspace.activeSession()).toBe(next);
  });

  it('cancel before a delayed start response cannot open a microphone or insert into a replacement draft', async () => {
    const fixture = speechFixture();
    let complete!: (recording: SpeechRecording) => void;
    let recordingId = '';
    fixture.speech.start = vi.fn((id) => {
      recordingId = id;
      return new Promise<SpeechRecording>((resolve) => {
        complete = resolve;
      });
    });
    const runtime = session(fixture);
    runtime.setDraft('Keep me');
    const pending = dictation(runtime).start();
    await dictation(runtime).cancel();
    runtime.setDraft('A newer draft');
    complete({ id: recordingId, phase: 'recording', nextSequence: 0, text: '', error: null });
    await pending;
    expect(fixture.ports.capture.open).not.toHaveBeenCalled();
    expect(fixture.speech.cancel).toHaveBeenCalledWith(recordingId, expect.any(AbortSignal));
    expect(runtime.store.getState()).toMatchObject({ draft: 'A newer draft', draftLocked: false });
  });

  it('silence and microphone denial retain the original draft and unlock it', async () => {
    const fixture = speechFixture('');
    const runtime = session(fixture);
    runtime.setDraft('Keep this');
    await dictation(runtime).start();
    await dictation(runtime).stop();
    expect(runtime.store.getState().draft).toBe('Keep this');
    expect(dictation(runtime).store.getState().error).toBe('No speech detected.');
    fixture.ports.capture.open = vi.fn(async () => {
      throw new DOMException('Denied', 'NotAllowedError');
    });
    await dictation(runtime).start();
    expect(runtime.store.getState()).toMatchObject({ draft: 'Keep this', draftLocked: false });
    expect(dictation(runtime).store.getState().error).toContain('Microphone permission was denied');
  });

  it('retries a native failure after capturing the last audio without duplicating acknowledged frames', async () => {
    const fixture = speechFixture();
    fixture.speech.audio = vi.fn(async (id, sequence) => ({
      id,
      phase: 'failed' as const,
      nextSequence: sequence + 1,
      text: 'Completed words.',
      error: 'Native process exited',
    }));
    const runtime = session(fixture);
    runtime.setDraft('Original');
    await dictation(runtime).start();
    fixture.tail(new Int16Array(8000).fill(100));
    fixture.emit();
    await waitFor(() => expect(dictation(runtime).store.getState().phase).toBe('failed'));
    expect(runtime.store.getState().draft).toBe('Original');
    fixture.speech.audio = vi.fn(async (id, sequence) => ({
      id,
      phase: 'recording' as const,
      nextSequence: sequence + 1,
      text: '',
      error: null,
    }));
    await dictation(runtime).retry();
    expect(fixture.speech.audio).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.any(Int16Array),
      expect.any(AbortSignal),
    );
    expect(runtime.store.getState()).toMatchObject({
      draft: 'Original A dictated idea.',
      draftLocked: false,
    });
  });

  it('does not forget earlier unsent dictation when a later clip is undone', async () => {
    const fixture = speechFixture();
    const runtime = session(fixture);
    runtime.setDraft('Typed');
    await dictation(runtime).start();
    await dictation(runtime).stop();
    const first = runtime.store.getState().draft;
    await dictation(runtime).start();
    await dictation(runtime).stop();
    runtime.setDraft(first);
    expect(dictation(runtime).hasUnsentDraft()).toBe(true);
    runtime.setDraft('Typed');
    expect(dictation(runtime).hasUnsentDraft()).toBe(false);
  });

  it('project retirement releases the microphone and retains the original draft target', async () => {
    const fixture = speechFixture();
    const runtime = session(fixture);
    await dictation(runtime).start();
    fixture.emit();
    runtime.retire('/project');
    await waitFor(() => expect(fixture.stop).toHaveBeenCalled());
    await waitFor(() => expect(runtime.store.getState().draft).toBe('A dictated idea.'));
    expect(runtime.store.getState().draftLocked).toBe(false);
  });
});
