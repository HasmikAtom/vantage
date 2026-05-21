import * as React from 'react';
import type { Sensor } from '@/types';
import type { FloatingTooltip } from '@/hooks/useTooltip';
import { heatColor } from '@/lib/utils';

export interface SensorTileProps {
  sensor: Sensor;
  tt: FloatingTooltip;
}

// React.memo: cheap shallow-compare on `sensor` (stable across ticks when
// values don't change) avoids the heatColor + DOM-diff for unchanged probes.
// `tt` from useFloatingTooltip is now a stable handle (show/hide are
// useCallback'd, the handle itself is useMemo'd), so the memo isn't
// defeated by a fresh handle each parent render.
export const SensorTile = React.memo(function SensorTile({ sensor, tt }: SensorTileProps) {
  const frac = sensor.value / sensor.max;
  const color = heatColor(frac);
  return (
    <div
      onMouseEnter={(e) =>
        tt.show(
          `${sensor.label} · ${sensor.value}${sensor.unit} (max ${sensor.max}${sensor.unit})`,
          e,
        )
      }
      onMouseLeave={tt.hide}
      className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 cursor-default transition-colors hover:border-foreground/20"
    >
      <span
        aria-hidden
        className="h-3 w-[3px] rounded-sm shrink-0"
        style={{ background: color }}
      />
      <span className="text-[11px] text-muted-foreground truncate max-w-[12rem]">
        {sensor.label}
      </span>
      <span className="font-mono text-[11px] font-semibold tabular-nums" style={{ color }}>
        {sensor.value}
        {sensor.unit}
      </span>
    </div>
  );
});
