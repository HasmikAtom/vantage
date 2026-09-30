import { describe, expect, it } from 'vitest';
import { iconKind } from './iconKind';

describe('iconKind', () => {
  it.each([
    ['anything', 'dir', 'dir'],
    ['link', 'symlink', 'symlink'],
    ['photo.JPG', 'file', 'image'],
    ['backup.tar.gz', 'file', 'archive'],
    ['main.go', 'file', 'code'],
    ['docker-compose.yml', 'file', 'code'],
    ['.env', 'file', 'code'],
    ['syslog.log', 'file', 'text'],
    ['README', 'file', 'text'],
    ['Makefile', 'file', 'text'],
    ['blob.bin', 'file', 'file'],
    ['sock', 'other', 'file'],
  ] as const)('%s (%s) → %s', (name, type, want) => {
    expect(iconKind(name, type)).toBe(want);
  });
});
