"use client";

/**
 * ConfigPanel — the StrategyConfig form.
 *
 * Built with React Hook Form + Zod. Strategy selection uses toggles (Wall
 * Reversion / ORB) from which `run_mode` is derived; risk and threshold
 * parameters use sliders; dataset and expiry use selects. On submit it maps the
 * form into a typed `BacktestRequest` and hands it to the parent.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Control, Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  BacktestRequest,
  DATA_MAX_DATE,
  DATA_MIN_DATE,
  RunMode,
  StrategyConfigInput,
  fetchDatasetExpiries,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const formSchema = z
  .object({
    dataset: z.string().min(1, "Select a dataset"),
    wall_enabled: z.boolean(),
    orb_enabled: z.boolean(),
    straddle_enabled: z.boolean(),
    start_date: z
      .string()
      .min(1, "Required")
      .refine((d) => d >= DATA_MIN_DATE && d <= DATA_MAX_DATE, {
        message: `Must be within ${DATA_MIN_DATE} – ${DATA_MAX_DATE}`,
      }),
    end_date: z
      .string()
      .min(1, "Required")
      .refine((d) => d >= DATA_MIN_DATE && d <= DATA_MAX_DATE, {
        message: `Must be within ${DATA_MIN_DATE} – ${DATA_MAX_DATE}`,
      }),
    capital: z.number().positive("Must be > 0"),
    lot_size: z.number().int().positive(),
    strike_step: z.number().int().positive(),
    max_reentries: z.number().int().min(0).max(5),
    // Per-strategy exit rules (Wall Reversion + ORB each have their own).
    wall_stop_loss_pct: z.number().min(1).max(100),
    wall_trailing_sl_pct: z.number().min(1).max(100),
    wall_max_hold_min: z.number().int().min(5).max(375),
    wall_take_profit_pct: z.number().min(0).max(500),
    orb_stop_loss_pct: z.number().min(1).max(100),
    orb_trailing_sl_pct: z.number().min(1).max(100),
    orb_max_hold_min: z.number().int().min(5).max(375),
    orb_take_profit_pct: z.number().min(0).max(500),
    orb_max_reentries: z.number().int().min(0).max(5),
    // Short Straddle exit rules.
    straddle_entry_time: z.string().min(1),
    straddle_exit_time: z.string().min(1),
    straddle_stop_loss_pct: z.number().min(1).max(100),
    iv_drop_threshold: z.number().min(0).max(0.05),
    required_anomalies: z.number().int().min(1).max(10),
    iv_scan_depth: z.number().int().min(1).max(20),
    ema_period: z.number().int().min(2).max(200),
    cooldown_minutes: z.number().int().min(0).max(240),
    capital_deploy_pct: z.number().min(1).max(100),
    entry_time: z.string().min(1),
    orb_minutes: z.number().int().min(1).max(120),
    orb_cutoff_time: z.string().min(1),
    exit_time: z.string().min(1),
    expiry_selection: z.string().min(1),
  })
  .refine((v) => v.wall_enabled || v.orb_enabled || v.straddle_enabled, {
    message: "Enable at least one strategy",
    path: ["wall_enabled"],
  })
  .refine((v) => v.start_date <= v.end_date, {
    message: "Start date must be on or before end date",
    path: ["end_date"],
  });

export type ConfigFormValues = z.infer<typeof formSchema>;

const DEFAULTS: ConfigFormValues = {
  dataset: "nifty",
  wall_enabled: true,
  orb_enabled: true,
  straddle_enabled: false,
  start_date: "2024-06-03",
  end_date: "2024-07-03",
  capital: 1_000_000,
  lot_size: 65,
  strike_step: 50,
  max_reentries: 0,
  wall_stop_loss_pct: 25,
  wall_trailing_sl_pct: 15,
  wall_max_hold_min: 45,
  wall_take_profit_pct: 0,
  orb_stop_loss_pct: 25,
  orb_trailing_sl_pct: 15,
  orb_max_hold_min: 45,
  orb_take_profit_pct: 0,
  orb_max_reentries: 0,
  straddle_entry_time: "10:00",
  straddle_exit_time: "14:45",
  straddle_stop_loss_pct: 30,
  iv_drop_threshold: 0.001,
  required_anomalies: 3,
  iv_scan_depth: 10,
  ema_period: 20,
  cooldown_minutes: 30,
  capital_deploy_pct: 100,
  entry_time: "09:45",
  orb_minutes: 15,
  orb_cutoff_time: "13:30",
  exit_time: "15:15",
  expiry_selection: "nearest",
};

function deriveRunMode(wall: boolean, orb: boolean): RunMode {
  if (wall && orb) return "COMBINED";
  if (orb) return "ORB_ONLY";
  return "WALL_ONLY";
}

/**
 * Default end date for a freshly-picked start: one calendar month later,
 * clamped to the dataset's last available day. Returned as a YYYY-MM-DD string.
 */
