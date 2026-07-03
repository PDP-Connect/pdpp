"use client";

/**
 * Command palette — the SINGLE unified ⌘K/Jump surface, shared by the operator
 * console (`apps/console`, `mode="live"`) and the public sandbox (`apps/site`,
 * `mode="mock-owner"`). There is one implementation of this component; the
 * console re-exports it verbatim.
 *
 * One provider owns the open state and the ONE ⌘K/Ctrl+K listener, and exposes
 * `toggle` so a shell "Jump" button and the shortcut open the same palette
 * without a second listener double-firing.
 *
 * The modal is built on the base-ui `Dialog` skin (`../ui/dialog`), so
 * focus-trap, scroll-lock, ARIA, autofocus (`initialFocus`), Escape, and — the
 * bug the Jump audit flagged — first-outside-click dismissal are owned by the
 * primitive rather than a hand-rolled backdrop. The list filters live over the
 * shared registry (`matchDashboardCommands`); ↑/↓ move the highlight and Enter
 * activates the highlighted row. Free-text record search is an explicit,
 * selectable last row — never the silent default Enter action that used to
 * eject the owner into the search route.
 */

import { useRouter } from "next/navigation";
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Dialog, DialogBackdrop, DialogPopup, DialogPortal } from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";
import { cn } from "../ui/utils.ts";
import {
  type DashboardCommand,
  type DashboardMode,
  type DashboardSegments,
  matchDashboardCommands,
} from "./command-registry.ts";

interface CommandPaletteContextValue {
  close: () => void;
  isOpen: boolean;
  open: () => void;
  toggle: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error("Command palette components must be rendered inside <CommandPaletteProvider>");
  }
  return context;
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);

  // The ONE ⌘K/Ctrl+K listener. Shells must NOT register their own — two
  // listeners flip the state twice per keypress (net no-op, never focused).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value: CommandPaletteContextValue = {
    close: () => setOpen(false),
    isOpen,
    open: () => setOpen(true),
    toggle: () => setOpen((o) => !o),
  };

  return <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>;
}

export function CommandPaletteTrigger() {
  const palette = useCommandPalette();
  return (
    <button
      aria-label="Open command palette"
      className="pdpp-caption inline-flex items-center gap-3 rounded-md border border-border px-2.5 py-1.5 font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      onClick={palette.open}
      type="button"
    >
      <span>Jump to…</span>
      <kbd className="rounded border border-border bg-muted/50 px-1 py-px font-mono text-foreground/80">⌘K</kbd>
    </button>
  );
}

/**
 * A palette row: either a registry command, or the explicit free-text search
 * fallback (only offered when the owner has typed something).
 */
type PaletteRow = { kind: "command"; command: DashboardCommand } | { kind: "search"; query: string };

function buildRows(query: string, commands: DashboardCommand[]): PaletteRow[] {
  const rows: PaletteRow[] = commands.map((command) => ({ kind: "command", command }));
  const trimmed = query.trim();
  if (trimmed) {
    // Explicit, selectable fallback — NOT the default Enter action.
    rows.push({ kind: "search", query: trimmed });
  }
  return rows;
}

