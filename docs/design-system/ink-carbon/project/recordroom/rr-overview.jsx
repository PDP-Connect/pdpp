// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* RECORDROOM — "Standing": the home as the product's point of view.
   Person-first language, one hero truth, the owner's three questions,
   calm↔alarm emotional center, a deliberate warm reassurance moment. */
(() => {
  const { useState } = React;
  const RR2 = window.RR2;

  /* ── Plain-language lexicon: scope → what it means to a person ── */
  const SCOPE_HUMAN = {
    "browsing.read": "your browsing",
    "employment.read": "your employment history",
    "listening_history.read": "what you listen to",
    "pay_statements.read": "your pay",
    "tax_docs.read": "your tax documents",
    "transactions.read": "your spending",
  };
  function scopeHuman(name) {
    return SCOPE_HUMAN[name] || name.replace(/\.read$/, "").replace(/_/g, " ");
  }

  /* ── What holds BEARER access — acts as you, reads everything. The tier
      most owners actually use; grants are the scoped minority case. ── */
  const BEARER = [
    { how: "owner token · MCP", kind: "app", last: "read everything · 2 h ago", who: "Claude Desktop" },
    { how: "owner token", kind: "key", last: "last used yesterday", who: "CLI on framework" },
  ];
  function joinHuman(arr) {
    if (arr.length <= 1) {
      return arr[0] || "";
    }
    if (arr.length === 2) {
      return arr[0] + " and " + arr[1];
    }
    return arr.slice(0, -1).join(", ") + ", and " + arr[arr.length - 1];
  }

  const STREAM_RECORD_NOUN = {
    employment: "employment records",
    listening_history: "listening records",
    pay_statements: "pay records",
    tax_docs: "tax records",
    transactions: "transactions",
  };
  function recordNoun(stream) {
    return STREAM_RECORD_NOUN[stream] || stream.replace(/_/g, " ") + " records";
  }

  function relDay(t) {
    // t like "2026-06-11 07:58:12Z"; now is 2026-06-12
    const d = t.slice(0, 10);
    if (d === "2026-06-12") {
      return "today";
    }
    if (d === "2026-06-11") {
      return "yesterday";
    }
    if (d === "2026-05-02") {
      return "May 2";
    }
    return d.slice(5);
  }

  function Overview({ grants, requestState, onReview, onGo, onOpenGrant }) {
    const [resolved, setResolved] = useState(false);
    const active = grants.filter((g) => g.status !== "revoked");
    const pending = requestState === "pending";
    const hasFailure = !resolved; // First Meridian sync, part of the standing fixture

    /* ── The hero: one truth, computed from state ── */
    let hero;
    if (pending) {
      hero = {
        cta: (
          <button className="pdpp-btn pdpp-btn--human" onClick={onReview} type="button">
            Review the request
          </button>
        ),
        kicker: "A request is waiting on you",
        line: (
          <React.Fragment>
            Atlas Mortgage wants to read <em>your pay, employment, and spending</em>.
          </React.Fragment>
        ),
        sub: "Nothing leaves until you say so — approve it one piece at a time.",
        tone: "decide",
      };
    } else if (hasFailure) {
      hero = {
        cta: (
          <button
            className="pdpp-btn pdpp-btn--sm"
            onClick={() => {
              setResolved(true);
            }}
            type="button"
          >
            Reconnect the bank
          </button>
        ),
        kicker: "One thing needs you",
        line: (
          <React.Fragment>
            Your bank data <em>stopped arriving</em> on Jun 11.
          </React.Fragment>
        ),
        sub: "First Meridian's connection expired. Nothing you already have is lost — but nothing new arrives until you reconnect.",
        tone: "alarm",
      };
    } else {
      hero = {
        kicker: "Where you stand",
        line: (
          <React.Fragment>
            48,120 records from 10 sources — <em>all yours to read</em>.
          </React.Fragment>
        ),
        sub:
          BEARER.length +
          " tokens can act as you, with full access. " +
          active.length +
          " apps read only the slices you granted. Revoke any of them instantly.",
        tone: "calm",
      };
    }

    /* ── What's crossed lately (humanized traces) ── */
    const lately = RR2.traces.slice(0, 4).map((tr) => {
      if (tr.decision === "deny") {
        const why =
          tr.reason === "scope not granted"
            ? "you never allowed it"
            : tr.reason === "grant revoked"
              ? "you'd revoked it"
              : tr.reason;
        return {
          deny: true,
          id: tr.id,
          text: (
            <React.Fragment>
              <b>{tr.client}</b> tried to read {tr.stream.replace(/_/g, " ")} — turned away, {why}.
            </React.Fragment>
          ),
          when: relDay(tr.t),
        };
      }
      return {
        deny: false,
        id: tr.id,
        text: (
          <React.Fragment>
            <b>{tr.client}</b> read {tr.records} {recordNoun(tr.stream)} — {tr.fields} fields each.
          </React.Fragment>
        ),
        when: relDay(tr.t),
      };
    });

    return (
      <div className="rr-stand">
        {/* HERO */}
        <section className={"rr-stand-hero is-" + hero.tone}>
          <span className="rr-stand-hero__kicker">{hero.kicker}</span>
          <h1 className="rr-stand-hero__line">{hero.line}</h1>
          <p className="rr-stand-hero__sub">{hero.sub}</p>
          {hero.cta && <div className="rr-stand-hero__foot">{hero.cta}</div>}
        </section>

        {/* WHAT CAN ACT AS YOU — bearer access, the primary tier */}
        <section className="rr-stand-block">
          <div className="rr-stand-block__head">
            <h2 className="rr-stand-block__title">What can act as you</h2>
            <button className="rr-link" onClick={() => onGo("deployment")} type="button">
              owner tokens →
            </button>
          </div>
          <div className="rr-bearer">
            {BEARER.map((b) => (
              <div className="rr-bearer__row" key={b.who}>
                <span className="rr-bearer__who">{b.who}</span>
                <span className="rr-bearer__tag">reads everything</span>
                <span className="rr-bearer__how">
                  {b.how} · {b.last}
                </span>
                <button className="rr-rel__revoke" onClick={() => onGo("deployment")} type="button">
                  revoke
                </button>
              </div>
            ))}
            <p className="rr-bearer__note">
              An owner token reads everything — every source, every field, exactly what you see. Keep the list short;
              revoke anytime.
            </p>
          </div>
        </section>

        <div className="rr-stand-grid">
          {/* WHO CAN READ PARTS OF YOU — grants, the scoped tier */}
          <section className="rr-stand-block">
            <div className="rr-stand-block__head">
              <h2 className="rr-stand-block__title">Who can read parts of you</h2>
              <button className="rr-link" onClick={() => onGo("grants")} type="button">
                all grants →
              </button>
            </div>
            <div className="rr-rel-list">
              {active.map((g) => (
                <div className="rr-rel" key={g.id}>
                  <span className="rr-rel__who">{g.client}</span>
                  <span className="rr-rel__reads">reads only {joinHuman(g.scopes.map((s) => scopeHuman(s.name)))}</span>
                  <button className="rr-rel__revoke" onClick={() => onOpenGrant(g.id)} type="button">
                    revoke
                  </button>
                </div>
              ))}
              {active.length === 0 && (
                <p className="rr-stand-empty">
                  No grant is out. Nothing is shared — only you and what you've given a token read this server.
                </p>
              )}
            </div>
          </section>

          {/* WHAT'S CROSSED LATELY */}
          <section className="rr-stand-block">
            <div className="rr-stand-block__head">
              <h2 className="rr-stand-block__title">What's been read</h2>
              <button className="rr-link" onClick={() => onGo("traces")} type="button">
                every read →
              </button>
            </div>
            <div className="rr-lately">
              {lately.map((e) => (
                <div className={"rr-lately__row" + (e.deny ? "is-deny" : "")} key={e.id}>
                  <span className="rr-lately__text">{e.text}</span>
                  <span className="rr-lately__when">{e.when}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ANYTHING WRONG */}
        <section className="rr-stand-block">
          <h2 className="rr-stand-block__title">Anything wrong</h2>
          {hasFailure ? (
            window.RRAttentionList ? (
              <window.RRAttentionList onGo={onGo} />
            ) : null
          ) : (
            <div className="rr-allclear">
              <span className="rr-allclear__text">
                Nothing needs you. Grants are within their limits, backups are on, and everything's syncing.
              </span>
            </div>
          )}
        </section>
      </div>
    );
  }

  Object.assign(window, { RROverview2: Overview });
})();