function defaultEndDate(startISO: string): string {
  const [y, m, d] = startISO.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setMonth(date.getMonth() + 1);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const next = `${date.getFullYear()}-${mm}-${dd}`;
  return next > DATA_MAX_DATE ? DATA_MAX_DATE : next;
}

/**
 * Primary strategy family for `config.strategy_type`. This must be exactly one
 * of the backend's `StrategyType` enum values, so it cannot encode a multi-
 * strategy combination — the human-readable combined label for history is
 * derived separately on the backend from the per-strategy enable flags.
 */
function strategyLabel(values: ConfigFormValues, mode: RunMode): string {
  if (values.straddle_enabled && !values.wall_enabled && !values.orb_enabled) {
    return "Short Straddle";
  }
  return mode === "ORB_ONLY" ? "Opening Range Breakout" : "Wall Reversion";
}

/** Map form values → the engine StrategyConfig payload (shared by run & save). */
function valuesToConfig(values: ConfigFormValues): StrategyConfigInput {
  const run_mode = deriveRunMode(values.wall_enabled, values.orb_enabled);
  return {
    run_mode,
    strategy_type: strategyLabel(values, run_mode),
    wall_enabled: values.wall_enabled,
    orb_enabled: values.orb_enabled,
    straddle_enabled: values.straddle_enabled,
    entry_time: values.entry_time,
    exit_time: values.exit_time,
    expiry_selection: values.expiry_selection,
    orb_minutes: values.orb_minutes,
    orb_cutoff_time: values.orb_cutoff_time,
    iv_drop_threshold: values.iv_drop_threshold,
    required_anomalies: values.required_anomalies,
    capital: values.capital,
    lot_size: values.lot_size,
    strike_step: values.strike_step,
    max_reentries: values.max_reentries,
    // Per-strategy exit rules.
    wall_stop_loss_pct: values.wall_stop_loss_pct / 100,
    wall_trailing_sl_pct: values.wall_trailing_sl_pct / 100,
    wall_max_hold_bars: values.wall_max_hold_min,
    wall_take_profit_pct: values.wall_take_profit_pct / 100,
    orb_stop_loss_pct: values.orb_stop_loss_pct / 100,
    orb_trailing_sl_pct: values.orb_trailing_sl_pct / 100,
    orb_max_hold_bars: values.orb_max_hold_min,
    orb_take_profit_pct: values.orb_take_profit_pct / 100,
    orb_max_reentries: values.orb_max_reentries,
    straddle_entry_time: values.straddle_entry_time,
    straddle_exit_time: values.straddle_exit_time,
    straddle_stop_loss_pct: values.straddle_stop_loss_pct / 100,
    iv_scan_depth: values.iv_scan_depth,
    ema_period: values.ema_period,
    cooldown_minutes: values.cooldown_minutes,
    capital_deploy_pct: values.capital_deploy_pct / 100,
  };
}

interface ConfigPanelProps {
  datasets: string[];
  isRunning: boolean;
  onRun: (request: BacktestRequest) => void;
}

