// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* RECORDROOM — Explore: the reading room. One record viewer for the whole
   product. Owner-grade query power (typed operators, machine-parity query
   line), instance-true facets, full fields always, relationships, images.
   Sources is the loading dock; it links INTO this view, never duplicates it. */
;(() => {

const { useState, useEffect, useMemo } = React;
const RRX = window.RRX;
const { labelFor, nounFor, displayTitle, RecordBody } = window.RRREC;

const conById = {};
RRX.connections.forEach((c) => { conById[c.id] = c; });
const recById = {};
RRX.records.forEach((r) => { recById[r.id] = r; });

/* Reverse links: every relationship reads in both directions. */
const backlinks = {};
RRX.records.forEach((r) => {
  (r.links || []).forEach(([rel, id]) => {
    backlinks[id] = backlinks[id] || [];
    backlinks[id].push(["linked from " + r.stream, r.id]);
  });
});

function CopyMono({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="pdpp-sheet__serial rr-copyid"
      onClick={() => {
        navigator.clipboard && navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
      title="Copy"
      type="button"
    >
      {ok ? "copied" : text}
    </button>
  );
}

/* ── Query language: free text + typed operators, the same axes the RS
   API exposes. con: stream: role: has:image|link  is:folded  before:/after:
   <date>  field:value (matches any field key~value). Everything composes. */
function parseQuery(q) {
  const out = { text: [], con: null, stream: null, role: null, hasImage: false, hasLink: false, folded: false, before: null, after: null, fields: [], tokens: [] };
  q.trim().split(/\s+/).filter(Boolean).forEach((tok) => {
    const m = tok.match(/^([a-z_]+):(.+)$/i);
    if (!m) { out.text.push(tok.toLowerCase()); out.tokens.push({ raw: tok, label: tok }); return; }
    const k = m[1].toLowerCase(), v = m[2], kv = v.toLowerCase();
    if (k === "con") { out.con = kv; out.tokens.push({ raw: tok, label: "in " + v }); }
    else if (k === "stream") { out.stream = kv; out.tokens.push({ raw: tok, label: "stream: " + v }); }
    else if (k === "role") { out.role = kv; out.tokens.push({ raw: tok, label: "role: " + v }); }
    else if (k === "has" && kv === "image") { out.hasImage = true; out.tokens.push({ raw: tok, label: "has image" }); }
    else if (k === "has" && kv === "link") { out.hasLink = true; out.tokens.push({ raw: tok, label: "has link" }); }
    else if (k === "is" && kv === "folded") { out.folded = true; out.tokens.push({ raw: tok, label: "folded" }); }
    else if (k === "before") { out.before = v; out.tokens.push({ raw: tok, label: "before " + v }); }
    else if (k === "after") { out.after = v; out.tokens.push({ raw: tok, label: "after " + v }); }
    else { out.fields.push([k, kv]); out.tokens.push({ raw: tok, label: k + ": " + v }); }
  });
  return out;
}

function ExploreView({ grants, onGo, onJump, seed }) {
  const [q, setQ] = useState("");
  const [range, setRange] = useState("all");
  const [conSel, setConSel] = useState(null);
  const [streamSel, setStreamSel] = useState(null);
  const [sel, setSel] = useState(RRX.records[0].id);
  const [lens, setLens] = useState(null);
  const [partialOpen, setPartialOpen] = useState(false);

  /* Sources hands off here with a preselected instance/stream. */
  useEffect(() => {
    if (!seed) return;
    setConSel(seed.con || null);
    setStreamSel(seed.stream || null);
    setQ("");
    setRange("all");
  }, [seed && seed.n]);

  const parsed = useMemo(() => parseQuery(q), [q]);
  const [sort, setSort] = useState("newest");

  function passes(r, opts) {
    opts = opts || {};
    const con = conById[r.con];
    if (!opts.ignoreCon && conSel && r.con !== conSel) return false;
    if (!opts.ignoreStream && streamSel && r.stream !== streamSel) return false;
    if (range === "today" && r.day !== RRX.now) return false;
    if (range === "7d" && r.day < "2026-06-06") return false;
    if (range === "30d" && r.day < "2026-05-13") return false;
    if (parsed.con && !(con.name.toLowerCase().includes(parsed.con) || r.con === parsed.con)) return false;
    if (parsed.stream && r.stream !== parsed.stream) return false;
    if (parsed.role && r.role !== parsed.role) return false;
    if (parsed.hasImage && !r.image) return false;
    if (parsed.hasLink && !(r.links && r.links.length)) return false;
    if (parsed.folded && !r.fold) return false;
    if (parsed.before && !(r.day < parsed.before)) return false;
    if (parsed.after && !(r.day > parsed.after)) return false;
    if (parsed.fields.length) {
      const fm = r.fields || [];
      if (!parsed.fields.every(([k, v]) => fm.some(([fk, fv]) => fk.toLowerCase().includes(k) && String(fv).toLowerCase().includes(v)))) return false;
    }
    if (parsed.text.length) {
      const ft = (r.fields || []).map((f) => f[0] + " " + f[1]).join(" ");
      const hay = (r.title + " " + (r.snippet || "") + " " + r.stream + " " + con.name + " " + ft).toLowerCase();
      if (!parsed.text.every((t) => hay.includes(t))) return false;
    }
    return true;
  }

  const rows = useMemo(() => {
    let list = RRX.records.filter((r) => passes(r));
    if (sort === "oldest") list = [...list].reverse();
    return list;
  }, [parsed, range, conSel, streamSel, sort]);

  const recordCount = rows.reduce((n, r) => n + (r.fold || 1), 0);

  /* The machine-parity line: the exact call this view is making. */
  const compiled = useMemo(() => {
    const parts = [];
    if (conSel || parsed.con) parts.push("connection=" + (conSel ? conById[conSel].cin : parsed.con));
    if (streamSel || parsed.stream) parts.push("stream=" + (streamSel || parsed.stream));
    if (parsed.role) parts.push("role=" + parsed.role);
    if (parsed.hasImage) parts.push("content_type=image/*");
    if (parsed.hasLink) parts.push("has=link");
    if (parsed.folded) parts.push("folded=true");
    if (parsed.before) parts.push("before=" + parsed.before);
    if (parsed.after) parts.push("after=" + parsed.after);
    parsed.fields.forEach(([k, v]) => parts.push(k + "~" + v));
    if (range === "today") parts.push("since=" + RRX.now);
    else if (range === "7d") parts.push("since=2026-06-06");
    else if (range === "30d") parts.push("since=2026-05-13");
    if (parsed.text.length) parts.push("match=" + parsed.text.join("+"));
    parts.push("order=" + sort, "limit=50");
    return "GET /v1/records?" + parts.join("&");
  }, [parsed, range, conSel, streamSel, sort]);

  /* Streams facet: instance-true when a connection is selected;
     otherwise an explicit NAME-match filter (overlap is incidental). */
  const streamFacets = useMemo(() => {
    if (conSel) return conById[conSel].streams.map((s) => [s.name, s.records]);
    const m = {};
    RRX.connections.forEach((c) => c.streams.forEach((s) => {
      m[s.name] = (m[s.name] || 0) + 1;
    }));
    return Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  }, [conSel]);

  const rec = recById[sel] || rows[0] || RRX.records[0];
  const recCon = conById[rec.con];
  const watchers = grants.filter((g) => g.status !== "revoked" && g.projections && g.projections[rec.stream]);
  const lensGrant = lens ? watchers.find((g) => g.id === lens) : null;
  const proj = lensGrant && rec.fields ? lensGrant.projections[rec.stream] : null;
  const baseFields = rec.fields || [];
  const shown = proj ? baseFields.filter(([k]) => proj.includes(k)) : baseFields;
  const kept = proj ? baseFields.filter(([k]) => !proj.includes(k)) : [];
  const fwdIds = new Set((rec.links || []).map(([, id]) => id));
  const related = [...(rec.links || []).map(([rel, id]) => [rel, id]), ...(backlinks[rec.id] || []).filter(([, id]) => !fwdIds.has(id))]
    .filter(([, id]) => recById[id]);

  useEffect(() => { setLens(null); }, [sel]);

  useEffect(() => {
    function onKey(e) {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (document.querySelector(".rr-overlay, .rr-palette-overlay")) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const i = rows.findIndex((r) => r.id === sel);
      const n = e.key === "ArrowDown" ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0);
      if (rows[n]) setSel(rows[n].id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, sel]);

  const showPartial = !conSel || conSel === RRX.partial.con;
  const partialCon = conById[RRX.partial.con];

  const activeChips = [];
  if (conSel) activeChips.push({ id: "con", label: conById[conSel].name, clear: () => setConSel(null) });
  if (streamSel) activeChips.push({ id: "stream", label: "stream: " + streamSel, clear: () => setStreamSel(null) });
  if (range !== "all") activeChips.push({ id: "range", label: range, clear: () => setRange("all") });
  parsed.tokens.forEach((tk, i) => activeChips.push({ id: "tok" + i, label: tk.label, clear: () => setQ(q.split(/\s+/).filter((x) => x !== tk.raw).join(" ")) }));
  const clearAll = () => { setConSel(null); setStreamSel(null); setRange("all"); setQ(""); };

  return (
    <div className="rr-x">
      {/* ── Facet rail ── */}
      <aside className="rr-x-rail">
        <div className="rr-x-facets">
          <span className="rr-x-facets__label">Connections</span>
          {RRX.connections.map((c) => {
            const n = RRX.records.filter((r) => r.con === c.id && passes(r, { ignoreCon: true })).length;
            return (
              <button
                className={"rr-x-facet" + (conSel === c.id ? " is-on" : "") + (c.status === "revoked" ? " is-revoked" : "")}
                key={c.id}
                onClick={() => { setConSel(conSel === c.id ? null : c.id); setStreamSel(null); }}
                type="button"
              >
                <span className="rr-x-facet__name">{c.name}</span>
                {c.status === "revoked" && <span className="rr-x-facet__flag">off</span>}
                {c.status === "reauth" && <span className="rr-x-facet__flag is-warn">auth</span>}
                <span className="rr-x-facet__n">{n || "—"}</span>
              </button>
            );
          })}
        </div>
        <div className="rr-x-facets">
          <span className="rr-x-facets__label">
            {conSel ? "Streams — " + conById[conSel].name : "Stream names"}
          </span>
          {!conSel && <span className="rr-x-facets__note">names overlap across connections — this filters by name</span>}
          {streamFacets.map(([s, n]) => (
            <button
              className={"rr-x-facet" + (streamSel === s ? " is-on" : "")}
              key={s}
              onClick={() => setStreamSel(streamSel === s ? null : s)}
              type="button"
            >
              <span className="rr-x-facet__name rr-x-facet__name--mono">{s}</span>
              <span className="rr-x-facet__n">{conSel ? n : n + " conn"}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* ── Feed ── */}
      <div className="rr-x-main">
        <div className="rr-x-controls">
          <div className="rr-x-searchrow">
            <input
              className="pdpp-input rr-x-search"
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search names, fields, and values — or type an operator"
              type="text"
              value={q}
            />
            <div className="rr-x-sort">
              <span className="rr-x-sort__label">sort</span>
              <button className={"rr-lens" + (sort === "newest" ? " is-on" : "")} onClick={() => setSort("newest")} type="button">newest</button>
              <button className={"rr-lens" + (sort === "oldest" ? " is-on" : "")} onClick={() => setSort("oldest")} type="button">oldest</button>
            </div>
          </div>
          <div className="rr-x-ranges">
            {[["today", "today"], ["7d", "7d"], ["30d", "30d"], ["all", "all"]].map(([v, label]) => (
              <button
                className={"rr-lens" + (range === v ? " is-on" : "")}
                key={v}
                onClick={() => setRange(v)}
                type="button"
              >
                {label}
              </button>
            ))}
            <details className="rr-x-help">
              <summary>operators</summary>
              <div className="rr-x-help__body">
                <code>con:</code> <code>stream:</code> <code>role:</code> <code>has:image</code> <code>has:link</code> <code>is:folded</code> <code>before:2026-06-11</code> <code>after:2026-06-10</code> <code>merchant:coffee</code> — combine freely; everything composes.
              </div>
            </details>
            <button className="rr-link rr-x-jump" onClick={onJump} type="button">jump to an id →</button>
          </div>
          {activeChips.length > 0 && (
            <div className="rr-x-active">
              {activeChips.map((c) => (
                <button className="rr-x-chip" key={c.id} onClick={c.clear} type="button">
                  {c.label}<span className="rr-x-chip__x">×</span>
                </button>
              ))}
              <button className="rr-x-clearall" onClick={clearAll} type="button">clear all</button>
            </div>
          )}
          <div className="rr-x-compiled">
            <span className="rr-x-compiled__label">the same call any client makes:</span>
            <CopyMono text={compiled} />
          </div>
        </div>

        <p className="rr-x-pulse__note">{recordCount} records shown · {RRX.totalOnServer} on your server</p>

        {showPartial && (
          <div className="rr-x-partial">
            <button className="rr-x-partial__head" onClick={() => setPartialOpen(!partialOpen)} type="button">
              <span className="rr-x-partial__line">Partial view — {partialCon.name} didn't answer for {RRX.partial.streams.length} streams</span>
              <span className="rr-x-partial__toggle">{partialOpen ? "less" : "why"}</span>
            </button>
            {partialOpen && (
              <div className="rr-x-partial__body">
                <p className="rr-x-partial__expl">
                  This connection was revoked {RRX.partial.revokedOn}. Its streams ({RRX.partial.streams.join(", ")}) refuse
                  new reads — that's the revocation holding, not a fault. Records ingested before revocation remain on your server.
                </p>
                <code className="rr-x-partial__raw">{RRX.partial.raw}</code>
                <button className="rr-link" onClick={() => onGo("sources")} type="button">review in Sources →</button>
              </div>
            )}
          </div>
        )}

        {RRX.days.map(([day, label]) => {
          const dayRows = rows.filter((r) => r.day === day);
          if (dayRows.length === 0) return null;
          return (
            <div className="rr-x-day" key={day}>
              <div className="rr-x-day__head">
                <span className="rr-x-day__label">{label}</span>
                <span className="rr-x-day__n">{dayRows.reduce((n, r) => n + (r.fold || 1), 0)}</span>
              </div>
              {dayRows.map((r) => (
                <button
                  className={"rr-x-row" + (sel === r.id ? " is-selected" : "") + (r.fold ? " is-fold" : "")}
                  key={r.id}
                  onClick={() => setSel(r.id)}
                  type="button"
                >
                  <span className="rr-x-row__attr">
                    <span className="rr-x-row__stream">{r.stream}</span>
                    <span className="rr-x-row__con">{conById[r.con].name}</span>
                    <span className="rr-x-row__rel">{r.rel}</span>
                  </span>
                  <span className={"rr-x-row__title" + (r.degraded ? " is-derived" : "")}>
                    {r.fold ? <span className="rr-x-mark">folded</span> : null}
                    {r.image ? <span className="rr-x-mark">image</span> : null}
                    {(() => { const dt = displayTitle(r); return dt.kicker
                      ? <React.Fragment><span className="rr-x-kicker">{dt.kicker}</span>{dt.primary}</React.Fragment>
                      : dt.primary; })()}
                  </span>
                  {(r.role || r.snippet) && (
                    <span className="rr-x-row__snippet">
                      {r.role && <span className="rr-x-role">{r.role}</span>}
                      {r.snippet}
                    </span>
                  )}
                </button>
              ))}
            </div>
          );
        })}

        {rows.length === 0 && (
          <div className="rr-x-empty">
            <span className="rr-x-empty__line">Nothing matches{q ? ` \u201c${q}\u201d` : ""} in this window.</span>
            <button className="rr-link" onClick={() => { setQ(""); setConSel(null); setStreamSel(null); setRange("all"); }} type="button">clear filters →</button>
          </div>
        )}
      </div>

      {/* ── The record sheet — the product's ONLY record viewer ── */}
      <div className="rr-inspector">
        <div className="rr-anim-swap" key={rec.id + (lens || "you")}>
          <div className="pdpp-sheet">
            <div className="pdpp-sheet__head">
              <h3 className="pdpp-sheet__title rr-x-sheet-title">
                {(() => { const dt = displayTitle(rec); return dt.kicker
                  ? <React.Fragment><span className="rr-x-kicker">{dt.kicker}</span>{dt.primary}</React.Fragment>
                  : dt.primary; })()}
              </h3>
              <CopyMono text={rec.id} />
            </div>

            {watchers.length > 0 && (
              <div className="rr-ex-lens">
                <span className="rr-ex-lens__label">read it as</span>
                <button className={"rr-lens" + (!lens ? " is-on" : "")} onClick={() => setLens(null)} type="button">you</button>
                {watchers.map((g) => (
                  <button
                    className={"rr-lens" + (lens === g.id ? " is-on" : "")}
                    key={g.id}
                    onClick={() => setLens(lens === g.id ? null : g.id)}
                    type="button"
                  >
                    {g.client}
                  </button>
                ))}
              </div>
            )}
            {watchers.length === 0 && (
              <p className="rr-ex-alone"><b>Only you can read this.</b> No grant covers {rec.stream} on {recCon.name} — nothing here crosses.</p>
            )}

            <div className="pdpp-sheet__body">
              <RecordBody pairs={shown} rec={rec} />
              {rec.fold && (
                <p className="rr-x-foldnote">Folded in the feed — every call is kept in the stream, unabridged.</p>
              )}
              {rec.degraded && (
                <p className="rr-x-foldnote">Title derived from the fields below — every field is listed.</p>
              )}
              {kept.length > 0 && (
                <div className="rr-ex-keep">
                  <span className="rr-ex-keep__label">Stays with you</span>
                  <span className="rr-ex-keep__fields">{kept.map(([k]) => labelFor(k)).join(" · ")}</span>
                  <span className="rr-ex-keep__note">{kept.length} {kept.length === 1 ? "field" : "fields"} never leave your server — never sent, not blacked out.</span>
                </div>
              )}
              {related.length > 0 && (
                <div className="rr-x-rel">
                  <span className="rr-ex-keep__label">Connected</span>
                  {related.map(([relName, id]) => {
                    const dt = displayTitle(recById[id]);
                    return (
                      <button className="rr-x-rel__row" key={relName + id} onClick={() => setSel(id)} type="button">
                        <span className="rr-x-rel__k">{relName}</span>
                        <span className="rr-x-rel__v">{dt.kicker ? dt.kicker + " · " + dt.primary : dt.primary}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="pdpp-sheet__foot">
              {proj ? (
                <span className="pdpp-copyline">{shown.length} of {baseFields.length} fields cross to {lensGrant.client} · enforced on every read</span>
              ) : (
                <span className="pdpp-typed-sm" style={{ color: "var(--muted-foreground)" }}>
                  {baseFields.length} fields · readable by you
                  {watchers.length > 0 ? ` · ${watchers.length} ${watchers.length === 1 ? "grant reads" : "grants read"} a projection` : ""}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { RRExploreView: ExploreView });
})();
