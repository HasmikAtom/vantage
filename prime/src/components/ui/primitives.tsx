import * as React from 'react';
import { cn } from '@/lib/utils';

export type DivProps = React.HTMLAttributes<HTMLDivElement>;

export const Card = ({ className, ...props }: DivProps) => (
  <div className={cn('rounded-lg border bg-card text-card-foreground', className)} {...props} />
);
export const CardHeader = ({ className, ...props }: DivProps) => (
  <div className={cn('flex flex-col space-y-1 px-4 py-3', className)} {...props} />
);
export const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3
    className={cn('text-xs font-semibold uppercase tracking-wider leading-none', className)}
    {...props}
  />
);
export const CardDescription = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('text-xs text-muted-foreground font-mono', className)} {...props} />
);
export const CardContent = ({ className, ...props }: DivProps) => (
  <div className={cn('px-4 pb-4', className)} {...props} />
);

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warn'
  | 'danger'
  | 'muted';

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
}

const badgeVariants: Record<BadgeVariant, string> = {
  default: 'bg-primary text-primary-foreground border-transparent',
  secondary: 'bg-secondary text-secondary-foreground border-transparent',
  destructive: 'bg-destructive text-destructive-foreground border-transparent',
  outline: 'text-foreground',
  success: 'bg-primary/10 text-primary border-primary/20',
  warn: 'bg-warn/10 text-warn border-warn/20',
  danger: 'bg-destructive/10 text-destructive border-destructive/20',
  muted: 'bg-muted text-muted-foreground border-border',
};

export const Badge = ({ variant = 'default', className, ...props }: BadgeProps) => (
  <div
    className={cn(
      'inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider',
      badgeVariants[variant],
      className,
    )}
    {...props}
  />
);

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'xs' | 'lg' | 'icon' | 'iconSm';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const buttonVariants: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm',
  outline:
    'border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 shadow-sm',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  link: 'text-primary underline-offset-4 hover:underline',
};

const buttonSizes: Record<ButtonSize, string> = {
  default: 'h-9 px-4 py-2 text-sm',
  sm: 'h-8 px-3 text-xs',
  xs: 'h-7 px-2.5 text-xs',
  lg: 'h-10 px-8 text-sm',
  icon: 'h-9 w-9',
  iconSm: 'h-8 w-8',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'default', size = 'default', className, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors',
      'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';

export interface ProgressProps extends DivProps {
  value?: number;
  indicatorClassName?: string;
}

export const Progress = ({ value = 0, indicatorClassName, className, ...props }: ProgressProps) => (
  <div
    className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-secondary', className)}
    {...props}
  >
    <div
      style={{ transform: `translateX(-${100 - Math.max(0, Math.min(100, value))}%)` }}
      className={cn(
        'h-full w-full flex-1 bg-primary transition-transform duration-500',
        indicatorClassName,
      )}
    />
  </div>
);

export interface SeparatorProps extends DivProps {
  orientation?: 'horizontal' | 'vertical';
}

export const Separator = ({ orientation = 'horizontal', className, ...props }: SeparatorProps) => (
  <div
    className={cn(
      'shrink-0 bg-border',
      orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
      className,
    )}
    {...props}
  />
);
