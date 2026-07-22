// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* PDPP Explorer — Feed with type-aware cards
 *
 * The card kind is dispatched from the stream's schema signals — same
 * function the view picker uses. Any future connector whose schema
 * carries currency renders as a money card; whose schema carries
 * blob+image renders as a photo card; etc. No connector identity is
 * referenced anywhere.
 *
 * On every viewport the feed is a single column of stacked cards,
 * separated by sticky day headers. This is the canonical view.
 */

(() => {
  const { useMemo } = React;
  const { fmtRelative, fmtClock, fmtDay, fmtCurrency, fmtDuration, fmtDistance, initials } = window.PDPPPrim;
  const { detect } = window.PDPP_DISPATCH;

  // ─── Per-record card kind ─────────────────────────────────────────────
  // Reuses the stream-level dispatch to pick a card. "feed-generic" is
  // the universal fallback.
  const KIND_FOR_CAP = {
    calendar: "event",
    chart: "activity",
    conversation: "message",
    gallery: "photo",
    ledger: "money",
    map: "location",
    reader: "reader",
    table: "generic",
    timeline: "generic",
  };
  function cardKindForStream(stream) {
    const { capabilities } = detect(stream);
    // The first non-table capability wins — same priority order as views.
    for (const cap of capabilities) {
      if (cap === "table") {
        continue;
      }
      return KIND_FOR_CAP[cap] ?? "generic";
    }
    return "generic";
  }

  // ─── Field probes (lexical only — no connector branches) ──────────────
  function findField(stream, regex) {
    return stream.schema.fields.find((f) => regex.test(f.name))?.name;
  }
  function findFieldByType(stream, type) {
    return stream.schema.fields.find((f) => f.type === type)?.name;
  }
  function findImageField(stream) {
    const blob = stream.schema.fields.find((f) => f.type === "blob" && (f.media_type ?? "").startsWith("image/"));
    if (blob) {
      return blob.name;
    }
    return stream.schema.fields.find(
      (f) => /thumb|image|photo|picture/i.test(f.name) && (f.type === "blob" || f.type === "url")
    )?.name;
  }

  function recordTimeISO(stream, r) {
    const tf = findFieldByType(stream, "timestamp") ?? findField(stream, /date|at$|night_of/i);
    return tf ? r[tf] : null;
  }

  function cleanPerson(s) {
    if (!s) {
      return "";
    }
    return String(s)
      .replace(/<[^>]+>/g, "")
      .trim();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Card components — each is small, opinionated, generic over the schema.
  // ═══════════════════════════════════════════════════════════════════════

  function CardEyebrow({ stream, time, light }) {
    return (
      <div className={`card__eyebrow ${light ? "is-light" : ""}`}>
        <span className="card__eyebrow-glyph">{stream.icon}</span>
        <span className="card__eyebrow-stream">{stream.connector_id}</span>
        <span className="card__eyebrow-conn">· {stream.connection_display}</span>
        <span style={{ flex: 1 }} />
        <span className="card__eyebrow-time">{time ? fmtClock(time) : "—"}</span>
      </div>
    );
  }

  function MessageCard({ stream, record, selected, onClick }) {
    const authorField = findField(stream, /^from$|author|sender|actor/i) ?? findFieldByType(stream, "person");
    const bodyField = findField(stream, /body|snippet|text|message|content/i);
    const subjField = findField(stream, /subject|title/i);
    const chanField = findField(stream, /channel/i);
    const author = cleanPerson(record[authorField]);
    const time = recordTimeISO(stream, record);
    return (
      <article className="card card--message" data-selected={selected} onClick={onClick}>
        <CardEyebrow stream={stream} time={time} />
        <div className="card__row card__row--message">
          <span className="card__avatar" style={{ background: avatarColor(author) }}>
            {initials(author)}
          </span>
          <div className="card__col">
            <div className="card__name">{author}</div>
            {chanField && record[chanField] ? <div className="card__channel">{record[chanField]}</div> : null}
          </div>
        </div>
        {subjField && record[subjField] ? <div className="card__title">{record[subjField]}</div> : null}
        <div className="card__body">{record[bodyField]}</div>
        {Array.isArray(record.reactions) && record.reactions.length ? (
          <div className="card__react">
            {record.reactions.map((rx, i) => (
              <span key={i}>
                {rx.emoji} {rx.count}
              </span>
            ))}
          </div>
        ) : null}
      </article>
    );
  }

  function MoneyCard({ stream, record, selected, onClick }) {
    const amtField = findFieldByType(stream, "currency") ?? findField(stream, /^amount$/i);
    const merchField = findField(stream, /merchant|payee|counterparty|seller/i);
    const catField = findField(stream, /category|kind/i);
    const memoField = findField(stream, /memo|note|description/i);
    const amount = record[amtField] ?? 0;
    const time = recordTimeISO(stream, record);
    return (
      <article className="card card--money" data-selected={selected} onClick={onClick}>
        <CardEyebrow stream={stream} time={time} />
        <div className={`card__amount ${amount > 0 ? "is-pos" : ""}`}>{fmtCurrency(amount)}</div>
        <div className="card__title">{record[merchField] ?? record.title}</div>
        <div className="card__meta-row">
          {record[catField] ? <span className="card__chip">{record[catField]}</span> : null}
          {record[memoField] ? <span className="card__meta-text">{record[memoField]}</span> : null}
        </div>
      </article>
    );
  }

  function PhotoCard({ stream, record, selected, onClick }) {
    const imgField = findImageField(stream);
    const capField = findField(stream, /caption|title|subject/i);
    const time = recordTimeISO(stream, record);
    // Variable aspect ratios so the feed breathes (Apple Photos masonry feel).
    // Deterministic per record so it doesn't reshuffle.
    const aspectClass = ["is-4x3", "is-3x4", "is-1x1", "is-16x9"][hashId(record.id) % 4];
    return (
      <article className={`card card--photo ${aspectClass}`} data-selected={selected} onClick={onClick}>
        <div className="card__photo">
          <img alt={record[capField] ?? ""} loading="lazy" src={record[imgField]} />
          <div className="card__photo-scrim" />
          <CardEyebrow light={true} stream={stream} time={time} />
          <div className="card__photo-caption">{record[capField]}</div>
        </div>
      </article>
    );
  }

  function hashId(s) {
    let h = 0;
    for (let i = 0; i < (s ?? "").length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }

  function EventCard({ stream, record, selected, onClick }) {
    const titleField = findField(stream, /title|subject|name/i);
    const locField = findField(stream, /location|place/i);
    const startField = findField(stream, /^start/i) ?? findFieldByType(stream, "timestamp");
    const endField = findField(stream, /^end/i);
    const attendField = findField(stream, /attendees|participants/i);
    const start = record[startField];
    const end = record[endField];
    return (
      <article className="card card--event" data-selected={selected} onClick={onClick}>
        <CardEyebrow stream={stream} time={start} />
        <div className="card__event-time">
          {start ? fmtClock(start) : ""} {end ? `– ${fmtClock(end)}` : ""}
        </div>
        <div className="card__title">{record[titleField]}</div>
        {record[locField] ? <div className="card__body">{record[locField]}</div> : null}
        {Array.isArray(record[attendField]) && record[attendField].length ? (
          <div className="card__meta-row">
            <span className="card__meta-text">
              {record[attendField].length} attendee{record[attendField].length === 1 ? "" : "s"}
            </span>
          </div>
        ) : null}
      </article>
    );
  }

  function ActivityCard({ stream, record, selected, onClick }) {
    const titleField = findField(stream, /title|name/i);
    const typeField = findField(stream, /^type$/i);
    const distField = findField(stream, /distance/i);
    const durField = findField(stream, /^duration|^elapsed/i);
    const elevField = findField(stream, /elev/i);
    // Sleep-like streams: score + sleep stages
    const scoreField = findField(stream, /^score|^value$/i);
    const time = recordTimeISO(stream, record);
    const stats = [];
    if (distField && record[distField] != null) {
      stats.push({ label: "distance", value: fmtDistance(record[distField]) });
    }
    if (durField && record[durField] != null) {
      stats.push({ label: "duration", value: fmtDuration(record[durField]) });
    }
    if (elevField && record[elevField] != null) {
      stats.push({ label: "elevation", value: `${Math.round(record[elevField])}m` });
    }
    if (!stats.length && scoreField && record[scoreField] != null) {
      stats.push({ label: scoreField, value: String(record[scoreField]) });
    }
    return (
      <article className="card card--activity" data-selected={selected} onClick={onClick}>
        <CardEyebrow stream={stream} time={time} />
        <div className="card__title">{record[titleField] ?? record[typeField] ?? "Activity"}</div>
        <div className="card__stats">
          {stats.map((s) => (
            <div className="card__stat" key={s.label}>
              <div className="card__stat-value">{s.value}</div>
              <div className="card__stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      </article>
    );
  }

  function ReaderCard({ stream, record, selected, onClick }) {
    const titleField = findField(stream, /title|subject/i);
    const bodyField = findField(stream, /body|content/i);
    const actorField = findField(stream, /actor|author|user/i);
    const typeField = findField(stream, /^type$/i);
    const repoField = findField(stream, /repo|project/i);
    const time = recordTimeISO(stream, record);
    return (
      <article className="card card--reader" data-selected={selected} onClick={onClick}>
        <CardEyebrow stream={stream} time={time} />
        {record[typeField] || record[repoField] ? (
          <div className="card__meta-row">
            {record[typeField] ? <span className="card__chip">{record[typeField]}</span> : null}
            {record[repoField] ? <span className="card__meta-text">{record[repoField]}</span> : null}
          </div>
        ) : null}
        <div className="card__title">{record[titleField]}</div>
        {record[bodyField] ? <div className="card__body card__body--clamped">{record[bodyField]}</div> : null}
        {record[actorField] ? (
          <div className="card__meta-text" style={{ marginTop: "0.5rem" }}>
            by {cleanPerson(record[actorField])}
          </div>
        ) : null}
      </article>
    );
  }

  function LocationCard({ stream, record, selected, onClick }) {
    const titleField = findField(stream, /title|caption|name/i);
    const latField = findField(stream, /^lat/i);
    const lngField = findField(stream, /^l(ng|on)/i);
    const time = recordTimeISO(stream, record);
    return (
      <article className="card card--location" data-selected={selected} onClick={onClick}>
        <CardEyebrow stream={stream} time={time} />
        <div className="card__title">{record[titleField] ?? "Location"}</div>
        <div className="card__body card__body--mono">
          {Number(record[latField]).toFixed(4)}, {Number(record[lngField]).toFixed(4)}
        </div>
      </article>
    );
  }

  function GenericCard({ stream, record, selected, onClick }) {
    // Best-effort: pick a title-ish field, time, and 1–2 secondary values
    const titleField = findField(stream, /title|subject|name|merchant|caption/i);
    const time = recordTimeISO(stream, record);
    const secondary = stream.schema.fields
      .filter(
        (f) =>
          f.granted &&
          f.name !== titleField &&
          f.type !== "id" &&
          f.type !== "blob" &&
          f.type !== "geo" &&
          record[f.name] != null
      )
      .slice(0, 3);
    return (
      <article className="card card--generic" data-selected={selected} onClick={onClick}>
        <CardEyebrow stream={stream} time={time} />
        <div className="card__title">{record[titleField] ?? record.id}</div>
        <div className="card__kv-list">
          {secondary.map((f) => (
            <div className="card__kv" key={f.name}>
              <span className="card__kv-k">{f.name}</span>
              <span className="card__kv-v">{String(record[f.name]).slice(0, 90)}</span>
            </div>
          ))}
        </div>
      </article>
    );
  }

  const CARD_BY_KIND = {
    activity: ActivityCard,
    event: EventCard,
    generic: GenericCard,
    location: LocationCard,
    message: MessageCard,
    money: MoneyCard,
    photo: PhotoCard,
    reader: ReaderCard,
  };

  // ─── Stable color from a string (used for message-card avatars) ─────
  function avatarColor(s) {
    let h = 0;
    for (let i = 0; i < (s ?? "").length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(h) % 360;
    return `oklch(0.52 0.13 ${hue})`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FeedView — groups hits by day, picks a card per record's stream kind.
  // ═══════════════════════════════════════════════════════════════════════

  function FeedView({ hits, selectedId, onSelect, showDiscover, streams, onAddChip }) {
    // Group by day
    const groups = useMemo(() => {
      const out = [];
      let lastDay = null;
      for (const h of hits) {
        const iso = recordTimeISO(h.stream, h.record);
        const day = iso ? iso.slice(0, 10) : "__no_date__";
        if (day !== lastDay) {
          out.push({ day, items: [] });
          lastDay = day;
        }
        out[out.length - 1].items.push(h);
      }
      return out;
    }, [hits]);

    const memories = useMemo(
      () => (showDiscover ? window.PDPP_DISCOVER.findMemories(streams ?? []) : []),
      [showDiscover, streams]
    );
    const { DayStory, ActivityStrip, PeopleRail, MerchantRail, ChannelRail, YearStrip } = window.PDPP_DISCOVER ?? {};

    if (!hits.length) {
      return (
        <div className="feed">
          {showDiscover && DayStory ? (
            <>
              <DayStory streams={streams ?? []} />
              <ActivityStrip streams={streams ?? []} />
              <YearStrip onAddChip={onAddChip} streams={streams ?? []} />
              <PeopleRail onAddChip={onAddChip} streams={streams ?? []} />
              <MerchantRail onAddChip={onAddChip} streams={streams ?? []} />
              <ChannelRail onAddChip={onAddChip} streams={streams ?? []} />
              <div className="feed__empty">
                <div className="feed__empty-title">All caught up for today.</div>
                <div className="feed__empty-sub">
                  Pick a person, a merchant, or a channel above to wander further back.
                </div>
              </div>
            </>
          ) : (
            <div className="feed__empty">
              <div className="feed__empty-title">Nothing here.</div>
              <div className="feed__empty-sub">Remove a filter, or try semantic search.</div>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="feed">
        {showDiscover && DayStory ? (
          <>
            <DayStory streams={streams ?? []} />
            <ActivityStrip streams={streams ?? []} />
            <YearStrip onAddChip={onAddChip} streams={streams ?? []} />
            <PeopleRail onAddChip={onAddChip} streams={streams ?? []} />
            <MerchantRail onAddChip={onAddChip} streams={streams ?? []} />
            <ChannelRail onAddChip={onAddChip} streams={streams ?? []} />
          </>
        ) : null}
        {memories.length ? (
          <section className="memories">
            <header className="memories__head">
              <h2 className="memories__title">On this day</h2>
              <span className="memories__sub">
                {memories.length} memor{memories.length === 1 ? "y" : "ies"}
              </span>
            </header>
            <div className="memories__cards">
              {memories.map(({ stream, record, label }) => {
                const kind = cardKindForStream(stream);
                const Card = CARD_BY_KIND[kind] ?? GenericCard;
                return (
                  <div className="memory" key={`mem::${stream.connection_id}::${record.id}`}>
                    <div className="memory__label">{label}</div>
                    <Card
                      onClick={() => onSelect(stream, record)}
                      record={record}
                      selected={selectedId === record.id}
                      stream={stream}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        {groups.map(({ day, items }) => (
          <section className="feed__group" key={day}>
            <header className="feed__day">
              <h2 className="feed__day-label">{day === "__no_date__" ? "Undated" : fmtDay(day + "T12:00:00Z")}</h2>
              <span className="feed__day-count">{items.length}</span>
            </header>
            <div className="feed__cards">
              {items.map(({ stream, record }) => {
                const kind = cardKindForStream(stream);
                const Card = CARD_BY_KIND[kind] ?? GenericCard;
                return (
                  <Card
                    key={`${stream.connection_id}::${record.id}`}
                    onClick={() => onSelect(stream, record)}
                    record={record}
                    selected={selectedId === record.id}
                    stream={stream}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    );
  }

  window.FeedView = FeedView;
})();
