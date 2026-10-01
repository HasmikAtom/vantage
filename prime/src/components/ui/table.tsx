import * as React from 'react';
import { cn } from '@/lib/utils';

export const Table = ({
  className,
  containerClassName,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement> & {
  // Replaces the wrapper's own overflow-auto, e.g. when an outer element
  // scrolls and the header must stick to it.
  containerClassName?: string;
}) => (
  <div className={cn('relative w-full', containerClassName ?? 'overflow-auto')}>
    <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
  </div>
);

export const TableHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className={cn('[&_tr]:border-b [&_tr]:bg-muted/40', className)} {...props} />
);

export const TableBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />
);

export const TableRow = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>) => (
  <tr
    className={cn(
      'border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
      className,
    )}
    {...props}
  />
);

export const TableHead = ({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th
    className={cn(
      'h-9 px-3 text-left align-middle font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground',
      className,
    )}
    {...props}
  />
);

export const TableCell = ({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn('px-3 py-2.5 align-middle', className)} {...props} />
);
