import { describe, expect, it } from 'vite-plus/test';

import { AGENT_ACCESS_MODES, honoredAccessMode } from './access';

describe('honoredAccessMode', () => {
  it('keeps a mode the runtime honors', () => {
    expect(honoredAccessMode(AGENT_ACCESS_MODES, 'plan')).toBe('plan');
  });

  it('settles on Auto, then Edit, then Ask, then whatever the runtime offers first', () => {
    expect(honoredAccessMode(['default', 'auto'], 'plan')).toBe('auto');
    expect(honoredAccessMode(['default', 'acceptEdits', 'plan'], 'auto')).toBe('acceptEdits');
    expect(honoredAccessMode(['default', 'plan'], 'auto')).toBe('default');
    expect(honoredAccessMode(['plan'], 'auto')).toBe('plan');
  });

  it('leaves a session alone when the runtime honors no mode at all', () => {
    expect(honoredAccessMode([], 'auto')).toBe('auto');
  });
});
