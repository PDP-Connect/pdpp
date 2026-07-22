// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* RECORDROOM — Sources: the loading dock. Per-instance operational truth:
   identity, config, auth, stream manifests, health. Records are never
   viewed here — every record path hands off to Explore, the one reader. */
(() => {
  const { useState } = React;
  const RRX = window.RRX;

  function SourcesView({ grants, onBrowse, onGo }) {
    const [sel, setSel] = useState(RRX.connections[0].id);
    const [revoking, setRevoking] = useState(false);
    const [localRevoked, setLocalRevoked] = useState([]);
    const [syncing, setSyncing] = useState(false);
    const [synced, setSynced] = useState([]);

    const con = RRX.connections.find((c) => c.id === sel);
    const status = localRevoked.includes(con.id) ? "revoked" : con.status;
    const revoked = status === "revoked";

    /* which grants read each stream of this instance */
    function readBy(streamName) {
      const names = grants
        .filter((g) => g.status !== "revoked" && g.projections && g.projections[streamName])
        .map((g) => g.client);
      return names.length ? names.join(" · ") : "—";
    }

    function syncNow() {
      setSyncing(true);
      setTimeout(() => {
        setSyncing(false);
        setSynced((cur) => [...cur, con.id]);
      }, 800);
    }

    return (
      <div className="rr-s">
        {/* ── Instance list ── */}
        <aside className="rr-s-list">
          {RRX.connections.map((c) => {
            const st = localRevoked.includes(c.id) ? "revoked" : c.status;
            return (
              <button
                className={"rr-s-item" + (sel === c.id ? "is-on" : "") + (st === "revoked" ? "is-revoked" : "")}
                key={c.id}
                onClick={() => {
                  setSel(c.id);
                  setRevoking(false);
                }}
                type="button"
              >
                <span className="rr-s-item__name">{c.name}</span>
                <span className="rr-s-item__kind">{c.kind}</span>
                <span className="rr-s-item__line">{c.account}</span>
                <span className="rr-s-item__flag">
                  {st === "revoked" && <span className="pdpp-endorse pdpp-endorse--revoked">revoked</span>}
                  {st === "reauth" && <span className="pdpp-endorse pdpp-endorse--denied">reauthorize</span>}
                  {st === "active" && <span className="rr-s-item__ok">●</span>}
                </span>
              </button>
            );
          })}
          <div className="rr-end">
            <button className="rr-link" type="button">
              add a source →
            </button>
            <span className="rr-end__note">a source pushes into your streams · nothing leaves</span>
          </div>
        </aside>

        {/* ── Instance passport ── */}
        <div className="rr-s-detail">
          <div className="pdpp-sheet">
            <div className="pdpp-sheet__head">
              <h3 className="pdpp-sheet__title rr-x-sheet-title">{revoked ? <s>{con.name}</s> : con.name}</h3>
              <span className="pdpp-sheet__serial">{con.cin}</span>
            </div>
            <div className="pdpp-sheet__body">
              <div className="pdpp-kv">
                <div className="pdpp-kv__row">
                  <span className="pdpp-kv__k">kind</span>
                  <span className="pdpp-kv__v">{con.kind}</span>
                </div>
                <div className="pdpp-kv__row">
                  <span className="pdpp-kv__k">account</span>
                  <span className="pdpp-kv__v">{con.account}</span>
                </div>
                <div className="pdpp-kv__row">
                  <span className="pdpp-kv__k">config</span>
                  <span className="pdpp-kv__v">{con.config}</span>
                </div>
                <div className="pdpp-kv__row">
                  <span className="pdpp-kv__k">auth</span>
                  <span className="pdpp-kv__v">{revoked ? "revoked" : con.auth}</span>
                </div>
                <div className="pdpp-kv__row">
                  <span className="pdpp-kv__k">schedule</span>
                  <span className="pdpp-kv__v">{con.schedule}</span>
                </div>
                <div className="pdpp-kv__row">
                  <span className="pdpp-kv__k">last run</span>
                  <span className="pdpp-kv__v">{synced.includes(con.id) ? "ok · just now" : con.lastRun}</span>
                </div>
                <div className="pdpp-kv__row">
                  <span className="pdpp-kv__k">added</span>
                  <span className="pdpp-kv__v">{con.added}</span>
                </div>
              </div>
              {revoked && (
                <p className="rr-x-foldnote">
                  Revoked {con.id === "cc2" ? RRX.partial.revokedOn : "just now"} — this instance can no longer push.
                  Records ingested before revocation remain on your server, in your streams.
                </p>
              )}
            </div>
            <div className="pdpp-sheet__foot">
              <span className="rr-s-actions">
                {!revoked && (
                  <button
                    className="pdpp-btn pdpp-btn--ghost pdpp-btn--sm"
                    disabled={syncing}
                    onClick={syncNow}
                    type="button"
                  >
                    {syncing ? "syncing…" : "Sync now"}
                  </button>
                )}
                {status === "reauth" && (
                  <button className="pdpp-btn pdpp-btn--sm" type="button">
                    Reauthorize
                  </button>
                )}
                {!(revoked || revoking) && (
                  <button
                    className="pdpp-btn pdpp-btn--destructive pdpp-btn--sm"
                    onClick={() => setRevoking(true)}
                    type="button"
                  >
                    Revoke instance
                  </button>
                )}
                {!revoked && revoking && (
                  <span style={{ display: "flex", gap: 8 }}>
                    <button
                      className="pdpp-btn pdpp-btn--ghost pdpp-btn--sm"
                      onClick={() => setRevoking(false)}
                      type="button"
                    >
                      Keep
                    </button>
                    <button
                      className="pdpp-btn pdpp-btn--destructive pdpp-btn--sm"
                      onClick={() => {
                        setLocalRevoked((cur) => [...cur, con.id]);
                        setRevoking(false);
                      }}
                      type="button"
                    >
                      Confirm revoke
                    </button>
                  </span>
                )}
              </span>
              <button className="rr-link" onClick={() => onBrowse(con.id, null)} type="button">
                browse records →
              </button>
            </div>
          </div>

          {/* ── Stream manifest — schema-level truth, not records ── */}
          <div className="rr-s-manifest">
            <div className="rr-mini-head">
              <h3 className="rr-mini-head__t">Streams on this instance</h3>
              <span className="rr-x-day__n">{con.streams.length}</span>
            </div>
            <div className="pdpp-table rr-s-cols">
              <div className="pdpp-table__hrow">
                <span className="pdpp-table__h">stream</span>
                <span className="pdpp-table__h u-r">records</span>
                <span className="pdpp-table__h">cursor</span>
                <span className="pdpp-table__h">search</span>
                <span className="pdpp-table__h">read by</span>
              </div>
              {con.streams.map((s) => (
                <button className="rr-row-btn" key={s.name} onClick={() => onBrowse(con.id, s.name)} type="button">
                  <div className="pdpp-data-row" style={{ "--cols": "inherit" }}>
                    <span className="rr-s-stream">{s.name}</span>
                    <span className="pdpp-data-row__meta">{s.records}</span>
                    <span className="rr-s-cursor">{s.cursor}</span>
                    <span className="rr-s-cursor">{s.searchable ? "text" : "sealed"}</span>
                    <span className="rr-s-readby">{readBy(s.name)}</span>
                  </div>
                </button>
              ))}
            </div>
            <p className="rr-s-note">
              {"\u201c"}sealed{"\u201d"} streams hold binary or machine arguments — browsable and linked, not
              text-searched. Click any stream to read its records in Explore.
            </p>
          </div>
        </div>
      </div>
    );
  }

  Object.assign(window, { RRSourcesView2: SourcesView });
})();
