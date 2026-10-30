// Adapted from the MIT-licensed shadcn/ui Radix Button; see THIRD_PARTY_NOTICES.md.
import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import type { VariantProps } from 'class-variance-authority';
import { cn } from './cn.js';
import { buttonVariants } from './button-variants.js';

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };
export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      data-slot="button"
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
