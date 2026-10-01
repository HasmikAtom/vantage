// Keys pressed while focus is on a field or inside a dialog/menu belong to
// that control. On a focused button or link only Enter and Space do (they
// press it); arrows, Delete, Ctrl+C… still drive the explorer, so clicking
// a toolbar button doesn't leave the keyboard dead.
export function ignoresExplorerKeys(target: HTMLElement, key: string): boolean {
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return true;
  if (target.closest('button, a[href]')) return key === 'Enter' || key === ' ';
  return false;
}
