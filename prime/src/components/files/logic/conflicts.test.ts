import { describe, expect, it } from 'vitest';
import { preflightConflict } from './conflicts';

const first = { overwrite: false, keepBoth: false };
const replace = { overwrite: true, keepBoth: false };
const keepBoth = { overwrite: false, keepBoth: true };

describe('preflightConflict', () => {
  it('asks when a folder lands on an existing name', () => {
    expect(preflightConflict(true, 'dir', first)).toBe('conflict');
    expect(preflightConflict(true, 'file', first)).toBe('conflict');
    expect(preflightConflict(false, 'dir', first)).toBe('conflict');
  });

  it('leaves file-over-file to the outpost (it answers 409 and honours overwrite)', () => {
    expect(preflightConflict(false, 'file', first)).toBe(null);
    expect(preflightConflict(false, 'file', replace)).toBe(null);
  });

  it('refuses Replace when a folder is involved and allows Keep both', () => {
    expect(preflightConflict(true, 'dir', replace)).toBe('cannot-replace-folder');
    expect(preflightConflict(false, 'dir', replace)).toBe('cannot-replace-folder');
    expect(preflightConflict(true, 'dir', keepBoth)).toBe(null);
  });

  it('does nothing when the name is free', () => {
    expect(preflightConflict(true, undefined, first)).toBe(null);
  });
});
