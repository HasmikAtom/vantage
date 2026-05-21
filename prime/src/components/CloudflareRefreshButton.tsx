import * as React from 'react';
import { refreshCloudflareTunnels } from '@/api';
import { Button } from './ui/primitives';
import { RefreshIcon } from './ui/icons';

interface Props {
  serverId: string;
}

// CloudflareRefreshButton triggers an immediate Cloudflare API fetch for the
// active server, bypassing the scheduled interval. The new tunnel data is
// pushed to the dashboard via SSE as soon as the backend's snapshot bumps,
// so the button just shows a spinner while the round-trip completes.
export function CloudflareRefreshButton({ serverId }: Props) {
  const [refreshing, setRefreshing] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const onClick = async () => {
    setErr(null);
    setRefreshing(true);
    try {
      await refreshCloudflareTunnels(serverId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {err && <span className="font-mono text-[11px] text-destructive">{err}</span>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={refreshing}
        className="gap-1.5"
        title="Fetch from Cloudflare now"
      >
        <RefreshIcon size={12} {...(refreshing ? { className: 'animate-spin' } : {})} />
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </Button>
    </div>
  );
}
