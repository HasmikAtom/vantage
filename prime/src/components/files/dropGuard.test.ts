import { describe, expect, it } from 'vitest';
import { installFileDropGuard } from './dropGuard';

function fire(target: EventTarget, type: string, types: string[]): boolean {
  const ev = new Event(type, { cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { types, dropEffect: 'copy' } });
  target.dispatchEvent(ev);
  return ev.defaultPrevented;
}

describe('installFileDropGuard', () => {
  it('cancels OS file dragover/drop that no target accepted, so the browser does not open the file', () => {
    const t = new EventTarget();
    const off = installFileDropGuard(t);
    expect(fire(t, 'dragover', ['Files'])).toBe(true);
    expect(fire(t, 'drop', ['Files'])).toBe(true);
    off();
    expect(fire(t, 'drop', ['Files'])).toBe(false);
  });

  it('leaves non-file drags alone', () => {
    const t = new EventTarget();
    installFileDropGuard(t);
    expect(fire(t, 'drop', ['text/plain'])).toBe(false);
  });
});
