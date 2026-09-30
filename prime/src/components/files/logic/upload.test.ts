import { describe, expect, it } from 'vitest';
import { joinRel, planUploadTree } from './upload';

const f = (name: string) => new File(['x'], name);

describe('planUploadTree', () => {
  it('creates every ancestor dir shallow-first and keeps file dirs', () => {
    const plan = planUploadTree([
      { relPath: 'site/css/a.css', file: f('a.css') },
      { relPath: 'site/index.html', file: f('index.html') },
      { relPath: 'loose.txt', file: f('loose.txt') },
    ], ['site/empty']);
    expect(plan.dirs).toEqual(['site', 'site/css', 'site/empty']);
    expect(plan.files.map((x) => [x.relDir, x.file.name])).toEqual([
      ['site/css', 'a.css'],
      ['site', 'index.html'],
      ['', 'loose.txt'],
    ]);
  });
});

describe('joinRel', () => {
  it('joins relative segments onto a host path', () => {
    expect(joinRel('/tmp', '')).toBe('/tmp');
    expect(joinRel('/tmp', 'a/b')).toBe('/tmp/a/b');
    expect(joinRel('/', 'a')).toBe('/a');
  });
});
