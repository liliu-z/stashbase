import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentPersonaInputSchema, agentPersonaSchema } from './agent-persona.ts';

const PERSONA = {
  description: 'A neutral news report',
  gallery: 'journalist',
  icon: 'newspaper',
  id: 'journalist',
  name: 'Journalist',
  prompt: 'Report what happened.',
};

test('a library persona carries its Gallery origin or none', () => {
  assert.deepEqual(agentPersonaSchema.parse(PERSONA), PERSONA);
  assert.equal(agentPersonaSchema.safeParse({ ...PERSONA, gallery: null }).success, true);
});

test('a persona id names one file and never a path', () => {
  for (const id of ['../escape', 'Upper', '', 'a/b', '-lead']) {
    assert.equal(agentPersonaSchema.safeParse({ ...PERSONA, id }).success, false, id);
  }
});

test('an input refuses an unknown icon and fields the service does not take', () => {
  const input = { description: '', icon: 'feather', name: 'Mine', prompt: 'Short sentences.' };
  assert.equal(agentPersonaInputSchema.safeParse(input).success, true);
  assert.equal(agentPersonaInputSchema.safeParse({ ...input, icon: 'rocket' }).success, false);
  assert.equal(agentPersonaInputSchema.safeParse({ ...input, id: 'forged' }).success, false);
});
