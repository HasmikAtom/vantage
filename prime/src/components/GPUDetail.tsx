import type { GpuHeadline } from '@/types';
import { Card, Separator } from './ui/primitives';
import { SectionHeader } from './SectionHeader';
import { heatColor } from '@/lib/utils';

interface Props {
  gpu: GpuHeadline;
}

/**
 * Renders every Nouveau-friendly GPU detail we can scrape. Util/VRAM stay
 * out by design because Nouveau doesn't expose them.
 */
export function GPUDetail({ gpu }: Props) {
  const pcie =
    gpu.pcie.currentSpeed && gpu.pcie.currentWidth
      ? `${gpu.pcie.currentSpeed} × ${gpu.pcie.currentWidth}`
      : '—';
  const pcieMax =
    gpu.pcie.maxSpeed && gpu.pcie.maxWidth
      ? `${gpu.pcie.maxSpeed} × ${gpu.pcie.maxWidth}`
      : '';
  const showClocks = gpu.coreMhz > 0 || gpu.memMhz > 0;
  // Kepler peak ~150W; use that as the heat ramp ceiling so colours mean something.
  const powerColor = heatColor(Math.min(1, gpu.powerW / 150));
  // Drivers like Nouveau don't expose util/VRAM. Caller-visible hint.
  const utilUnavailable =
    gpu.driver === 'nouveau' || (gpu.pct === 0 && gpu.vram.total === 0);

  return (
    <div>
      <SectionHeader label="GPU detail" count={gpu.driver || 'no driver'} />
      <Card>
        <div className="p-4 space-y-4">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
              {gpu.name || 'Unknown GPU'}
            </div>
            <div className="flex items-baseline gap-2">
              <div
                className="font-serif text-2xl font-medium leading-none tabular-nums"
                style={{ color: powerColor }}
              >
                {gpu.powerW ? gpu.powerW.toFixed(1) : '—'}
              </div>
              <div className="text-xs text-muted-foreground">W</div>
              {gpu.voltageV > 0 && (
                <div className="text-[11px] text-muted-foreground/80 font-mono ml-2">
                  · {gpu.voltageV.toFixed(3)} V
                </div>
              )}
            </div>
            <div className="text-[10px] font-mono text-muted-foreground/80 mt-1">
              power draw (proxy for utilization on Nouveau)
            </div>
          </div>

          <Separator />

          <div className="grid grid-cols-2 gap-y-3 gap-x-4">
            {showClocks && (
              <>
                <Field label="Core" value={gpu.coreMhz ? `${gpu.coreMhz} MHz` : '—'} />
                <Field label="Memory" value={gpu.memMhz ? `${gpu.memMhz} MHz` : '—'} />
              </>
            )}
            <Field label="PCIe" value={pcie} {...(pcieMax ? { sub: `max ${pcieMax}` } : {})} />
            {gpu.pstate && <Field label="P-state" value={gpu.pstate} />}
            <Field label="Temp" value={gpu.temp ? `${gpu.temp} °C` : '—'} />
            <Field label="Fan" value={gpu.fan ? `${gpu.fan}%` : '—'} />
          </div>

          {gpu.processes.length > 0 && (
            <>
              <Separator />
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
                  Processes using GPU
                </div>
                <div className="space-y-1">
                  {gpu.processes.map((p) => (
                    <div
                      key={p.pid}
                      className="flex items-baseline justify-between font-mono text-[11px]"
                    >
                      <span className="truncate">{p.name || '?'}</span>
                      <span className="text-muted-foreground/70 ml-2 shrink-0">
                        #{p.pid} · {p.device.replace('/dev/dri/', '')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {utilUnavailable && (
            <>
              <Separator />
              <div className="text-[10px] italic text-muted-foreground/80 leading-snug">
                Utilization % and VRAM are not exposed by the {gpu.driver || 'open-source'}{' '}
                driver. Power draw above is the most reliable proxy for "how busy is the GPU
                right now".
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
      <div className="text-xs mt-1">{value}</div>
      {sub && <div className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">{sub}</div>}
    </div>
  );
}
