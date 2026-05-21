import * as React from 'react';
import type { DashboardSnapshot, Disk, NvmeHealthLog, ScrutinyScore, SmartAttr } from '@/types';
import { cn, formatBps, formatBytesAbs, formatStorage, heatColor } from '@/lib/utils';
import { Badge, Card, Separator } from '../ui/primitives';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ShieldCheckIcon,
} from '../ui/icons';
import { SectionHeader } from '../SectionHeader';

export interface StorageTabProps {
  snapshot: DashboardSnapshot;
}

// Each NVMe "data unit" is 512000 bytes per the spec, regardless of LBA size.
const NVME_DATA_UNIT_BYTES = 512_000;

export const StorageTab = ({ snapshot }: StorageTabProps) => {
  const disks = snapshot.disks ?? [];
  const filesystems = snapshot.filesystems ?? [];
  const diskIO = snapshot.diskIo ?? [];

  return (
    <div className="space-y-6">
      <HealthSummary disks={disks} />

      <div>
        <SectionHeader label="Physical disks" count={disks.length} />
        <div className="space-y-3">
          {disks.map((d) => (
            <DiskCard key={d.id} disk={d} />
          ))}
        </div>
      </div>

      <div>
        <SectionHeader label="Disk I/O" count={diskIO.length + ' devices'} />
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead className="text-right">Read</TableHead>
                <TableHead className="text-right">Write</TableHead>
                <TableHead className="text-right">IOPS r/w</TableHead>
                <TableHead>Busy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {diskIO.map((d) => {
                const color = heatColor(d.utilPct / 100);
                return (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-xs">{d.id}</TableCell>
                    <TableCell className="text-right font-mono text-[11px] tabular-nums">
                      {formatBps(d.readBps)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] tabular-nums">
                      {formatBps(d.writeBps)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                      {d.readIops.toFixed(1)} / {d.writeIops.toFixed(1)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-1 rounded-full bg-muted overflow-hidden flex-1 max-w-[160px]">
                          <div
                            className="h-full"
                            style={{ width: d.utilPct + '%', background: color }}
                          />
                        </div>
                        <span className="font-mono text-[11px] tabular-nums" style={{ color }}>
                          {d.utilPct.toFixed(0)}%
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </div>

      <div>
        <SectionHeader label="Filesystems" count={filesystems.length + ' mounts'} />
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mount</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Usage</TableHead>
                <TableHead className="text-right">Used</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filesystems.map((fs) => {
                const frac = fs.used / fs.total;
                const color = heatColor(frac > 0.85 ? 0.95 : frac > 0.65 ? 0.55 : 0.2);
                return (
                  <TableRow key={fs.mount}>
                    <TableCell className="font-mono text-xs">{fs.mount}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {fs.fstype}
                    </TableCell>
                    <TableCell>
                      <div className="h-1 rounded-full bg-muted overflow-hidden max-w-[220px]">
                        <div className="h-full" style={{ width: frac * 100 + '%', background: color }} />
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
                      {formatStorage(fs.used)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px]">
                      {formatStorage(fs.total)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
};

function HealthSummary({ disks }: { disks: Disk[] }) {
  // Single full traversal computing counts + capacity + extremes. Cheap per
  // tick but the tab also recomputes Disk-level frac/heat values; memoize the
  // shared reduction so unrelated re-renders skip it.
  const { counts, totalCapacityGB, hottest, oldest } = React.useMemo(() => {
    const counts = { healthy: 0, warning: 0, failed: 0, unknown: 0 };
    let totalCapacityGB = 0;
    let hottest = { tempC: 0, id: '' };
    let oldest = { hours: 0, id: '' };
    for (const d of disks) {
      totalCapacityGB += d.total;
      if (d.tempC > hottest.tempC) hottest = { tempC: d.tempC, id: d.id };
      if (d.powerOnHours > oldest.hours) oldest = { hours: d.powerOnHours, id: d.id };
      const r = d.detail?.score.rating;
      if (r === 'healthy') counts.healthy++;
      else if (r === 'warning') counts.warning++;
      else if (r === 'failed') counts.failed++;
      else counts.unknown++;
    }
    return { counts, totalCapacityGB, hottest, oldest };
  }, [disks]);

  return (
    <div className="grid grid-cols-4 gap-3">
      <Card className="p-3">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          Drive health
        </div>
        <div className="flex items-center gap-3">
          <ScoreCount label="OK" count={counts.healthy} variant="healthy" />
          <ScoreCount label="Warn" count={counts.warning} variant="warning" />
          <ScoreCount label="Fail" count={counts.failed} variant="failed" />
          {counts.unknown > 0 && (
            <ScoreCount label="?" count={counts.unknown} variant="unknown" />
          )}
        </div>
      </Card>
      <SummaryTile
        label="Total capacity"
        value={formatStorage(totalCapacityGB)}
        hint={`${disks.length} physical drives`}
      />
      <SummaryTile
        label="Hottest drive"
        value={hottest.tempC ? `${hottest.tempC} °C` : '—'}
        hint={hottest.id || ''}
        {...(hottest.tempC ? { color: heatColor(hottest.tempC / 70) } : {})}
      />
      <SummaryTile
        label="Oldest drive"
        value={oldest.hours ? `${(oldest.hours / 8760).toFixed(1)} yrs` : '—'}
        hint={oldest.id ? `${oldest.id} · ${oldest.hours.toLocaleString()} h` : ''}
      />
    </div>
  );
}

function ScoreCount({
  label,
  count,
  variant,
}: {
  label: string;
  count: number;
  variant: 'healthy' | 'warning' | 'failed' | 'unknown';
}) {
  const colour = {
    healthy: 'text-emerald-500',
    warning: 'text-amber-500',
    failed: 'text-rose-500',
    unknown: 'text-muted-foreground',
  }[variant];
  return (
    <div className="flex-1">
      <div className={cn('font-serif text-2xl font-medium leading-none tabular-nums', colour)}>
        {count}
      </div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80 mt-1">
        {label}
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: string;
  hint?: string;
  color?: string;
}) {
  return (
    <Card className="p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
        {label}
      </div>
      <div
        className="font-serif text-2xl font-medium leading-none tabular-nums"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      {hint && (
        <div className="font-mono text-[10px] text-muted-foreground/70 mt-2 truncate">{hint}</div>
      )}
    </Card>
  );
}

function DiskCard({ disk }: { disk: Disk }) {
  const [expanded, setExpanded] = React.useState(false);

  const usedFrac = disk.total > 0 ? disk.used / disk.total : 0;
  const usedHeat = heatColor(usedFrac > 0.8 ? 0.9 : usedFrac > 0.6 ? 0.5 : 0.2);
  const tempHeat = heatColor(disk.tempC / 70);
  const yearsOn = disk.powerOnHours / 8760;

  return (
    <Card className="overflow-hidden">
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex justify-between items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <div className="font-mono text-base font-semibold">{disk.label}</div>
              <Badge variant="muted">{disk.type}</Badge>
              {disk.mount && (
                <span className="font-mono text-[10px] text-muted-foreground/80">
                  mounted at {disk.mount}
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {disk.model}
              {disk.detail?.modelFamily && (
                <span className="text-muted-foreground/60"> · {disk.detail.modelFamily}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {disk.detail?.score && <ScoreBadge score={disk.detail.score} />}
            <Badge
              variant="outline"
              className="font-mono"
              style={{
                color: tempHeat,
                borderColor: tempHeat + '40',
                background: tempHeat + '14',
              }}
            >
              {disk.tempC || '—'}°C
            </Badge>
          </div>
        </div>

        {/* Identity row */}
        {disk.detail && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-[11px]">
            <KV label="Serial" value={disk.detail.serial || '—'} mono />
            <KV label="Firmware" value={disk.detail.firmware || '—'} mono />
            <KV
              label="Interface"
              value={
                disk.detail.interfaceSpeed ||
                (disk.detail.nvmeLog ? 'NVMe' : '—')
              }
              {...(disk.detail.maxInterface &&
              disk.detail.interfaceSpeed !== disk.detail.maxInterface
                ? { sub: `max ${disk.detail.maxInterface}` }
                : {})}
            />
            <KV
              label="Form"
              value={
                disk.detail.rotationRate > 0
                  ? `${disk.detail.rotationRate} RPM`
                  : disk.detail.nvmeLog
                    ? 'NVMe SSD'
                    : 'SSD'
              }
              {...(disk.detail.formFactor ? { sub: disk.detail.formFactor } : {})}
            />
          </div>
        )}

        <Separator />

        {/* Headline metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Metric
            label="Used"
            big={`${(usedFrac * 100).toFixed(0)}%`}
            sub={`${formatStorage(disk.used)} / ${formatStorage(disk.total)}`}
            barFrac={usedFrac}
            barColor={usedHeat}
          />
          <Metric
            label="Life left"
            big={disk.smart.lifeLeft > 0 ? `${disk.smart.lifeLeft}%` : '—'}
            sub={
              disk.detail?.nvmeLog
                ? `${100 - disk.detail.nvmeLog.percentageUsed}% NVMe spec`
                : 'Wear leveling'
            }
            barFrac={disk.smart.lifeLeft / 100}
            barColor={heatColor(1 - disk.smart.lifeLeft / 100)}
          />
          <Metric
            label="Power-on"
            big={yearsOn > 0 ? `${yearsOn.toFixed(1)} yrs` : '—'}
            sub={`${disk.powerOnHours.toLocaleString()} hours`}
          />
          <Metric
            label="Cycles"
            big={(disk.detail?.powerCycles ?? 0).toLocaleString()}
            sub={
              disk.detail?.nvmeLog
                ? `${disk.detail.nvmeLog.unsafeShutdowns.toLocaleString()} unsafe`
                : 'power cycles'
            }
          />
        </div>

        {/* NVMe-specific telemetry block */}
        {disk.detail?.nvmeLog && <NvmeStrip log={disk.detail.nvmeLog} />}

        {/* Score reasons */}
        {disk.detail && disk.detail.score.reasons.length > 0 && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              Health notes
            </div>
            <ul className="space-y-1">
              {disk.detail.score.reasons.map((r, i) => (
                <li
                  key={i}
                  className={cn(
                    'flex items-start gap-2 text-[11px] leading-snug',
                    disk.detail!.score.rating === 'failed'
                      ? 'text-rose-500'
                      : 'text-amber-500',
                  )}
                >
                  <AlertTriangleIcon size={11} className="shrink-0 mt-[2px]" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Expand: full attribute table */}
        {(disk.detail?.ataAttrs.length || disk.detail?.nvmeLog) && (
          <div>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
              Full SMART
              <span className="text-muted-foreground/60">
                ·{' '}
                {disk.detail?.nvmeLog
                  ? 'NVMe health log'
                  : `${disk.detail?.ataAttrs.length ?? 0} attributes`}
              </span>
            </button>
            {expanded && (
              <div className="mt-3">
                {disk.detail?.nvmeLog ? (
                  <NvmeLogTable log={disk.detail.nvmeLog} />
                ) : (
                  <AtaAttrTable attrs={disk.detail?.ataAttrs ?? []} />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function ScoreBadge({ score }: { score: ScrutinyScore }) {
  const styles = {
    healthy: { label: 'PASS', cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' },
    warning: { label: 'WARN', cls: 'bg-amber-500/10 text-amber-500 border-amber-500/30' },
    failed: { label: 'FAIL', cls: 'bg-rose-500/10 text-rose-500 border-rose-500/30' },
  }[score.rating];
  const Icon = score.rating === 'healthy' ? ShieldCheckIcon : AlertTriangleIcon;
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded border',
        styles.cls,
      )}
    >
      <Icon size={11} />
      {styles.label}
    </div>
  );
}

function NvmeStrip({ log }: { log: NvmeHealthLog }) {
  const dataRead = log.dataUnitsRead * NVME_DATA_UNIT_BYTES;
  const dataWritten = log.dataUnitsWritten * NVME_DATA_UNIT_BYTES;
  const spareCritical = log.availableSpareThreshold > 0 && log.availableSpare <= log.availableSpareThreshold;
  const wearColor = heatColor(log.percentageUsed / 100);
  const spareColor = spareCritical
    ? heatColor(0.95)
    : heatColor(Math.max(0, (100 - log.availableSpare) / 100));
  return (
    <div className="rounded border bg-muted/30 p-3 grid grid-cols-2 md:grid-cols-4 gap-3">
      <KV
        label="NVMe wear"
        value={`${log.percentageUsed}% used`}
        sub="0-100% of rated writes"
        valueColor={wearColor}
      />
      <KV
        label="Available spare"
        value={`${log.availableSpare}%`}
        sub={`threshold ${log.availableSpareThreshold}%`}
        valueColor={spareColor}
      />
      <KV
        label="Host writes"
        value={formatBytesAbs(dataWritten)}
        sub={`${formatBytesAbs(dataRead)} read`}
      />
      <KV
        label="Errors"
        value={`${log.mediaErrors} media`}
        sub={`${log.numErrLogEntries} log entries`}
      />
    </div>
  );
}

function NvmeLogTable({ log }: { log: NvmeHealthLog }) {
  const rows: Array<[string, string]> = [
    ['critical_warning', `0x${log.criticalWarning.toString(16).padStart(2, '0')}`],
    ['temperature', `${log.temperature} °C`],
    ['available_spare', `${log.availableSpare}%`],
    ['available_spare_threshold', `${log.availableSpareThreshold}%`],
    ['percentage_used', `${log.percentageUsed}%`],
    ['data_units_read', `${log.dataUnitsRead.toLocaleString()} (${formatBytesAbs(log.dataUnitsRead * NVME_DATA_UNIT_BYTES)})`],
    ['data_units_written', `${log.dataUnitsWritten.toLocaleString()} (${formatBytesAbs(log.dataUnitsWritten * NVME_DATA_UNIT_BYTES)})`],
    ['host_reads', log.hostReads.toLocaleString()],
    ['host_writes', log.hostWrites.toLocaleString()],
    ['controller_busy_time', `${log.controllerBusyTime.toLocaleString()} min`],
    ['power_cycles', log.powerCycles.toLocaleString()],
    ['power_on_hours', `${log.powerOnHours.toLocaleString()} (${(log.powerOnHours / 8760).toFixed(2)} yrs)`],
    ['unsafe_shutdowns', log.unsafeShutdowns.toLocaleString()],
    ['media_errors', log.mediaErrors.toLocaleString()],
    ['num_err_log_entries', log.numErrLogEntries.toLocaleString()],
    ['warning_temp_time', `${log.warningTempTime} min`],
    ['critical_comp_time', `${log.criticalCompTime} min`],
    ['temperature_sensors', log.temperatureSensors.map((t) => `${t} °C`).join(' · ') || '—'],
  ];
  return (
    <div className="rounded border overflow-hidden">
      <table className="w-full text-[11px]">
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={k} className={cn(i > 0 && 'border-t')}>
              <td className="font-mono text-muted-foreground px-3 py-1.5 w-1/3">{k}</td>
              <td className="font-mono tabular-nums px-3 py-1.5">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AtaAttrTable({ attrs }: { attrs: SmartAttr[] }) {
  return (
    <div className="rounded border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40px] text-right">ID</TableHead>
            <TableHead>Attribute</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Worst</TableHead>
            <TableHead className="text-right">Thresh</TableHead>
            <TableHead className="text-right">Raw</TableHead>
            <TableHead className="w-[80px]">Flags</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {attrs.map((a) => {
            const failing = a.whenFailed === 'FAILING_NOW';
            const failedPast = a.whenFailed === 'in_the_past';
            const rowCls = failing
              ? 'bg-rose-500/5'
              : failedPast
                ? 'bg-amber-500/5'
                : undefined;
            return (
              <TableRow key={a.id} className={rowCls}>
                <TableCell className="text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                  {a.id}
                </TableCell>
                <TableCell className="font-mono text-[11px]">{a.name}</TableCell>
                <TableCell className="text-right font-mono text-[11px] tabular-nums">
                  {a.value}
                </TableCell>
                <TableCell className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {a.worst}
                </TableCell>
                <TableCell className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {a.threshold}
                </TableCell>
                <TableCell className="text-right font-mono text-[11px] tabular-nums">
                  {a.rawString || a.rawValue}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {a.prefailure && (
                      <span className="font-mono text-[9px] text-amber-500 uppercase tracking-wider">
                        pre-fail
                      </span>
                    )}
                    {failing && (
                      <span className="font-mono text-[9px] text-rose-500 uppercase tracking-wider">
                        failing
                      </span>
                    )}
                    {failedPast && (
                      <span className="font-mono text-[9px] text-amber-500 uppercase tracking-wider">
                        past
                      </span>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function KV({
  label,
  value,
  sub,
  mono,
  valueColor,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  valueColor?: string;
}) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
        {label}
      </div>
      <div
        className={cn('mt-0.5 text-xs', mono && 'font-mono', 'tabular-nums truncate')}
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </div>
      {sub && <div className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">{sub}</div>}
    </div>
  );
}

function Metric({
  label,
  big,
  sub,
  barFrac,
  barColor,
}: {
  label: string;
  big: string;
  sub?: string;
  barFrac?: number;
  barColor?: string;
}) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
        {label}
      </div>
      <div className="font-serif text-2xl font-medium leading-none tabular-nums mt-1">{big}</div>
      {sub && <div className="text-[10px] font-mono text-muted-foreground/70 mt-1">{sub}</div>}
      {barFrac != null && (
        <div className="h-1 rounded-full bg-muted overflow-hidden mt-2">
          <div
            className="h-full"
            style={{ width: Math.min(100, Math.max(0, barFrac * 100)) + '%', background: barColor }}
          />
        </div>
      )}
    </div>
  );
}
