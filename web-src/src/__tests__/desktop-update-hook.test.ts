import assert from 'node:assert/strict';
import test from 'node:test';
import React, { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { DesktopUpdateState, ElectronBridge } from '../electronBridge';
import { useDesktopUpdate } from '../hooks/useDesktopUpdate';

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = (phase: DesktopUpdateState['phase'], extra: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  phase,
  currentVersion: '2.0.0',
  platform: 'win32',
  autoCheckEnabled: true,
  releaseUrl: 'https://github.com/liliu-z/stashbase/releases/latest',
  ...extra,
});

function UpdateStateHarness() {
  const { state: updateState } = useDesktopUpdate();
  return createElement('span', null, updateState?.phase ?? 'none');
}

test('a late initial updater snapshot cannot erase a newer pushed state', async () => {
  const originalWindow = globalThis.window;
  let resolveInitial!: (value: DesktopUpdateState) => void;
  const initial = new Promise<DesktopUpdateState>((resolve) => { resolveInitial = resolve; });
  let pushState: ((next: DesktopUpdateState) => void) | undefined;
  let unsubscribed = false;
  const bridge: ElectronBridge = {
    getUpdateState: () => initial,
    onUpdateState: (handler) => {
      pushState = handler;
      return () => { unsubscribed = true; };
    },
  };
  Object.assign(globalThis, { window: { electron: bridge } });

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(createElement(UpdateStateHarness));
    });
    await act(async () => {
      pushState?.(state('available', { availableVersion: '2.1.0' }));
    });
    assert.equal(renderer!.root.findByType('span').children.join(''), 'available');

    await act(async () => {
      resolveInitial(state('idle'));
      await initial;
    });
    assert.equal(renderer!.root.findByType('span').children.join(''), 'available');
  } finally {
    if (renderer) await act(async () => renderer?.unmount());
    assert.equal(unsubscribed, true);
    Object.assign(globalThis, { window: originalWindow });
  }
});
