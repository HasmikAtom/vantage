import * as React from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Badge } from './ui/primitives';
import { Card } from './ui/primitives';
import { Sparkline } from './ui/sparkline';
import type { IconProps } from './ui/icons';
import { cn, heatColor } from '@/lib/utils';

export interface HeroMetricProps {
  icon?: ComponentType<IconProps>;
  title: string;
  subtitle: string;
  big: string;
  bigUnit?: string;
  sub: ReactNode;
  temp?: number | null;
  tempMax?: number;
  sparkData?: number[];
  /**
   * When set, the big value is replaced with an em-dash, the sparkline is
   * suppressed, and this string is shown as an italic footnote underneath.
   * Used for "the driver doesn't expose this metric" cases like Nouveau util.
   */
  unavailableNote?: string;
}

// React.memo: shallow-compares props. In practice big/temp/sparkData change
// every tick when the underlying metric moves, so this is a no-op on hot
// ticks. It does avoid work on idle ticks (no metric change) and on tab
// switches that don't touch the snapshot. Callers in OverviewTab still pass
// inline JSX `sub` nodes that won't be referentially stable — flagged in the
// audit but not refactored in this pass to keep scope tight.
export const HeroMetric = React.memo(function HeroMetric({
  icon: IconCmp,
  title,
  subtitle,
  big,
  bigUnit,
  sub,
  temp,
  tempMax,
  sparkData,
  unavailableNote,
}: HeroMetricProps) {
  const showTemp = temp != null && tempMax != null;
  const frac = showTemp ? temp / tempMax : 0;
  const tempColor = showTemp ? heatColor(frac) : null;
  const unavailable = Boolean(unavailableNote);
  return (
    <Card className="relative overflow-hidden">
      {showTemp && tempColor && (
        <div
          className="absolute inset-x-0 top-0 h-[3px]"
          style={{ background: tempColor, opacity: 0.85 }}
        />
      )}
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              {IconCmp && <IconCmp size={12} />}
              <div className="text-[10px] font-mono font-semibold uppercase tracking-wider">
                {title}
              </div>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground font-mono truncate">
              {subtitle}
            </div>
          </div>
          {showTemp && tempColor && (
            <Badge
              variant="outline"
              className="font-mono shrink-0"
              style={{
                color: tempColor,
                borderColor: tempColor + '40',
                background: tempColor + '14',
              }}
            >
              {temp}°C
            </Badge>
          )}
        </div>
        <div className="flex items-baseline gap-1">
          <div
            className={cn(
              'font-serif text-[44px] font-medium leading-none tracking-tight tabular-nums',
              unavailable && 'text-muted-foreground/50',
            )}
          >
            {unavailable ? '—' : big}
          </div>
          {!unavailable && bigUnit && (
            <div className="text-sm text-muted-foreground font-medium">{bigUnit}</div>
          )}
          {unavailable && (
            <div
              className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground/70"
              title={unavailableNote}
            >
              N/A
            </div>
          )}
        </div>
        <div className="flex items-end justify-between gap-2 pt-1">
          <div className="text-[11px] text-muted-foreground font-mono truncate">{sub}</div>
          {sparkData && !unavailable && (
            <div className="text-primary shrink-0">
              <Sparkline data={sparkData} width={96} height={22} stroke="currentColor" fill />
            </div>
          )}
        </div>
        {unavailable && (
          <div className="text-[10px] italic text-muted-foreground/80 leading-snug border-t border-border/60 pt-2 -mb-1">
            {unavailableNote}
          </div>
        )}
      </div>
    </Card>
  );
});
