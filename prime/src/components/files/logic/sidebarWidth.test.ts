import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSidebarWidth,
  parseSidebarWidth,
} from './sidebarWidth';

describe('clampSidebarWidth', () => {
  it('keeps a width inside 160–480 px', () => {
    expect(clampSidebarWidth(300, 1600, false)).toBe(300);
    expect(clampSidebarWidth(40, 1600, false)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(900, 1600, false)).toBe(SIDEBAR_MAX);
  });
  it('leaves the file list at least 360 px in single view', () => {
    expect(clampSidebarWidth(480, 800, false)).toBe(440);
  });
  it('leaves both panes room in split view', () => {
    expect(clampSidebarWidth(480, 1000, true)).toBe(360);
  });
  it('never goes below the minimum, even in a narrow card', () => {
    expect(clampSidebarWidth(300, 500, true)).toBe(SIDEBAR_MIN);
  });
  it('rounds to whole pixels', () => {
    expect(clampSidebarWidth(250.6, 1600, false)).toBe(251);
  });
});

describe('parseSidebarWidth', () => {
  it('reads a saved width', () => {
    expect(parseSidebarWidth('312')).toBe(312);
  });
  it('falls back to the default for missing or invalid values', () => {
    for (const raw of [null, '', 'abc', 'NaN', '-5', '9999', '12.5px']) {
      expect(parseSidebarWidth(raw)).toBe(SIDEBAR_DEFAULT);
    }
  });
});
