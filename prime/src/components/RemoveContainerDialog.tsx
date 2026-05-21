import * as React from 'react';
import type { Container } from '@/types';
import { ContainerRunningError, removeContainer } from '@/api';
import { Button } from './ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

export interface RemoveContainerDialogProps {
  serverId: string;
  // The container to remove, or null to keep the dialog closed.
  container: Container | null;
  onClose: () => void;
  onRemoved?: () => void;
}

/**
 * Destructive confirmation for removing a container.
 *
 * Single dialog with two opt-in checkboxes (force, remove anonymous
 * volumes) rather than a multi-step wizard. Backend returns 409 when the
 * container is running and force is off — we catch that and surface an
 * inline error suggesting the user enable force, instead of closing the
 * dialog and forcing them to start over.
 *
 * Cancel auto-focused (anti-muscle-memory Enter); the destructive button
 * stays disabled while a request is in flight.
 */
export const RemoveContainerDialog = ({
  serverId,
  container,
  onClose,
  onRemoved,
}: RemoveContainerDialogProps) => {
  const [force, setForce] = React.useState(false);
  const [removeVolumes, setRemoveVolumes] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  // Reset state whenever the dialog re-opens for a new container, so old
  // checkbox + error state doesn't leak across opens.
  React.useEffect(() => {
    if (container) {
      setForce(false);
      setRemoveVolumes(false);
      setError(null);
      setPending(false);
      // Focus Cancel on open — destructive default per ConfirmDialog convention.
      requestAnimationFrame(() => cancelRef.current?.focus());
    }
  }, [container]);

  if (!container) return null;

  const handleRemove = async () => {
    setPending(true);
    setError(null);
    try {
      await removeContainer(serverId, container.id, { force, volumes: removeVolumes });
      onRemoved?.();
      onClose();
    } catch (err) {
      if (err instanceof ContainerRunningError) {
        // Don't close — let the user tick "force" and retry without
        // having to re-open the dialog and re-orient.
        setError('Container is running. Enable “Force kill” to remove it anyway.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogDescription>Destructive action</DialogDescription>
          <DialogTitle>Remove container?</DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-4 space-y-3">
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono">
            <div className="font-semibold">{container.name}</div>
            <div className="text-muted-foreground mt-0.5 truncate">{container.image}</div>
            <div className="text-muted-foreground mt-0.5">
              {container.id.slice(0, 12)} · {container.status}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            The container will be permanently removed. This cannot be undone.
          </p>

          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              disabled={pending}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Force kill if running</span>
              <span className="block text-muted-foreground">
                SIGKILL the process before removal. Without this, removing a
                running container will fail.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={removeVolumes}
              onChange={(e) => setRemoveVolumes(e.target.checked)}
              disabled={pending}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Also remove anonymous volumes</span>
              <span className="block text-muted-foreground">
                Named volumes are left alone — only volumes the container
                created itself get deleted.
              </span>
            </span>
          </label>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-6 py-3">
          <Button ref={cancelRef} variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => void handleRemove()}
          >
            {pending ? 'Removing…' : 'Remove'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
