import type { ComponentProps } from 'react';
import { cn } from './cn.js';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-xl border border-border bg-card text-card-foreground', className)}
      {...props}
    />
  );
}
export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('space-y-1.5 p-6', className)} {...props} />;
}
export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-base font-semibold tracking-tight', className)} {...props} />;
}
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-6 pt-0', className)} {...props} />;
}