/** Small section heading used between form groups. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

/**
 * A section whose body collapses behind its heading. Used for "Exit Rules" so
 * the protective-stop parameters don't clutter the main form until expanded.
 */
function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center justify-between text-left"
      >
        <SectionLabel>{title}</SectionLabel>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && <div className="flex flex-col gap-3">{children}</div>}
    </div>
  );
}

/**
 * The four exit-rule sliders (stop loss, trailing stop, max hold, take profit),
 * rendered for a given strategy's set of field names. Used inside each strategy's
 * own "Exit Rules" section so Wall Reversion and ORB can be tuned independently.
 */
function ExitRulesFields({
  control,
  fields,
}: {
  control: Control<ConfigFormValues>;
  fields: {
    stopLoss: keyof ConfigFormValues;
    trailing: keyof ConfigFormValues;
    maxHold: keyof ConfigFormValues;
    takeProfit: keyof ConfigFormValues;
  };
}) {
  return (
    <>
      <Controller
        control={control}
        name={fields.stopLoss}
        render={({ field }) => (
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>Stop loss</Label>
              <span className="nums text-sm font-medium text-primary">
                {field.value as number}%
              </span>
            </div>
            <Slider
              min={5}
              max={50}
              step={1}
              value={field.value as number}
              onValueChange={(v) => field.onChange(Array.isArray(v) ? v[0] : v)}
            />
          </div>
        )}
      />

      <Controller
        control={control}
        name={fields.trailing}
        render={({ field }) => (
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>Trailing stop</Label>
              <span className="nums text-sm font-medium text-primary">
                {field.value as number}%
              </span>
            </div>
            <Slider
              min={5}
              max={50}
              step={1}
              value={field.value as number}
              onValueChange={(v) => field.onChange(Array.isArray(v) ? v[0] : v)}
            />
          </div>
        )}
      />

      <Controller
        control={control}
        name={fields.maxHold}
        render={({ field }) => (
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>Max hold</Label>
              <span className="nums text-sm font-medium text-primary">
                {(field.value as number) >= 375 ? "EOD" : `${field.value as number} min`}
              </span>
            </div>
            <Slider
              min={5}
              max={375}
              step={5}
              value={field.value as number}
              onValueChange={(v) => field.onChange(Array.isArray(v) ? v[0] : v)}
            />
            <p className="text-xs text-muted-foreground">
              Force-exit a leg after this long. Max = hold until square-off (EOD).
            </p>
          </div>
        )}
      />

      <Controller
        control={control}
        name={fields.takeProfit}
        render={({ field }) => (
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>Take profit</Label>
              <span className="nums text-sm font-medium text-primary">
                {(field.value as number) === 0 ? "Off" : `+${field.value as number}%`}
              </span>
            </div>
            <Slider
              min={0}
              max={200}
              step={5}
              value={field.value as number}
              onValueChange={(v) => field.onChange(Array.isArray(v) ? v[0] : v)}
            />
          </div>
        )}
      />
    </>
  );
}

// ── Risk profiles ─────────────────────────────────────────────────────────────
type RiskProfile = "custom" | "safe" | "neutral" | "risky";

const PROFILE_OPTIONS: { id: RiskProfile; label: string; description: string }[] = [
  { id: "custom", label: "Custom", description: "Tune every parameter yourself." },
  { id: "safe", label: "Safe", description: "Tuned to minimise drawdown — small size, tight stops, selective entries." },
  { id: "neutral", label: "Neutral", description: "Balanced risk and return for typical conditions." },
  { id: "risky", label: "Risky", description: "Maximises return and tolerates larger drawdowns — bigger size, wider stops, more entries." },
];

