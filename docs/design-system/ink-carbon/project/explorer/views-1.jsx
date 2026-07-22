// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* IIFE-WRAPPED */
(() => {
  /* PDPP Explorer — views part 1: Table, Timeline, Conversation, Reader */

  const {
    fmtRelative,
    fmtClock,
    fmtDate,
    fmtDay,
    fmtCurrency,
    fmtDuration,
    fmtDistance,
    Avatar,
    getTimeField,
    getRecordTime,
    getRecordTitle,
  } = window.PDPPPrim;

  /* ─── TABLE VIEW (the universal floor) ─────────────────────────────────
   *
   * Picks columns generically: prefer timestamp first, then human-readable
   * scalars (text, currency, enum, number, person), then everything else
   * stays in the peek. Currency right-aligns. Long text gets truncated.
   */
  function TableView({ stream, selectedId, onSelect, projection }) {
    const fields = stream.schema.fields;
    const visibleFields = projection ? fields.filter((f) => f.granted) : fields;

    // Column priority: timestamp first, then text/enum/person/currency/number,
    // then booleans, then anything else.
    const priority = (f) => {
      if (f.type === "timestamp") return 0;
      if (f.type === "text" && /title|subject|merchant|name/i.test(f.name)) return 1;
      if (f.type === "person") return 2;
      if (f.type === "text") return 3;
      if (f.type === "enum") return 4;
      if (f.type === "currency") return 5;
      if (f.type === "number") return 6;
      return 9;
    };
    const cols = [...visibleFields]
      .filter(
        (f) => f.type !== "id" && f.type !== "blob" && f.type !== "geo" && f.type !== "json" && f.type !== "person[]"
      )
      .sort((a, b) => priority(a) - priority(b))
      .slice(0, 5);

    function renderCell(field, record) {
      const v = record[field.name];
      if (v == null) return <span className="mono">—</span>;
      if (field.type === "timestamp") {
        return <span className="mono num">{fmtRelative(v)}</span>;
      }
      if (field.type === "currency") {
        return <span className={`num mono ${v > 0 ? "pos" : ""}`}>{fmtCurrency(v)}</span>;
      }
      if (field.type === "number") {
        let display = v.toLocaleString();
        if (field.unit === "meters") display = fmtDistance(v);
        else if (field.unit === "seconds") display = fmtDuration(v);
        return <span className="num mono">{display}</span>;
      }
      if (field.type === "boolean") return <span className="mono">{v ? "yes" : "—"}</span>;
      if (field.type === "enum" || field.type === "enum[]") {
        const arr = Array.isArray(v) ? v : [v];
        return <span className="mono">{arr.slice(0, 2).join(", ")}</span>;
      }
      if (field.type === "person")
        return (
          <span>
            {String(v)
              .replace(/<[^>]+>/g, "")
              .trim()}
          </span>
        );
      return (
        <span className="truncate" title={String(v)}>
          {String(v)}
        </span>
      );
    }

    return (
      <div style={{ overflowX: "auto" }}>
        <table className="exp-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.name}>{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stream.records.map((r) => (
              <tr key={r.id} data-selected={selectedId === r.id} onClick={() => onSelect(r)}>
                {cols.map((c) => (
                  <td key={c.name}>{renderCell(c, r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  /* ─── TIMELINE VIEW ────────────────────────────────────────────────────
   *
   * Day-grouped reverse-chrono list. Right-rail scrubber jumps to a month.
   * Works for any stream with a timestamp field.
   */
  function TimelineView({ stream, selectedId, onSelect }) {
    const tf = getTimeField(stream);
    if (!tf) return <div className="exp-empty">No timestamp field in schema.</div>;
    const sorted = [...stream.records].sort((a, b) => new Date(b[tf]) - new Date(a[tf]));

    // Group by day
    const days = [];
    let lastDay = "";
    for (const r of sorted) {
      const day = r[tf]?.slice(0, 10);
      if (day !== lastDay) {
        days.push({ day, items: [] });
        lastDay = day;
      }
      days[days.length - 1].items.push(r);
    }

    // Months for the scrubber
    const monthsSet = new Map();
    for (const r of sorted) {
      const m = r[tf]?.slice(0, 7);
      monthsSet.set(m, (monthsSet.get(m) ?? 0) + 1);
    }
    const months = [...monthsSet.entries()];

    return (
      <div className="exp-tl">
        <div className="exp-tl__list">
          {days.map(({ day, items }) => (
            <div key={day}>
              <div className="exp-tl__day-label">
                {fmtDay(day + "T12:00:00Z")} · {items.length} record{items.length === 1 ? "" : "s"}
              </div>
              {items.map((r) => (
                <div className="exp-tl__row" data-selected={selectedId === r.id} key={r.id} onClick={() => onSelect(r)}>
                  <div className="exp-tl__time">{fmtClock(r[tf])}</div>
                  <div className="exp-tl__content">
                    <b>{getRecordTitle(stream, r)}</b>
                    <small>
                      {[r.from, r.author, r.actor, r.merchant, r.title, r.channel]
                        .filter(Boolean)
                        .slice(0, 1)
                        .join(" · ") || r.id}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="exp-tl__scrubber">
          {months.map(([m, count]) => (
            <span className="exp-tl__scrubber-month" key={m} data-active>
              {new Date(m + "-15").toLocaleDateString("en-US", { month: "short" })}{" "}
              <span style={{ opacity: 0.6 }}>{count}</span>
            </span>
          ))}
        </div>
      </div>
    );
  }

  /* ─── CONVERSATION VIEW ─────────────────────────────────────────────────
   *
   * Two cols: channel rail + thread list. Works for any record with an
   * (author|from) + (text|body) + (thread/channel|to) shape.
   */
  function ConversationView({ stream, selectedId, onSelect }) {
    // Determine field names from schema
    const fields = stream.schema.fields;
    const authorField = fields.find((f) => /author|from|sender|user/i.test(f.name))?.name;
    const bodyField = fields.find((f) => /body|text|message|content|snippet/i.test(f.name))?.name;
    const channelField =
      fields.find((f) => /channel|thread|conversation/i.test(f.name) && f.type !== "id")?.name ??
      fields.find((f) => /channel|thread|conversation/i.test(f.name))?.name;
    const subjectField = fields.find((f) => /subject|title/i.test(f.name))?.name;
    const timeField = getTimeField(stream);
    const recipField = fields.find((f) => f.name === "to")?.name;

    // Group by channel/thread
    const groups = new Map();
    for (const r of stream.records) {
      const key = r[channelField] ?? r[subjectField] ?? (recipField ? `to:${(r[recipField] ?? []).join(",")}` : "—");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const channels = [...groups.entries()].sort((a, b) => {
      const ta = Math.max(...a[1].map((r) => new Date(r[timeField] ?? 0)));
      const tb = Math.max(...b[1].map((r) => new Date(r[timeField] ?? 0)));
      return tb - ta;
    });

    const [active, setActive] = useState(channels[0]?.[0]);
    const activeRecords = (groups.get(active) ?? [])
      .slice()
      .sort((a, b) => new Date(a[timeField] ?? 0) - new Date(b[timeField] ?? 0));

    return (
      <div className="exp-conv">
        <div className="exp-conv__channels">
          {channels.map(([name, items]) => (
            <button
              className="exp-conv__channel"
              data-active={active === name}
              key={name}
              onClick={() => setActive(name)}
            >
              <span>{name}</span>
              <span className="exp-conv__channel-count">{items.length}</span>
            </button>
          ))}
        </div>
        <div className="exp-conv__list">
          {activeRecords.map((r) => (
            <div className="exp-conv__msg" data-selected={selectedId === r.id} key={r.id} onClick={() => onSelect(r)}>
              <Avatar label={r[authorField]} />
              <div>
                <div className="exp-conv__head">
                  <span className="exp-conv__head-name">
                    {String(r[authorField] ?? "·")
                      .replace(/<[^>]+>/g, "")
                      .trim()}
                  </span>
                  <span className="exp-conv__head-time">{fmtRelative(r[timeField])}</span>
                  {subjectField && r[subjectField] ? (
                    <span className="exp-conv__head-channel">· {r[subjectField]}</span>
                  ) : null}
                </div>
                <div className="exp-conv__text">{r[bodyField]}</div>
                {Array.isArray(r.reactions) && r.reactions.length > 0 ? (
                  <div className="exp-conv__react">
                    {r.reactions.map((rx, i) => (
                      <span key={i}>
                        {rx.emoji} {rx.count}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  /* ─── READER VIEW ──────────────────────────────────────────────────────
   *
   * Title + long body. Used for GitHub PR/issue bodies, etc.
   */
  function ReaderView({ stream, selectedId, onSelect }) {
    const fields = stream.schema.fields;
    const titleField = fields.find((f) => /title|subject/i.test(f.name))?.name;
    const bodyField = fields.find((f) => /body|content/i.test(f.name))?.name;
    const timeField = getTimeField(stream);
    const actorField = fields.find((f) => /actor|author|from|user/i.test(f.name))?.name;
    const sorted = [...stream.records].sort((a, b) => new Date(b[timeField] ?? 0) - new Date(a[timeField] ?? 0));
    return (
      <div className="exp-rdr">
        <div className="exp-rdr__list">
          {sorted.map((r) => (
            <div className="exp-rdr__item" data-selected={selectedId === r.id} key={r.id} onClick={() => onSelect(r)}>
              <div className="exp-rdr__item-meta">
                <span>{r.type ?? r[actorField] ?? ""}</span>
                <span>·</span>
                <span>{r.repo ?? ""}</span>
                <span>·</span>
                <span>{fmtRelative(r[timeField])}</span>
              </div>
              <h3 className="exp-rdr__item-title">{r[titleField]}</h3>
              <p className="exp-rdr__item-body">{r[bodyField]}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  Object.assign(window, { TableView, TimelineView, ConversationView, ReaderView });
})();
