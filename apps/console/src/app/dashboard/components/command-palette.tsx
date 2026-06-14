"use client";

import { IcButton, IcInput } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { type DashboardMode, listDashboardCommands } from "../lib/actions.ts";

interface CommandPaletteContextValue {
  close: () => void;
  isOpen: boolean;
  open: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

function useCommandPalette(): CommandPaletteContextValue {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error("Command palette components must be rendered inside <CommandPaletteProvider>");
  }
  return context;
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);

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
  };

  return <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>;
}

export function CommandPaletteTrigger() {
  const palette = useCommandPalette();
  return (
    <IcButton
      aria-label="Open command palette"
      className="gap-3 font-normal text-muted-foreground"
      onClick={palette.open}
      size="sm"
      type="button"
      variant="ghost"
    >
      <span>Jump to…</span>
      <kbd className="pdpp-caption rounded border border-border bg-muted/50 px-1 py-px font-mono text-foreground/80">
        ⌘K
      </kbd>
    </IcButton>
  );
}

export function CommandPalette({
  basePath = "/dashboard",
  mode = "live",
}: {
  basePath?: string;
  mode?: DashboardMode;
} = {}) {
  const router = useRouter();
  const palette = useCommandPalette();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const allCommands = listDashboardCommands({ basePath, mode });
  const navCommands = allCommands.filter((c) => c.section === "Navigate");
  const actionCommands = allCommands.filter((c) => c.section === "Quick action");

  useEffect(() => {
    if (palette.isOpen) {
      setQuery("");
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [palette.isOpen]);

  if (!palette.isOpen) {
    return null;
  }

  function submit(e: { preventDefault: () => void }) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    palette.close();
    router.push(`${basePath}/search?q=${encodeURIComponent(trimmed)}&jump=1`);
  }

  function navigate(href: string) {
    palette.close();
    router.push(href);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24 backdrop-blur-sm">
      <button
        aria-label="Close command palette"
        className="absolute inset-0 cursor-default"
        onClick={palette.close}
        type="button"
      />
      <div
        aria-label="Jump to artifact"
        aria-modal="true"
        className="relative mx-4 w-full max-w-lg rounded-lg border border-border/80 bg-background shadow-2xl"
        role="dialog"
      >
        <form className="p-3" onSubmit={submit}>
          <IcInput
            className="h-10 py-2 font-mono"
            data-testid="command-palette-input"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="trace_id, grant_id, run_id, or free text…"
            ref={inputRef}
            type="text"
            value={query}
          />
          <div className="mt-3 flex flex-wrap gap-1.5 text-muted-foreground">
            {navCommands.map((cmd) => (
              <IcButton key={cmd.id} onClick={() => navigate(cmd.href)} size="sm" type="button" variant="ghost">
                {cmd.title}
              </IcButton>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5 text-muted-foreground">
            {actionCommands.map((cmd) => (
              <IcButton key={cmd.id} onClick={() => navigate(cmd.href)} size="sm" type="button" variant="default">
                {cmd.title}
              </IcButton>
            ))}
          </div>
          <div className="pdpp-caption mt-3 text-muted-foreground/70">⏎ search · ⎋ close · ⌘/ctrl+k toggle</div>
        </form>
      </div>
    </div>
  );
}
