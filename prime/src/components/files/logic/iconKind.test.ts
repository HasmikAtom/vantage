import { describe, expect, it } from 'vitest';
import { iconKind } from './iconKind';

describe('iconKind', () => {
  it.each([
    ['anything', 'dir', 'dir'],
    ['link', 'symlink', 'symlink'],
    ['photo.JPG', 'file', 'image'],
    ['logo.svg', 'file', 'image'],
    ['clip.mp4', 'file', 'video'],
    ['movie.MKV', 'file', 'video'],
    ['song.flac', 'file', 'audio'],
    ['manual.pdf', 'file', 'pdf'],
    ['letter.docx', 'file', 'document'],
    ['slides.pptx', 'file', 'document'],
    ['budget.xlsx', 'file', 'spreadsheet'],
    ['export.csv', 'file', 'spreadsheet'],
    ['backup.tar.gz', 'file', 'archive'],
    ['pkg.deb', 'file', 'archive'],
    ['main.go', 'file', 'code'],
    ['app.tsx', 'file', 'code'],
    ['nginx.conf', 'file', 'config'],
    ['docker-compose.yml', 'file', 'config'],
    ['package.json', 'file', 'config'],
    ['.env', 'file', 'config'],
    ['.env.production', 'file', 'config'],
    ['vantage.service', 'file', 'config'],
    ['install.sh', 'file', 'exec'],
    ['server.pem', 'file', 'key'],
    ['id_ed25519', 'file', 'key'],
    ['id_rsa.pub', 'file', 'key'],
    ['authorized_keys', 'file', 'key'],
    ['known_hosts', 'file', 'key'],
    ['app.db', 'file', 'database'],
    ['dump.sql', 'file', 'database'],
    ['ubuntu.iso', 'file', 'disk'],
    ['vm.qcow2', 'file', 'disk'],
    ['Inter.woff2', 'file', 'font'],
    ['syslog.log', 'file', 'log'],
    ['syslog.1', 'file', 'log'],
    ['app.log.2.gz', 'file', 'log'],
    ['notes.txt', 'file', 'text'],
    ['README', 'file', 'text'],
    ['Makefile', 'file', 'text'],
    ['blob.bin', 'file', 'file'],
    ['sock', 'other', 'file'],
  ] as const)('%s (%s) → %s', (name, type, want) => {
    expect(iconKind(name, type)).toBe(want);
  });

  it('treats an extensionless file with the execute bit as an executable', () => {
    expect(iconKind('vantage-outpost', 'file', 0o755)).toBe('exec');
    expect(iconKind('vantage-outpost', 'file', 0o644)).toBe('file');
  });

  it('does not mistake versioned names for rotated logs', () => {
    expect(iconKind('libssl.so.3', 'file')).toBe('file');
    expect(iconKind('python3.12', 'file', 0o755)).toBe('exec');
    expect(iconKind('messages.1', 'file')).toBe('log');
  });

  it('keeps a known type even when the execute bit is set', () => {
    expect(iconKind('photo.jpg', 'file', 0o755)).toBe('image');
  });
});
