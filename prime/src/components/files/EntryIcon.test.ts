import { describe, expect, it } from 'vitest';
import { iconClassFor } from './EntryIcon';

describe('iconClassFor', () => {
  it('uses only the destructive colour for a broken symlink', () => {
    const c = iconClassFor('symlink', true);
    expect(c).toContain('text-destructive');
    expect(c).not.toContain('text-muted-foreground');
  });

  it('keeps the kind colour otherwise', () => {
    expect(iconClassFor('symlink', false)).toBe('text-muted-foreground');
    expect(iconClassFor('pdf', false)).toContain('text-red-500');
  });
});