/**
 * Backtest-derived parameter sets for the three non-custom risk profiles.
 * Values are in form units (percent integers, minutes), so they slot straight
 * into the form fields. Profiles populate both the general trade parameters and
 * each strategy's tuning; the user can still override any field afterwards.
 *
 * Tuned from a COMBINED-mode sweep over Apr–Jun 2024 (61 trading days, includes
 * the 4-Jun election-day shock). Of six candidates the winners were:
 *   • safe    → lowest drawdown (−15% of capital), best Sharpe 3.36, +36% ROC
 *   • neutral → best profit factor 2.73, Sharpe 2.46, +369% ROC, −38% DD
 *   • risky   → highest ROC (+455%), Sharpe 2.32, −46% DD
 * Looser-stop / take-profit-off variants were tested and rejected — they earned
 * the same-or-less return with ~2.5× the drawdown. iv_scan_depth/ema_period and
 * orb_cutoff_time were held at engine defaults across the sweep.
 *
 * The Wall-selectivity knobs (required_anomalies, iv_drop_threshold) and the ORB
 * range (orb_minutes) were then set per spec: Safe 4 / 0.002 / 30m, Neutral
 * 3 / 0.001 / 15m, Risky 2 / 0.00075 / 10m (tighter selectivity & longer opening
 * range = safer; looser & shorter = riskier).
 */
const RISK_PROFILES: Record<
  Exclude<RiskProfile, "custom">,
  Partial<ConfigFormValues>
> = {
  safe: {
    wall_stop_loss_pct: 12,
    wall_trailing_sl_pct: 8,
    wall_max_hold_min: 25,
    wall_take_profit_pct: 35,
    orb_stop_loss_pct: 12,
    orb_trailing_sl_pct: 8,
    orb_max_hold_min: 25,
    orb_take_profit_pct: 35,
    iv_drop_threshold: 0.002,
    required_anomalies: 4,
    orb_minutes: 30,
    orb_cutoff_time: "13:30",
    iv_scan_depth: 10,
    ema_period: 20,
    cooldown_minutes: 60,
    capital_deploy_pct: 100,
  },
  neutral: {
    wall_stop_loss_pct: 25,
    wall_trailing_sl_pct: 15,
    wall_max_hold_min: 45,
    wall_take_profit_pct: 75,
    orb_stop_loss_pct: 25,
    orb_trailing_sl_pct: 15,
    orb_max_hold_min: 45,
    orb_take_profit_pct: 75,
    iv_drop_threshold: 0.001,
    required_anomalies: 3,
    orb_minutes: 15,
    orb_cutoff_time: "13:30",
    iv_scan_depth: 10,
    ema_period: 20,
    cooldown_minutes: 30,
    capital_deploy_pct: 100,
  },
  risky: {
    wall_stop_loss_pct: 30,
    wall_trailing_sl_pct: 18,
    wall_max_hold_min: 60,
    wall_take_profit_pct: 100,
    orb_stop_loss_pct: 30,
    orb_trailing_sl_pct: 18,
    orb_max_hold_min: 60,
    orb_take_profit_pct: 100,
    iv_drop_threshold: 0.00075,
    required_anomalies: 2,
    orb_minutes: 10,
    orb_cutoff_time: "13:30",
    iv_scan_depth: 10,
    ema_period: 20,
    cooldown_minutes: 30,
    capital_deploy_pct: 100,
  },
};

/** Fields a profile controls — editing any of these drops back to "Custom". */
const TUNABLE_FIELDS = new Set<string>(Object.keys(RISK_PROFILES.neutral));

