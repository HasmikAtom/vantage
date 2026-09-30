import { describe, expect, it } from 'vitest';
import type { FsEntry } from '@/types';
import { DEFAULT_SORT, filterEntries, parseSort, sortEntries, toggleSort } from './sort';
import type { SizeInfo } from './sizes';

const e = (name: string, over: Partial<FsEntry> = {}): FsEntry => ({
  name,
  path: '/x/' + name,
  type: 'file',
  size: 0,
  mode: 0o644,
  modeStr: '-rw-r--r--',
  owner: 'root',
  group: 'root',
  uid: 0,
  gid: 0,
  mtime: 0,
  ...over,
});

const names = (xs: FsEntry[]) => xs.map((x) => x.name);
const none = new Map<string, SizeInfo>();

describe('sortEntries', () => {
  it('keeps folders first and uses natural name order', () => {
    const list = [e('file10'), e('b', { type: 'dir' }), e('file2'), e('A', { type: 'dir' })];
    expect(names(sortEntries(list, DEFAULT_SORT, none))).toEqual(['A', 'b', 'file2', 'file10']);
    expect(names(sortEntries(list, { key: 'name', dir: 'desc' }, none))).toEqual(['b', 'A', 'file10', 'file2']);
  });

  it('sorts by size using folder sizes when known; pending folders go last either way', () => {
    const list = [
      e('big', { type: 'dir' }),
      e('pending', { type: 'dir' }),
      e('small', { type: 'dir' }),
      e('f1', { size: 5 }),
      e('f2', { size: 1 }),
    ];
    const sizes = new Map<string, SizeInfo>([
      ['/x/big', { state: 'done', bytes: 900, partial: false }],
      ['/x/pending', { state: 'pending' }],
      ['/x/small', { state: 'done', bytes: 10, partial: true }],
    ]);
    expect(names(sortEntries(list, { key: 'size', dir: 'asc' }, sizes))).toEqual(['small', 'big', 'pending', 'f2', 'f1']);
    expect(names(sortEntries(list, { key: 'size', dir: 'desc' }, sizes))).toEqual(['big', 'small', 'pending', 'f1', 'f2']);
  });

  it('sorts by mtime, owner, and mode with name as tie-breaker', () => {
    const list = [e('b', { mtime: 2 }), e('a', { mtime: 2 }), e('c', { mtime: 1 })];
    expect(names(sortEntries(list, { key: 'mtime', dir: 'asc' }, none))).toEqual(['c', 'a', 'b']);
    const owners = [e('x', { owner: 'www' }), e('y', { owner: 'root' })];
    expect(names(sortEntries(owners, { key: 'owner', dir: 'asc' }, none))).toEqual(['y', 'x']);
    const modes = [e('x', { mode: 0o755 }), e('y', { mode: 0o600 })];
    expect(names(sortEntries(modes, { key: 'mode', dir: 'asc' }, none))).toEqual(['y', 'x']);
  });

  it('does not mutate the input', () => {
    const list = [e('b'), e('a')];
    sortEntries(list, DEFAULT_SORT, none);
    expect(names(list)).toEqual(['b', 'a']);
  });
});

describe('filterEntries', () => {
  const list = [e('.env'), e('Readme.md'), e('src', { type: 'dir' })];
  it('hides dotfiles unless asked', () => {
    expect(names(filterEntries(list, { showHidden: false, query: '' }))).toEqual(['Readme.md', 'src']);
    expect(names(filterEntries(list, { showHidden: true, query: '' }))).toHaveLength(3);
  });
  it('matches names case-insensitively, trimming the query', () => {
    expect(names(filterEntries(list, { showHidden: true, query: '  README ' }))).toEqual(['Readme.md']);
  });
});

describe('sort spec helpers', () => {
  it('toggles direction on the same key and resets to asc on a new key', () => {
    expect(toggleSort(DEFAULT_SORT, 'name')).toEqual({ key: 'name', dir: 'desc' });
    expect(toggleSort({ key: 'name', dir: 'desc' }, 'size')).toEqual({ key: 'size', dir: 'asc' });
  });
  it('parses stored specs and falls back on junk', () => {
    expect(parseSort('{"key":"mtime","dir":"desc"}')).toEqual({ key: 'mtime', dir: 'desc' });
    expect(parseSort('{"key":"nope","dir":"desc"}')).toEqual(DEFAULT_SORT);
    expect(parseSort('not json')).toEqual(DEFAULT_SORT);
    expect(parseSort(null)).toEqual(DEFAULT_SORT);
  });
});
