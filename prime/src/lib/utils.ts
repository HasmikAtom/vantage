export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function heatColor(frac: number, alpha = 1): string {
  const f = Math.max(0, Math.min(1, frac));
  // Fixed gradient stops; tuple typing keeps element indexing safe under
  // noUncheckedIndexedAccess so we don't need a runtime guard on each access.
  type Stop = readonly [number, number, number, number];
  const stops: readonly Stop[] = [
    [0.0, 22, 163, 74],
    [0.4, 22, 163, 74],
    [0.6, 202, 138, 4],
    [0.85, 220, 38, 38],
    [1.0, 159, 18, 57],
  ];
  // Safe: `stops` is statically non-empty (5 entries above).
  let a: Stop = stops[0]!;
  let b: Stop = stops[stops.length - 1]!;
  for (let i = 0; i < stops.length - 1; i++) {
    // Safe: loop bound guarantees both indices are in range.
    const lo = stops[i]!;
    const hi = stops[i + 1]!;
    if (f >= lo[0] && f <= hi[0]) {
      a = lo;
      b = hi;
      break;
    }
  }
  const t = (f - a[0]) / (b[0] - a[0] || 1);
  const r = Math.round(a[1] + (b[1] - a[1]) * t);
  const g = Math.round(a[2] + (b[2] - a[2]) * t);
  const bl = Math.round(a[3] + (b[3] - a[3]) * t);
  return alpha === 1 ? `rgb(${r},${g},${bl})` : `rgba(${r},${g},${bl},${alpha})`;
}

