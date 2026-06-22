import { BrandMark } from "@/components/brand-mark";

/** Shared site footer — keeps the dashboard and inner pages visually anchored and consistent. */
export function SiteFooter() {
  return (
    <footer className="border-t border-zinc-200 bg-white/60">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-6 py-6 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-2">
          <BrandMark className="h-5 w-5" />
          InnovFin Automations · Innovfix Private Limited
        </span>
        <span className="tabular-nums text-zinc-400">GSTIN 29AAICI1603A1Z3</span>
      </div>
    </footer>
  );
}
