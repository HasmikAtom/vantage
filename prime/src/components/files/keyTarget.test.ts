// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ignoresExplorerKeys } from './keyTarget';

describe('ignoresExplorerKeys', () => {
  it('lets buttons, links, fields, dialogs and menus handle their own keys', () => {
    for (const html of ['<button>x</button>', '<a href="#">x</a>', '<input>', '<textarea></textarea>', '<select></select>', '<div role="dialog"><span>x</span></div>', '<div role="menu"><span>x</span></div>']) {
      const host = document.createElement('div');
      host.innerHTML = html;
      const el = (host.querySelector('span') ?? host.firstElementChild) as HTMLElement;
      expect(ignoresExplorerKeys(el), html).toBe(true);
    }
  });
  it('handles keys on the pane itself and on list rows', () => {
    const pane = document.createElement('div');
    pane.tabIndex = 0;
    pane.innerHTML = '<table><tr data-path="/x"><td>x</td></tr></table>';
    expect(ignoresExplorerKeys(pane)).toBe(false);
    expect(ignoresExplorerKeys(pane.querySelector('td') as HTMLElement)).toBe(false);
  });
});
