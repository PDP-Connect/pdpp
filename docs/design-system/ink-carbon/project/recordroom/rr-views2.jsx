/* RECORDROOM — full-surface views: Overview, Explore, Traces, Runs,
   Schedules, Sources, Connect, Deployment, Exporters, Subscriptions,
   plus the command palette. Data from window.RR2. */
;(() => {

const { useState, useEffect, useRef } = React;
const RR2 = window.RR2;

function CopyId({ id }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="pdpp-sheet__serial rr-copyid"
      onClick={() => {
        navigator.clipboard && navigator.clipboard.writeText(id);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      title="Copy id"
      type="button"
    >
      {done ? "copied" : id}
    </button>
  );
}

function MiniHead({ title, action, onAction }) {
  return (
    <div className="rr-mini-head">
      <h3 className="rr-mini-head__t">{title}</h3>
      {action && <button className="rr-link" onClick={onAction} type="button">{action} →</button>}
    </div>
  );
}

/* ─── Traces ─── */

function TraceList({ selected, onSelect, limit, traces }) {
  const rows = limit ? traces.slice(0, limit) : traces;
  return (
    <div className="pdpp-table rr-cols-traces">
      <div className="pdpp-table__hrow">
        <span className="pdpp-table__h">time</span>
        <span className="pdpp-table__h">client</span>
        <span className="pdpp-table__h">request</span>
        <span className="pdpp-table__h u-r">recs</span>
        <span className="pdpp-table__h u-r">fields</span>
        <span className="pdpp-table__h">ruling</span>
      </div>
      {rows.map((tr) => (
        <button
          className={"rr-trace-row" + (selected === tr.id ? " is-selected" : "")}
          key={tr.id}
          onClick={() => onSelect && onSelect(tr.id)}
          type="button"
        >
          <span className="rr-trace-row__t">{tr.t.slice(5, 16)}</span>
          <span className="rr-trace-row__who">{tr.client}</span>
          <span className="rr-trace-row__what">{tr.stream} · {tr.op}</span>
          <span className="rr-trace-row__n">{tr.records}</span>
          <span className="rr-trace-row__n">{tr.fields}</span>
          <span className={"rr-decide rr-decide--" + tr.decision}>{tr.decision}</span>
        </button>
      ))}
    </div>
  );
}

function TraceDetail({ trace }) {
  if (!trace) return null;
  return (
    <div className="pdpp-sheet rr-inspector">
      <div className="pdpp-sheet__head">
        <h3 className="pdpp-sheet__title" style={{ whiteSpace: "nowrap" }}>{trace.decision === "deny" ? "Refused" : "Served"} in {trace.dur}</h3>
        <CopyId id={trace.id} />
      </div>
      <div className="pdpp-sheet__body">
        <div className="rr-steps">
          {trace.steps.map(([k, v], i) => (
            <div className={"rr-step" + (k === "deny" ? " rr-step--deny" : "")} key={i}>
              <span className="rr-step__k">{k}</span>
              <span className="rr-step__v">{v}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="pdpp-sheet__foot">
        <span className="pdpp-typed-sm" style={{ color: "var(--muted-foreground)" }}>
          {trace.decision === "deny" ? "boundary held · " + trace.reason : "every response stays inside the grant"}
        </span>
      </div>
    </div>
  );
}

function TracesView() {
  const [sel, setSel] = useState(RR2.traces[3].id);
  const trace = RR2.traces.find((t) => t.id === sel);
  return (
    <div className="rr-content--split" style={{ display: "grid" }}>
      <TraceList onSelect={setSel} selected={sel} traces={RR2.traces} />
      <TraceDetail trace={trace} />
    </div>
  );
}

/* ─── Overview ─── */

function OverviewView({ pending, onReview, onGo, grantsSummary }) {
  return (
    <div className="rr-ov">
      {pending && (
        <div className="rr-hero pdpp-carbon">
          <div className="rr-hero__sheet">
            <span className="rr-hero__text">
              <span className="pdpp-eyebrow">Access request · staged · waiting on you</span>
              <h2 className="rr-hero__title">Atlas Mortgage asks to read 3 streams</h2>
              <span className="rr-hero__meta">req_atlas_7f2k · purpose: mortgage_preapproval · nothing crosses until you decide</span>
            </span>
            <button className="pdpp-btn" onClick={onReview} type="button">Review request</button>
          </div>
        </div>
      )}
      <div className="pdpp-band">
        <div className="pdpp-band__cell"><span className="pdpp-band__v">10</span><span className="pdpp-band__k">connections</span></div>
        <div className="pdpp-band__cell"><span className="pdpp-band__v">34</span><span className="pdpp-band__k">streams</span></div>
        <div className="pdpp-band__cell"><span className="pdpp-band__v">48,120</span><span className="pdpp-band__k">records</span></div>
        <div className="pdpp-band__cell"><span className="pdpp-band__v">{grantsSummary}</span><span className="pdpp-band__k">grants in effect</span></div>
        <div className="pdpp-band__cell"><span className="pdpp-band__v">14</span><span className="pdpp-band__k">reads this week</span></div>
      </div>
      <div className="rr-ov__grid">
        <div>
          <MiniHead action="all traces" onAction={() => onGo("traces")} title="Latest traces" />
          <TraceList limit={4} traces={RR2.traces} />
        </div>
        <div>
          <MiniHead action="syncs" onAction={() => onGo("syncs")} title="Needs attention" />
          {window.RRAttentionList ? <window.RRAttentionList onGo={onGo} /> : null}
        </div>
      </div>
    </div>
  );
}

/* ─── Explore ─── */

function ExploreView() {
  return (
    <div>
      <div className="pdpp-table rr-cols-feed">
        <div className="pdpp-table__hrow">
          <span className="pdpp-table__h">arrived</span>
          <span className="pdpp-table__h">stream</span>
          <span className="pdpp-table__h">record</span>
          <span className="pdpp-table__h u-r">id</span>
        </div>
        {RR2.feed.map((r) => (
          <div className="rr-feed-row" key={r.id}>
            <span className="rr-feed-row__t">{r.t}</span>
            <span className="rr-feed-row__stream">{r.stream}</span>
            <span className="rr-feed-row__body">{r.body}</span>
            <span className="rr-feed-row__id">{r.id}</span>
          </div>
        ))}
      </div>
      <p className="pdpp-typed-sm" style={{ color: "var(--muted-foreground)", marginTop: 12 }}>
        newest first · the feed is your own data arriving — nothing here has crossed to anyone
      </p>
    </div>
  );
}

/* ─── Sources ─── */

function SourcesView() {
  return (
    <div className="rr-attn">
      {RR2.sources.map((s) => (
        <div className="rr-attn__row" key={s.name}>
          <span className="rr-attn__name">{s.name}</span>
          <span className="rr-attn__detail">{s.kind} · {s.streams} · last sync {s.last}</span>
          <span className="rr-attn__side">
            {s.authOk
              ? <span className="pdpp-endorse pdpp-endorse--active">auth ok</span>
              : <span className="pdpp-endorse pdpp-endorse--denied">reauthorize</span>}
            <span className="rr-attn__meta">{s.auth}</span>
          </span>
        </div>
      ))}
      <div className="rr-end">
        <button className="rr-link" type="button">add a source →</button>
        <span className="rr-end__note">a source pushes into your streams · nothing leaves</span>
      </div>
    </div>
  );
}

/* ─── Runs ─── */

function RunsView() {
  return (
    <div>
      <div className="pdpp-table rr-cols-runs">
        <div className="pdpp-table__hrow">
          <span className="pdpp-table__h">connector</span>
          <span className="pdpp-table__h">stream · result</span>
          <span className="pdpp-table__h">status</span>
          <span className="pdpp-table__h u-r">took</span>
          <span className="pdpp-table__h u-r">started</span>
        </div>
        {RR2.runs.map((r) => (
          <div className="pdpp-data-row" key={r.id} style={{ "--cols": "inherit" }}>
            <span className="pdpp-data-row__who">
              <span className="pdpp-data-row__title">{r.connector}</span>
              <span className="pdpp-data-row__id">{r.id}</span>
            </span>
            <span className="pdpp-data-row__detail">
              {r.stream} · {r.upserts} upserts · cursor {r.cursor}{r.note ? " · " + r.note : ""}
            </span>
            {r.status === "ok"
              ? <span className="pdpp-endorse pdpp-endorse--active">ok</span>
              : <span className="pdpp-endorse pdpp-endorse--denied">failed</span>}
            <span className="pdpp-data-row__meta">{r.dur}</span>
            <span className="pdpp-data-row__meta">{r.started.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Schedules ─── */

function SchedulesView() {
  return (
    <div>
      <div className="pdpp-table rr-cols-schedules">
        <div className="pdpp-table__hrow">
          <span className="pdpp-table__h">stream</span>
          <span className="pdpp-table__h">cadence</span>
          <span className="pdpp-table__h">last run</span>
          <span className="pdpp-table__h u-r">next run</span>
        </div>
        {RR2.schedules.map((s, i) => (
          <div className="pdpp-data-row" key={i} style={{ "--cols": "inherit" }}>
            <span className="pdpp-data-row__who">
              <span className="pdpp-data-row__title">{s.stream}</span>
              <span className="pdpp-data-row__id">{s.connector}</span>
            </span>
            <span className="pdpp-data-row__detail">{s.cadence}</span>
            {s.last === "ok"
              ? <span className="pdpp-endorse pdpp-endorse--active">last ok</span>
              : <span className="pdpp-endorse pdpp-endorse--denied">last failed</span>}
            <span className="pdpp-data-row__meta">next {s.next}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectView() {
  return (
    <div className="rr-attn">
      {RR2.apps.map((a) => (
        <div className="rr-attn__row" key={a.name}>
          <span className="rr-attn__name">{a.name}</span>
          <span className="rr-attn__detail">{a.via} · {a.detail}</span>
          <span className="rr-attn__side">
            {a.status === "connected"
              ? <span className="pdpp-endorse pdpp-endorse--active">connected</span>
              : <span className="pdpp-endorse pdpp-endorse--expiring">pending code</span>}
            <span className="rr-attn__meta">{a.status === "connected" ? "since " + a.added : "device flow"}</span>
          </span>
        </div>
      ))}
      <div className="rr-end">
        <button className="rr-link" type="button">connect an app →</button>
        <span className="rr-end__note">apps read through grants — never more than the grant behind them</span>
      </div>
    </div>
  );
}

/* ─── Deployment ─── */

function DeploymentView() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <div>
        <MiniHead title="Readiness" />
        <div>
          {RR2.checks.map((c) => (
            <div className={"rr-check " + (c.ok ? "rr-check--ok" : "rr-check--warn")} key={c.name}>
              <span className="rr-check__glyph">{c.ok ? "ok" : "check"}</span>
              <span className="rr-check__name">{c.name}</span>
              <span className="rr-check__detail">{c.detail}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <MiniHead title="Owner tokens" />
        <div className="rr-attn">
          {RR2.tokens.map((t) => (
            <div className="rr-attn__row" key={t.id}>
              <span className="rr-attn__name">{t.label}</span>
              <span className="rr-attn__detail">{t.id} · created {t.created} · for the operator and trusted local agents only</span>
              <span className="rr-attn__side">
                <span className="pdpp-endorse pdpp-endorse--continuous">active</span>
                <span className="rr-attn__meta">last used {t.last}</span>
              </span>
            </div>
          ))}
          <div className="rr-end">
            <button className="rr-link" type="button">issue a token →</button>
            <span className="rr-end__note">owner tokens bypass grants · issue sparingly</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Device exporters / Event subscriptions ─── */

function ExportersView() {
  return (
    <div className="rr-attn">
      {RR2.exporters.map((e) => (
        <div className="rr-attn__row" key={e.device}>
          <span className="rr-attn__name">{e.device}</span>
          <span className="rr-attn__detail">pushes to your server — nothing transits a third party · {e.records} records</span>
          <span className="rr-attn__side">
            {e.status === "ok"
              ? <span className="pdpp-endorse pdpp-endorse--active">exporting</span>
              : <span className="pdpp-endorse pdpp-endorse--revoked">paused</span>}
            <span className="rr-attn__meta">{e.last}</span>
          </span>
        </div>
      ))}
      <div className="rr-end">
        <button className="rr-link" type="button">pair a device →</button>
        <span className="rr-end__note">device flow · approve the code on this console</span>
      </div>
    </div>
  );
}

function SubscriptionsView() {
  return (
    <div className="rr-attn">
      {RR2.subscriptions.map((s) => (
        <div className="rr-attn__row" key={s.url}>
          <span className="rr-attn__name rr-attn__name--mono">{s.url}</span>
          <span className="rr-attn__detail">{s.events}</span>
          <span className="rr-attn__side">
            <span className="pdpp-endorse pdpp-endorse--continuous">{s.status}</span>
          </span>
        </div>
      ))}
      <div className="rr-end">
        <button className="rr-link" type="button">add a webhook →</button>
        <span className="rr-end__note">fires on protocol events · grant.created · grant.revoked · run.failed</span>
      </div>
    </div>
  );
}

/* ─── Command palette ─── */

function CommandPalette({ open, onClose, items, recents = [], onExec }) {
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { if (open) { setQ(""); setHl(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 30); } }, [open]);
  if (!open) return null;
  const ql = q.toLowerCase();
  function score(it) {
    const hay = (it.label + " " + it.kind).toLowerCase();
    if (!hay.includes(ql)) return -1;
    let s = it.label.toLowerCase().startsWith(ql) ? 3 : 1;
    if (it.kind === "action") s += 0.5;
    return s;
  }
  let filtered;
  if (!q) {
    const rec = recents.map((l) => items.find((i) => i.label === l)).filter(Boolean).map((i) => ({ ...i, kind: "recent" }));
    const rest = items.filter((i) => !recents.includes(i.label));
    filtered = [...rec, ...rest].slice(0, 9);
  } else {
    filtered = items
      .map((i) => [score(i), i])
      .filter(([s]) => s >= 0)
      .sort((a, b) => b[0] - a[0])
      .map(([, i]) => i)
      .slice(0, 9);
  }
  function choose(it) {
    it.run();
    onExec && onExec(it.label);
    onClose();
  }
  function onKey(e) {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(h + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
    if (e.key === "Enter" && filtered[hl]) choose(filtered[hl]);
  }
  return (
    <div className="rr-palette-overlay" onClick={onClose}>
      <div className="rr-palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="rr-palette__input"
          onChange={(e) => { setQ(e.target.value); setHl(0); }}
          onKeyDown={onKey}
          placeholder="Jump to a view, grant, stream, or action…"
          ref={inputRef}
          value={q}
        />
        <div className="rr-palette__list">
          {filtered.length === 0 && <div className="rr-palette__empty">Nothing matches — the record is honest about that.</div>}
          {filtered.map((it, i) => (
            <button
              className={"rr-palette__item" + (i === hl ? " is-hl" : "")}
              key={it.kind + it.label}
              onClick={() => choose(it)}
              onMouseEnter={() => setHl(i)}
              type="button"
            >
              <span>{it.label}</span>
              <span className="rr-palette__kind">{it.kind}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  RRTracesView: TracesView,
  RROverviewView: OverviewView,
  RRSourcesView: SourcesView,
  RRRunsView: RunsView,
  RRSchedulesView: SchedulesView,
  RRConnectView: ConnectView,
  RRDeploymentView: DeploymentView,
  RRExportersView: ExportersView,
  RRSubscriptionsView: SubscriptionsView,
  RRCommandPalette: CommandPalette,
});
})();
