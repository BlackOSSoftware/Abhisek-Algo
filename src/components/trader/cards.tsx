import { cn, Panel } from "@/components/ui";

export function SectionCard({
  title,
  subtitle,
  action,
  children,
  className
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Panel className={cn("rounded-xl border-white/70 p-0 shadow-sm", className)}>
      <div className="flex flex-col gap-3 border-b border-line px-3 py-3 sm:px-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold sm:text-lg">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="p-3 sm:p-4">{children}</div>
    </Panel>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-line bg-white/70 p-4 text-center text-sm font-medium text-muted sm:p-6">{text}</div>;
}
