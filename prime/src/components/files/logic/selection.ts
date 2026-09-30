// Explorer selection model: a set of selected paths plus an anchor (where
// Shift ranges start) and a keyboard focus row, which is tracked separately
// from the selection the way desktop file managers do.

export interface SelectionState {
  selected: ReadonlySet<string>;
  anchor: string | null;
  focus: string | null;
}

export const emptySelection: SelectionState = { selected: new Set(), anchor: null, focus: null };

export type SelectionAction =
  | { type: 'click'; path: string; ctrl: boolean; shift: boolean; order: readonly string[] }
  | { type: 'toggle'; path: string }
  | { type: 'selectAll'; order: readonly string[] }
  | { type: 'clear' }
  | { type: 'move'; to: 'prev' | 'next' | 'first' | 'last'; extend: boolean; order: readonly string[] }
  | { type: 'focus'; path: string }
  | { type: 'retain'; existing: ReadonlySet<string> };

function range(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

function toggled(set: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(set);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

export function selectionReducer(s: SelectionState, a: SelectionAction): SelectionState {
  switch (a.type) {
    case 'click': {
      if (a.shift) {
        const from = s.anchor ?? a.path;
        const span = range(a.order, from, a.path);
        const base = a.ctrl ? new Set(s.selected) : new Set<string>();
        for (const p of span) base.add(p);
        return { selected: base, anchor: from, focus: a.path };
      }
      if (a.ctrl) return { selected: toggled(s.selected, a.path), anchor: a.path, focus: a.path };
      return { selected: new Set([a.path]), anchor: a.path, focus: a.path };
    }
    case 'toggle':
      return { selected: toggled(s.selected, a.path), anchor: a.path, focus: a.path };
    case 'selectAll':
      return { ...s, selected: new Set(a.order) };
    case 'clear':
      return emptySelection;
    case 'focus':
      return { ...s, focus: a.path };
    case 'move': {
      if (a.order.length === 0) return s;
      const cur = s.focus ? a.order.indexOf(s.focus) : -1;
      const last = a.order.length - 1;
      const idx =
        a.to === 'first' ? 0
        : a.to === 'last' ? last
        : a.to === 'next' ? Math.min(cur + 1, last)
        : Math.max(cur - 1, 0);
      const target = a.order[idx]!;
      if (a.extend) {
        const from = s.anchor ?? s.focus ?? target;
        return { selected: new Set(range(a.order, from, target)), anchor: from, focus: target };
      }
      return { selected: new Set([target]), anchor: target, focus: target };
    }
    case 'retain': {
      const selected = new Set([...s.selected].filter((p) => a.existing.has(p)));
      const anchor = s.anchor && selected.has(s.anchor) ? s.anchor : null;
      const focus = s.focus && selected.has(s.focus) ? s.focus : null;
      // Same state back when nothing vanished, so re-sorts and size
      // updates don't re-render the list for nothing.
      if (selected.size === s.selected.size && anchor === s.anchor && focus === s.focus) return s;
      return { selected, anchor, focus };
    }
  }
}

// findTypeAhead returns the first row after `from` (wrapping) whose name
// starts with `prefix`, case-insensitively.
export function findTypeAhead(
  rows: readonly { path: string; name: string }[],
  prefix: string,
  from: string | null,
): string | null {
  if (rows.length === 0 || prefix === '') return null;
  const p = prefix.toLowerCase();
  const start = from ? rows.findIndex((r) => r.path === from) : -1;
  // A multi-character prefix may still match the current row.
  const offset = p.length > 1 ? 0 : 1;
  for (let k = 0; k < rows.length; k++) {
    const row = rows[(start + offset + k + rows.length) % rows.length]!;
    if (row.name.toLowerCase().startsWith(p)) return row.path;
  }
  return null;
}
