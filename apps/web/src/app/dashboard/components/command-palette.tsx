"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

const SHORTCUTS = [
  { label: "Overview", href: "/dashboard" },
  { label: "Search", href: "/dashboard/search" },
  { label: "Traces", href: "/dashboard/traces" },
  { label: "Grants", href: "/dashboard/grants" },
  { label: "Runs", href: "/dashboard/runs" },
  { label: "Records", href: "/dashboard/records" },
];

function noopOpen(): void {
  // Placeholder until <CommandPalette /> mounts and installs the real opener.
}
let openRef: { open: () => void } = { open: noopOpen };

export function CommandPaletteTrigger() {
  return (
    <Button
      aria-label="Open command palette"
      className="gap-3 font-normal text-muted-foreground"
      onClick={() => openRef.open()}
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

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    openRef = { open: () => setOpen(true) };
    return () => {
      openRef = { open: noopOpen };
    };
  }, []);

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

  useEffect(() => {
    if (open) {
      setQuery("");
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) {
    return null;
  }

  function submit(e: { preventDefault: () => void }) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    setOpen(false);
    router.push(`/dashboard/search?q=${encodeURIComponent(trimmed)}&jump=1`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24 backdrop-blur-sm">
      <button
        aria-label="Close command palette"
        className="absolute inset-0 cursor-default"
        onClick={() => setOpen(false)}
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
            {SHORTCUTS.map((s) => (
              <Button
                key={s.href}
                onClick={() => {
                  setOpen(false);
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
