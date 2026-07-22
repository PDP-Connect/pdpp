// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* PDPP round 3 — console + consent, written once, themed three ways */
(() => {
  /* ─── Hosted consent page (light) ─── */
  function Consent({ t }) {
    const isT1 = t === "t1",
      isT2 = t === "t2",
      isT3 = t === "t3";
    const endorse = isT2 ? (s) => `[${s.toUpperCase()}]` : isT3 ? (s) => (s === "active" ? "● " + s : s) : (s) => s;
    return (
      <div className={`s3 lite ${t} hc`}>
        <div className="hc-head">
          <span className="hc-mark"></span>
          <span className="hc-word">PDPP</span>
          <span className="hc-prov">Northstar HR · provider</span>
        </div>
        <div className="hc-main">
          <div>
            <span className="hc-eyebrow">{isT2 ? "access request · staged via PAR" : "Access request"}</span>
            <h1 className="hc-title">Longview Planning asks to read 2 streams</h1>
            <p className="hc-lede">
              Purpose: <b>long-term financial planning</b>. Only the fields below cross. Every response is projected to
              this grant — nothing else leaves Northstar HR.
            </p>
          </div>
          <div className="hc-sheetwrap">
            {(isT1 || isT2) && <div className="hc-carbon"></div>}
            <div className="hc-sheet">
              <div className="hc-sheet__head">
                <span className="hc-sheet__client">Longview Planning</span>
                <span className="hc-sheet__serial">grant grt_lngvw_01 · client longview_planning_v1</span>
              </div>
              <div className="hc-scope">
                <span className="hc-scope__name">pay_statements.read</span>
                <span className="hc-scope__terms">append only · 2 yrs</span>
                <span className="hc-scope__desc">Employer, pay period, gross and net pay — 5 of 8 fields</span>
              </div>
              <div className="hc-scope">
                <span className="hc-scope__name">employment.read</span>
                <span className="hc-scope__terms">current + 5 yrs</span>
                <span className="hc-scope__desc">Employers and dates. No salary history.</span>
              </div>
              <div className="hc-sheet__foot">
                <span className="hc-copyline">
                  {isT1 && "Carbon — your copy stays here"}
                  {isT2 && "DUPLICATE — OWNER'S FILE"}
                  {isT3 && "A copy stays on your server"}
                </span>
                <span className="hc-meta">
                  <span>expires 2026-12-14</span>
                </span>
              </div>
            </div>
          </div>
          <div className="hc-meta">
            <span>revocable at any time</span>
            <span>takes effect at the server, not the app</span>
          </div>
        </div>
        <div className="hc-foot">
          <button className="hc-btn hc-btn--go" type="button">
            Approve 2 streams
          </button>
          <button className="hc-btn hc-btn--ghost" type="button">
            Deny
          </button>
          <span className="hc-revnote">You can revoke from your dashboard.</span>
        </div>
      </div>
    );
  }

  /* ─── Operator console overview (dark) ─── */
  const NAV = [
    ["Overview", "", true],
    ["Explore", ""],
    ["Sources", "7"],
    ["Traces", ""],
    ["Grants", "4"],
    ["Runs", "12"],
    ["Schedules", "2"],
    ["Connect AI apps", ""],
    ["Deployment", ""],
  ];
  const GRANTS = [
    {
      client: "Longview Planning",
      id: "grt_lngvw_01",
      scopes: "pay_statements.read · employment.read",
      exp: "exp 2026-12-14",
      st: ["st-ok", "active"],
      dupe: true,
    },
    {
      client: "Concert Recommendations",
      id: "grt_cncrt_02",
      scopes: "listening_history.read",
      exp: "continuous",
      st: ["st-pro", "continuous"],
    },
    {
      client: "pdpp CLI — owner export",
      id: "dev_cli_07",
      scopes: "* (owner device flow)",
      exp: "exp 2026-06-11",
      st: ["st-warn", "expiring 26h"],
    },
    {
      client: "Crosswise Ads",
      id: "grt_xwise_09",
      scopes: "browsing.read",
      exp: "2026-05-02",
      st: ["st-off", "revoked"],
      revoked: true,
    },
  ];

  function Console({ t }) {
    const isT2 = t === "t2",
      isT3 = t === "t3";
    const fmt = (s) =>
      isT2
        ? `[${s.toUpperCase()}]`
        : isT3 && s === "active"
          ? "● active"
          : isT3 && s === "revoked"
            ? "⊘ revoked"
            : isT3 && s.startsWith("expiring")
              ? "◐ " + s
              : isT3
                ? "○ " + s
                : s;
    return (
      <div className={`s3 dark ${t} oc`}>
        <div className="oc-side">
          <div className="oc-side__brand">
            <span className="hc-mark" style={{ background: "var(--fg)" }}></span>
            <span className="oc-side__word">PDPP</span>
          </div>
          <nav className="oc-nav">
            {NAV.map(([label, count, on]) => (
              <span className={"oc-nav__item" + (on ? " is-on" : "")} key={label}>
                <span>{label}</span>
                {count ? <span className="oc-nav__count">{count}</span> : null}
              </span>
            ))}
          </nav>
          <div className="oc-side__foot">
            AS :7662 · RS :7663
            <br />
            composed @ localhost:3002
            <br />
            rev 668ecf811d47
          </div>
        </div>
        <div className="oc-main">
          <div className="oc-top">
            <h1 className="oc-h1">Overview</h1>
            <span className="oc-kbd">⌘K — jump to grant, trace, run</span>
          </div>
          <div className="oc-band">
            <div className="oc-cell">
              <span className="oc-cell__v">2</span>
              <span className="oc-cell__k">connectors</span>
            </div>
            <div className="oc-cell">
              <span className="oc-cell__v">7</span>
              <span className="oc-cell__k">streams</span>
            </div>
            <div className="oc-cell">
              <span className="oc-cell__v">48,112</span>
              <span className="oc-cell__k">records</span>
            </div>
            <div className="oc-cell">
              <span className="oc-cell__v">1.21 GB</span>
              <span className="oc-cell__k">retained</span>
            </div>
          </div>
          <div>
            <div className="oc-listhead">
              <h2 className="oc-h2">{isT2 ? "Grants on file" : "Grants"}</h2>
              <span className="oc-link">View all 4 →</span>
            </div>
            <div className="oc-list">
              {GRANTS.map((g) => (
                <div
                  className={
                    "oc-row" + (g.dupe && t === "t1" ? " oc-row--dupe" : "") + (g.revoked ? " oc-row--revoked" : "")
                  }
                  key={g.id}
                >
                  <span className="oc-row__who">
                    <span className="oc-row__client">{g.client}</span>
                    <span className="oc-row__id">{g.id}</span>
                  </span>
                  <span className="oc-row__scopes">{g.scopes}</span>
                  <span className={"st " + g.st[0]}>{fmt(g.st[1])}</span>
                  <span className="oc-row__exp">{g.exp}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  Object.assign(window, { R3Consent: Consent, R3Console: Console });
})();
