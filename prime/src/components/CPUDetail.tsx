import type { CoreUsage, CpuHeadline, Pressure, Sensor, SystemInfo } from '@/types';
import { Card, Separator } from './ui/primitives';
import { SectionHeader } from './SectionHeader';
import { heatColor } from '@/lib/utils';

interface Props {
  cpu: CpuHeadline;
  system: SystemInfo;
  sensors: Sensor[];
  cores: CoreUsage[];
  pressure?: Pressure;
}

export function CPUDetail({ cpu, system, sensors, cores, pressure }: Props) {
  // 125 W is a reasonable mid-range desktop TDP ceiling for the heat ramp.
  // Server-class chips will still ramp red sooner; the colour scale is meant
  // for at-a-glance, not precise.
  const powerColor = heatColor(Math.min(1, cpu.powerW / 125));
  const tempColor = heatColor(Math.min(1, cpu.temp / 95));
  // Safe: String.split always returns at least one element.
  const clockHeadline = system.cpuClock.split('·')[0]!.trim();

  // Optional CPU fan — only present when an hwmon driver exposes one for the
  // CPU package. Most desktops route the CPU fan through the super-IO chip
  // (nct6775 etc.); silent if no such driver is loaded.
  const cpuFan = sensors.find((s) => s.group === 'cpu' && s.unit === 'RPM');

  // Pair per-core util with per-core temp. coretemp labels its dies "Core N";
  // the kernel's stat indices line up 1:1 with those on every CPU we care about.
  const coreTempByIndex = new Map<number, number>();
  for (const s of sensors) {
    if (s.group !== 'cpu' || s.unit !== '°C') continue;
    const m = s.label.match(/Core (\d+)/);
    // Safe: the regex has a single capture group, which is present when `m` matches.
    if (m) coreTempByIndex.set(parseInt(m[1]!, 10), s.value);
  }

  const psi = pressure?.available ? pressure.cpu.avg10 : undefined;

  return (
    <div>
      <SectionHeader
        label="CPU detail"
        count={
          system.cpuPhysicalCores < system.cpuCores
            ? `${system.cpuPhysicalCores} cores · ${system.cpuCores} threads`
            : `${system.cpuCores} cores`
        }
      />
      <Card>
        <div className="p-4 space-y-4">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1 truncate">
              {system.cpuModel || 'Unknown CPU'}
            </div>
            <div className="flex items-baseline gap-2">
              <div
                className="font-serif text-2xl font-medium leading-none tabular-nums"
                style={{ color: powerColor }}
              >
                {cpu.powerW > 0 ? cpu.powerW.toFixed(1) : '—'}
              </div>
              <div className="text-xs text-muted-foreground">W</div>
              <div className="text-[11px] text-muted-foreground/80 font-mono ml-2 tabular-nums">
                · <span style={{ color: tempColor }}>{cpu.temp || '—'}</span> °C package
              </div>
            </div>
            <div className="text-[10px] font-mono text-muted-foreground/80 mt-1">
              RAPL package power draw{cpu.powerW === 0 ? ' (not exposed)' : ''}
            </div>
          </div>

          <Separator />

          <div className="grid grid-cols-3 gap-x-4">
            {system.loadAvg.map((v, i) => (
              <div key={i}>
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/80">
                  load {['1m', '5m', '15m'][i]}
                </div>
                <div className="font-serif text-xl font-medium leading-none tabular-nums mt-1">
                  {v.toFixed(2)}
                </div>
              </div>
            ))}
          </div>

          <Separator />

          <div className="grid grid-cols-2 gap-y-3 gap-x-4">
            <Field label="Clock" value={clockHeadline || '—'} />
            <Field label="Utilization" value={`${cpu.pct.toFixed(1)}%`} />
            <Field label="User" value={`${cpu.user.toFixed(1)}%`} />
            <Field label="System" value={`${cpu.system.toFixed(1)}%`} />
            <Field label="I/O wait" value={`${cpu.iowait.toFixed(1)}%`} />
            <Field label="Idle" value={`${cpu.idle.toFixed(1)}%`} />
            <Field label="Ctx switch" value={`${formatRate(cpu.ctxSwitch)}/s`} />
            <Field label="Interrupts" value={`${formatRate(cpu.interrupts)}/s`} />
            {cpuFan && <Field label="Fan" value={`${cpuFan.value.toFixed(0)} RPM`} />}
            {psi !== undefined && (
              <Field
                label="PSI stall"
                value={`${psi.toFixed(2)}%`}
                sub="avg 10s"
              />
            )}
          </div>

          {cores.length > 0 && (
            <>
              <Separator />
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
                  Per core
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {cores.map((c) => {
                    const utilColor = heatColor(c.pct / 100);
                    const t = coreTempByIndex.get(c.core);
                    const coreTempColor = t != null ? heatColor(Math.min(1, t / 95)) : undefined;
                    return (
                      <div key={c.core} className="space-y-1">
                        <div className="flex items-baseline justify-between gap-2 font-mono text-[10px] tabular-nums">
                          <span className="uppercase tracking-wider text-muted-foreground">
                            core {c.core}
                          </span>
                          <span className="flex items-baseline gap-1.5">
                            <span style={{ color: utilColor }} className="font-semibold">
                              {c.pct.toFixed(0)}%
                            </span>
                            <span className="text-muted-foreground/50">·</span>
                            <span style={{ color: coreTempColor }}>
                              {t != null ? `${t.toFixed(0)}°C` : '—'}
                            </span>
                          </span>
                        </div>
                        <div className="h-[3px] rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{ width: Math.min(100, c.pct) + '%', background: utilColor }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

function Field({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/80">
        {label}
      </div>
      <div className="text-xs mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">{sub}</div>}
    </div>
  );
}

function formatRate(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return n.toString();
}
