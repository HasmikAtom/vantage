import { describe, expect, it } from 'vitest';
import { PANE_RATIO_DEFAULT, clampPaneRatio, parsePaneRatio, ratioFromPointer } from './paneRatio';

describe('clampPaneRatio', () => {
  it('keeps each pane at least 360 px wide', () => {
    expect(clampPaneRatio(0.5, 1000)).toBe(0.5);
    expect(clampPaneRatio(0.1, 1000)).toBe(0.36);
    expect(clampPaneRatio(0.95, 1000)).toBe(0.64);
  });
  it('falls back to an even split when there is no room for two minimum panes', () => {
    expect(clampPaneRatio(0.2, 700)).toBe(0.5);
  });
  it('only applies the 10–90 % range when the width is unknown', () => {
    expect(clampPaneRatio(0.02, 0)).toBe(0.1);
    expect(clampPaneRatio(0.6, 0)).toBe(0.6);
  });
  it('rounds to a tenth of a percent', () => {
    expect(clampPaneRatio(0.123456, 0)).toBe(0.123);
  });
});

describe('ratioFromPointer', () => {
  it('is the pointer position across the panes area', () => {
    expect(ratioFromPointer(600, 200, 1000)).toBe(0.4);
  });
});

describe('parsePaneRatio', () => {
  it('reads a saved ratio', () => {
    expect(parsePaneRatio('0.35')).toBe(0.35);
  });
  it('falls back to 50/50 for missing or invalid values', () => {
    for (const raw of [null, '', 'abc', '0', '1', '-0.2', '1.5', 'NaN']) {
      expect(parsePaneRatio(raw)).toBe(PANE_RATIO_DEFAULT);
    }
  });
});
