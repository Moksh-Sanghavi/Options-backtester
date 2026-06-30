"use client";

/**
 * DatePicker — a compact date field that opens a small calendar in a popover.
 *
 * The trigger looks like an input showing the selected date; clicking it opens a
 * single-month calendar (Base UI Popover, portalled so it never clips inside
 * scroll containers). The header splits into a month button and a year button:
 * clicking either swaps the calendar for a scrollable list of selectable months
 * / years (auto-scrolled to the current value). Days outside [min, max] are
 * disabled, so pairing two pickers (start.max = end, end.min = start) makes an
 * end-before-start range impossible.
 */
import { Popover } from "@base-ui/react/popover";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

interface DatePickerProps {
  value: string; // YYYY-MM-DD ("" = none)
  min: string;
  max: string;
  onChange: (date: string) => void;
  id?: string;
  placeholder?: string;
}

type Mode = "days" | "months" | "years";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function toISO(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}
/** "3 Jun 2024" for the trigger label. */
function formatDisplay(s: string): string {
  if (!s) return "";
  return parseISO(s).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function DatePicker({ value, min, max, onChange, id, placeholder = "Select date" }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("days");
  const [view, setView] = useState(() => {
    const base = value ? parseISO(value) : parseISO(min);
    return { year: base.getFullYear(), month: base.getMonth() };
  });
  const selectedItemRef = useRef<HTMLButtonElement>(null);

  // Re-centre on the selected date whenever the popover is (re)opened.
  useEffect(() => {
    if (open) {
      const base = value ? parseISO(value) : parseISO(min);
      setView({ year: base.getFullYear(), month: base.getMonth() });
      setMode("days");
    }
  }, [open, value, min]);

  // When a list opens, scroll its current value into view.
  useEffect(() => {
    if (mode !== "days") {
      selectedItemRef.current?.scrollIntoView({ block: "center" });
    }
  }, [mode]);

  const minDate = parseISO(min);
  const maxDate = parseISO(max);
  const minKey = monthKey(minDate.getFullYear(), minDate.getMonth());
  const maxKey = monthKey(maxDate.getFullYear(), maxDate.getMonth());
  const viewKey = monthKey(view.year, view.month);

  const cells = useMemo(() => {
    const firstWeekday = new Date(view.year, view.month, 1).getDay();
    const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
    const out: (string | null)[] = [];
    for (let i = 0; i < firstWeekday; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(toISO(new Date(view.year, view.month, d)));
    return out;
  }, [view]);

  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = minDate.getFullYear(); y <= maxDate.getFullYear(); y++) out.push(y);
    return out;
  }, [min, max]);

  const shiftMonth = (delta: number) => {
    setView((v) => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  const selectMonth = (m: number) => {
    setView((v) => ({ ...v, month: m }));
    setMode("days");
  };

  const selectYear = (y: number) => {
    // Clamp the month into range when landing on a boundary year.
    let m = view.month;
    if (monthKey(y, m) < minKey) m = minDate.getMonth();
    else if (monthKey(y, m) > maxKey) m = maxDate.getMonth();
    setView({ year: y, month: m });
    setMode("days");
  };

  const triggerClasses = cn(
    "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-3 text-sm transition-colors",
    "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
    "dark:bg-input/30 dark:hover:bg-input/50",
    !value && "text-muted-foreground",
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button id={id} type="button" className={triggerClasses}>
            <span className="nums truncate">{value ? formatDisplay(value) : placeholder}</span>
            <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <Popover.Popup
            className={cn(
              "w-[268px] rounded-xl bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none",
              "origin-(--transform-origin) duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            )}
          >
            {/* Header: prev | [Month] [Year] | next */}
            <div className="mb-2 flex items-center justify-between">
              <NavButton
                disabled={mode !== "days" || viewKey <= minKey}
                onClick={() => shiftMonth(-1)}
                label="Previous month"
              >
                <ChevronLeft className="size-4" />
              </NavButton>
              <div className="flex items-center gap-1">
                <HeaderButton
                  active={mode === "months"}
                  onClick={() => setMode((m) => (m === "months" ? "days" : "months"))}
                >
                  {MONTHS[view.month]}
                </HeaderButton>
                <HeaderButton
                  active={mode === "years"}
                  onClick={() => setMode((m) => (m === "years" ? "days" : "years"))}
                >
                  {view.year}
                </HeaderButton>
              </div>
              <NavButton
                disabled={mode !== "days" || viewKey >= maxKey}
                onClick={() => shiftMonth(1)}
                label="Next month"
              >
                <ChevronRight className="size-4" />
              </NavButton>
            </div>

            {mode === "years" && (
              <ScrollList>
                {years.map((y) => (
                  <ListItem
                    key={y}
                    ref={y === view.year ? selectedItemRef : undefined}
                    selected={y === view.year}
                    onClick={() => selectYear(y)}
                  >
                    {y}
                  </ListItem>
                ))}
              </ScrollList>
            )}

            {mode === "months" && (
              <ScrollList>
                {MONTHS.map((name, m) => {
                  const k = monthKey(view.year, m);
                  const disabled = k < minKey || k > maxKey;
                  return (
                    <ListItem
                      key={name}
                      ref={m === view.month ? selectedItemRef : undefined}
                      selected={m === view.month}
                      disabled={disabled}
                      onClick={() => selectMonth(m)}
                    >
                      {name}
                    </ListItem>
                  );
                })}
              </ScrollList>
            )}

            {mode === "days" && (
              <>
                <div className="grid grid-cols-7">
                  {WEEKDAYS.map((w, i) => (
                    <div
                      key={i}
                      className="pb-1 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                    >
                      {w}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-y-0.5">
                  {cells.map((iso, idx) => {
                    if (!iso) return <div key={idx} className="size-8" />;
                    const disabled = iso < min || iso > max;
                    const selected = iso === value;
                    const isToday = iso === toISO(new Date());
                    return (
                      <div key={idx} className="flex items-center justify-center">
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            onChange(iso);
                            setOpen(false);
                          }}
                          className={cn(
                            "nums flex size-8 items-center justify-center rounded-full text-sm transition-colors",
                            !disabled && !selected && "text-foreground hover:bg-accent",
                            selected && "bg-primary font-semibold text-primary-foreground shadow-sm",
                            isToday && !selected && "font-semibold text-primary",
                            disabled && "cursor-not-allowed text-muted-foreground/25",
                          )}
                        >
                          {parseInt(iso.slice(8), 10)}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Chevron month-step button in the calendar header. */
function NavButton({
  children,
  disabled,
  onClick,
  label,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

/** Clickable month/year segment in the calendar header. */
function HeaderButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-2 py-1 text-sm font-semibold tracking-tight transition-colors hover:bg-accent",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Scrollable container for the month / year lists. */
function ScrollList({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-h-[216px] overflow-y-auto px-0.5 py-0.5">
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

/** One row in a scrollable month / year list. */
function ListItem({
  children,
  selected,
  disabled,
  onClick,
  ref,
}: {
  children: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "nums w-full rounded-lg px-3 py-2 text-center text-sm transition-colors",
        !disabled && !selected && "text-foreground hover:bg-accent",
        selected && "bg-primary font-semibold text-primary-foreground",
        disabled && "cursor-not-allowed text-muted-foreground/25",
      )}
    >
      {children}
    </button>
  );
}
