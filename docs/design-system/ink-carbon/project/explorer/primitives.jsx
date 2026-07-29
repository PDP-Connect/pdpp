// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* IIFE-WRAPPED */
(() => {
  /* PDPP Explorer — shared primitives + format helpers
   *
   * Tiny, view-agnostic building blocks. Exported on window so the
   * babel-split view files can pick them up.
   */

  // biome-ignore lint/correctness/noUndeclaredVariables: this standalone design artifact deliberately uses dynamic preview behavior.
  // biome-ignore lint/correctness/noUnusedVariables: this standalone design artifact deliberately uses dynamic preview behavior.
  const { useState, useEffect, useMemo, useRef, useCallback } = React;

  // ─── Format helpers ───────────────────────────────────────────────────

  const NOW = window.PDPP_DATA?.now ?? Date.now();

  function fmtRelative(iso) {
    const t = new Date(iso).getTime();
    const d = NOW - t;
    if (Math.abs(d) < 60_000) {
      return d < 0 ? "in <1m" : "just now";
    }
    if (Math.abs(d) < 3_600_000) {
      const m = Math.round(Math.abs(d) / 60_000);
      return d < 0 ? `in ${m}m` : `${m}m ago`;
    }
    if (Math.abs(d) < 86_400_000) {
      const h = Math.round(Math.abs(d) / 3_600_000);
      return d < 0 ? `in ${h}h` : `${h}h ago`;
    }
    const days = Math.round(Math.abs(d) / 86_400_000);
    if (days < 30) {
      return d < 0 ? `in ${days}d` : `${days}d ago`;
    }
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function fmtClock(iso) {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function fmtDay(iso) {
    const d = new Date(iso);
    const today = new Date(NOW);
    const sameDay = (a, b) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (sameDay(d, today)) {
      return "Today";
    }
    const y = new Date(NOW - 86_400_000);
    if (sameDay(d, y)) {
      return "Yesterday";
    }
    return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  }
  function fmtCurrency(n) {
    // biome-ignore lint/style/noNestedTernary: this standalone design artifact deliberately uses dynamic preview behavior.
    const sign = n < 0 ? "−" : n > 0 ? "+" : "";
    const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${sign}$${abs}`;
  }
  function fmtDuration(seconds) {
    const m = Math.round(seconds / 60);
    if (m < 60) {
      return `${m}m`;
    }
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
  }
  function fmtDistance(meters) {
    const mi = meters / 1609.34;
    return `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  }

  // ─── Initials avatar ──────────────────────────────────────────────────

  function initials(label) {
    if (!label) {
      return "·";
    }
    const cleaned = label.replace(/<[^>]+>/g, "").trim();
    // biome-ignore lint/performance/useTopLevelRegex: this standalone design artifact deliberately uses dynamic preview behavior.
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return "·";
    }
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts.at(-1)[0]).toUpperCase();
  }

  function Avatar({ label, size = 28 }) {
    return (
      <span
        className="exp-conv__avatar"
        style={{ width: size, height: size, fontSize: size * 0.4, borderRadius: Math.round(size * 0.22) }}
      >
        {initials(label)}
      </span>
    );
  }

  // ─── Heatmap (GitHub-style; weeks across, days down) ──────────────────

  function Heatmap({ values, days = 84, color = "var(--foreground)" }) {
    // values: array of {date: iso, count: number} keyed by yyyy-mm-dd
    const map = new Map();
    for (const v of values || []) {
      const key = v.date.slice(0, 10);
      map.set(key, (map.get(key) ?? 0) + (v.count ?? 1));
    }
    const max = Math.max(1, ...map.values());

    const cells = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(NOW - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      const v = map.get(key) ?? 0;
      const intensity = v === 0 ? 0 : Math.min(1, 0.18 + 0.82 * (v / max));
      cells.push(
        <span
          className="exp-heatmap__cell"
          key={key}
          style={{
            background:
              v === 0 ? "var(--muted)" : `color-mix(in oklab, ${color} ${Math.round(intensity * 100)}%, transparent)`,
          }}
          title={`${key} · ${v}`}
        />
      );
    }
    return <div className="exp-heatmap">{cells}</div>;
  }

  // ─── Tiny sparkline ────────────────────────────────────────────────────

  function Sparkline({ values, width = 120, height = 28, color = "var(--foreground)" }) {
    if (!values?.length) {
      return null;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const step = width / (values.length - 1 || 1);
    const points = values
      .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
      .join(" ");
    return (
      // biome-ignore lint/a11y/noSvgWithoutTitle: this standalone design artifact deliberately uses dynamic preview behavior.
      <svg height={height} style={{ display: "block" }} width={width}>
        <polyline
          fill="none"
          points={points}
          stroke={color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
        <circle
          cx={(values.length - 1) * step}
          cy={height - ((values.at(-1) - min) / range) * height}
          fill={color}
          r="2"
        />
      </svg>
    );
  }

  // ─── Capability icons (glyphs, not icons-as-an-iconset) ────────────────

  const CAP_GLYPH = {
    table: "▦",
    timeline: "│",
    conversation: "❝",
    ledger: "$",
    gallery: "▥",
    map: "◎",
    calendar: "▤",
    chart: "↟",
    reader: "¶",
  };
  const CAP_LABEL = {
    table: "Table",
    timeline: "Timeline",
    conversation: "Conversation",
    ledger: "Ledger",
    gallery: "Gallery",
    map: "Map",
    calendar: "Calendar",
    chart: "Chart",
    reader: "Reader",
  };

  // ─── Useful: useKeyboard for cmd-k ─────────────────────────────────────

  function useGlobalKey(key, modifiers, handler) {
    useEffect(() => {
      function onKey(e) {
        const meta = modifiers.includes("meta") ? e.metaKey || e.ctrlKey : true;
        if (e.key.toLowerCase() === key.toLowerCase() && meta) {
          e.preventDefault();
          handler(e);
        }
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [key, handler, modifiers]);
  }

  // ─── Stream-record utilities ───────────────────────────────────────────

  /** Find the timestamp field in a stream's records by checking the schema. */
  function getTimeField(stream) {
    const fs = stream.schema?.fields ?? [];
    // biome-ignore lint/performance/useTopLevelRegex: this standalone design artifact deliberately uses dynamic preview behavior.
    return (fs.find((f) => f.type === "timestamp") ?? fs.find((f) => /date|ts|at_$|^at$|night_of/i.test(f.name)))?.name;
  }
  function getRecordTime(stream, record) {
    const f = getTimeField(stream);
    return f ? record[f] : null;
  }

  /** Returns the field labelled as "title" for the record, with sensible fallbacks. */
  function getRecordTitle(_stream, record) {
    return (
      record.subject ?? record.title ?? record.merchant ?? record.text ?? record.caption ?? record.snippet ?? record.id
    );
  }

  window.PDPPPrim = {
    fmtRelative,
    fmtClock,
    fmtDate,
    fmtDay,
    fmtCurrency,
    fmtDuration,
    fmtDistance,
    Avatar,
    Heatmap,
    Sparkline,
    CAP_GLYPH,
    CAP_LABEL,
    useGlobalKey,
    getTimeField,
    getRecordTime,
    getRecordTitle,
    initials,
    NOW,
  };
})();
