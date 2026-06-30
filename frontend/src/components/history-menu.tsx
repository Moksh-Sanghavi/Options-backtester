"use client";

/**
 * HistoryMenu — a header dropdown listing persisted backtests. Selecting one
 * reopens its stored results; each row can also be deleted. Runs are saved
 * server-side (SQLite) when a backtest completes.
 */
import { Popover } from "@base-ui/react/popover";
import { History, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RunSummary, deleteRun, fetchHistory } from "@/lib/api";
import { formatSigned } from "@/lib/format";
import { cn } from "@/lib/utils";

export function HistoryMenu({ onLoad }: { onLoad: (runId: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = () => {
    setLoading(true);
    fetchHistory()
      .then(setRuns)
      .catch((err) => toast.error("Could not load history", { description: String(err?.message) }))
      .finally(() => setLoading(false));
  };

  return (
    <Popover.Root onOpenChange={(open) => open && refresh()}>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/40 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
          >
            <History className="size-3.5" />
            History
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Popover.Popup className="w-[340px] max-h-[420px] overflow-y-auto rounded-xl bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none">
            <p className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              Recent backtests
            </p>
            {loading && (
              <div className="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            )}
            {!loading && runs.length === 0 && (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                No saved runs yet. Run a backtest to populate history.
              </p>
            )}
            <div className="flex flex-col gap-0.5">
              {runs.map((r) => (
                <div
                  key={r.id}
                  className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent"
                >
                  <button
                    type="button"
                    onClick={() => onLoad(r.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-xs font-medium">{r.label}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()} ·{" "}
                      {r.strategy_type ?? r.run_mode} · {r.total_trades ?? 0} trades
                    </p>
                  </button>
                  <span
                    className={cn(
                      "nums shrink-0 text-xs font-semibold",
                      (r.total_pnl ?? 0) >= 0 ? "text-positive" : "text-negative",
                    )}
                  >
                    {formatSigned(r.total_pnl ?? 0)}
                  </span>
                  <button
                    type="button"
                    aria-label="Delete run"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteRun(r.id)
                        .then(() => setRuns((rs) => rs.filter((x) => x.id !== r.id)))
                        .catch((err) =>
                          toast.error("Delete failed", { description: String(err?.message) }),
                        );
                    }}
                    className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
