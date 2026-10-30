import type { ReactNode } from 'react';
export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div
        aria-hidden="true"
        className="mb-5 grid size-14 place-items-center rounded-2xl border border-border bg-background text-muted-foreground"
      >
        {icon}
      </div>
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      <div className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{children}</div>
    </div>
  );
}
