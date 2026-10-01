import { describe, expect, it } from 'vitest';
import type { TransferProgress } from '@/api';
import { pollTransfer } from './transferWatch';

const ev = (status: TransferProgress['status'], error: string | null = null): TransferProgress => ({
  id: 't', bytesTotal: 10, bytesDone: 5, status, error,
});

// Feeds a scripted sequence of answers; Error entries are thrown.
function script(steps: (TransferProgress | Error)[]) {
  let i = 0;
  const calls = { n: 0 };
  const fetchStatus = async () => {
    calls.n++;
    const s = steps[Math.min(i++, steps.length - 1)]!;
    if (s instanceof Error) throw s;
    return s;
  };
  return { fetchStatus, calls };
}
const noSleep = async () => {};
const notFound = () => Object.assign(new Error('unknown transfer'), { status: 404 });

describe('pollTransfer', () => {
  it('resolves once the transfer completes', async () => {
    const s = script([ev('pending'), ev('running'), ev('completed')]);
    await expect(pollTransfer('t', s.fetchStatus, { sleep: noSleep })).resolves.toBeUndefined();
    expect(s.calls.n).toBe(3);
  });

  it('rejects with the transfer error on failed or cancelled', async () => {
    await expect(pollTransfer('t', script([ev('failed', 'disk full')]).fetchStatus, { sleep: noSleep })).rejects.toThrow('disk full');
    await expect(pollTransfer('t', script([ev('cancelled')]).fetchStatus, { sleep: noSleep })).rejects.toThrow('cancelled');
  });

  it('rides out a few failed checks (a network blip is not a failed transfer)', async () => {
    const s = script([ev('running'), new Error('fetch failed'), new Error('fetch failed'), ev('completed')]);
    await expect(pollTransfer('t', s.fetchStatus, { sleep: noSleep, maxErrors: 5 })).resolves.toBeUndefined();
  });

  it('gives up after too many failed checks in a row', async () => {
    const s = script([new Error('fetch failed')]);
    await expect(pollTransfer('t', s.fetchStatus, { sleep: noSleep, maxErrors: 3 })).rejects.toThrow(/lost contact/);
    expect(s.calls.n).toBe(3);
  });

  it('fails at once when gate no longer knows the transfer', async () => {
    const s = script([notFound()]);
    await expect(pollTransfer('t', s.fetchStatus, { sleep: noSleep })).rejects.toThrow(/no longer known/);
    expect(s.calls.n).toBe(1);
  });
});
