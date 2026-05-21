import { cn, statusTone, type StatusTone } from '@/lib/utils';

export interface StatusDotProps {
  status?: string;
  size?: number;
  pulse?: boolean;
  className?: string;
}

const toneBgClass: Record<StatusTone, string> = {
  positive: 'bg-primary',
  warn: 'bg-warn',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground',
};

export const StatusDot = ({
  status = 'healthy',
  size = 6,
  pulse = false,
  className,
}: StatusDotProps) => {
  const color = toneBgClass[statusTone(status)];
  return (
    <span
      className={cn('relative inline-block rounded-full shrink-0', color, className)}
      style={{ width: size, height: size }}
    >
      {pulse && (
        <span
          className={cn('absolute inset-0 rounded-full opacity-75', color)}
          style={{ animation: 'vantage-ping 1.6s cubic-bezier(0,0,.2,1) infinite' }}
        />
      )}
    </span>
  );
};
