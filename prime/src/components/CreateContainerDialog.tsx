import * as React from 'react';
import { createContainer } from '@/api';
import type { CreateContainerRequest, PortMapping, VolumeMount } from '@/types';
import { Button, Input } from './ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

export interface CreateContainerDialogProps {
  serverId: string;
  open: boolean;
  onClose: () => void;
  onCreated?: (id: string, name: string) => void;
}

type RestartPolicy = NonNullable<CreateContainerRequest['restartPolicy']>;

const RESTART_POLICIES: ReadonlyArray<{ value: RestartPolicy; label: string }> = [
  { value: '', label: 'no (default)' },
  { value: 'on-failure', label: 'on-failure' },
  { value: 'always', label: 'always' },
  { value: 'unless-stopped', label: 'unless-stopped' },
];

interface EnvRow {
  key: string;
  value: string;
}

/**
 * Form-driven create flow for a single container. Mirrors Portainer's
 * "+ Create container" basics: image, name, ports, env vars, mounts,
 * restart policy. Network / labels / command override are deferred to a
 * later sub-phase per the roadmap.
 *
 * Image pull happens synchronously inside the create call — UI shows a
 * "Pulling… (this can take a minute)" pending state. The auth proxy gives
 * this endpoint a 6-minute upstream timeout to cover cold pulls.
 *
 * On success the dialog closes; the new container shows up in the table
 * via the SSE stream within ~1s of the backend's fast-poke.
 */
