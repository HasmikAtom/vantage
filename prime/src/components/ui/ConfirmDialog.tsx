import * as React from 'react';
import { Button } from './primitives';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './dialog';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  // Body content. Strings render as a single paragraph; passing a node lets
  // callers compose richer messages (lists, code blocks for the target name,
  // a "this is irreversible" emphasis line, etc.).
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // `destructive` paints the confirm button red and auto-focuses Cancel so
  // an unintentional Enter on the keyboard cancels rather than confirms.
  destructive?: boolean;
  // While onConfirm is pending we disable both buttons and show the
  // confirmLabel as "…" suffixed. Callers pass async handlers freely.
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Shared confirmation modal for destructive / state-changing actions.
 * Used wherever a click can't be undone with a second click (remove
 * container, kill container, prune volumes, demote admin, etc.).
 *
 * For non-destructive confirmations (e.g. "save changes?") prefer inline
 * UI — modals interrupt flow and should be reserved for things the user
 * shouldn't undo by reflex.
 */
export const ConfirmDialog = ({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) => {
  const [pending, setPending] = React.useState(false);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const confirmRef = React.useRef<HTMLButtonElement>(null);

  // Focus management: destructive dialogs focus Cancel (safer default on
  // muscle-memory Enter), non-destructive focus Confirm (faster happy path).
  React.useEffect(() => {
    if (!open) return;
    const target = destructive ? cancelRef.current : confirmRef.current;
    target?.focus();
  }, [open, destructive]);

  // Reset the pending flag when the dialog closes so a re-opened dialog
  // doesn't show stale "in-flight" state.
  React.useEffect(() => {
    if (!open) setPending(false);
  }, [open]);

  const handleConfirm = async () => {
    setPending(true);
    try {
      await onConfirm();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-6 text-sm text-muted-foreground">
          {typeof description === 'string' ? <p>{description}</p> : description}
        </div>
        <div className="flex justify-end gap-2 border-t px-6 py-3">
          <Button
            ref={cancelRef}
            variant="ghost"
            disabled={pending}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={() => void handleConfirm()}
          >
            {pending ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
