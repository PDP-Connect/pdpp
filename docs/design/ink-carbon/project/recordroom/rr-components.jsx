/* RECORDROOM — view components. Data lives in rr-app.jsx; these render it. */
;(() => {

const { useState, useEffect } = React;

/* ─── Shared bits ─── */

function Endorse({ status, hours }) {
  const map = {
    active: ["pdpp-endorse--active", "active"],
    continuous: ["pdpp-endorse--continuous", "continuous"],
    expiring: ["pdpp-endorse--expiring", `expiring ${hours}h`],
    revoked: ["pdpp-endorse--revoked", "revoked"],
  };
  const [cls, label] = map[status] || map.active;
  return <span className={"pdpp-endorse " + cls}>{label}</span>;
}

function Sidebar({ view, onView, counts }) {
  const items = [
    ["grants", "Grants", counts.grants],
    ["streams", "Streams", counts.streams],
    ["activity", "Activity", counts.activity],
  ];
  return (
    <aside className="rr-side">
      <div className="rr-side__brand">
        <span className="rr-side__mark"></span>
        <span className="rr-side__name">Recordroom</span>
      </div>
      <nav className="rr-side__nav">
        {items.map(([id, label, n]) => (
          <button
            className={"rr-nav-item" + (view === id ? " is-active" : "")}
            key={id}
            onClick={() => onView(id)}
            type="button"
          >
            <span>{label}</span>
            <span className="rr-nav-item__count">{n}</span>
          </button>
        ))}
      </nav>
      <div className="rr-side__spacer"></div>
      <div className="rr-side__foot">
        <span className="rr-side__owner">M. Okafor</span>
        <span className="rr-side__host">rs.okafor.recordroom.net · pdpp 0.1.0</span>
      </div>
    </aside>
  );
}

function SidebarFull({ view, onView, nav, counts }) {
  return (
    <aside className="rr-side">
      <div className="rr-side__brand">
        <span className="rr-side__mark"></span>
        <span className="rr-side__name">Recordroom</span>
      </div>
      <nav className="rr-side__nav" style={{ overflowY: "auto" }}>
        {nav.map((item, i) =>
          item.group ? (
            <div className="rr-side__group" key={"g" + i}>{item.group}</div>
          ) : (
            <button
              className={"rr-nav-item" + (view === item.id ? " is-active" : "")}
              key={item.id}
              onClick={() => onView(item.id)}
              type="button"
            >
              <span>{item.label}</span>
              {item.id === "grants" && <span className="rr-nav-item__count">{counts.grants}</span>}
              {item.id === "traces" && <span className="rr-nav-item__count">{counts.traces}</span>}
            </button>
          )
        )}
      </nav>
      <div className="rr-side__spacer"></div>
      <div className="rr-side__foot">
        <span className="rr-side__owner">M. Okafor</span>
        <span className="rr-side__host">rs.okafor.recordroom.net · pdpp 0.1.0</span>
        <span className="rr-side__motto">your data, at home</span>
        <div className="rr-env">
          <span className="rr-env__row"><span className="rr-env__dot"></span><span className="rr-env__label">AS</span><span className="rr-env__url">as.okafor.recordroom.net</span></span>
          <span className="rr-env__row"><span className="rr-env__dot"></span><span className="rr-env__label">RS</span><span className="rr-env__url">rs.okafor.recordroom.net</span></span>
        </div>
      </div>
    </aside>
  );
}

/* ─── Grants view ─── */

function monogram(name) {
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

function GrantRow({ grant, selected, onSelect }) {
  const cls =
    "pdpp-data-row" +
    (grant.status === "revoked" ? " pdpp-data-row--revoked" : "") +
    (grant.justAdded ? " pdpp-data-row--landed" : "");
  return (
    <button
      className={"rr-row-btn" + (selected ? " is-selected" : "")}
      onClick={() => onSelect(grant.id)}
      type="button"
    >
      <div className={cls} style={{ "--cols": "inherit" }}>
        <span className="pdpp-monogram">{monogram(grant.client)}</span>
        <span className="pdpp-data-row__who">
          <span className="pdpp-data-row__title">{grant.client}</span>
          <span className="pdpp-data-row__id">{grant.id}</span>
        </span>
        <span className="pdpp-data-row__detail">{grant.scopes.map((s) => s.name).join(" · ")}</span>
        <span><Endorse hours={grant.hoursLeft} status={grant.status} /></span>
        <span className="pdpp-data-row__meta">{grant.status === "revoked" ? grant.revokedOn : grant.expiry}</span>
      </div>
    </button>
  );
}

function fmtToken(v) {
  // allow long protocol identifiers to wrap at their own joints
  return String(v).split("_").join("_\u200b");
}

const STREAM_HUMAN = {
  pay_statements: "Your pay",
  employment: "Your work history",
  transactions: "Your spending",
  listening_history: "Your listening",
  tax_docs: "Your tax documents",
  browsing: "Your browsing",
};

function Inspector({ grant, streams, log, revoking, striking, onRevokeStart, onRevokeConfirm, onRevokeCancel }) {
  if (!grant) {
    return (
      <div className="rr-inspector">
        <div className="rr-inspector__empty">Select a grant to read your copy.</div>
      </div>
    );
  }
  const revoked = grant.status === "revoked";
  const granted = grant.scopes.map((s) => {
    const sid = s.name.split(".")[0];
    const stream = (streams || []).find((x) => x.id === sid);
    const proj = (grant.projections && grant.projections[sid]) || [];
    const dropped = stream ? stream.fields.filter((f) => !proj.includes(f)) : [];
    return { sid, s, proj, total: stream ? stream.fields.length : null, dropped };
  });
  const reads = (log || []).filter((e) => e.ref === grant.id && e.kind === "read");
  return (
    <div className="rr-inspector">
      <div className="pdpp-carbon rr-anim-swap" key={grant.id}>
        <div className="pdpp-sheet">
          <div className="pdpp-sheet__head">
            <h3 className="pdpp-sheet__title" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <span className={"rr-strikeable" + (striking ? " rr-strike-go" : "")}>
                {grant.client}
                <span className="rr-strikeable__line"></span>
              </span>
            </h3>
            <span className="pdpp-sheet__serial">{grant.id}</span>
          </div>
          <div className="pdpp-sheet__body">
            <div className="pdpp-kv">
              <div className="pdpp-kv__row">
                <span className="pdpp-kv__k">status</span>
                <span className="pdpp-kv__v"><Endorse hours={grant.hoursLeft} status={grant.status} /></span>
              </div>
              <div className="pdpp-kv__row">
                <span className="pdpp-kv__k">purpose</span>
                <span className="pdpp-kv__v">{fmtToken(grant.purpose)}</span>
              </div>
              <div className="pdpp-kv__row">
                <span className="pdpp-kv__k">{revoked ? "revoked" : "expires"}</span>
                <span className="pdpp-kv__v">{revoked ? grant.revokedFull : grant.expiresFull}</span>
              </div>
            </div>

            <div className="rr-insp-label">What {grant.client.split(" ")[0]} can assemble</div>
            {granted.map(({ sid, s, proj, total }) => (
              <div className="rr-insp-item" key={sid}>
                <span className="rr-insp-item__t">{STREAM_HUMAN[sid] || sid}</span>
                <span className="rr-insp-item__s">{proj.length}{total ? ` of ${total}` : ""} fields cross · {s.terms}</span>
                <span className="rr-insp-item__f">{proj.join(" · ")}</span>
              </div>
            ))}

            {(granted.some((g) => g.dropped.length > 0) || grant.declined.length > 0) && (
              <div className="rr-insp-label">What stays yours</div>
            )}
            {granted.filter((g) => g.dropped.length > 0).map(({ sid, dropped }) => (
              <div className="rr-insp-keep" key={sid}>
                <span className="rr-insp-keep__what">{dropped.join(" · ")}</span>
                <span className="rr-insp-keep__why">projected out of {sid} — never crosses</span>
              </div>
            ))}
            {grant.declined.map((d) => (
              <div className="rr-insp-keep" key={d}>
                <span className="rr-insp-keep__what rr-insp-keep__what--declined">{d}</span>
                <span className="rr-insp-keep__why">declined by you at consent</span>
              </div>
            ))}

            {reads.length > 0 && (
              <div className="rr-insp-pulse">{reads.length} read{reads.length === 1 ? "" : "s"} on record · last {reads[0].t.slice(5)}</div>
            )}
          </div>
          <div className="pdpp-sheet__foot">
            {!revoking && <span className="pdpp-copyline">Carbon — your copy stays here</span>}
            {!revoked && !revoking && (
              <button className="pdpp-btn pdpp-btn--destructive pdpp-btn--sm" onClick={onRevokeStart} type="button">
                Revoke
              </button>
            )}
            {!revoked && revoking && (
              <span style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                <button className="pdpp-btn pdpp-btn--ghost pdpp-btn--sm" onClick={onRevokeCancel} type="button">
                  Keep
                </button>
                <button className="pdpp-btn pdpp-btn--destructive pdpp-btn--sm" onClick={onRevokeConfirm} type="button">
                  Confirm revoke
                </button>
              </span>
            )}
            {revoked && (
              <span className="pdpp-typed-sm" style={{ color: "var(--muted-foreground)" }}>
                struck, not erased
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Streams view ─── */

function StreamSheet({ stream, grants }) {
  const [lens, setLens] = useState(null); // grant id or null
  const lensGrant = lens ? grants.find((g) => g.id === lens) : null;
  const projected = lensGrant ? lensGrant.projections[stream.id] : null;
  const granted = grants.filter((g) => g.status !== "revoked" && g.projections[stream.id]);
  return (
    <div className="pdpp-sheet rr-stream">
      <div className="pdpp-sheet__head">
        <h3 className="pdpp-sheet__title">{stream.id}</h3>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {granted.map((g) => (
            <button
              className={"rr-lens" + (lens === g.id ? " is-on" : "")}
              key={g.id}
              onClick={() => setLens(lens === g.id ? null : g.id)}
              type="button"
            >
              {lens === g.id ? "view as " + g.client : "view as " + g.client}
            </button>
          ))}
          <span className="pdpp-sheet__serial">{stream.connector} · {stream.records} records</span>
        </span>
      </div>
      <div className="rr-stream__fields">
        {stream.fields.map((f) => {
          const dropped = projected && !projected.includes(f);
          return (
            <span className={"rr-field-chip" + (dropped ? " rr-field-chip--dropped" : "")} key={f}>
              {f}
            </span>
          );
        })}
      </div>
      {projected && (
        <div className="pdpp-sheet__foot">
          <span className="pdpp-typed-sm" style={{ color: "var(--primary)" }}>
            {projected.length} of {stream.fields.length} fields cross · projection enforced at the server
          </span>
        </div>
      )}
    </div>
  );
}

/* ─── Activity view ─── */

function ActivityLog({ entries }) {
  return (
    <div className="rr-log">
      {entries.map((e, i) => (
        <div className={"rr-log__row" + (e.fresh ? " rr-log__row--new" : "")} key={entries.length - i}>
          <span className="rr-log__t">{e.t}</span>
          <span className={"rr-log__verb rr-log__verb--" + e.kind}>{e.verb}</span>
          <span className="rr-log__what">{e.what}</span>
          <span className="rr-log__ref">{e.ref}</span>
        </div>
      ))}
    </div>
  );
}

/* ─── The consent ceremony ─── */

function Ceremony({ request, pressing, onToggle, onApprove, onRefuse, onDismiss }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onDismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);
  const allowed = request.scopes.filter((s) => s.allowed);
  return (
    <div className="rr-overlay" onClick={pressing ? undefined : onDismiss}>
      <div className={"rr-ceremony rr-paper-scope" + (pressing ? " is-pressing" : "")} onClick={(e) => e.stopPropagation()}>
        <div className="pdpp-carbon">
          <div className="pdpp-sheet">
            <div className="rr-ceremony__kicker-row">
              <span className="pdpp-eyebrow">Access request · staged</span>
              <span className="pdpp-sheet__serial">{request.id}</span>
            </div>
            <div className="rr-ceremony__body">
              <h2 className="rr-ceremony__title">{request.client} asks to read {request.scopes.length} streams</h2>
              <p className="rr-ceremony__sub">
                Purpose: {request.purposeHuman}. Decide stream by stream — anything you decline
                stays on the record as declined.
              </p>
              <div className="rr-ceremony__scopes">
                {request.scopes.map((s, i) => (
                  <div className={"rr-scope-decide" + (s.allowed ? "" : " rr-scope-decide--off")} key={s.name}>
                    <span className="rr-scope-decide__name">{s.name}</span>
                    <span className="rr-scope-decide__terms">{s.terms}</span>
                    <button
                      className={"rr-allow" + (s.allowed ? " is-on" : "")}
                      disabled={pressing}
                      onClick={() => onToggle(i)}
                      type="button"
                    >
                      {s.allowed ? "allow" : "declined"}
                    </button>
                    <span className="rr-scope-decide__desc">{s.desc}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rr-ceremony__foot">
              {!pressing && (
                <button className="pdpp-btn pdpp-btn--ghost" onClick={onRefuse} type="button">
                  Refuse all
                </button>
              )}
              {!pressing && (
                <button
                  className="pdpp-btn pdpp-btn--human"
                  disabled={allowed.length === 0}
                  onClick={onApprove}
                  style={allowed.length === 0 ? { opacity: 0.45, cursor: "default" } : null}
                  type="button"
                >
                  Approve {allowed.length} {allowed.length === 1 ? "stream" : "streams"}
                </button>
              )}
              {pressing && (
                <span className="pdpp-copyline rr-press-reveal">Carbon pressed — your copy stays here</span>
              )}
              {pressing && (
                <span className="pdpp-typed-sm rr-press-reveal" style={{ color: "var(--muted-foreground)" }}>
                  recording grant…
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  RREndorse: Endorse,
  RRSidebar: Sidebar,
  RRSidebarFull: SidebarFull,
  RRGrantRow: GrantRow,
  RRInspector: Inspector,
  RRStreamSheet: StreamSheet,
  RRActivityLog: ActivityLog,
  RRCeremony: Ceremony,
});
})();
