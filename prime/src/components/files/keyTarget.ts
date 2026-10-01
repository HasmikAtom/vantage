// Keys pressed while focus is on a control (button, link, field) or inside
// a dialog/menu belong to that control; the explorer's shortcuts must not
// hijack them (e.g. Enter on a toolbar button must press the button).
export function ignoresExplorerKeys(target: HTMLElement): boolean {
  return !!target.closest(
    'input, textarea, select, button, a[href], [contenteditable="true"], [role="dialog"], [role="menu"]',
  );
}
