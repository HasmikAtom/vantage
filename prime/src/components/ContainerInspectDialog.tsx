import * as React from 'react';
import type { ContainerInspect } from '@/types';
import { inspectContainer } from '@/api';
import { cn, formatBytesAbs, isPositiveStatus } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Badge } from './ui/primitives';
import { StatusDot } from './ui/status-dot';

export interface ContainerInspectDialogProps {
  serverId: string;
  // The container ID to inspect, or null to keep the dialog closed. Setting
  // back to null fires onClose and unmounts the body — keeps the in-flight
  // fetch from landing in a dead component.
  containerId: string | null;
  onClose: () => void;
}

function splitKV(line: string): [string, string] {
  const eq = line.indexOf('=');
  if (eq < 0) return [line, ''];
  return [line.slice(0, eq), line.slice(eq + 1)];
}

function formatCpus(nanoCpus: number): string {
  if (nanoCpus <= 0) return 'unlimited';
  return (nanoCpus / 1e9).toFixed(2) + ' cpu';
}

function formatMemory(bytes: number): string {
  if (bytes <= 0) return 'unlimited';
  return formatBytesAbs(bytes);
}

/**
 * Read-only details panel for one container. Fetches /containers/{id}/inspect
 * on open and renders a structured view: state, image, command, env vars,
 * labels, host config, mounts, networks.
 *
 * Gated to operator+ at the backend; viewers get 403 if they somehow reach
 * here (the UI hides the trigger button for them, but the gate is the
 * source of truth).
 */
export const ContainerInspectDialog = ({
  serverId,
  containerId,
  onClose,
}: ContainerInspectDialogProps) => {
  const [data, setData] = React.useState<ContainerInspect | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!containerId) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    inspectContainer(serverId, containerId, ctrl.signal)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [serverId, containerId]);

  if (!containerId) return null;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogDescription className="flex items-center gap-2">
            {data && (
              <StatusDot
                status={data.state.status}
                pulse={isPositiveStatus(data.state.status)}
              />
            )}
            Container · {containerId.slice(0, 12)}
          </DialogDescription>
          <DialogTitle>{data?.name ?? '…'}</DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-5">
          {loading && (
            <div className="font-mono text-xs text-muted-foreground py-4">
              Loading…
            </div>
          )}
          {error && (
            <div className="font-mono text-xs text-destructive py-4">
              {error}
            </div>
          )}
          {data && <InspectBody d={data} />}
        </div>
      </DialogContent>
    </Dialog>
  );
};

function InspectBody({ d }: { d: ContainerInspect }) {
  return (
    <>
      <Section title="State">
        <KV
          rows={[
            ['Status', d.state.status],
            ['Health', d.state.health || '—'],
            ['Exit code', d.state.running ? '—' : String(d.state.exitCode)],
            ['Started', d.state.startedAt || '—'],
            ['Restart count', String(d.state.restartCount)],
            ['PID', d.state.pid ? String(d.state.pid) : '—'],
          ]}
        />
        {d.state.error && (
          <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] font-mono text-destructive">
            {d.state.error}
          </div>
        )}
      </Section>

      <Section title="Image">
        <KV
          rows={[
            ['Image', d.image],
            ['Digest', d.imageDigest],
            ['Platform', d.platform],
            ['Driver', d.driver],
          ]}
          mono
        />
      </Section>

      <Section title="Process">
        <KV
          rows={[
            ['Entrypoint', d.config.entrypoint.join(' ') || '—'],
            ['Command', d.config.cmd.join(' ') || '—'],
            ['Working dir', d.config.workingDir || '—'],
            ['User', d.config.user || '—'],
            ['Hostname', d.config.hostname || '—'],
          ]}
          mono
        />
      </Section>

      <Section title="Host config">
        <KV
          rows={[
            ['Restart policy', d.hostConfig.restartPolicy || 'no'],
            ['Network mode', d.hostConfig.networkMode || '—'],
            ['Privileged', d.hostConfig.privileged ? 'yes' : 'no'],
            ['Auto remove', d.hostConfig.autoRemove ? 'yes' : 'no'],
            ['Memory limit', formatMemory(d.hostConfig.memoryLimit)],
            ['CPU limit', formatCpus(d.hostConfig.nanoCpus)],
          ]}
        />
      </Section>

      <Section title={`Environment · ${d.config.env.length}`}>
        {d.config.env.length === 0 ? (
          <Empty />
        ) : (
          <pre className="rounded-md p-3 font-mono text-[11px] leading-relaxed overflow-x-auto bg-muted/60 border max-h-64">
            {d.config.env.map((line) => {
              const [k, v] = splitKV(line);
              return (
                <div key={k + '=' + v}>
                  <span className="text-muted-foreground">{k}=</span>
                  <span>{v}</span>
                </div>
              );
            })}
          </pre>
        )}
      </Section>

      <Section title={`Labels · ${Object.keys(d.config.labels).length}`}>
        {Object.keys(d.config.labels).length === 0 ? (
          <Empty />
        ) : (
          <pre className="rounded-md p-3 font-mono text-[11px] leading-relaxed overflow-x-auto bg-muted/60 border max-h-64">
            {Object.entries(d.config.labels)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => (
                <div key={k}>
                  <span className="text-muted-foreground">{k}=</span>
                  <span>{v}</span>
                </div>
              ))}
          </pre>
        )}
      </Section>

      <Section title={`Mounts · ${d.mounts.length}`}>
        {d.mounts.length === 0 ? (
          <Empty />
        ) : (
          <div className="space-y-1">
            {d.mounts.map((m, i) => (
              <div
                key={`${m.source}→${m.destination}-${i}`}
                className="rounded-md border px-3 py-2 text-[11px] font-mono"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="muted" className="rounded-sm uppercase">
                    {m.type}
                  </Badge>
                  <span className="text-muted-foreground">
                    {m.rw ? 'rw' : 'ro'}
                  </span>
                  {m.mode && (
                    <span className="text-muted-foreground/60">· {m.mode}</span>
                  )}
                </div>
                <div className="mt-1 truncate">{m.source}</div>
                <div className="text-muted-foreground truncate">
                  → {m.destination}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={`Networks · ${Object.keys(d.networks).length}`}>
        {Object.keys(d.networks).length === 0 ? (
          <Empty />
        ) : (
          <div className="space-y-1">
            {Object.entries(d.networks).map(([name, n]) => (
              <div
                key={name}
                className="rounded-md border px-3 py-2 text-[11px] font-mono"
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-semibold">{name}</span>
                  <span className="text-muted-foreground">{n.ipAddress || '—'}</span>
                </div>
                <div className="text-muted-foreground mt-0.5">
                  gw {n.gateway || '—'} · mac {n.macAddress || '—'}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

function KV({
  rows,
  mono = false,
}: {
  rows: Array<[string, string]>;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-2.5">
      {rows.map(([k, v]) => (
        <div key={k} className="rounded-md bg-muted/50 border px-3 py-2">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            {k}
          </div>
          <div
            className={cn(
              'text-xs mt-1 break-all',
              mono && 'font-mono',
            )}
          >
            {v || '—'}
          </div>
        </div>
      ))}
    </div>
  );
}

function Empty() {
  return <div className="text-[11px] text-muted-foreground italic">— none —</div>;
}
