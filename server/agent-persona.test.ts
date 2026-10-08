import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MAX_AGENT_PERSONA_LENGTH } from '../shared/agent-persona.ts';
import {
  createAgentPersonaLibrary,
  PACKAGED_AGENT_PERSONAS_DIR,
  parsePersonaFile,
  trackChatPersona,
} from './agent-persona.ts';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-personas-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const io = {
    directory: path.join(root, 'personas'),
    chatsFile: path.join(root, 'persona-chats.json'),
    packagedDirectory: PACKAGED_AGENT_PERSONAS_DIR,
  };
  return { io, library: createAgentPersonaLibrary(io) };
}

test('a new library installs the packaged personas once, as Gallery copies', (t) => {
  const { io, library } = fixture(t);
  const ids = library.list().map((persona) => persona.id).sort();
  assert.deepEqual(ids, ['builder', 'journalist', 'marketer', 'storyteller']);
  const journalist = library.list().find((persona) => persona.id === 'journalist');
  assert.equal(journalist?.name, 'Journalist');
  assert.equal(journalist?.icon, 'newspaper');
  assert.equal(journalist?.gallery, 'journalist');
  assert.match(journalist?.prompt ?? '', /^Take the persona of a news journalist/u);

  // Deleting a packaged persona is the reader's choice; it is not reinstalled.
  for (const id of ids) library.remove(id);
  assert.deepEqual(createAgentPersonaLibrary(io).list(), []);
});

test('a reader can keep adding personas, edit them, and delete them', (t) => {
  const { io, library } = fixture(t);
  const first = library.create({ name: 'My Twitter voice', description: 'Short and dry', icon: 'feather', prompt: '  Write short.\n\nNo emoji.  ' });
  const second = library.create({ name: '我的口吻', description: '', icon: 'smile', prompt: '简洁。' });
  assert.match(first.id, /^my-twitter-voice-[0-9a-f]{6}$/u);
  assert.match(second.id, /^persona-[0-9a-f]{6}$/u);
  assert.equal(first.prompt, 'Write short.\n\nNo emoji.');
  assert.equal(first.gallery, null);
  assert.deepEqual(library.list().slice(-2).map((persona) => persona.id), [first.id, second.id]);

  const edited = library.update(first.id, { name: 'Twitter', description: '', icon: 'mic', prompt: 'Shorter.' });
  assert.equal(edited.prompt, 'Shorter.');
  assert.equal(library.prompt(first.id), 'Shorter.');
  assert.ok(fs.readFileSync(path.join(io.directory, `${first.id}.md`), 'utf8').includes('name: Twitter'));

  library.remove(first.id);
  assert.equal(library.prompt(first.id), '');
  assert.throws(() => library.update(first.id, edited), /no longer exists/u);
  assert.throws(() => library.remove(first.id), /no longer exists/u);
});

test('editing a Gallery copy keeps its origin, and a persona refuses unusable input', (t) => {
  const { library } = fixture(t);
  const builder = library.update('builder', { name: 'Builder', description: '', icon: 'hammer', prompt: 'Mine now.' });
  assert.equal(builder.gallery, 'builder');

  const valid = { name: 'X', description: '', icon: 'drama', prompt: 'P' };
  assert.throws(() => library.create({ ...valid, name: '   ' }), /name/u);
  assert.throws(() => library.create({ ...valid, prompt: '  ' }), /Write the persona/u);
  assert.throws(() => library.create({ ...valid, icon: 'rocket' }), /icon/u);
  assert.throws(() => library.create({ ...valid, prompt: 'x'.repeat(MAX_AGENT_PERSONA_LENGTH + 1) }), /characters or fewer/u);
  assert.throws(() => library.create({ ...valid, gallery: '../escape' }), /gallery/u);
  // An id is a file name in the library, never a path out of it.
  assert.equal(library.prompt('../personas/builder'), '');
  assert.throws(() => library.remove('../builder'), /no longer exists/u);
});

test('a hand-edited file reads as the nearest valid persona, and an empty one is not listed', () => {
  assert.deepEqual(parsePersonaFile('plain', 'Just a prompt.\n'), {
    id: 'plain', name: 'plain', description: '', icon: 'drama', prompt: 'Just a prompt.', gallery: null,
  });
  assert.equal(parsePersonaFile('odd', '---\nname: Odd\nicon: rocket\n---\nBody')?.icon, 'drama');
  assert.equal(parsePersonaFile('empty', '---\nname: Empty\n---\n\n'), null);
  assert.equal(parsePersonaFile('broken', '---\nname: [unclosed\n---\nBody'), null);
});

test('each Chat remembers its own persona, and a deleted persona restores as none', (t) => {
  const { library } = fixture(t);
  library.recordChat('claude', 'session-a', 'journalist');
  library.recordChat('codex', 'session-a', 'marketer');
  assert.equal(library.chatPersona('claude', 'session-a'), 'journalist');
  assert.equal(library.chatPersona('codex', 'session-a'), 'marketer');

  library.recordChat('claude', 'session-a', null);
  assert.equal(library.chatPersona('claude', 'session-a'), null);

  library.recordChat('claude', 'session-b', 'storyteller');
  library.remove('storyteller');
  assert.equal(library.chatPersona('claude', 'session-b'), null);
});

test('the socket seam records the persona against the id the runtime announces', (t) => {
  const { library } = fixture(t);
  const sent: unknown[] = [];
  const fresh = { send: (data: unknown) => { sent.push(data); } };
  trackChatPersona(fresh, 'claude', { persona: 'builder' }, () => library);
  fresh.send(JSON.stringify({ t: 'ready' }));
  fresh.send(JSON.stringify({ t: 'session-id', id: 'native-1' }));
  assert.equal(sent.length, 2);
  assert.equal(library.chatPersona('claude', 'native-1'), 'builder');

  // Resuming under none clears what the Chat ran before.
  const resumed = { send: () => {} };
  trackChatPersona(resumed, 'claude', { resume: 'native-1' }, () => library);
  assert.equal(library.chatPersona('claude', 'native-1'), null);
});
