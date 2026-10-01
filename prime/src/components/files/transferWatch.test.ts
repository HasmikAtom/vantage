import { describe, expect, it } from 'vitest';
import { awaitTransfer, type EventSourceLike } from './transferWatch';

function fakeSource() {
  const es: EventSourceLike & { closed: boolean; emit(data: unknown): void; fail(): void } = {
    onmessage: null,
    onerror: null,
    closed: false,
    close() { this.closed = true; },
    emit(data) { this.onmessage?.({ data: JSON.stringify(data) }); },
    fail() { this.onerror?.(); },
  };
  return es;
}

const ev = (status: string, error: string | null = null) => ({ id: 't', bytesTotal: 10, bytesDone: 5, status, error });

describe('awaitTransfer', () => {
  it('resolves on completed and closes the stream', async () => {
    const es = fakeSource();
    const p = awaitTransfer('/x', () => es);
    es.emit(ev('running'));
    es.emit(ev('completed'));
    await expect(p).resolves.toBeUndefined();
    expect(es.closed).toBe(true);
  });

  it('rejects with the error on failed or cancelled', async () => {
    const a = fakeSource();
    const pa = awaitTransfer('/x', () => a);
    a.emit(ev('failed', 'disk full'));
    await expect(pa).rejects.toThrow('disk full');
    const b = fakeSource();
    const pb = awaitTransfer('/x', () => b);
    b.emit(ev('cancelled'));
    await expect(pb).rejects.toThrow('cancelled');
  });

  it('ignores the error event that follows a terminal status', async () => {
    const es = fakeSource();
    const p = awaitTransfer('/x', () => es);
    es.emit(ev('completed'));
    es.fail();
    await expect(p).resolves.toBeUndefined();
  });

  it('rejects when the stream drops before a terminal status', async () => {
    const es = fakeSource();
    const p = awaitTransfer('/x', () => es);
    es.fail();
    await expect(p).rejects.toThrow('lost connection');
  });
});
