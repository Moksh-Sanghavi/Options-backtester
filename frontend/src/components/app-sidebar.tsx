/**
 * AppSidebar — slim icon navigation rail for the terminal shell.
 *
 * Purely presentational (single-page app for now); the active item is the
 * dashboard. Hidden on small screens where the layout stacks vertically.
 */
import {
  LineChart,
  Database,
  History,
  LayoutDashboard,
  Settings,
} from "lucide-react";

import { cn } from "@/lib/utils";

interface NavItem {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { icon: LayoutDashboard, label: "Dashboard", active: true },

];

export function AppSidebar() {
  return (
    <aside className="hidden md:flex w-16 shrink-0 flex-col items-center gap-2 border-r border-border bg-sidebar/60 py-4 backdrop-blur-xl">
      <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/30">
        <LineChart className="size-5" />
      </div>

      <nav className="flex flex-1 flex-col items-center gap-1.5">
        {NAV_ITEMS.map(({ icon: Icon, label, active }) => (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex size-10 items-center justify-center rounded-xl transition-colors",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {active && (
              <span className="absolute left-0 h-5 w-0.5 -translate-x-2 rounded-full bg-primary" />
            )}
            <Icon className="size-5" />
          </button>
        ))}
      </nav>
    </aside>
  );
}
