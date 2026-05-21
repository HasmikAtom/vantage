import type { Tunnel } from '@/types';
import { cn, isPositiveStatus, statusTone, statusToneTextClass } from '@/lib/utils';
import { Button } from './ui/primitives';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { StatusDot } from './ui/status-dot';
import { ExternalLinkIcon } from './ui/icons';

export interface TunnelDialogProps {
  tunnel: Tunnel | null;
  onClose: () => void;
}

export const TunnelDialog = ({ tunnel, onClose }: TunnelDialogProps) => {
  if (!tunnel) return null;
  const yaml = `# ~/.cloudflared/config.yml — tunnel: vantage-prime
ingress:
  - hostname: ${tunnel.hostname}
    service:  ${tunnel.service}
    originRequest:
      connectTimeout: 30s
      tlsTimeout:     10s
      noTLSVerify:    false
  - service: http_status:404`;

  const fields: Array<[string, string]> = [
    ['Origin', tunnel.service],
    ['Target', tunnel.target],
    ['Status', tunnel.status],
    ['Requests · 24h', tunnel.requests24h.toLocaleString()],
    ['Latency p50', tunnel.latencyMs + ' ms'],
    ['Connector', 'cloudflared 2024.11.1'],
  ];

  return (
    <Dialog open={!!tunnel} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogDescription className="flex items-center gap-2">
            <StatusDot status={tunnel.status} pulse={isPositiveStatus(tunnel.status)} />
            Cloudflare Tunnel · {tunnel.origin}
          </DialogDescription>
          <DialogTitle>{tunnel.hostname}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-6 space-y-5">
          <div className="grid grid-cols-3 gap-2.5">
            {fields.map(([k, v]) => {
              // Status row gets a tone-coloured value; unknown statuses fall
              // through to the default foreground (we don't dim them — that
              // would imply "stale" which isn't what 'muted' tone means here).
              const tone = statusTone(tunnel.status);
              const statusCls = k === 'Status' && tone !== 'muted' ? statusToneTextClass[tone] : undefined;
              return (
                <div key={k} className="rounded-md bg-muted/50 border px-3 py-2">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                    {k}
                  </div>
                  <div
                    className={cn(
                      'text-xs mt-1',
                      k === 'Origin' && 'font-mono truncate',
                      statusCls,
                    )}
                  >
                    {v}
                  </div>
                </div>
              );
            })}
          </div>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
              Config
            </div>
            <pre className="rounded-md p-3.5 font-mono text-[11.5px] leading-relaxed overflow-x-auto bg-foreground/95 text-background">
              {yaml}
            </pre>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button size="sm">
              <ExternalLinkIcon size={13} />
              Open dashboard
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
