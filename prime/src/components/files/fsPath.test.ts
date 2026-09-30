import { describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  baseName,
  copyName,
  formatBytes,
  formatSize,
  isSameOrDescendant,
  joinPath,
  parentOf,
} from './fsPath';

describe('path helpers', () => {
  it('joins and splits paths', () => {
    expect(joinPath('/', 'etc')).toBe('/etc');
    expect(joinPath('/etc', 'hosts')).toBe('/etc/hosts');
    expect(parentOf('/etc/hosts')).toBe('/etc');
    expect(parentOf('/etc')).toBe('/');
    expect(parentOf('/')).toBe('/');
    expect(baseName('/etc/hosts')).toBe('hosts');
    expect(baseName('/')).toBe('/');
  });

  it('detects same-or-descendant without prefix false positives', () => {
    expect(isSameOrDescendant('/a', '/a')).toBe(true);
    expect(isSameOrDescendant('/a', '/a/b/c')).toBe(true);
    expect(isSameOrDescendant('/a', '/ab')).toBe(false);
    expect(isSameOrDescendant('/', '/anything')).toBe(true);
  });

  it('lists ancestors from root down', () => {
    expect(ancestorsOf('/')).toEqual(['/']);
    expect(ancestorsOf('/var/log/nginx')).toEqual(['/', '/var', '/var/log', '/var/log/nginx']);
  });
});

describe('formatting', () => {
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.00 TB');
  });

  it('shows a dash for directory sizes in the plain formatter', () => {
    expect(formatSize(4096, 'dir')).toBe('—');
    expect(formatSize(10, 'file')).toBe('10 B');
  });
});

describe('copyName', () => {
  it('suffixes before the extension for files', () => {
    expect(copyName('a.txt', false, new Set())).toBe('a (copy).txt');
    expect(copyName('a.txt', false, new Set(['a (copy).txt']))).toBe('a (copy 2).txt');
    expect(copyName('a.txt', false, new Set(['a (copy).txt', 'a (copy 2).txt']))).toBe('a (copy 3).txt');
  });

  it('uses the last dot only', () => {
    expect(copyName('archive.tar.gz', false, new Set())).toBe('archive.tar (copy).gz');
  });

  it('appends for dirs, dotfiles, and extensionless names', () => {
    expect(copyName('photos.2024', true, new Set())).toBe('photos.2024 (copy)');
    expect(copyName('.bashrc', false, new Set())).toBe('.bashrc (copy)');
    expect(copyName('Makefile', false, new Set())).toBe('Makefile (copy)');
  });
});
