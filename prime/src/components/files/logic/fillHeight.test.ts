import { describe, expect, it } from 'vitest';
import { fillHeight } from './fillHeight';

describe('fillHeight', () => {
  it('fills the window below the card, leaving the bottom gap', () => {
    expect(fillHeight(900, 172, 24)).toBe(704);
  });
  it('never goes below the minimum on a short window', () => {
    expect(fillHeight(500, 172, 24)).toBe(360);
  });
  it('rounds down to whole pixels so the page never scrolls by a fraction', () => {
    expect(fillHeight(900.6, 172.2, 24)).toBe(704);
  });
});
