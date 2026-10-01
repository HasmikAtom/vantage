// What F5 (copy) / F6 (move) "to the other pane" does, given where the
// selection lives and where the other pane points.
export type ToOtherPlan = 'copy-in-place' | 'refuse-same-folder' | 'same-server' | 'cross-server';

export function planToOther(
  src: { serverId: string; dir: string },
  dst: { serverId: string; dir: string },
  mode: 'copy' | 'move',
): ToOtherPlan {
  if (src.serverId !== dst.serverId) return 'cross-server';
  if (src.dir === dst.dir) return mode === 'copy' ? 'copy-in-place' : 'refuse-same-folder';
  return 'same-server';
}
