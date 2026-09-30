// installFileDropGuard stops the browser from opening an OS file that was
// dropped somewhere no drop target accepted it (a viewer's drop, the
// toolbar, a heading). Accepted drops already called preventDefault and
// stopPropagation in useDnd, so this only sees the leftovers.
export function installFileDropGuard(target: EventTarget): () => void {
  const guard = (e: Event) => {
    const dt = (e as DragEvent).dataTransfer;
    if (!dt || !Array.from(dt.types).includes('Files')) return;
    e.preventDefault();
    if (e.type === 'dragover') dt.dropEffect = 'none';
  };
  target.addEventListener('dragover', guard);
  target.addEventListener('drop', guard);
  return () => {
    target.removeEventListener('dragover', guard);
    target.removeEventListener('drop', guard);
  };
}