export function CommandPalette({
  // Clean owner-console default: root base path, live mode. Sandbox callers
  // pass `basePath="/sandbox"` + `segments` explicitly.
  basePath = "",
  mode = "live",
  segments,
}: {
  basePath?: string;
  mode?: DashboardMode;
  segments?: DashboardSegments;
} = {}) {
  const router = useRouter();
  const palette = useCommandPalette();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commands = useMemo(
    () => matchDashboardCommands(query, { basePath, mode, segments }),
    [query, basePath, mode, segments]
  );
  const rows = useMemo(() => buildRows(query, commands), [query, commands]);

  // Reset query + highlight each open. Autofocus is owned by the dialog
  // primitive (initialFocus below), so no microtask focus hack is needed.
  useEffect(() => {
    if (palette.isOpen) {
      setQuery("");
      setHighlight(0);
    }
  }, [palette.isOpen]);

  // Keep the highlight in range as the filtered list shrinks/grows.
  useEffect(() => {
    setHighlight((h) => (rows.length === 0 ? 0 : Math.min(h, rows.length - 1)));
  }, [rows.length]);

  function activate(row: PaletteRow) {
    palette.close();
    if (row.kind === "search") {
      router.push(`${basePath}/explore?q=${encodeURIComponent(row.query)}`);
      return;
    }
    router.push(row.command.href);
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (rows.length === 0 ? 0 : (h + 1) % rows.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (rows.length === 0 ? 0 : (h - 1 + rows.length) % rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[highlight];
      if (row) {
        activate(row);
      }
    }
  }

  const navRows = rows.filter((r) => r.kind === "command" && r.command.section === "Navigate");
  const actionRows = rows.filter((r) => r.kind === "command" && r.command.section === "Quick action");
  const searchRow = rows.find((r) => r.kind === "search");

  return (
    <Dialog
      modal
      onOpenChange={(next: boolean) => {
        if (!next) {
          palette.close();
        }
      }}
      open={palette.isOpen}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup
          aria-label="Jump to artifact"
          className="top-24 left-1/2 mx-auto w-[calc(100%-2rem)] max-w-lg translate-x-[-50%] translate-y-0 gap-3 p-3"
          // Autofocus the input deterministically via the primitive.
          initialFocus={inputRef}
        >
          <Input
            aria-label="Search commands"
            className="h-10 py-2 font-mono"
            data-testid="command-palette-input"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search commands, or type to search records…"
            ref={inputRef}
            type="text"
            value={query}
          />

          <PaletteList
            actionRows={actionRows}
            highlight={highlight}
            navRows={navRows}
            onActivate={activate}
            onHighlight={setHighlight}
            rows={rows}
            searchRow={searchRow}
          />

          <div className="pdpp-caption text-muted-foreground/70">↑↓ move · ⏎ open · ⎋ close · ⌘/ctrl+k toggle</div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

function PaletteList({
  rows,
  navRows,
  actionRows,
  searchRow,
  highlight,
  onHighlight,
  onActivate,
}: {
  actionRows: PaletteRow[];
  highlight: number;
  navRows: PaletteRow[];
  onActivate: (row: PaletteRow) => void;
  onHighlight: (index: number) => void;
  rows: PaletteRow[];
  searchRow: PaletteRow | undefined;
}) {
  if (rows.length === 0) {
    return <div className="pdpp-caption px-1 text-muted-foreground/70">No matching commands.</div>;
  }
  // Index in the flat `rows` array drives the highlight so keyboard and pointer
  // selection agree.
  const indexOf = (row: PaletteRow) => rows.indexOf(row);
  return (
    <div className="flex flex-col gap-3">
      {navRows.length > 0 ? (
        <PaletteGroup
          heading="Navigate"
          highlight={highlight}
          indexOf={indexOf}
          onActivate={onActivate}
          onHighlight={onHighlight}
          rows={navRows}
        />
      ) : null}
      {actionRows.length > 0 ? (
        <PaletteGroup
          heading="Quick action"
          highlight={highlight}
          indexOf={indexOf}
          onActivate={onActivate}
          onHighlight={onHighlight}
          rows={actionRows}
        />
      ) : null}
      {searchRow ? (
        <PaletteGroup
          heading="Search"
          highlight={highlight}
          indexOf={indexOf}
          onActivate={onActivate}
          onHighlight={onHighlight}
          rows={[searchRow]}
        />
      ) : null}
    </div>
  );
}

function PaletteGroup({
  heading,
  rows,
  highlight,
  indexOf,
  onHighlight,
  onActivate,
}: {
  heading: string;
  highlight: number;
  indexOf: (row: PaletteRow) => number;
  onActivate: (row: PaletteRow) => void;
  onHighlight: (index: number) => void;
  rows: PaletteRow[];
}) {
  return (
    <div>
      <div className="pdpp-eyebrow mb-1 px-1 text-muted-foreground">{heading}</div>
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const index = indexOf(row);
          const active = index === highlight;
          const key = row.kind === "search" ? `search:${row.query}` : row.command.id;
          const label = row.kind === "search" ? `Search records for “${row.query}” →` : row.command.title;
          const description = row.kind === "search" ? "Open Explore with this query" : row.command.description;
          return (
            <li key={key}>
              <button
                className={cn(
                  "flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left transition-colors",
                  active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
                data-active={active ? "true" : undefined}
                data-testid={row.kind === "search" ? "command-palette-search-row" : `command-${row.command.id}`}
                onClick={() => onActivate(row)}
                onMouseMove={() => onHighlight(index)}
                type="button"
              >
                <span className="pdpp-body">{label}</span>
                <span className="pdpp-caption text-muted-foreground/70">{description}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
