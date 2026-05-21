import type { ReactNode } from 'react';

export interface SectionHeaderProps {
  label: string;
  count?: ReactNode;
  right?: ReactNode;
}

export const SectionHeader = ({ label, count, right }: SectionHeaderProps) => (
  <div className="flex items-baseline justify-between mb-3">
    <div className="flex items-baseline gap-2">
      <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
        {label}
      </h3>
      {count != null && <span className="font-mono text-[11px] text-muted-foreground">{count}</span>}
    </div>
    {right}
  </div>
);