export function formatBytes(b: number): string {
  if (b > 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB/s';
  if (b > 1024) return (b / 1024).toFixed(1) + ' KB/s';
  return b + ' B/s';
}

export function formatStorage(gb: number): string {
  if (gb >= 1024) return (gb / 1024).toFixed(2) + ' TB';
  if (gb < 1) return (gb * 1024).toFixed(0) + ' MB';
  return gb.toFixed(0) + ' GB';
}

export function formatMem(m: number | null): string {
  if (m == null) return '—';
  return m >= 100 ? m.toFixed(0) + ' MB' : m.toFixed(1) + ' MB';
}

export function portBadgeVariant(exposed: string): 'danger' | 'success' | 'muted' {
  if (exposed === 'public') return 'danger';
  if (exposed === 'cf-tun') return 'success';
  return 'muted';
}

/**
 * Browser-reachable URL for a docker port spec ("8088:80" or just "3000").
 * Returns null for unpublished ports (no `PUBLIC:PRIVATE` form) — those
 * only resolve inside the docker network and can't be opened from a
 * browser tab.
 *
 * `host` is the server the container is actually running on (its
 * registered URL's hostname). When omitted we fall back to
 * `window.location.hostname` — but that's almost never what you want in
 * the multi-server / reverse-proxy world we live in. Concrete reason:
 * accessing the dashboard via a Cloudflare tunnel (`vantage.example.com`)
 * would otherwise produce `https://vantage.example.com:3000` which the
 * tunnel doesn't route. We default to http: when an explicit host is
 * given, because container ports are almost always plain HTTP and only
 * accessible on the host's LAN — TLS termination is the dashboard's job,
 * not each container's.
 */
export function containerPortURL(portSpec: string, host?: string): string | null {
  const m = portSpec.match(/^(\d+):\d+$/);
  if (!m) return null;
  if (host) return `http://${host}:${m[1]}`;
  return `${window.location.protocol}//${window.location.hostname}:${m[1]}`;
}

/** First published port in the list, as a clickable URL. See containerPortURL for `host` semantics. */
export function firstContainerPortURL(ports: string[], host?: string): string | null {
  for (const p of ports) {
    const u = containerPortURL(p, host);
    if (u) return u;
  }
  return null;
}

/**
 * hostFromServerURL extracts the hostname portion of a registered server
 * URL ("http://192.168.0.117:8095" → "192.168.0.117"). Returns "" if the
 * URL is malformed so the caller can fall back to the browser default
 * cleanly (rather than crash on bad input).
 */
export function hostFromServerURL(serverURL: string): string {
  try {
    return new URL(serverURL).hostname;
  } catch {
    return '';
  }
}

function parseTunnelService(svc: string): { host: string; port: number } | null {
  const m = svc.match(/^[a-z]+:\/\/([^/:?#]+):(\d+)/i);
  if (!m) return null;
  return { host: m[1]!, port: Number(m[2]) };
}

function parseContainerPort(p: string): { pub?: number; priv: number } | null {
  const pub = p.match(/^(\d+):(\d+)$/);
  if (pub) return { pub: Number(pub[1]), priv: Number(pub[2]) };
  const priv = p.match(/^(\d+)$/);
  if (priv) return { priv: Number(priv[1]) };
  return null;
}

/**
 * Tunnels whose `service` ingress points at this container.
 *  - docker bridge route:  service = http://<containerName>:<privatePort>
 *  - host published route: service = http://localhost:<publishedPort>
 * Anything else (LAN IP, unix:, ssh://) is ignored.
 */
export function tunnelsForContainer<
  C extends { name: string; ports: string[] },
  T extends { service: string },
>(c: C, tunnels: T[]): T[] {
  if (!tunnels.length || !c.ports.length) return [];
  const cPorts = c.ports
    .map(parseContainerPort)
    .filter((p): p is { pub?: number; priv: number } => p !== null);
  const out: T[] = [];
  for (const t of tunnels) {
    const svc = parseTunnelService(t.service);
    if (!svc) continue;
    if (svc.host === c.name && cPorts.some((p) => p.priv === svc.port)) {
      out.push(t);
      continue;
    }
    if (
      (svc.host === 'localhost' || svc.host === '127.0.0.1') &&
      cPorts.some((p) => p.pub === svc.port)
    ) {
      out.push(t);
    }
  }
  return out;
}

/** Bytes per second → "12.3 MB/s" style. */
export function formatBps(bps: number): string {
  if (bps >= 1024 * 1024) return (bps / (1024 * 1024)).toFixed(1) + ' MB/s';
  if (bps >= 1024) return (bps / 1024).toFixed(1) + ' KB/s';
  return Math.round(bps) + ' B/s';
}

/** Total bytes → "12.3 GB" style. */
export function formatBytesAbs(b: number): string {
  if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(2) + ' TB';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

/** Cumulative CPU time (seconds) → "MM:SS" or "HH:MM:SS" for ≥1h.
 *  Matches Glances' TIME+ column: small numbers stay compact, long-running
 *  daemons get the hour field. We don't include sub-second decimals — at
 *  multi-minute scales the noise outweighs the precision. */
export function formatProcTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/** Single-letter /proc state → human label + color class.
 *  Glances colors R green (running), D amber (disk-wait), Z red (zombie),
 *  T amber (stopped); everything else muted. */
export function processStateMeta(state: string): { label: string; className: string } {
  switch (state) {
    case 'R': return { label: 'R', className: 'text-emerald-500' };
    case 'D': return { label: 'D', className: 'text-warn' };
    case 'Z': return { label: 'Z', className: 'text-destructive' };
    case 'T':
    case 't': return { label: state, className: 'text-warn' };
    case 'S':
    case 'I': return { label: state, className: 'text-muted-foreground' };
    default:  return { label: state || '?', className: 'text-muted-foreground' };
  }
}

/** Syslog priority → label + tailwind color class. 0–3 red, 4 amber, rest muted. */
export function journalSeverity(p: number): { label: string; className: string } {
  if (p <= 3) return { label: ['emerg', 'alert', 'crit', 'err'][p] ?? 'err', className: 'text-destructive' };
  if (p === 4) return { label: 'warn', className: 'text-warn' };
  if (p === 5) return { label: 'notice', className: 'text-muted-foreground' };
  return { label: 'info', className: 'text-muted-foreground' };
}

/**
 * Discriminated tone tag for a free-form status string. Domains overlap on
 * "positive" — services say "active", containers "running", tunnels/disks
 * "healthy", interfaces "up" — and on "destructive" — "failed", "down",
 * "stopped". Mapping them once here means callers can ask `statusTone(s)`
 * without re-encoding the synonyms.
 *
 * `muted` is the fallback for unknown / empty values; treat it like
 * "no signal" rather than "bad".
 *
 * Note: `StorageTab`'s ScrutinyScore rating ('healthy'|'warning'|'failed')
 * also routes through here, but its surface uses literal Tailwind palette
 * colours (emerald/amber/rose) for visual emphasis on the drive-health
 * cards — intentional divergence, preserved on purpose. Everywhere else
 * uses the semantic-token classes from `statusToneTextClass`.
 */
export type StatusTone = 'positive' | 'warn' | 'destructive' | 'muted';

const statusToneMap: Record<string, StatusTone> = {
  healthy: 'positive',
  running: 'positive',
  active: 'positive',
  up: 'positive',
  degraded: 'warn',
  restarting: 'warn',
  watch: 'warn',
  warning: 'warn',
  failed: 'destructive',
  down: 'destructive',
  stopped: 'destructive',
};

export function statusTone(status: string | undefined | null): StatusTone {
  if (!status) return 'muted';
  return statusToneMap[status] ?? 'muted';
}

/** Convenience: "is this a healthy/running/active/up status?" — used to drive
 * the StatusDot pulse animation and the per-domain "healthy count" reductions
 * on the overview tab. */
export function isPositiveStatus(status: string | undefined | null): boolean {
  return statusTone(status) === 'positive';
}

/** Semantic-token text class for each tone — matches StatusDot's bg-* tokens. */
export const statusToneTextClass: Record<StatusTone, string> = {
  positive: 'text-primary',
  warn: 'text-warn',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};

/**
 * Builds a safe href value from an untrusted URL string. Returns
 * undefined when the URL fails any of these checks:
 *   - parses as a URL at all (rejects "javascript:alert(1)" before any
 *     prefix-based test ever runs)
 *   - protocol is http: or https: (no javascript:, data:, file:, etc.)
 *   - has no userinfo segment ("https://safe.com@evil.com/" is rejected
 *     — without this the browser navigates to evil.com)
 *
 * Use for any `<a href={...}>` whose value contains an untrusted
 * substring. JSX attribute-encoding handles textual escaping; this
 * helper closes the protocol/userinfo classes JSX encoding doesn't.
 *
 * Returns undefined (not "") on failure so React's prop-merging skips
 * the attribute entirely — the link is rendered without a target, which
 * is the most failure-safe state.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.username !== '' || u.password !== '') return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}
