import assert from 'node:assert/strict';
import test from 'node:test';

import { composeAgentRuntimeInstructions } from '../agent-runtime-instructions.ts';

test('the shared agent policy gives every runtime one dollar-math convention', () => {
  const instructions = composeAgentRuntimeInstructions();

  assert.match(instructions, /Use `\$\.\.\.\$` for inline formulas, with no space just inside the dollar signs/u);
  assert.match(instructions, /Write dollar amounts such as \$5 or \$50-\$100 normally/u);
  assert.doesNotMatch(instructions, /\\\(|\\\$/u, 'neither the \\(...\\) form nor escaped dollars are requested');
});
