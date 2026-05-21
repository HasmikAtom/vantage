import * as React from 'react';
import {
  createStack,
  getStack,
  removeStack,
  updateStack,
} from '@/api';
import type { StackSummary } from '@/types';
import { Button, Input } from './ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

// Stack management lives in three dialogs (Create / Edit / Remove). Create
// and Edit share most of the form — name + YAML textarea + apply — but
// Create takes a fresh name and Edit fetches existing content + only
// shows YAML.

const STACK_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

const EXAMPLE_COMPOSE = `services:
  hello:
    image: alpine:latest
    command: ["sh","-c","while true; do date; sleep 5; done"]
    restart: unless-stopped
`;

// ---------------------------------------------------------------------------
// CreateStackDialog
// ---------------------------------------------------------------------------

export interface CreateStackDialogProps {
  serverId: string;
  open: boolean;
  onClose: () => void;
  onCreated?: (name: string) => void;
  // Optional prefilled values, used by the "Recreate from discovered"
  // flow. When set, they override the example YAML / empty name on
  // every open. Caller is responsible for clearing them when the
  // dialog closes if it wants a different prefill next time.
  initialName?: string;
  initialYaml?: string;
  // Optional explanatory notice rendered above the form fields — e.g.
  // "This was reverse-engineered from <name>'s existing containers."
  notice?: React.ReactNode;
}

export const CreateStackDialog = ({
  serverId,
  open,
  onClose,
  onCreated,
  initialName,
  initialYaml,
  notice,
}: CreateStackDialogProps) => {
  const [name, setName] = React.useState('');
  const [yaml, setYaml] = React.useState(EXAMPLE_COMPOSE);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(initialName ?? '');
      setYaml(initialYaml ?? EXAMPLE_COMPOSE);
      setError(null);
      setPending(false);
    }
  }, [open, initialName, initialYaml]);

  const handleSubmit = async () => {
    setError(null);
    const trimmedName = name.trim();
    if (!STACK_NAME_RE.test(trimmedName)) {
      setError('Name must match [a-z0-9_-], start with a letter or digit, max 64 chars');
      return;
    }
    if (!yaml.trim()) {
      setError('YAML is required');
      return;
    }
    setPending(true);
    try {
      await createStack(serverId, { name: trimmedName, yaml });
      onCreated?.(trimmedName);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogDescription>New stack</DialogDescription>
          <DialogTitle>Deploy a compose stack</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4 space-y-3">
          {notice && (
            <div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
              {notice}
            </div>
          )}
          <FieldLabel label="Name" required>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="my-stack"
              disabled={pending}
              className="font-mono"
            />
            <Hint>lowercase, [a-z0-9_-], starts with a letter or digit</Hint>
          </FieldLabel>
          <FieldLabel label="docker-compose.yml" required>
            <YamlTextarea value={yaml} onChange={setYaml} disabled={pending} />
          </FieldLabel>
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>
        <Footer
          onCancel={onClose}
          onConfirm={() => void handleSubmit()}
          confirmLabel={pending ? 'Pulling & deploying…' : 'Create & deploy'}
          pending={pending}
        />
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// EditStackDialog
// ---------------------------------------------------------------------------

export interface EditStackDialogProps {
  serverId: string;
  stackName: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

export const EditStackDialog = ({
  serverId,
  stackName,
  onClose,
  onSaved,
}: EditStackDialogProps) => {
  const [yaml, setYaml] = React.useState('');
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (!stackName) return;
    setLoaded(false);
    setError(null);
    setPending(false);
    const ctrl = new AbortController();
    getStack(serverId, stackName, ctrl.signal)
      .then((s) => {
        if (!ctrl.signal.aborted) {
          setYaml(s.yaml);
          setLoaded(true);
        }
      })
      .catch((e: unknown) => {
        // The fetch was aborted on unmount/dep-change — drop the result
        // silently. Real errors still land in the state below.
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, [serverId, stackName]);

  if (!stackName) return null;

  const handleSave = async () => {
    setError(null);
    if (!yaml.trim()) {
      setError('YAML is required');
      return;
    }
    setPending(true);
    try {
      await updateStack(serverId, stackName, { yaml });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogDescription>Edit stack</DialogDescription>
          <DialogTitle>{stackName}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4 space-y-3">
          {!loaded && !error && (
            <div className="font-mono text-xs text-muted-foreground py-4">Loading…</div>
          )}
          {loaded && (
            <FieldLabel label="docker-compose.yml">
              <YamlTextarea value={yaml} onChange={setYaml} disabled={pending} />
              <Hint>
                Re-applies with <span className="font-mono">compose up -d</span> —
                only services with changed config are recreated.
              </Hint>
            </FieldLabel>
          )}
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>
        <Footer
          onCancel={onClose}
          onConfirm={() => void handleSave()}
          confirmLabel={pending ? 'Applying…' : 'Save & re-apply'}
          pending={pending || !loaded}
        />
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// RemoveStackDialog
// ---------------------------------------------------------------------------

export interface RemoveStackDialogProps {
  serverId: string;
  stack: StackSummary | null;
  onClose: () => void;
  onRemoved?: () => void;
}

export const RemoveStackDialog = ({
  serverId,
  stack,
  onClose,
  onRemoved,
}: RemoveStackDialogProps) => {
  const [removeVolumes, setRemoveVolumes] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (stack) {
      setRemoveVolumes(false);
      setError(null);
      setPending(false);
      requestAnimationFrame(() => cancelRef.current?.focus());
    }
  }, [stack]);

  if (!stack) return null;

  const handleRemove = async () => {
    setError(null);
    setPending(true);
    try {
      await removeStack(serverId, stack.name, { volumes: removeVolumes });
      onRemoved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogDescription>Destructive action</DialogDescription>
          <DialogTitle>Remove stack?</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4 space-y-3">
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono">
            <div className="font-semibold">{stack.name}</div>
            <div className="text-muted-foreground mt-0.5">
              {stack.containerCount} container{stack.containerCount === 1 ? '' : 's'}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Runs <span className="font-mono">compose down</span>, then deletes the
            compose file. Named volumes are left alone regardless of the
            checkbox below — those are independent objects.
          </p>
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
                Passes <span className="font-mono">--volumes</span> to compose
                down. Only volumes declared inline in this stack are removed.
              </span>
            </span>
          </label>
          {error && <ErrorBox>{error}</ErrorBox>}
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

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function FieldLabel({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground block mb-1">
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </label>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] text-muted-foreground/70 mt-1">{children}</div>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive whitespace-pre-wrap">
      {children}
    </div>
  );
}

function YamlTextarea({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  // Plain textarea for v1 — syntax-highlighted editor (Monaco / CodeMirror)
  // is a future enhancement. Disable spell-check / autocomplete since this
  // is structured config, not prose.
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      className="w-full font-mono text-[11px] leading-relaxed rounded-md border bg-background p-3 min-h-[280px] max-h-[60vh]"
    />
  );
}

function Footer({
  onCancel,
  onConfirm,
  confirmLabel,
  pending,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  pending: boolean;
}) {
  return (
    <div className="flex justify-end gap-2 border-t px-6 py-3">
      <Button variant="ghost" disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
      <Button disabled={pending} onClick={onConfirm}>
        {confirmLabel}
      </Button>
    </div>
  );
}
