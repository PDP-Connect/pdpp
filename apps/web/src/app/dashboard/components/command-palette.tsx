'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const SHORTCUTS = [
  { label: 'Overview', href: '/dashboard' },
  { label: 'Search', href: '/dashboard/search' },
  { label: 'Traces', href: '/dashboard/traces' },
  { label: 'Grants', href: '/dashboard/grants' },
  { label: 'Runs', href: '/dashboard/runs' },
  { label: 'Records', href: '/dashboard/records' },
];

let openRef: { open: () => void } = { open: () => {} };

export function CommandPaletteTrigger() {
  return (
    <Button
      type="button"
      onClick={() => openRef.open()}
      variant="outline"
      size="sm"
      aria-label="Open command palette"
      className="text-muted-foreground gap-3 font-normal"
    >
      <span>Jump to…</span>
      <kbd className="pdpp-caption border-border bg-muted/50 rounded border px-1 py-px font-mono text-foreground/80">
        ⌘K
      </kbd>
    </Button>
  );
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    openRef = { open: () => setOpen(true) };
    return () => {
      openRef = { open: () => {} };
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  function submit(e: { preventDefault: () => void }) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    setOpen(false);
    router.push(`/dashboard/search?q=${encodeURIComponent(trimmed)}&jump=1`);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Jump to artifact"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-background border-border/80 mx-4 w-full max-w-lg rounded-lg border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={submit} className="p-3">
          <Input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="trace_id, grant_id, run_id, or free text…"
            className="h-10 py-2 font-mono"
            data-testid="command-palette-input"
          />
          <div className="text-muted-foreground mt-3 flex flex-wrap gap-1.5">
            {SHORTCUTS.map((s) => (
              <Button
                key={s.href}
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push(s.href);
                }}
                variant="outline"
                size="xs"
              >
                {s.label}
              </Button>
            ))}
          </div>
          <div className="pdpp-caption text-muted-foreground/70 mt-3">
            ⏎ search · ⎋ close · ⌘/ctrl+k toggle
          </div>
        </form>
      </div>
    </div>
  );
}
