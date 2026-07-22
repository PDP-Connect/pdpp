// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* IIFE-WRAPPED */
(() => {
  /* PDPP Explorer — shared primitives + format helpers
   *
   * Tiny, view-agnostic building blocks. Exported on window so the
   * babel-split view files can pick them up.
   */

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
    return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short" });
  }

  function fmtClock(iso) {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short" });
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
    return d.toLocaleDateString("en-US", { day: "numeric", month: "short", weekday: "long" });
  }
  function fmtCurrency(n) {
    const sign = n < 0 ? "−" : n > 0 ? "+" : "";
    const abs = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
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
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return "·";
    }
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function Avatar({ label, size = 28 }) {
    return (
      <span
        className="exp-conv__avatar"
        style={{ borderRadius: Math.round(size * 0.22), fontSize: size * 0.4, height: size, width: size }}
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
    for (let i = days - 1; i >= 0; i--) {
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
          cy={height - ((values[values.length - 1] - min) / range) * height}
          fill={color}
          r="2"
        />
      </svg>
    );
  }

  // ─── Capability icons (glyphs, not icons-as-an-iconset) ────────────────

  const CAP_GLYPH = {
    calendar: "▤",
    chart: "↟",
    conversation: "❝",
    gallery: "▥",
    ledger: "$",
    map: "◎",
    reader: "¶",
    table: "▦",
    timeline: "│",
  };
  const CAP_LABEL = {
    calendar: "Calendar",
    chart: "Chart",
    conversation: "Conversation",
    gallery: "Gallery",
    ledger: "Ledger",
    map: "Map",
    reader: "Reader",
    table: "Table",
    timeline: "Timeline",
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
    return (fs.find((f) => f.type === "timestamp") ?? fs.find((f) => /date|ts|at_$|^at$|night_of/i.test(f.name)))?.name;
  }
  function getRecordTime(stream, record) {
    const f = getTimeField(stream);
    return f ? record[f] : null;
  }

  /** Returns the field labelled as "title" for the record, with sensible fallbacks. */
  function getRecordTitle(stream, record) {
    return (
      record.subject ?? record.title ?? record.merchant ?? record.text ?? record.caption ?? record.snippet ?? record.id
    );
  }

  window.PDPPPrim = {
    Avatar,
    CAP_GLYPH,
    CAP_LABEL,
    fmtClock,
    fmtCurrency,
    fmtDate,
    fmtDay,
    fmtDistance,
    fmtDuration,
    fmtRelative,
    getRecordTime,
    getRecordTitle,
    getTimeField,
    Heatmap,
    initials,
    NOW,
    Sparkline,
    useGlobalKey,
  };
})();
