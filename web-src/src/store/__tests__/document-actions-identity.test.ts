import assert from 'node:assert/strict';
import test from 'node:test';
import React, { useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { EditorHandle } from '../actionTypes';
import { initialState, type Action, type State } from '../state';
import { useDocumentActions } from '../useDocumentActions';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const loadFiles = async (): Promise<State['files']> => [];
const refreshIndexState = async () => undefined;
const toast = () => 'toast';
const primeFind = () => undefined;
const askConfirm = async () => true;
const dispatch = (_action: Action) => undefined;

function DocumentActionsHarness({
  onRender,
  pollRevision,
}: {
  onRender: (actions: ReturnType<typeof useDocumentActions>) => void;
  pollRevision: number;
}) {
  const state = useRef(initialState);
  const editor = useRef<EditorHandle | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlight = useRef<Promise<boolean> | null>(null);
  const actions = useDocumentActions(
    { state, editor, saveTimer, saveInFlight },
    { loadFiles, refreshIndexState, toast, primeFind, askConfirm },
    dispatch,
  );
  onRender(actions);
  return React.createElement('span', null, pollRevision);
}

test('poll-driven parent rerenders keep document command identities stable', async () => {
  const renders: Array<ReturnType<typeof useDocumentActions>> = [];
  const onRender = (actions: ReturnType<typeof useDocumentActions>) => renders.push(actions);
  let renderer: ReactTestRenderer;

  await act(async () => {
    renderer = create(React.createElement(DocumentActionsHarness, { onRender, pollRevision: 0 }));
  });
  await act(async () => {
    renderer!.update(React.createElement(DocumentActionsHarness, { onRender, pollRevision: 1 }));
  });

  assert.equal(renders.length, 2);
  for (const [name, command] of Object.entries(renders[0])) {
    assert.strictEqual(
      renders[1][name as keyof typeof renders[1]],
      command,
      `an unrelated index poll must not replace the ${name} command`,
    );
  }
  await act(async () => { renderer!.unmount(); });
});
