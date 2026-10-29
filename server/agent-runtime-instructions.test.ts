import assert from 'node:assert/strict';
import test from 'node:test';

import { composeAgentRuntimeInstructions } from './agent-runtime-instructions.ts';

/** The Math switch reaches the agent as a named delimiter, so what it writes
 *  stays legible in the project that reads it. The policy line is only added
 *  when a project supplied a switch; a scope-less conversation leaves the
 *  delimiters to the user's own request. */
test('runtime instructions carry the project Math mode as the formula source', () => {
  const base = composeAgentRuntimeInstructions();
  assert.ok(!base.includes('write inline formulas'),
    'no switch means the policy names no delimiter preference');

  // On: `$...$` opens a formula, so the agent writes that and escapes amounts.
  const on = composeAgentRuntimeInstructions(undefined, true);
  assert.ok(on.includes('$...$'));
  assert.ok(on.includes('$$'), 'the display `$$` delimiter survives composition');
  assert.ok(!on.includes('\\(...\\)'));
  assert.ok(on.includes('literal dollar sign'));
  assert.ok(on.indexOf('write inline formulas') < on.indexOf('</stashbase_runtime_policy>'),
    'the math line sits inside the policy block');

  // Off: a plain `$` is an amount, so formulas use `\(..\)`.
  const off = composeAgentRuntimeInstructions(undefined, false);
  assert.ok(off.includes('\\(...\\)'));
  assert.ok(!off.includes('$...$'));
  assert.ok(!off.includes('literal dollar sign'));

  // A chosen Persona still frames the same policy; the switch only edits the
  // tail of the block, so role and Persona keep their order.
  const withPersona = composeAgentRuntimeInstructions('Be terse.', true);
  assert.ok(withPersona.indexOf('Be terse.') < withPersona.indexOf('write inline formulas'));
});
