import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_AGENT_INSTRUCTIONS_LENGTH } from '../shared/agent-instructions.ts';
import {
  createAgentInstructionsStore,
  getAgentInstructions,
  readDefaultAgentInstructions,
  readDefaultLibraryAgentInstructions,
  resolveAgentInstructions,
} from './agent-instructions.ts';
import type { AppConfigFile } from './app-config.ts';

function fixture(initial: AppConfigFile = {}) {
  let config = structuredClone(initial);
  const store = createAgentInstructionsStore({
    read: () => structuredClone(config),
    readStrict: () => structuredClone(config),
    write: (next) => { config = structuredClone(next); },
    equalPath: (left, right) => left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US'),
    defaultText: 'Default Wiki guidance.',
    defaultLibraryText: 'Default Library guidance.',
  });
  return { store, config: () => config };
}

test('Agent Instructions are independent for each working folder', () => {
  const { store, config } = fixture({ appearance: { theme: 'dark' } });
  store.set({ kind: 'folder', path: '/Work/Alpha' }, 'Prefer project sources.');
  store.set({ kind: 'folder', path: '/Work/Beta' }, 'Prefer meeting notes.');

  assert.equal(store.get({ kind: 'folder', path: '/work/alpha' }).text, 'Prefer project sources.');
  assert.equal(store.get({ kind: 'folder', path: '/work/beta' }).text, 'Prefer meeting notes.');
  assert.equal(config().appearance?.theme, 'dark');
});

test('the packaged default applies until a folder is customized and blank restores it', () => {
  const { store, config } = fixture();
  assert.deepEqual(store.get({ kind: 'folder', path: '/Work/Alpha' }), {
    scope: { kind: 'folder', path: '/Work/Alpha' },
    text: 'Default Wiki guidance.',
    customized: false,
  });
  store.set({ kind: 'folder', path: '/Work/Alpha' }, 'Folder guidance');
  store.set({ kind: 'folder', path: '/work/alpha' }, '   ');

  assert.deepEqual(store.get({ kind: 'folder', path: '/Work/Alpha' }), {
    scope: { kind: 'folder', path: '/Work/Alpha' },
    text: 'Default Wiki guidance.',
    customized: false,
  });
  assert.equal(config().agentInstructions, undefined);
});

test('the Library scope has its own default and customization, independent of folders', () => {
  const { store, config } = fixture();
  assert.deepEqual(store.get({ kind: 'library' }), {
    scope: { kind: 'library' },
    text: 'Default Library guidance.',
    customized: false,
  });

  store.set({ kind: 'folder', path: '/Work/Alpha' }, 'Folder guidance');
  store.set({ kind: 'library' }, 'Find things across my library.');
  assert.equal(store.get({ kind: 'library' }).text, 'Find things across my library.');
  assert.equal(store.get({ kind: 'folder', path: '/Work/Alpha' }).text, 'Folder guidance');
  assert.deepEqual(config().agentInstructions, {
    folders: [{ path: '/Work/Alpha', text: 'Folder guidance' }],
    library: 'Find things across my library.',
  });

  // Clearing one scope never disturbs the other, and clearing both
  // compacts the config key away entirely.
  store.set({ kind: 'library' }, '   ');
  assert.equal(store.get({ kind: 'library' }).customized, false);
  assert.equal(store.get({ kind: 'folder', path: '/Work/Alpha' }).text, 'Folder guidance');
  store.set({ kind: 'folder', path: '/Work/Alpha' }, '');
  assert.equal(config().agentInstructions, undefined);
});

test('a Library Chat resolves the Library scope, and the packaged defaults are two distinct texts', () => {
  // Runtime injection and the editor must agree on what a Library Chat reads.
  assert.equal(resolveAgentInstructions(null), getAgentInstructions({ kind: 'library' }).text);
  const folderDefault = readDefaultAgentInstructions();
  const libraryDefault = readDefaultLibraryAgentInstructions();
  assert.ok(libraryDefault.length > 0);
  assert.notEqual(libraryDefault, folderDefault);
});

test('Agent Instructions reject unbounded input and defensively bound hand-edited config', () => {
  const tooLong = 'x'.repeat(MAX_AGENT_INSTRUCTIONS_LENGTH + 1);
  const scope = { kind: 'folder', path: '/Work/Alpha' } as const;
  const { store } = fixture({ agentInstructions: { folders: [{ path: scope.path, text: tooLong }] } });
  assert.equal(store.get(scope).text.length, MAX_AGENT_INSTRUCTIONS_LENGTH);
  assert.throws(
    () => store.set(scope, tooLong),
    /characters or fewer/,
  );
});

test('a malformed Agent Instructions object cannot block a later strict save', () => {
  const { store, config } = fixture({ agentInstructions: 'legacy-noise' as unknown as AppConfigFile['agentInstructions'] });
  const scope = { kind: 'folder', path: '/Work/Alpha' } as const;
  assert.equal(store.get(scope).text, 'Default Wiki guidance.');
  assert.equal(store.get(scope).customized, false);
  store.set(scope, 'Recovered guidance');
  assert.deepEqual(config().agentInstructions, {
    folders: [{ path: '/Work/Alpha', text: 'Recovered guidance' }],
  });
});
