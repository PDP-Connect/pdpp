/* PDPP vibe studies — realistic consent screens, six skins, same flow */
;(() => {

const REQ = {
  client: "Longview Planning",
  purpose: "Long-term financial planning",
  scopes: [
    { name: "pay_statements.read", desc: "Employer, pay period, gross and net pay", terms: "append only · 2 yrs", on: true },
    { name: "employment.read", desc: "Current and past employers, with dates", terms: "current + 5 yrs", on: true },
    { name: "tax_docs.read", desc: "W-2s and filed returns", terms: "not requested by you — off", on: false },
  ],
  expires: "Dec 14, 2026",
  id: "GRT-7F2K-0419",
};

/* ── 1 · Carbon Copy ── */
function R1() {
  return (
    <div className="scr cc">
      <div className="cc-top">
        <span className="cc-top__brand">recordroom<em>.</em></span>
        <span className="cc-top__user">m.okafor · 3 grants active</span>
      </div>
      <div className="scr-main">
        <div>
          <span className="cc-req__kicker">Access request</span>
          <h1 className="cc-req__title">Longview Planning wants to read 2 of your records</h1>
          <p className="cc-req__sub">For {REQ.purpose.toLowerCase()}. They see only the fields below — nothing else crosses.</p>
        </div>
        <div className="cc-dupe">
          <div className="cc-dupe__shadow"></div>
          <div className="cc-card">
            {REQ.scopes.map((s) => (
              <div className={"cc-scope-row" + (s.on ? "" : " cc-scope-row--off")} key={s.name}>
                <span className={"cc-check" + (s.on ? " is-on" : "")}>{s.on ? "\u00d7" : ""}</span>
                <span>
                  <span className="cc-scope-row__name">{s.name}</span><br />
                  <span className="cc-scope-row__desc">{s.desc}</span>
                </span>
                <span className="cc-scope-row__terms cc-scope__terms">{s.terms}</span>
              </div>
            ))}
            <div className="cc-card__foot">
              <span className="cc-copytag">Carbon · your copy stays here</span>
            </div>
          </div>
        </div>
        <div className="cc-meta">
          <span>expires {REQ.expires}</span>
          <span>revoke anytime</span>
          <span>{REQ.id}</span>
        </div>
      </div>
      <div className="cc-foot">
        <button className="cc-btn cc-btn--ghost" type="button">Refuse</button>
        <button className="cc-btn" type="button">Approve 2 scopes</button>
      </div>
    </div>
  );
}

/* ── 2 · Two-Color Ribbon ── */
function R2() {
  return (
    <div className="scr rb">
      <div className="rb-top">
        <span className="rb-top__brand">RECORDROOM</span>
        <span className="rb-top__user">m.okafor</span>
      </div>
      <div className="scr-main">
        <h1 className="rb-req__title">Longview Planning asks to read your records. Anything refused is typed <b>in red.</b></h1>
        <div>
          <div className="rb-field"><span className="rb-field__k">requester</span><span>{REQ.client}</span></div>
          <div className="rb-field"><span className="rb-field__k">purpose</span><span>{REQ.purpose}</span></div>
          <div className="rb-field"><span className="rb-field__k">expires</span><span>{REQ.expires} · revocable anytime</span></div>
        </div>
        <div>
          {REQ.scopes.map((s) => (
            <div className={"rb-scope-line" + (s.on ? "" : " rb-scope-line--off")} key={s.name}>
              <span className={"rb-scope-line__mark" + (s.on ? "" : " is-no")}>{s.on ? "[x]" : "[–]"}</span>
              <span>{s.name}</span>
              <span className="rb-scope-line__terms">{s.terms}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rb-foot">
        <button className="rb-btn" type="button">Record consent</button>
        <button className="rb-btn rb-btn--red" type="button">Refuse all</button>
        <span className="rb-foot__id">{REQ.id}</span>
      </div>
    </div>
  );
}

/* ── 3 · Clarendon Ledger ── */
function R3() {
  return (
    <div className="scr cl">
      <div className="cl-top">
        <h2 className="cl-top__brand">Recordroom</h2>
        <span className="cl-top__user">M. Okafor · ledger of grants</span>
      </div>
      <div className="scr-main">
        <div>
          <h1 className="cl-req__title"><b>Longview Planning</b> asks leave to read two of your records.</h1>
          <p className="cl-req__sub">Purpose: {REQ.purpose.toLowerCase()}. Until {REQ.expires}, unless you strike it sooner.</p>
        </div>
        <div className="cl-sched">
          {REQ.scopes.map((s, i) => (
            <div className={"cl-sched-row" + (s.on ? "" : " cl-sched-row--off")} key={s.name}>
              <span className="cl-sched-row__no">{String(i + 1).padStart(2, "0")}</span>
              <span>
                <span className="cl-sched-row__name">{s.name}</span><br />
                <span className="cl-sched-row__desc">{s.desc}</span>
              </span>
              <span className="cl-sched-row__terms">{s.terms}</span>
              <span className="cl-sched-row__mark">{s.on ? "granted" : "—"}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="cl-foot">
        <button className="cl-btn" type="button">Enter in the ledger</button>
        <button className="cl-btn cl-btn--ghost" type="button">Decline</button>
        <span className="cl-foot__note">No. {REQ.id}<br />revocable at any time</span>
      </div>
    </div>
  );
}

/* ── 4 · Punch Column ── */
function R4() {
  return (
    <div className="scr pc">
      <div className="pc-top">
        <span className="pc-top__brand">RECORDROOM</span>
        <span className="pc-top__user">M.OKAFOR · 03 ACTIVE</span>
      </div>
      <div className="scr-main">
        <div>
          <span className="pc-req__kicker">Access request</span>
          <h1 className="pc-req__title">Longview Planning wants two fields punched</h1>
          <p className="pc-req__sub">For {REQ.purpose.toLowerCase()}. A field crosses only where the card is punched.</p>
        </div>
        <div className="pc-card">
          {REQ.scopes.map((s) => (
            <div className="pc-scope" key={s.name}>
              <span className={"pc-slot" + (s.on ? " pc-slot--punched" : "")}></span>
              <span>
                <span className="pc-scope__name">{s.name}</span><br />
                <span style={{ fontSize: 11.5, color: "oklch(0.45 0.02 75)" }}>{s.desc}</span>
              </span>
              <span className="pc-scope__terms">{s.terms}</span>
            </div>
          ))}
          <div className="pc-index"><span>0 1 2 3 4 5 6 7 8 9</span><span>{REQ.id}</span></div>
        </div>
        <div className="pc-meta">
          <span>EXPIRES {REQ.expires.toUpperCase()}</span>
          <span>REVOKE ANYTIME</span>
        </div>
      </div>
      <div className="pc-foot">
        <button className="pc-btn pc-btn--ghost" type="button">Leave blank</button>
        <button className="pc-btn" type="button">Punch 2 fields</button>
      </div>
    </div>
  );
}

/* ── 5 · Civic Bold ── */
function R5() {
  return (
    <div className="scr cb">
      <div className="cb-top">
        <span className="cb-top__brand">Recordroom</span>
        <span className="cb-top__user">m.okafor</span>
      </div>
      <div className="scr-main">
        <div>
          <h1 className="cb-req__title">Longview Planning wants to read <b>2 records.</b></h1>
          <p className="cb-req__sub">Purpose: {REQ.purpose.toLowerCase()}. Only the fields below cross. Revoke whenever you want.</p>
        </div>
        <div>
          {REQ.scopes.map((s) => (
            <div className="cb-scope-row" key={s.name}>
              <span className="cb-scope-row__name">{s.name}</span>
              <span className="cb-scope-row__terms">{s.terms}</span>
              <span className={"cb-yn " + (s.on ? "cb-yn--yes" : "cb-yn--no")}>{s.on ? "Yes" : "No"}</span>
            </div>
          ))}
        </div>
        <div className="cb-meta">
          <span>expires {REQ.expires}</span>
          <span>{REQ.id}</span>
        </div>
      </div>
      <div className="cb-foot">
        <button className="cb-btn" type="button">Approve</button>
        <button className="cb-btn cb-btn--ghost" type="button">Refuse</button>
      </div>
    </div>
  );
}

/* ── 6 · Greenbar ── */
function R6() {
  return (
    <div className="scr gb" style={{ position: "relative" }}>
      <div className="gb-sprockets gb-sprockets--l"></div>
      <div className="gb-sprockets gb-sprockets--r"></div>
      <div className="gb-top">
        <span className="gb-top__brand">RECORDROOM</span>
        <span className="gb-top__user">m.okafor · cycle 2026-06</span>
      </div>
      <div className="scr-main" style={{ paddingLeft: 34, paddingRight: 34 }}>
        <div>
          <h1 className="gb-req__title"><b>Longview Planning</b> requests read access</h1>
          <p className="gb-req__sub">Purpose: {REQ.purpose.toLowerCase()}. Every read is printed to your log — you can audit the full history anytime.</p>
        </div>
        <div className="gb-list">
          {REQ.scopes.map((s) => (
            <div className={"gb-row" + (s.on ? "" : " gb-row--off")} key={s.name}>
              <span>{s.name}</span>
              <span className="gb-row__terms">{s.terms}</span>
            </div>
          ))}
          <div className="gb-row"><span>expires</span><span className="gb-row__terms">{REQ.expires} · revocable anytime</span></div>
        </div>
      </div>
      <div className="gb-foot">
        <button className="gb-btn" type="button">Approve</button>
        <button className="gb-btn gb-btn--ghost" type="button">Refuse</button>
        <span className="gb-foot__id">{REQ.id}</span>
      </div>
    </div>
  );
}

Object.assign(window, { R1, R2, R3, R4, R5, R6 });
})();
