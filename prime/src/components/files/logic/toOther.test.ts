import { describe, expect, it } from 'vitest';
import { planToOther } from './toOther';

describe('planToOther', () => {
  const at = (serverId: string, dir: string) => ({ serverId, dir });
  it('copies in place (copy names) when both panes show the same folder', () => {
    expect(planToOther(at('a', '/x'), at('a', '/x'), 'copy')).toBe('copy-in-place');
  });
  it('refuses a move into the folder the items already live in', () => {
    expect(planToOther(at('a', '/x'), at('a', '/x'), 'move')).toBe('refuse-same-folder');
  });
  it('uses the local path on one server and the cross-server path otherwise', () => {
    expect(planToOther(at('a', '/x'), at('a', '/y'), 'move')).toBe('same-server');
    expect(planToOther(at('a', '/x'), at('b', '/x'), 'move')).toBe('cross-server');
  });
});
