import assert from 'node:assert/strict';
import test from 'node:test';
import { reconciledSkillSelection, skillMenuState } from '../components/agent/skillMenuState.ts';

test('skill picker distinguishes discovery, an empty catalog, errors, and available skills', () => {
  assert.deepEqual(skillMenuState({ loading: true, skills: [], error: null }), { kind: 'loading', message: 'Finding skills for this folder…' });
  assert.deepEqual(skillMenuState({ loading: false, skills: [], error: null }), { kind: 'empty', message: 'No skills are available for this folder.' });
  assert.deepEqual(skillMenuState({ loading: false, skills: [], error: 'Runtime unavailable' }), { kind: 'error', message: 'Runtime unavailable' });
  assert.deepEqual(skillMenuState({ loading: false, skills: [{ id: 'review', name: 'review', description: 'Review code' }], error: null }), { kind: 'ready' });
});

test('skill picker clears a selection invalidated by a refreshed catalog', () => {
  const selected = { id: 'user-review', name: 'review', description: 'Review code' };
  assert.deepEqual(reconciledSkillSelection(selected, [selected]), selected);
  assert.equal(reconciledSkillSelection(selected, [{ id: 'project-review', name: 'review', description: 'Project review' }]), null);
});
