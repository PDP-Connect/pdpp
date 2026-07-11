/* PDPP Explorer — Discoverables (Immich / Apple Photos / Spotify Wrapped / Strava)
 *
 * These render at the top of the feed when no filters are active, and
 * surface delightful, schema-driven navigation that works for ANY
 * connector — not just the bundled ones.
 *
 * Each component is purely a function of typed schema fields:
 *   - DayStory     — per-stream counts + numeric aggregates for "today"
 *   - EntityRails  — person / merchant / channel rails (Immich Faces, generalized)
 *   - ActivityStrip — 30-day density heatmap across granted streams (Strava)
 *   - findMemories — records from exactly N years/months ago (Apple Photos)
 */

;(() => {

const { useMemo } = React;
const { fmtRelative, fmtClock, fmtDate, fmtDay, fmtCurrency, fmtDistance, initials, NOW } = window.PDPPPrim;

// ─── helpers ─────────────────────────────────────────────────────────

function recordTimeISO(stream, r) {
  const tf = stream.schema.fields.find((f) => f.type === "timestamp")?.name
    ?? stream.schema.fields.find((f) => /date|at$|night_of/i.test(f.name))?.name;
  return tf ? r[tf] : null;
}

function avatarColor(s) {
  let h = 0;
  for (let i = 0; i < (s ?? "").length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `oklch(0.55 0.12 ${Math.abs(h) % 360})`;
}

function cleanPerson(s) {
  if (!s) return "";
  return String(s).replace(/<[^>]+>/g, "").trim();
}

// ═══════════════════════════════════════════════════════════════════════
// Day Story — "Today across your data"
//
// References: Spotify Wrapped (story-card), Stripe Dashboard (key metrics)
// Generalized: counts records per stream that touched today; pulls headline
// numeric aggregates (sum of currency, sum of distance, average of score).
// ═══════════════════════════════════════════════════════════════════════

function DayStory({ streams }) {
  const todayStart = useMemo(() => {
    const d = new Date(NOW); d.setHours(0,0,0,0); return d.getTime();
  }, []);
  const todayEnd = todayStart + 86_400_000;

  // Total records today
  const stats = useMemo(() => {
    const out = [];
    for (const s of streams) {
      const tf = s.schema.fields.find((f) => f.type === "timestamp")?.name;
      if (!tf) continue;
      const today = s.records.filter((r) => {
        const t = new Date(r[tf]).getTime();
        return t >= todayStart && t < todayEnd;
      });
      if (!today.length) continue;

      const fs = s.schema.fields;
      const cur = fs.find((f) => f.type === "currency");
      const dist = fs.find((f) => /^distance/i.test(f.name));
      const dur = fs.find((f) => /^duration/i.test(f.name));
      const blob = fs.find((f) => f.type === "blob" && (f.media_type ?? "").startsWith("image/"));
      const score = fs.find((f) => f.name === "score");

      if (cur) {
        const net = today.reduce((x, r) => x + (r[cur.name] ?? 0), 0);
        out.push({ stream: s, label: net < 0 ? "spent" : "received", value: fmtCurrency(net), n: today.length });
      } else if (dist) {
        const m = today.reduce((x, r) => x + (r[dist.name] ?? 0), 0);
        out.push({ stream: s, label: "moved", value: fmtDistance(m), n: today.length });
      } else if (blob) {
        out.push({ stream: s, label: "photo" + (today.length === 1 ? "" : "s"), value: String(today.length), n: today.length });
      } else if (score) {
        const avg = today.reduce((x, r) => x + (r[score.name] ?? 0), 0) / today.length;
        out.push({ stream: s, label: "score", value: avg.toFixed(0), n: today.length });
      } else {
        out.push({ stream: s, label: s.name, value: String(today.length), n: today.length });
      }
    }
    return out.sort((a, b) => b.n - a.n).slice(0, 4);
  }, [streams, todayStart, todayEnd]);

  if (!stats.length) return null;
  const totalToday = stats.reduce((x, s) => x + s.n, 0);

  return (
    <section className="day-story">
      <div className="day-story__head">
        <div className="day-story__date">
          {new Date(NOW).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
        </div>
        <div className="day-story__title">
          <b>{totalToday}</b> record{totalToday === 1 ? "" : "s"} so far
        </div>
      </div>
      <div className="day-story__stats">
        {stats.map((s) => (
          <div className="day-story__stat" key={`${s.stream.connection_id}::${s.stream.name}::${s.label}`}>
            <div className="day-story__stat-value">{s.value}</div>
            <div className="day-story__stat-label">
              <span className="day-story__stat-glyph">{s.stream.icon}</span> {s.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Activity strip — 30-day density heatmap across ALL granted streams.
//
// References: Strava weekly summary, GitHub contribution graph.
// Generalized: any stream with a timestamp contributes; intensity is total
// record count per day.
// ═══════════════════════════════════════════════════════════════════════

function ActivityStrip({ streams, onPickDay }) {
  const days = 30;
  const counts = useMemo(() => {
    const map = new Map();
    for (const s of streams) {
      const tf = s.schema.fields.find((f) => f.type === "timestamp")?.name;
      if (!tf) continue;
      for (const r of s.records) {
        const t = r[tf];
        if (!t) continue;
        const d = t.slice(0, 10);
        map.set(d, (map.get(d) ?? 0) + 1);
      }
    }
    return map;
  }, [streams]);
  const max = Math.max(1, ...counts.values());

  const cells = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(NOW - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const v = counts.get(key) ?? 0;
    const intensity = v === 0 ? 0 : 0.18 + 0.82 * (v / max);
    const isToday = i === 0;
    cells.push({ key, d, v, intensity, isToday });
  }

  return (
    <section className="actstrip">
      <div className="actstrip__head">
        <div className="actstrip__title">last 30 days</div>
        <div className="actstrip__legend">
          <span>less</span>
          {[0.18, 0.4, 0.6, 0.8, 1].map((i) => (
            <span className="actstrip__legend-cell" key={i} style={{ background: `color-mix(in oklab, var(--foreground) ${Math.round(i * 100)}%, transparent)` }} />
          ))}
          <span>more</span>
        </div>
      </div>
      <div className="actstrip__cells">
        {cells.map(({ key, d, v, intensity, isToday }) => (
          <button
            className="actstrip__cell"
            data-today={isToday}
            data-zero={v === 0}
            key={key}
            onClick={() => onPickDay?.(key)}
            style={{ "--intensity": intensity }}
            title={`${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${v} record${v === 1 ? "" : "s"}`}
          >
            <span className="actstrip__cell-fill" />
            <span className="actstrip__cell-day">{d.getDate()}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Entity rails — auto-extracted facets that work for any future connector.
//
// References: Immich Faces / Places / Things.
// Generalized: scans every granted stream's schema for fields of type
// `person`/`person[]` (PeopleRail), or named `merchant`/`payee`/`seller`
// (MerchantRail), or `channel`/`channel_id` (ChannelRail). Each rail
// only renders if its underlying field exists somewhere in the grant.
// ═══════════════════════════════════════════════════════════════════════

function PeopleRail({ streams, onAddChip }) {
  const { firstNameToken } = window.PDPP_QUERY;
  const people = useMemo(() => {
    const map = new Map();
    for (const s of streams) {
      const personFields = s.schema.fields.filter((f) => f.type === "person" || f.type === "person[]");
      if (!personFields.length) continue;
      for (const r of s.records) {
        for (const f of personFields) {
          const v = r[f.name];
          const list = Array.isArray(v) ? v : v ? [v] : [];
          for (const p of list) {
            const name = cleanPerson(p);
            if (!name) continue;
            const first = firstNameToken(p);
            if (!first) continue;
            if (!map.has(first)) map.set(first, { display: name, count: 0, first });
            map.get(first).count += 1;
          }
        }
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 12);
  }, [streams]);
  if (!people.length) return null;
  return (
    <Rail label="People" sub="across granted streams">
      {people.map((p) => (
        <button
          className="rail__entity"
          key={p.first}
          onClick={() => onAddChip({ field: "from", op: "is", value: p.first })}
        >
          <span className="rail__avatar" style={{ background: avatarColor(p.display) }}>{initials(p.display)}</span>
          <span className="rail__entity-name">{p.first}</span>
          <span className="rail__entity-count">{p.count}</span>
        </button>
      ))}
    </Rail>
  );
}

function MerchantRail({ streams, onAddChip }) {
  const merchants = useMemo(() => {
    const map = new Map();
    for (const s of streams) {
      const merchField = s.schema.fields.find((f) => /merchant|payee|counterparty|seller|store/i.test(f.name))?.name;
      if (!merchField) continue;
      const amtField = s.schema.fields.find((f) => f.type === "currency")?.name;
      for (const r of s.records) {
        const m = r[merchField];
        if (!m || typeof m !== "string") continue;
        if (!map.has(m)) map.set(m, { name: m, count: 0, total: 0 });
        const entry = map.get(m);
        entry.count += 1;
        if (amtField) entry.total += r[amtField] ?? 0;
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  }, [streams]);
  if (!merchants.length) return null;
  return (
    <Rail label="Merchants" sub="recent activity">
      {merchants.map((m) => (
        <button
          className="rail__entity"
          key={m.name}
          onClick={() => onAddChip({ field: "text", op: "contains", value: m.name.split(/[\s·•]/)[0] })}
          title={`${m.count} record${m.count === 1 ? "" : "s"}`}
        >
          <span className="rail__avatar rail__avatar--mono" style={{ background: avatarColor(m.name) }}>
            {m.name.replace(/[^a-z]/gi, "")[0]?.toUpperCase() ?? "·"}
          </span>
          <span className="rail__entity-name">{m.name.split(/[—·•·-]/)[0].trim().slice(0, 20)}</span>
          <span className="rail__entity-count">{m.count}</span>
        </button>
      ))}
    </Rail>
  );
}

function ChannelRail({ streams, onAddChip }) {
  const channels = useMemo(() => {
    const map = new Map();
    for (const s of streams) {
      const ch = s.schema.fields.find((f) => /^channel$/i.test(f.name))?.name;
      if (!ch) continue;
      for (const r of s.records) {
        const v = r[ch];
        if (!v) continue;
        if (!map.has(v)) map.set(v, { name: v, count: 0 });
        map.get(v).count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  }, [streams]);
  if (!channels.length) return null;
  return (
    <Rail label="Channels" sub="conversations">
      {channels.map((c) => (
        <button
          className="rail__entity rail__entity--channel"
          key={c.name}
          onClick={() => onAddChip({ field: "channel", op: "is", value: c.name })}
        >
          <span className="rail__entity-name">{c.name.startsWith("DM") ? c.name : c.name}</span>
          <span className="rail__entity-count">{c.count}</span>
        </button>
      ))}
    </Rail>
  );
}

function Rail({ label, sub, children }) {
  return (
    <section className="rail">
      <div className="rail__head">
        <h3 className="rail__label">{label}</h3>
        <span className="rail__sub">{sub}</span>
      </div>
      <div className="rail__scroll">
        <div className="rail__row">{children}</div>
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Memories — surface records from N years or months ago.
//
// Reference: Apple Photos "On this day".
// Generalized: any record with a timestamp; we look for exactly N×365 days
// ago and N×30 days ago. Returns up to 3 hits.
// ═══════════════════════════════════════════════════════════════════════

function findMemories(streams) {
  const out = [];
  const today = new Date(NOW);
  const m = today.getMonth();
  const d = today.getDate();
  // Anniversaries we care about: same month/day, going back as far as data allows
  const targetYears = [];
  for (let yearsAgo = 1; yearsAgo <= 15; yearsAgo++) {
    targetYears.push(today.getFullYear() - yearsAgo);
  }
  const seen = new Set();
  for (const ya of targetYears) {
    const day = new Date(Date.UTC(ya, m, d)).toISOString().slice(0, 10);
    for (const s of streams) {
      const tf = s.schema.fields.find((f) => f.type === "timestamp")?.name;
      if (!tf) continue;
      for (const r of s.records) {
        if (r[tf]?.slice(0, 10) === day) {
          const key = `${s.connection_id}::${r.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const yearsAgo = today.getFullYear() - ya;
          out.push({
            stream: s,
            record: r,
            label: yearsAgo === 1 ? "1 year ago" : `${yearsAgo} years ago`,
          });
          if (out.length >= 4) return out;
        }
      }
    }
  }
  // Fallback: same day-of-month last month
  if (out.length < 2) {
    const lastMonth = new Date(today.getFullYear(), m - 1, d).toISOString().slice(0, 10);
    for (const s of streams) {
      const tf = s.schema.fields.find((f) => f.type === "timestamp")?.name;
      if (!tf) continue;
      for (const r of s.records) {
        if (r[tf]?.slice(0, 10) === lastMonth) {
          out.push({ stream: s, record: r, label: "1 month ago" });
          if (out.length >= 4) return out;
        }
      }
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// YearStrip — Apple Photos "Years" zoom level
//
// One cell per year across the grant's full time horizon. Density encodes
// per-year record count. Click to add a `year:YYYY` chip. This is the
// move that makes a 20-year personal archive feel navigable.
// ═══════════════════════════════════════════════════════════════════════

function YearStrip({ streams, onAddChip }) {
  const years = useMemo(() => {
    const map = new Map();
    let earliest = null, latest = null;
    for (const s of streams) {
      const tf = s.schema.fields.find((f) => f.type === "timestamp")?.name;
      if (!tf) continue;
      for (const r of s.records) {
        const t = r[tf];
        if (!t) continue;
        const y = Number(t.slice(0, 4));
        if (Number.isFinite(y)) {
          map.set(y, (map.get(y) ?? 0) + 1);
          if (earliest == null || y < earliest) earliest = y;
          if (latest == null   || y > latest)   latest = y;
        }
      }
    }
    if (earliest == null) return [];
    const list = [];
    for (let y = earliest; y <= latest; y++) {
      list.push({ year: y, count: map.get(y) ?? 0 });
    }
    return list;
  }, [streams]);

  if (years.length < 2) return null;
  const max = Math.max(1, ...years.map((y) => y.count));
  const total = years.reduce((x, y) => x + y.count, 0);
  const span = years.length;
  const thisYear = new Date(NOW).getFullYear();

  return (
    <section className="yearstrip">
      <div className="yearstrip__head">
        <div className="yearstrip__title">
          <span className="yearstrip__eyebrow">all time</span>
          <span className="yearstrip__count">{total.toLocaleString()} records</span>
          <span className="yearstrip__span">spans {span} year{span === 1 ? "" : "s"} · {years[0].year} → {years[years.length - 1].year}</span>
        </div>
      </div>
      <div className="yearstrip__cells">
        {years.map(({ year, count }) => {
          const intensity = count === 0 ? 0 : 0.2 + 0.8 * (count / max);
          const isThis = year === thisYear;
          return (
            <button
              className="yearstrip__cell"
              data-this={isThis}
              data-zero={count === 0}
              key={year}
              onClick={() => onAddChip({ field: "year", op: "is", value: year })}
              title={`${year} — ${count.toLocaleString()} record${count === 1 ? "" : "s"}`}
            >
              <span className="yearstrip__bar" style={{ height: `${Math.round(intensity * 100)}%` }} />
              <span className="yearstrip__year">{String(year).slice(2)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

window.PDPP_DISCOVER = {
  DayStory, ActivityStrip, PeopleRail, MerchantRail, ChannelRail, YearStrip, findMemories,
};

})();
