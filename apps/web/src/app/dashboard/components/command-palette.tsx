'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const SHORTCUTS = [
  { label: 'Overview', href: '/dashboard' },
  { label: 'Traces', href: '/dashboard/traces' },
  { label: 'Grants', href: '/dashboard/grants' },
  { label: 'Runs', href: '/dashboard/runs' },
  { label: 'Records', href: '/dashboard/records' },
  { label: 'Search', href: '/dashboard/search' },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      role="dialog"
      aria-modal="true"
      aria-label="Jump to artifact"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-background border-border mx-4 w-full max-w-lg rounded border shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={submit} className="p-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="trace_id, grant_id, run_id, or text…"
            className="border-border bg-background w-full rounded border px-3 py-2 font-mono text-sm"
            data-testid="command-palette-input"
          />
          <div className="text-muted-foreground mt-2 flex flex-wrap gap-2 text-[11px]">
            {SHORTCUTS.map((s) => (
              <button
                key={s.href}
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push(s.href);
                }}
                className="border-border hover:bg-muted/50 rounded border px-2 py-1"
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="text-muted-foreground mt-2 text-[10px]">
            press ⏎ to search · ⎋ to close · ⌘/ctrl+k to toggle
          </div>
        </form>
      </div>
    </div>
  );
}
