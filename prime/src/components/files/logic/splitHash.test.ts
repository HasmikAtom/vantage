import { describe, expect, it } from 'vitest';
import { parseFilesHash, splitHashFor } from './splitHash';

describe('split hash', () => {
  it('parses the single-pane form unchanged', () => {
    expect(parseFilesHash('#files:/var/log')).toEqual({ mode: 'single', path: '/var/log' });
  });

  it.each([
    ['/var/log', 'srv-abc', '/backup'],
    ['/tmp/a #1/50%', 'srv-2', '/x|y/a:b'],
    ['/', 'srv_1', '/home/My Documents/日本'],
  ])('round-trips %s | %s : %s', (left, server, right) => {
    expect(parseFilesHash(splitHashFor(left, server, right))).toEqual({
      mode: 'split',
      left,
      rightServer: server,
      right,
    });
  });

  it('keeps the separators unambiguous by encoding them inside paths', () => {
    expect(splitHashFor('/a|b', 's', '/c:d')).toBe('#files:/a%7Cb|s:/c%3Ad');
  });

  it('rejects malformed hashes', () => {
    for (const h of ['#overview', '#files', '#files:/a|', '#files:/a|srv', '#files:/a|:/b', '#files:/a|s r v:/b', '#files:/a|srv:relative']) {
      expect(parseFilesHash(h)).toBe(null);
    }
  });
});
