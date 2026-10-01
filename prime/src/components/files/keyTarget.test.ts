// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ignoresExplorerKeys } from './keyTarget';

const el = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return (host.querySelector('span') ?? host.firstElementChild) as HTMLElement;
};

describe('ignoresExplorerKeys', () => {
  it('fields, dialogs and menus keep every key', () => {
    for (const html of ['<input>', '<textarea></textarea>', '<select></select>', '<div role="dialog"><span>x</span></div>', '<div role="menu"><span>x</span></div>']) {
      for (const key of ['Enter', 'ArrowDown', 'Delete', 'c']) {
        expect(ignoresExplorerKeys(el(html), key), `${html} ${key}`).toBe(true);
      }
    }
  });

  it('buttons and links keep only Enter and Space', () => {
    for (const html of ['<button>x</button>', '<a href="#">x</a>']) {
      expect(ignoresExplorerKeys(el(html), 'Enter')).toBe(true);
      expect(ignoresExplorerKeys(el(html), ' ')).toBe(true);
      expect(ignoresExplorerKeys(el(html), 'ArrowDown')).toBe(false);
      expect(ignoresExplorerKeys(el(html), 'Delete')).toBe(false);
    }
  });

  it('handles keys on the pane itself and on list rows', () => {
    const pane = document.createElement('div');
    pane.tabIndex = 0;
    pane.innerHTML = '<table><tr data-path="/x"><td>x</td></tr></table>';
    expect(ignoresExplorerKeys(pane, 'Enter')).toBe(false);
    expect(ignoresExplorerKeys(pane.querySelector('td') as HTMLElement, 'Delete')).toBe(false);
  });
});