export function ConfigPanel({ datasets, isRunning, onRun }: ConfigPanelProps) {
  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<ConfigFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { ...DEFAULTS, dataset: datasets[0] ?? DEFAULTS.dataset },
  });

  const wallEnabled = watch("wall_enabled");
  const orbEnabled = watch("orb_enabled");
  const straddleEnabled = watch("straddle_enabled");

  // Dynamic "Target Expiry" options: fetched from the backend for the chosen
  // dataset + date range. Debounced so dragging the date pickers doesn't spam
  // the API. Empty for single-file datasets (which only support "nearest").
  const dataset = watch("dataset");
  const startDate = watch("start_date");
  const endDate = watch("end_date");
  const [expiries, setExpiries] = useState<string[]>([]);
  // Once the user picks an end date by hand, stop auto-deriving it from the
  // start date (the "+1 month" rule only governs an untouched end date).
  const [endTouched, setEndTouched] = useState(false);

  useEffect(() => {
    if (!dataset) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchDatasetExpiries(dataset, startDate, endDate)
        .then((list) => {
          if (cancelled) return;
          setExpiries(list);
          // If the chosen expiry is no longer offered, fall back to "nearest".
          const current = getValues("expiry_selection");
          if (current !== "nearest" && !list.includes(current)) {
            setValue("expiry_selection", "nearest");
          }
        })
        .catch(() => {
          if (!cancelled) setExpiries([]);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [dataset, startDate, endDate, getValues, setValue]);

  const submit = (values: ConfigFormValues) => {
    const request: BacktestRequest = {
      dataset: values.dataset,
      start_date: values.start_date || null,
      end_date: values.end_date || null,
      config: valuesToConfig(values),
    };
    onRun(request);
  };

  // ── Risk profiles ─────────────────────────────────────────────────────────
  // The active profile is just a starting point: selecting Safe/Neutral/Risky
  // populates the form with that profile's tested values, after which the user
  // can still override any individual field — at which point the selector falls
  // back to "Custom" to make clear the values no longer match the named profile.
  const [riskProfile, setRiskProfile] = useState<RiskProfile>("custom");
  // Guards the auto-revert watcher from firing on our own programmatic writes.
  const applyingProfile = useRef(false);

  const applyProfile = (profile: RiskProfile) => {
    setRiskProfile(profile);
    if (profile === "custom") return;
    applyingProfile.current = true;
    for (const [key, value] of Object.entries(RISK_PROFILES[profile])) {
      setValue(key as keyof ConfigFormValues, value as never, {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
    // Release the guard after the synchronous setValue notifications settle.
    setTimeout(() => {
      applyingProfile.current = false;
    }, 0);
  };

  // When the user hand-edits any profile-controlled field, drop to "Custom".
  useEffect(() => {
    const sub = watch((_values, { name }) => {
      if (applyingProfile.current || !name || !TUNABLE_FIELDS.has(name)) return;
      setRiskProfile((prev) => (prev === "custom" ? prev : "custom"));
    });
    return () => sub.unsubscribe();
  }, [watch]);

  /** Reset every field back to defaults and clear the active profile. */
  const resetAll = () => {
    setEndTouched(false);
    setRiskProfile("custom");
    reset({ ...DEFAULTS, dataset: datasets[0] ?? DEFAULTS.dataset });
  };

  return (
    <Card className="glass-panel flex h-full flex-col gap-0 overflow-hidden p-0">
      <CardHeader className="border-b border-border px-5 py-4">
        <CardTitle className="font-heading text-base">Strategy Configuration</CardTitle>
        <CardDescription>Tune parameters, then run the simulation.</CardDescription>
      </CardHeader>

      <CardContent className="flex-1 overflow-y-auto px-5 py-4">
        <form
          id="config-form"
          onSubmit={handleSubmit(submit)}
          className="flex flex-col gap-5"
        >
          {/* ── Run ─────────────────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <SectionLabel>Run</SectionLabel>

            <div className="grid gap-1.5">
              <Label htmlFor="dataset">Dataset</Label>
              <Controller
                control={control}
                name="dataset"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="dataset" className="w-full">
                      <SelectValue placeholder="Select dataset" />
                    </SelectTrigger>
                    <SelectContent>
                      {(datasets.length ? datasets : [DEFAULTS.dataset]).map((d) => (
                        <SelectItem key={d} value={d}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="start_date">Start date</Label>
                <DatePicker
                  id="start_date"
                  value={startDate}
                  min={DATA_MIN_DATE}
                  max={DATA_MAX_DATE}
                  onChange={(d) => {
                    setValue("start_date", d, { shouldValidate: true, shouldDirty: true });
                    // Auto-advance end date to one month later while the user
                    // hasn't set it by hand. If they have, leave it alone — unless
                    // the new start would land after it, which would make the
                    // range invalid; then push the end forward to keep it valid.
                    if (!endTouched || d > getValues("end_date")) {
                      setValue("end_date", defaultEndDate(d), {
                        shouldValidate: true,
                        shouldDirty: true,
                      });
                    }
                  }}
                />
                {errors.start_date && (
                  <p className="text-xs text-destructive">{errors.start_date.message}</p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="end_date">End date</Label>
                <DatePicker
                  id="end_date"
                  value={endDate}
                  min={startDate || DATA_MIN_DATE}
                  max={DATA_MAX_DATE}
                  onChange={(d) => {
                    setEndTouched(true);
                    setValue("end_date", d, { shouldValidate: true, shouldDirty: true });
                  }}
                />
                {errors.end_date && (
                  <p className="text-xs text-destructive">{errors.end_date.message}</p>
                )}
              </div>
            </div>
          </div>

          <Separator />

          {/* ── Strategies (toggles) ────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <SectionLabel>Strategies</SectionLabel>

            <Controller
              control={control}
              name="wall_enabled"
              render={({ field }) => (
                <label className="flex cursor-pointer items-center justify-between rounded-lg border border-border bg-card/40 px-3 py-2.5">
                  <div>
                    <p className="text-sm font-medium">Wall Reversion</p>
                    <p className="text-xs text-muted-foreground">IV anomaly reversion</p>
                  </div>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </label>
              )}
            />
            <Controller
              control={control}
              name="orb_enabled"
              render={({ field }) => (
                <label className="flex cursor-pointer items-center justify-between rounded-lg border border-border bg-card/40 px-3 py-2.5">
                  <div>
                    <p className="text-sm font-medium">Opening Range Breakout</p>
                    <p className="text-xs text-muted-foreground">ORB with asymmetric sizing</p>
                  </div>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </label>
              )}
            />
            <Controller
              control={control}
              name="straddle_enabled"
              render={({ field }) => (
                <label className="flex cursor-pointer items-center justify-between rounded-lg border border-border bg-card/40 px-3 py-2.5">
                  <div>
                    <p className="text-sm font-medium">Short Straddle</p>
                    <p className="text-xs text-muted-foreground">Sell ATM call + put, breakeven-shift SL</p>
                  </div>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </label>
              )}
            />
            {errors.wall_enabled && (
              <p className="text-xs text-destructive">{errors.wall_enabled.message}</p>
            )}
          </div>

          <Separator />

          {/* ── Risk Profile ────────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <SectionLabel>Risk Profile</SectionLabel>

            <div className="flex items-center gap-1.5">
              <div className="grid flex-1 grid-cols-4 gap-1.5">
                {PROFILE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => applyProfile(opt.id)}
                    aria-pressed={riskProfile === opt.id}
                    className={cn(
                      "rounded-lg border px-2 py-2 text-xs font-medium transition-colors",
                      riskProfile === opt.id
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card/40 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={resetAll}
                title="Reset all parameters to defaults"
                aria-label="Reset all parameters to defaults"
              >
                <RotateCcw className="size-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {PROFILE_OPTIONS.find((o) => o.id === riskProfile)?.description}
            </p>
          </div>

          <Separator />

          {/* ── Capital & Risk ──────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <SectionLabel>Capital &amp; Risk</SectionLabel>

            <div className="grid gap-1.5">
              <Label htmlFor="capital">Capital (₹)</Label>
              <Input
                id="capital"
                type="number"
                step={50000}
                {...register("capital", { valueAsNumber: true })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="lot_size">Lot size</Label>
                <Input
                  id="lot_size"
                  type="number"
                  {...register("lot_size", { valueAsNumber: true })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="strike_step">Strike step</Label>
                <Input
                  id="strike_step"
                  type="number"
                  {...register("strike_step", { valueAsNumber: true })}
                />
              </div>
            </div>
          </div>

          {/* ── Wall Reversion params ───────────────────────────── */}
          {wallEnabled && (
            <>
              <Separator />
              <div className="flex flex-col gap-3">
                <SectionLabel>Wall Reversion</SectionLabel>

                <Controller
                  control={control}
                  name="iv_drop_threshold"
                  render={({ field }) => (
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between">
                        <Label>IV drop threshold</Label>
                        <span className="nums text-sm font-medium text-primary">
                          {field.value.toFixed(5)}
                        </span>
                      </div>
                      <Slider
                        min={0}
                        max={0.02}
                        step={0.00025}
                        value={field.value}
                        onValueChange={(v) =>
                          field.onChange(Array.isArray(v) ? v[0] : v)
                        }
                      />
                    </div>
                  )}
                />

                <Controller
                  control={control}
                  name="required_anomalies"
                  render={({ field }) => (
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between">
                        <Label>Required anomalies</Label>
                        <span className="nums text-sm font-medium text-primary">
                          {field.value}
                        </span>
                      </div>
                      <Slider
                        min={1}
                        max={10}
                        step={1}
                        value={field.value}
                        onValueChange={(v) =>
                          field.onChange(Array.isArray(v) ? v[0] : v)
                        }
                      />
                    </div>
                  )}
                />

                <div className="grid gap-1.5">
                  <Label htmlFor="entry_time">Scan start time</Label>
                  <Input id="entry_time" type="time" {...register("entry_time")} />
                </div>

                <CollapsibleSection title="Exit Rules">
                  <ExitRulesFields
                    control={control}
                    fields={{
                      stopLoss: "wall_stop_loss_pct",
                      trailing: "wall_trailing_sl_pct",
                      maxHold: "wall_max_hold_min",
                      takeProfit: "wall_take_profit_pct",
                    }}
                  />
                </CollapsibleSection>

                {/* Advanced tuning — hidden behind "More settings". */}
                <div className="rounded-lg border border-border bg-card/40 px-3 py-2.5">
                  <CollapsibleSection title="More settings">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1.5">
                        <Label htmlFor="iv_scan_depth">Strike range</Label>
                        <Input
                          id="iv_scan_depth"
                          type="number"
                          {...register("iv_scan_depth", { valueAsNumber: true })}
                        />
                        <p className="text-xs text-muted-foreground">IV scan depth (strikes/side)</p>
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="ema_period">EMA period</Label>
                        <Input
                          id="ema_period"
                          type="number"
                          {...register("ema_period", { valueAsNumber: true })}
                        />
                        <p className="text-xs text-muted-foreground">Minutes</p>
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="cooldown_minutes">Cooldown</Label>
                        <Input
                          id="cooldown_minutes"
                          type="number"
                          {...register("cooldown_minutes", { valueAsNumber: true })}
                        />
                        <p className="text-xs text-muted-foreground">Minutes between entries</p>
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="capital_deploy_pct">Capital-deploy %</Label>
                        <Input
                          id="capital_deploy_pct"
                          type="number"
                          {...register("capital_deploy_pct", { valueAsNumber: true })}
                        />
                        <p className="text-xs text-muted-foreground">Margin ceiling</p>
                      </div>
                    </div>
                  </CollapsibleSection>
                </div>
              </div>
            </>
          )}

          {/* ── ORB params ──────────────────────────────────────── */}
          {orbEnabled && (
            <>
              <Separator />
              <div className="flex flex-col gap-3">
                <SectionLabel>Opening Range Breakout</SectionLabel>

                <Controller
                  control={control}
                  name="orb_minutes"
                  render={({ field }) => (
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between">
                        <Label>Opening range</Label>
                        <span className="nums text-sm font-medium text-primary">
                          {field.value} min
                        </span>
                      </div>
                      <Slider
                        min={1}
                        max={60}
                        step={1}
                        value={field.value}
                        onValueChange={(v) =>
                          field.onChange(Array.isArray(v) ? v[0] : v)
                        }
                      />
                    </div>
                  )}
                />

                <div className="grid gap-1.5">
                  <Label htmlFor="orb_cutoff_time">Breakout cutoff</Label>
                  <Input id="orb_cutoff_time" type="time" {...register("orb_cutoff_time")} />
                </div>

                <CollapsibleSection title="Exit Rules">
                  <ExitRulesFields
                    control={control}
                    fields={{
                      stopLoss: "orb_stop_loss_pct",
                      trailing: "orb_trailing_sl_pct",
                      maxHold: "orb_max_hold_min",
                      takeProfit: "orb_take_profit_pct",
                    }}
                  />

                  <Controller
                    control={control}
                    name="orb_max_reentries"
                    render={({ field }) => (
                      <div className="grid gap-2">
                        <div className="flex items-center justify-between">
                          <Label>Dynamic re-entries</Label>
                          <span className="nums text-sm font-medium text-primary">
                            {field.value === 0 ? "Off" : field.value}
                          </span>
                        </div>
                        <Slider
                          min={0}
                          max={5}
                          step={1}
                          value={field.value}
                          onValueChange={(v) => field.onChange(Array.isArray(v) ? v[0] : v)}
                        />
                        <p className="text-xs text-muted-foreground">
                          After a stop-out, re-arm on the opening range and re-enter on
                          the next fresh breakout — recomputing the ATM strike from the
                          spot price at that moment (a brand-new contract, not the old
                          one). Limited to this many re-entries per day, before the
                          breakout cutoff.
                        </p>
                      </div>
                    )}
                  />
                </CollapsibleSection>
              </div>
            </>
          )}

          {/* ── Short Straddle params ───────────────────────────── */}
          {straddleEnabled && (
            <>
              <Separator />
              <div className="flex flex-col gap-3">
                <SectionLabel>Short Straddle</SectionLabel>

                <CollapsibleSection title="Exit Rules" defaultOpen>
                  <Controller
                    control={control}
                    name="straddle_stop_loss_pct"
                    render={({ field }) => (
                      <div className="grid gap-2">
                        <div className="flex items-center justify-between">
                          <Label>Stop loss (per leg)</Label>
                          <span className="nums text-sm font-medium text-primary">
                            {field.value}%
                          </span>
                        </div>
                        <Slider
                          min={5}
                          max={80}
                          step={1}
                          value={field.value}
                          onValueChange={(v) => field.onChange(Array.isArray(v) ? v[0] : v)}
                        />
                      </div>
                    )}
                  />

                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="straddle_entry_time">Entry time</Label>
                      <Input
                        id="straddle_entry_time"
                        type="time"
                        {...register("straddle_entry_time")}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="straddle_exit_time">Square-off</Label>
                      <Input
                        id="straddle_exit_time"
                        type="time"
                        {...register("straddle_exit_time")}
                      />
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Sells 1 ATM call + 1 ATM put at the entry time and squares off at
                    the exit time. Each leg stops out at the stop-loss above; when one
                    leg is stopped, the surviving leg&apos;s stop moves to its cost
                    price (breakeven).
                  </p>
                </CollapsibleSection>
              </div>
            </>
          )}

          <Separator />

          {/* ── Session ─────────────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <SectionLabel>Session</SectionLabel>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="exit_time">Square-off</Label>
                <Input id="exit_time" type="time" {...register("exit_time")} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="expiry_selection">Target expiry</Label>
                <Controller
                  control={control}
                  name="expiry_selection"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="expiry_selection" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="nearest">Nearest (auto-roll)</SelectItem>
                        {expiries.map((e) => (
                          <SelectItem key={e} value={e}>
                            {e}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>
          </div>
        </form>
      </CardContent>

      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        <Button
          type="submit"
          form="config-form"
          size="lg"
          disabled={isRunning}
          className="flex-1"
        >
          <Play className="size-4" />
          {isRunning ? "Running…" : "Run Backtest"}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="outline"
          disabled={isRunning}
          onClick={resetAll}
          title="Reset to defaults"
        >
          <RotateCcw className="size-4" />
        </Button>
      </div>
    </Card>
  );
}