export const CreateContainerDialog = ({
  serverId,
  open,
  onClose,
  onCreated,
}: CreateContainerDialogProps) => {
  const [image, setImage] = React.useState('');
  const [name, setName] = React.useState('');
  const [restartPolicy, setRestartPolicy] = React.useState<RestartPolicy>('');
  const [ports, setPorts] = React.useState<PortMapping[]>([]);
  const [envRows, setEnvRows] = React.useState<EnvRow[]>([]);
  const [mounts, setMounts] = React.useState<VolumeMount[]>([]);

  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset whenever the dialog re-opens — old state from a previous create
  // shouldn't leak into the next one.
  React.useEffect(() => {
    if (open) {
      setImage('');
      setName('');
      setRestartPolicy('');
      setPorts([]);
      setEnvRows([]);
      setMounts([]);
      setError(null);
      setPending(false);
    }
  }, [open]);

  const handleSubmit = async () => {
    setError(null);
    const trimmedImage = image.trim();
    if (!trimmedImage) {
      setError('Image is required');
      return;
    }

    // Build the request, dropping rows the user added but left empty.
    const cleanEnv = envRows
      .filter((r) => r.key.trim() !== '')
      .map((r) => `${r.key.trim()}=${r.value}`);
    const cleanPorts = ports.filter(
      (p) => p.containerPort > 0,
    );
    const cleanMounts = mounts.filter(
      (m) => m.hostPath.trim() !== '' && m.containerPath.trim() !== '',
    );

    const req: CreateContainerRequest = {
      image: trimmedImage,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(cleanEnv.length ? { env: cleanEnv } : {}),
      ...(cleanPorts.length ? { ports: cleanPorts } : {}),
      ...(cleanMounts.length ? { mounts: cleanMounts } : {}),
      ...(restartPolicy ? { restartPolicy } : {}),
    };

    setPending(true);
    try {
      const res = await createContainer(serverId, req);
      onCreated?.(res.id, res.name || trimmedImage);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogDescription>New container</DialogDescription>
          <DialogTitle>Run an image</DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-4 space-y-4">
          <Field label="Image" required hint='Tag-form, e.g. "nginx:latest" or "ghcr.io/org/app:dev"'>
            <Input
              autoFocus
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="nginx:latest"
              disabled={pending}
            />
          </Field>

          <Field label="Name" hint="Optional — Docker generates one if left blank">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auto"
              disabled={pending}
            />
          </Field>

          <Field label="Restart policy">
            <select
              value={restartPolicy}
              onChange={(e) => setRestartPolicy(e.target.value as RestartPolicy)}
              disabled={pending}
              className="h-9 px-3 text-sm rounded-md border bg-background w-full"
            >
              {RESTART_POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>

          <PortsField rows={ports} setRows={setPorts} disabled={pending} />
          <EnvField rows={envRows} setRows={setEnvRows} disabled={pending} />
          <MountsField rows={mounts} setRows={setMounts} disabled={pending} />

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-6 py-3">
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={pending}>
            {pending ? 'Pulling & creating…' : 'Create & start'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
          {label}
          {required && <span className="text-destructive ml-1">*</span>}
        </label>
        {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function PortsField({
  rows,
  setRows,
  disabled,
}: {
  rows: PortMapping[];
  setRows: React.Dispatch<React.SetStateAction<PortMapping[]>>;
  disabled: boolean;
}) {
  const add = () =>
    setRows((r) => [...r, { hostPort: 0, containerPort: 80, protocol: 'tcp' }]);
  const update = (i: number, patch: Partial<PortMapping>) =>
    setRows((r) => r.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const remove = (i: number) =>
    setRows((r) => r.filter((_, idx) => idx !== i));

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
          Port mappings
        </label>
        <Button type="button" variant="ghost" size="xs" onClick={add} disabled={disabled}>
          + add
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="text-[10px] text-muted-foreground/70 italic">no published ports</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((p, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                type="number"
                min={0}
                max={65535}
                value={p.hostPort || ''}
                onChange={(e) => update(i, { hostPort: Number(e.target.value) || 0 })}
                placeholder="host"
                disabled={disabled}
                className="font-mono"
              />
              <span className="text-muted-foreground text-xs">:</span>
              <Input
                type="number"
                min={1}
                max={65535}
                value={p.containerPort || ''}
                onChange={(e) => update(i, { containerPort: Number(e.target.value) || 0 })}
                placeholder="container"
                disabled={disabled}
                className="font-mono"
              />
              <select
                value={p.protocol}
                onChange={(e) => update(i, { protocol: e.target.value as 'tcp' | 'udp' })}
                disabled={disabled}
                className="h-9 px-2 text-xs rounded-md border bg-background"
              >
                <option value="tcp">tcp</option>
                <option value="udp">udp</option>
              </select>
              <Button
                type="button"
                variant="ghost"
                size="iconSm"
                onClick={() => remove(i)}
                disabled={disabled}
                title="Remove"
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EnvField({
  rows,
  setRows,
  disabled,
}: {
  rows: EnvRow[];
  setRows: React.Dispatch<React.SetStateAction<EnvRow[]>>;
  disabled: boolean;
}) {
  const add = () => setRows((r) => [...r, { key: '', value: '' }]);
  const update = (i: number, patch: Partial<EnvRow>) =>
    setRows((r) => r.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const remove = (i: number) => setRows((r) => r.filter((_, idx) => idx !== i));

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
          Environment variables
        </label>
        <Button type="button" variant="ghost" size="xs" onClick={add} disabled={disabled}>
          + add
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="text-[10px] text-muted-foreground/70 italic">none</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={row.key}
                onChange={(e) => update(i, { key: e.target.value })}
                placeholder="KEY"
                disabled={disabled}
                className="font-mono uppercase"
              />
              <span className="text-muted-foreground text-xs">=</span>
              <Input
                value={row.value}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder="value"
                disabled={disabled}
                className="font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="iconSm"
                onClick={() => remove(i)}
                disabled={disabled}
                title="Remove"
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MountsField({
  rows,
  setRows,
  disabled,
}: {
  rows: VolumeMount[];
  setRows: React.Dispatch<React.SetStateAction<VolumeMount[]>>;
  disabled: boolean;
}) {
  const add = () =>
    setRows((r) => [...r, { hostPath: '', containerPath: '', readOnly: false }]);
  const update = (i: number, patch: Partial<VolumeMount>) =>
    setRows((r) => r.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  const remove = (i: number) => setRows((r) => r.filter((_, idx) => idx !== i));

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
          Volume mounts
        </label>
        <Button type="button" variant="ghost" size="xs" onClick={add} disabled={disabled}>
          + add
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="text-[10px] text-muted-foreground/70 italic">
          none — bind paths or named-volume names accepted on the host side
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((m, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={m.hostPath}
                onChange={(e) => update(i, { hostPath: e.target.value })}
                placeholder="/host/path or volume-name"
                disabled={disabled}
                className="font-mono"
              />
              <span className="text-muted-foreground text-xs">→</span>
              <Input
                value={m.containerPath}
                onChange={(e) => update(i, { containerPath: e.target.value })}
                placeholder="/container/path"
                disabled={disabled}
                className="font-mono"
              />
              <label className="text-[10px] text-muted-foreground flex items-center gap-1 shrink-0">
                <input
                  type="checkbox"
                  checked={m.readOnly}
                  onChange={(e) => update(i, { readOnly: e.target.checked })}
                  disabled={disabled}
                />
                ro
              </label>
              <Button
                type="button"
                variant="ghost"
                size="iconSm"
                onClick={() => remove(i)}
                disabled={disabled}
                title="Remove"
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
