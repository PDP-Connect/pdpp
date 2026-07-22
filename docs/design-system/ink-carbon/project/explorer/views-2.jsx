// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* IIFE-WRAPPED */
(() => {
  /* PDPP Explorer — views part 2: Ledger, Gallery, Map, Calendar, Chart */

  const {
    fmtRelative,
    fmtClock,
    fmtDate,
    fmtDay,
    fmtCurrency,
    fmtDuration,
    fmtDistance,
    Heatmap,
    Sparkline,
    getTimeField,
    getRecordTitle,
    NOW,
  } = window.PDPPPrim;

  /* ─── LEDGER VIEW ──────────────────────────────────────────────────────
   *
   * Month-strip + transactions list + category breakdown.
   * Generalized: works on any stream with a currency-typed field.
   */
  function LedgerView({ stream, selectedId, onSelect }) {
    const fields = stream.schema.fields;
    const amountField = (
      fields.find((f) => f.type === "currency") ?? fields.find((f) => f.type === "number" && /amount/i.test(f.name))
    )?.name;
    const merchantField = fields.find((f) => /merchant|payee|counterparty|seller/i.test(f.name))?.name;
    const catField = fields.find((f) => /category|kind|type/i.test(f.name) && f.type === "enum")?.name;
    const timeField = getTimeField(stream);
    const memoField = fields.find((f) => /memo|note|description/i.test(f.name))?.name;

    // Month strip
    const monthBuckets = useMonths(stream.records, timeField);
    const [activeMonth, setActiveMonth] = useState(monthBuckets[0]?.key ?? null);
    const visible = stream.records.filter((r) => r[timeField]?.slice(0, 7) === activeMonth);
    const sorted = [...visible].sort((a, b) => new Date(b[timeField]) - new Date(a[timeField]));

    // Category breakdown
    const cats = new Map();
    for (const r of visible) {
      const cat = r[catField] ?? "Other";
      cats.set(cat, (cats.get(cat) ?? 0) + Math.abs(r[amountField] ?? 0));
    }
    const catEntries = [...cats.entries()].sort((a, b) => b[1] - a[1]);
    const catMax = Math.max(1, ...catEntries.map((c) => c[1]));

    return (
      <div className="exp-ledger">
        <div>
          <div className="exp-ledger__month-strip">
            {monthBuckets.map((m) => (
              <button
                className="exp-ledger__month"
                data-active={m.key === activeMonth}
                key={m.key}
                onClick={() => setActiveMonth(m.key)}
              >
                <span className="exp-ledger__month-label">{m.label}</span>
                <span className="exp-ledger__month-amount">{fmtCurrency(m.net)}</span>
              </button>
            ))}
          </div>
          <div className="exp-ledger__rows">
            {sorted.map((r) => (
              <div
                className="exp-ledger__row"
                data-selected={selectedId === r.id}
                key={r.id}
                onClick={() => onSelect(r)}
              >
                <div className="exp-ledger__row-date">{fmtDate(r[timeField])}</div>
                <div className="exp-ledger__row-merchant">
                  {r[merchantField] ?? r.title ?? "—"}
                  {r[memoField] ? <small>{r[memoField]}</small> : null}
                </div>
                <div className="exp-ledger__row-cat">{r[catField] ?? "—"}</div>
                <div className={`exp-ledger__row-amount ${r[amountField] > 0 ? "pos" : ""}`}>
                  {fmtCurrency(r[amountField] ?? 0)}
                </div>
              </div>
            ))}
          </div>
        </div>
        <aside className="exp-ledger__side">
          <div className="exp-ledger__side-label">By category</div>
          {catEntries.map(([name, amt]) => (
            <div className="exp-ledger__side-row" key={name}>
              <span className="exp-ledger__side-row-cat">{name}</span>
              <span className="exp-ledger__side-bar" style={{ "--pct": `${(amt / catMax) * 100}%` }} />
              <span className="exp-ledger__side-row-amt">{fmtCurrency(-amt)}</span>
            </div>
          ))}
        </aside>
      </div>
    );
  }

  function useMonths(records, timeField) {
    const buckets = new Map();
    for (const r of records) {
      const k = r[timeField]?.slice(0, 7);
      if (!k) continue;
      if (!buckets.has(k)) buckets.set(k, { key: k, net: 0, count: 0 });
      buckets.get(k).net += r.amount ?? 0;
      buckets.get(k).count += 1;
    }
    const list = [...buckets.values()].sort((a, b) => b.key.localeCompare(a.key));
    return list.slice(0, 6).map((b) => ({
      ...b,
      label: new Date(b.key + "-15").toLocaleDateString("en-US", { month: "short" }),
    }));
  }

  /* ─── GALLERY VIEW ─────────────────────────────────────────────────────
   *
   * Justified-grid masonry-ish for any stream with a blob image / url image field.
   */
  function GalleryView({ stream, selectedId, onSelect }) {
    const fields = stream.schema.fields;
    const imgField = (
      fields.find((f) => f.type === "blob" && (f.media_type ?? "").startsWith("image/")) ??
      fields.find((f) => /thumb|image|photo|picture/i.test(f.name))
    )?.name;
    const capField = fields.find((f) => /caption|title|subject/i.test(f.name))?.name;
    const timeField = getTimeField(stream);
    const sorted = [...stream.records].sort((a, b) => new Date(b[timeField] ?? 0) - new Date(a[timeField] ?? 0));

    return (
      <div className="exp-gal">
        {sorted.map((r) => (
          <div className="exp-gal__item" data-selected={selectedId === r.id} key={r.id} onClick={() => onSelect(r)}>
            <img alt={r[capField] ?? ""} loading="lazy" src={r[imgField]} />
            {capField ? <div className="exp-gal__cap">{r[capField]}</div> : null}
          </div>
        ))}
      </div>
    );
  }

  /* ─── MAP VIEW ─────────────────────────────────────────────────────────
   *
   * Stylized rectangular projection — not a real map, just enough geography
   * to read multiple pins as a place. For a generalized explorer this is
   * meant as a quick locator; a real impl would mount mapbox/maplibre here.
   */
  function MapView({ stream, selectedId, onSelect }) {
    const fields = stream.schema.fields;
    const latField = fields.find((f) => /^lat(itude)?$/i.test(f.name))?.name;
    const lngField = fields.find((f) => /^l(ng|on|ongitude)$/i.test(f.name))?.name;
    const labelField = fields.find((f) => /title|caption|subject/i.test(f.name))?.name;
    const timeField = getTimeField(stream);

    if (!latField || !lngField) return <div className="exp-empty">Stream carries no usable geo fields.</div>;

    const pts = stream.records.filter((r) => r[latField] != null && r[lngField] != null);
    if (!pts.length) return <div className="exp-empty">No records carry coordinates in this window.</div>;

    const lats = pts.map((p) => p[latField]);
    const lngs = pts.map((p) => p[lngField]);
    // Pad bbox slightly so pins don't sit on the edges
    const minLat = Math.min(...lats) - 0.005;
    const maxLat = Math.max(...lats) + 0.005;
    const minLng = Math.min(...lngs) - 0.005;
    const maxLng = Math.max(...lngs) + 0.005;

    function projX(lng) {
      const range = maxLng - minLng || 1;
      return ((lng - minLng) / range) * 100;
    }
    function projY(lat) {
      const range = maxLat - minLat || 1;
      return (1 - (lat - minLat) / range) * 100;
    }

    return (
      <div className="exp-map">
        <div className="exp-map__grid" />
        {pts.map((r) => (
          <div
            className="exp-map__pin"
            data-selected={selectedId === r.id}
            key={r.id}
            onClick={() => onSelect(r)}
            style={{
              left: `${projX(r[lngField])}%`,
              top: `${projY(r[latField])}%`,
            }}
          >
            <span className="exp-map__pin-dot" />
            <span className="exp-map__pin-label">
              {(r[labelField] ?? r.title ?? "·").slice(0, 28)} · {fmtDate(r[timeField])}
            </span>
          </div>
        ))}
        <div className="exp-map__legend">
          {pts.length} record{pts.length === 1 ? "" : "s"} · bbox {minLat.toFixed(2)},{minLng.toFixed(2)} →{" "}
          {maxLat.toFixed(2)},{maxLng.toFixed(2)}
        </div>
      </div>
    );
  }

  /* ─── CALENDAR VIEW ────────────────────────────────────────────────────
   *
   * 6-week month grid anchored on `today`. Records with start/end (or
   * any timestamp field) render as inline event chips.
   */
  function CalendarView({ stream, selectedId, onSelect }) {
    const fields = stream.schema.fields;
    const startField = fields.find((f) => /^start/i.test(f.name))?.name ?? getTimeField(stream);
    const titleField = fields.find((f) => /title|subject|name/i.test(f.name))?.name;

    const today = new Date(NOW);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    // Start the grid on the Sunday before (or equal to) the 1st.
    const gridStart = new Date(monthStart);
    gridStart.setDate(monthStart.getDate() - monthStart.getDay());

    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      cells.push(d);
    }

    const byDate = new Map();
    for (const r of stream.records) {
      if (!r[startField]) continue;
      const key = r[startField].slice(0, 10);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(r);
    }

    const dayKey = (d) => d.toISOString().slice(0, 10);

    return (
      <>
        <div
          style={{
            marginBottom: "0.75rem",
            fontFamily: "var(--font-mono)",
            fontSize: "0.78rem",
            color: "var(--muted-foreground)",
          }}
        >
          {today.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </div>
        <div className="exp-cal">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div className="exp-cal__dow" key={d}>
              {d}
            </div>
          ))}
          {cells.map((d) => {
            const isToday = dayKey(d) === dayKey(today);
            const isOther = d.getMonth() !== today.getMonth();
            const evts = byDate.get(dayKey(d)) ?? [];
            return (
              <div className="exp-cal__day" data-other={isOther} data-today={isToday} key={dayKey(d)}>
                <span className="exp-cal__day-num">{d.getDate()}</span>
                {evts.map((r) => (
                  <span
                    className="exp-cal__event"
                    data-selected={selectedId === r.id}
                    key={r.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(r);
                    }}
                  >
                    {r[titleField] ?? r.title ?? "·"}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </>
    );
  }

  /* ─── CHART VIEW ───────────────────────────────────────────────────────
   *
   * For each numeric measure, render a heatmap (day density) + sparkline.
   * Generic: doesn't care what stream.
   */
  function ChartView({ stream }) {
    const fields = stream.schema.fields;
    const timeField = getTimeField(stream);
    const isMeasure = (f) => f.type === "number" && !/^(lat|lng|longitude|latitude|id|.*_id|.*_count)$/i.test(f.name);
    const measures = fields.filter(isMeasure);

    // Aggregate per-day count for the activity heatmap
    const dayCounts = new Map();
    for (const r of stream.records) {
      const d = r[timeField]?.slice(0, 10);
      if (!d) continue;
      dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
    }
    const heatValues = [...dayCounts.entries()].map(([date, count]) => ({ date, count }));

    // Sparklines: for each measure, sort by time and take last 30 values
    function valuesForMeasure(f) {
      return [...stream.records]
        .filter((r) => r[f.name] != null && r[timeField])
        .sort((a, b) => new Date(a[timeField]) - new Date(b[timeField]))
        .map((r) => r[f.name]);
    }

    return (
      <div className="exp-chart-grid">
        <div className="exp-chart-card">
          <div className="exp-chart-card__head">
            <span className="exp-chart-card__title">Activity · last 12 weeks</span>
            <span className="exp-chart-card__sub">
              {stream.records.length} records · {dayCounts.size} active days
            </span>
          </div>
          <Heatmap days={84} values={heatValues} />
        </div>
        {measures.map((f) => {
          const values = valuesForMeasure(f);
          if (!values.length) return null;
          const avg = values.reduce((s, v) => s + v, 0) / values.length;
          const latest = values[values.length - 1];
          return (
            <div className="exp-chart-card" key={f.name}>
              <div className="exp-chart-card__head">
                <span className="exp-chart-card__title">{f.name}</span>
                <span className="exp-chart-card__sub">
                  latest <b style={{ color: "var(--foreground)" }}>{formatMeasure(f, latest)}</b>
                  {" · "}avg {formatMeasure(f, avg)}
                </span>
              </div>
              <Sparkline color="var(--primary)" height={48} values={values} width={520} />
            </div>
          );
        })}
      </div>
    );
  }

  function formatMeasure(f, v) {
    if (f.unit === "meters") return fmtDistance(v);
    if (f.unit === "seconds") return fmtDuration(v);
    if (typeof v === "number") return v.toFixed(v % 1 === 0 ? 0 : 1);
    return String(v);
  }

  Object.assign(window, { LedgerView, GalleryView, MapView, CalendarView, ChartView });
})();
