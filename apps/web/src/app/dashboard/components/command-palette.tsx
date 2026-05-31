"use client";

import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

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

function buildShortcuts({ basePath, overviewHref }: { basePath: string; overviewHref: string }) {
  const shortcuts = [
    { label: "Overview", href: overviewHref },
    { label: "Jump", href: `${basePath}/search` },
    { label: "Explore", href: `${basePath}/explore` },
    { label: "Traces", href: `${basePath}/traces` },
    { label: "Grants", href: `${basePath}/grants` },
    { label: "Runs", href: `${basePath}/runs` },
  ];
  if (basePath === "/dashboard") {
    shortcuts.push({ label: "Connections", href: `${basePath}/records` });
    shortcuts.push({ label: "Device exporters", href: `${basePath}/device-exporters` });
  }
  return shortcuts;
}

export function CommandPaletteTrigger() {
  const palette = useCommandPalette();
  return (
    <Button
      aria-label="Open command palette"
      className="gap-3 font-normal text-muted-foreground"
      onClick={palette.open}
      size="sm"
      type="button"
      variant="outline"
    >
      <span>Jump to…</span>
      <kbd className="pdpp-caption rounded border border-border bg-muted/50 px-1 py-px font-mono text-foreground/80">
        ⌘K
      </kbd>
    </Button>
  );
}

export function CommandPalette({
  basePath = "/dashboard",
  overviewHref = basePath,
}: {
  basePath?: string;
  overviewHref?: string;
} = {}) {
  const router = useRouter();
  const palette = useCommandPalette();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shortcuts = buildShortcuts({ basePath, overviewHref });

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
          <Input
            className="h-10 py-2 font-mono"
            data-testid="command-palette-input"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="trace_id, grant_id, run_id, or free text…"
            ref={inputRef}
            type="text"
            value={query}
          />
          <div className="mt-3 flex flex-wrap gap-1.5 text-muted-foreground">
            {shortcuts.map((s) => (
              <Button
                key={s.href}
                onClick={() => {
                  palette.close();
                  router.push(s.href);
                }}
                size="xs"
                type="button"
                variant="outline"
              >
                {s.label}
              </Button>
            ))}
          </div>
          <div className="pdpp-caption mt-3 text-muted-foreground/70">⏎ search · ⎋ close · ⌘/ctrl+k toggle</div>
        </form>
      </div>
    </div>
  );
}
