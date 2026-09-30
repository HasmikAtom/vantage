import { describe, expect, it } from 'vitest';
import type { FsListResponse } from '@/types';
import { seedListing } from './listing';

const L = (path: string): FsListResponse => ({ path, parent: '/', entries: [] });

describe('seedListing', () => {
  it('keeps the current listing while the same folder reloads, even with the cache cleared', () => {
    const shown = L('/a');
    expect(seedListing({ key: 's|/a', data: shown }, 's|/a', undefined)).toBe(shown);
  });

  it('prefers a cached listing when navigating to another folder', () => {
    const cached = L('/b');
    expect(seedListing({ key: 's|/a', data: L('/a') }, 's|/b', cached)).toBe(cached);
  });

  it('shows nothing for an uncached folder instead of the previous folder', () => {
    expect(seedListing({ key: 's|/a', data: L('/a') }, 's|/b', undefined)).toBe(null);
  });
});
