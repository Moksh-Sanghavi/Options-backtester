"use client";

/**
 * TradeLogTable — paginated, dense trade-execution table with win/loss visual
 * cues (row tint + coloured PnL). Pagination is client-side over the already
 * fetched trade log.
 */
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { TradeLogRow } from "@/lib/api";
import { CsvColumn, downloadCsv, rowsToCsv } from "@/lib/export-csv";
import { formatINR, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 12;

/** Column layout for the exported CSV — one entry per TradeLogRow field. */
const CSV_COLUMNS: CsvColumn<TradeLogRow>[] = [
  { header: "Trade ID", value: (r) => r.trade_id },
  { header: "Strategy", value: (r) => r.strategy },
  { header: "Date", value: (r) => r.date },
  { header: "Leg ID", value: (r) => r.leg_id },
  { header: "Right", value: (r) => r.right },
  { header: "Strike", value: (r) => r.strike },
  { header: "Direction", value: (r) => r.direction },
  { header: "Expiry", value: (r) => r.expiry },
  { header: "Entry Time", value: (r) => r.entry_time ?? "" },
  { header: "Exit Time", value: (r) => r.exit_time ?? "" },
  { header: "Entry Premium", value: (r) => r.entry_premium },
  { header: "Exit Premium", value: (r) => r.exit_premium },
  { header: "Premium Change", value: (r) => r.premium_change },
  { header: "Lots", value: (r) => r.lots },
  { header: "Lot Size", value: (r) => r.lot_size },
  { header: "Margin Blocked", value: (r) => r.margin_blocked },
  { header: "Net PnL (INR)", value: (r) => r.net_pnl_inr },
  { header: "Exit Reason", value: (r) => r.exit_reason },
];

interface TradeLogTableProps {
  rows: TradeLogRow[];
}

/** Format an ISO timestamp to HH:MM (24h). */
function timeOnly(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function TradeLogTable({ rows }: TradeLogTableProps) {
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = useMemo(
    () => rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [rows, safePage],
  );

  const handleExport = () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadCsv(`tradelog-${stamp}.csv`, rowsToCsv(rows, CSV_COLUMNS));
  };

  return (
    <div className="glass-surface overflow-hidden rounded-xl">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold">Trade Log</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {rows.length} executions
          </span>
          {/* Only offer the export once a completed backtest has trades. */}
          {rows.length > 0 && (
            <Button size="sm" variant="outline" onClick={handleExport}>
              <Download className="size-4" />
              Export CSV
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
              <Th>Date</Th>
              <Th>Strategy</Th>
              <Th>Type</Th>
              <Th className="text-right">Strike</Th>
              <Th className="text-right">Entry</Th>
              <Th className="text-right">Exit</Th>
              <Th className="text-right">Entry ₹</Th>
              <Th className="text-right">Exit ₹</Th>
              <Th className="text-right">Lots</Th>
              <Th className="text-right">Net PnL</Th>
              <Th>Reason</Th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => {
              const win = r.net_pnl_inr >= 0;
              const isCall = r.right.toLowerCase().startsWith("c");
              return (
                <tr
                  key={r.leg_id}
                  className={cn(
                    "border-b border-border/60 transition-colors hover:bg-accent/40",
                    win ? "bg-positive/[0.04]" : "bg-negative/[0.05]",
                  )}
                >
                  <Td className="whitespace-nowrap text-muted-foreground">{r.date}</Td>
                  <Td className="whitespace-nowrap">{r.strategy}</Td>
                  <Td>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-xs font-medium",
                        isCall
                          ? "bg-positive/15 text-positive"
                          : "bg-negative/15 text-negative",
                      )}
                    >
                      {isCall ? "CE" : "PE"}
                    </span>
                  </Td>
                  <Td className="nums font-mono text-right">{formatNumber(r.strike, 0)}</Td>
                  <Td className="nums font-mono text-right text-muted-foreground">
                    {timeOnly(r.entry_time)}
                  </Td>
                  <Td className="nums font-mono text-right text-muted-foreground">
                    {timeOnly(r.exit_time)}
                  </Td>
                  <Td className="nums font-mono text-right">{formatNumber(r.entry_premium, 2)}</Td>
                  <Td className="nums font-mono text-right">{formatNumber(r.exit_premium, 2)}</Td>
                  <Td className="nums font-mono text-right">{r.lots}</Td>
                  <Td
                    className={cn(
                      "nums font-mono text-right font-medium",
                      win ? "text-positive" : "text-negative",
                    )}
                  >
                    {win ? "+" : "−"}
                    {formatINR(Math.abs(r.net_pnl_inr))}
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-muted-foreground">
                    {r.exit_reason}
                  </Td>
                </tr>
              );
            })}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">
                  No executions to display.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
        <span className="text-xs text-muted-foreground">
          Page {safePage + 1} of {totalPages}
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="size-4" />
            Prev
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            Next
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <th className={cn("px-3 py-2 font-medium", className)}>{children}</th>;
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={cn("px-3 py-2", className)}>{children}</td>;
}
