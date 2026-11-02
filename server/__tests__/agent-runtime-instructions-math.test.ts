import assert from 'node:assert/strict';
import test from 'node:test';

import { composeAgentRuntimeInstructions } from '../agent-runtime-instructions.ts';

test('the shared agent policy gives each runtime the selected math convention', () => {
  const off = composeAgentRuntimeInstructions(undefined, false);
  const on = composeAgentRuntimeInstructions(undefined, true);

  assert.match(off, /Use `\\\(\.\.\.\\\)` for inline formulas/u);
  assert.match(off, /Dollar amounts can use ordinary `\$`/u);
  assert.match(on, /Use `\$\.\.\.\$` for inline formulas/u);
  assert.match(on, /Escape literal dollar signs as `\\\$`/u);
});
