import { cn } from "@/components/ui";

export function Loader({ className }: { className?: string }) {
  return <span className={cn("loader-bubble", className)} />;
}

export function BusyOverlay({ show, label = "Working" }: { show: boolean; label?: string }) {
  if (!show) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-white/45 backdrop-blur-sm">
      <div className="grid place-items-center gap-3 rounded-xl border border-line bg-white px-6 py-5 shadow-xl">
        <Loader />
        <div className="text-sm font-bold text-ink">{label}</div>
      </div>
    </div>
  );
}
