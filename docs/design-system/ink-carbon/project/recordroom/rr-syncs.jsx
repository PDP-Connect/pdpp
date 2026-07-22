// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* RECORDROOM — Syncs (merged Runs+Schedules) + de-souped ops rows for
   Connect / Exporters / Subscriptions + the Overview attention list.
   Health-first: the failure is a card with an action, not a row.
   Data: window.RR2 + a compact sync model authored here. */
(() => {
  const { useState } = React;
  const RR2 = window.RR2;

  /* ── Sync model: grouped by connection instance, per-stream rhythm ── */
  const SYNCS = [
    {
      con: "Northstar HR",
      cin: "cin_nh_e3391c",
      health: "ok",
      streams: [
        {
          stream: "pay_statements",
          cadence: "with payroll",
          next: "Jun 12 · 06:00Z",
          rhythm: ["ok", "ok", "ok", "ok", "ok"],
          delta: "+2 records",
          when: "today 06:00Z",
          dur: "18 s",
        },
        {
          stream: "employment",
          cadence: "daily · 06:00Z",
          next: "Jun 12 · 06:00Z",
          rhythm: ["ok", "ok", "ok", "ok", "ok"],
          delta: "no change",
          when: "today 06:00Z",
          dur: "4 s",
          quiet: true,
        },
        {
          stream: "tax_docs",
          cadence: "yearly · Feb 01",
          next: "2027 · Feb 01",
          rhythm: ["ok"],
          delta: "no change",
          when: "Feb 01",
          dur: "2 s",
          quiet: true,
        },
      ],
    },
    {
      con: "First Meridian — checking",
      cin: "cin_fm_206b11",
      health: "failing",
      fix: {
        title: "First Meridian — checking can't sync",
        body: "The bank's OFX session expired on Jun 11. New transactions aren't arriving — the cursor is held at Jun 10, so nothing already on your server is lost, but nothing new is coming in either.",
        action: "Reauthorize bank",
      },
      streams: [
        {
          stream: "transactions",
          cadence: "daily · 05:00Z",
          next: "held",
          rhythm: ["ok", "ok", "ok", "ok", "fail"],
          delta: "held at Jun 10",
          when: "Jun 11 05:00Z",
          dur: "2 s",
          failed: true,
        },
        {
          stream: "statements",
          cadence: "monthly",
          next: "held",
          rhythm: ["ok", "ok", "fail"],
          delta: "held at May",
          when: "Jun 11 05:00Z",
          dur: "—",
          failed: true,
        },
        {
          stream: "balances",
          cadence: "daily · 05:00Z",
          next: "held",
          rhythm: ["ok", "ok", "ok", "fail"],
          delta: "held at Jun 10",
          when: "Jun 11 05:00Z",
          dur: "—",
          failed: true,
        },
      ],
    },
    {
      con: "Gmail — personal",
      cin: "cin_gm_410c2b",
      health: "ok",
      streams: [
        {
          stream: "messages",
          cadence: "every 15 min",
          next: "in 11 min",
          rhythm: ["ok", "ok", "ok", "ok", "ok"],
          delta: "+38 records",
          when: "31 min ago",
          dur: "6 s",
        },
        {
          stream: "threads",
          cadence: "every 15 min",
          next: "in 11 min",
          rhythm: ["ok", "ok", "ok", "ok", "ok"],
          delta: "+12 records",
          when: "31 min ago",
          dur: "5 s",
        },
        {
          stream: "attachments",
          cadence: "every 15 min",
          next: "in 11 min",
          rhythm: ["ok", "ok", "ok", "ok", "ok"],
          delta: "+3 records",
          when: "2 h ago",
          dur: "9 s",
        },
      ],
    },
    {
      con: "Tonal",
      cin: "cin_tn_77f024",
      health: "ok",
      streams: [
        {
          stream: "listening_history",
          cadence: "every 15 min",
          next: "in 3 min",
          rhythm: ["ok", "ok", "ok", "ok", "ok"],
          delta: "+4 records",
          when: "12 min ago",
          dur: "7 s",
        },
      ],
    },
  ];

  function Rhythm({ runs }) {
    return (
      <span className="rr-rhythm" title={runs.join(" · ")}>
        {runs.map((r, i) => (
          <span className={"rr-rhythm__tick" + (r === "fail" ? " is-fail" : "")} key={i}></span>
        ))}
      </span>
    );
  }

  /* ─── Syncs ─── */

  function SyncsView() {
    const [open, setOpen] = useState(null);
    const [fixed, setFixed] = useState(false);
    const groups = SYNCS;
    const streamTotal = groups.reduce((n, g) => n + g.streams.length, 0);
    const failing = fixed ? 0 : groups.filter((g) => g.health === "failing").reduce((n, g) => n + g.streams.length, 0);
    const onSched = streamTotal - failing;
    const fixGroup = groups.find((g) => g.fix);

    return (
      <div className="rr-sync">
        <div className="rr-sync-health">
          <div className="rr-sync-health__stat">
            <span className="rr-sync-health__v">{onSched}</span>
            <span className="rr-sync-health__k">streams on schedule</span>
          </div>
          <div className={"rr-sync-health__stat" + (failing ? " is-warn" : "")}>
            <span className="rr-sync-health__v">{failing}</span>
            <span className="rr-sync-health__k">{failing ? "need your hand" : "need attention"}</span>
          </div>
          <div className="rr-sync-health__stat rr-sync-health__stat--note">
            <span className="rr-sync-health__note">
              Nothing already saved is ever lost — a held connection only pauses new arrivals.
            </span>
          </div>
        </div>

        {fixGroup && !fixed && (
          <div className="rr-fix">
            <div className="rr-fix__body">
              <h3 className="rr-fix__title">{fixGroup.fix.title}</h3>
              <p className="rr-fix__expl">{fixGroup.fix.body}</p>
            </div>
            <div className="rr-fix__act">
              <button className="pdpp-btn pdpp-btn--sm" onClick={() => setFixed(true)} type="button">
                {fixGroup.fix.action}
              </button>
            </div>
          </div>
        )}

        {groups.map((g) => {
          const healthy = fixed || g.health !== "failing";
          return (
            <div className="rr-sync-group" key={g.cin}>
              <div className="rr-sync-group__head">
                <span className={"rr-sync-group__dot" + (healthy ? " is-ok" : " is-fail")}></span>
                <span className="rr-sync-group__name">{g.con}</span>
                <span className="rr-sync-group__cin">{g.cin}</span>
                <span className="rr-sync-group__count">
                  {g.streams.length} {g.streams.length === 1 ? "stream" : "streams"}
                </span>
              </div>
              <div className="pdpp-table rr-cols-sync">
                <div className="pdpp-table__hrow">
                  <span className="pdpp-table__h">stream</span>
                  <span className="pdpp-table__h">cadence</span>
                  <span className="pdpp-table__h">recent</span>
                  <span className="pdpp-table__h">last result</span>
                  <span className="pdpp-table__h u-r">next</span>
                </div>
                {g.streams.map((s) => {
                  const failed = s.failed && !fixed;
                  const isOpen = open === g.cin + s.stream;
                  return (
                    <React.Fragment key={s.stream}>
                      <button
                        className={"rr-sync-row" + (failed ? " is-failed" : "") + (isOpen ? " is-open" : "")}
                        onClick={() => setOpen(isOpen ? null : g.cin + s.stream)}
                        type="button"
                      >
                        <span className="rr-sync-row__stream">{s.stream}</span>
                        <span className="rr-sync-row__cadence">{s.cadence}</span>
                        <Rhythm runs={fixed && s.failed ? [...s.rhythm.slice(0, -1), "ok"] : s.rhythm} />
                        <span
                          className={"rr-sync-row__delta" + (s.quiet ? " is-quiet" : "") + (failed ? " is-failed" : "")}
                        >
                          {failed ? "sync failed" : s.delta}
                          <span className="rr-sync-row__when">{s.when}</span>
                        </span>
                        <span className="rr-sync-row__next">{fixed && s.failed ? "resumed" : s.next}</span>
                      </button>
                      {isOpen && (
                        <div className="rr-sync-detail">
                          <div className="rr-sync-detail__kv">
                            <span className="rr-sync-detail__k">last run</span>
                            <span className="rr-sync-detail__v">
                              {s.when} · {s.dur}
                            </span>
                            <span className="rr-sync-detail__k">delta</span>
                            <span className="rr-sync-detail__v">{failed ? "0 records — cursor held" : s.delta}</span>
                            <span className="rr-sync-detail__k">cadence</span>
                            <span className="rr-sync-detail__v">{s.cadence}</span>
                          </div>
                          <button className="rr-link" type="button">
                            browse this stream →
                          </button>
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  /* ─── Connect (de-souped) ─── */

  function ConnectView() {
    return (
      <div className="rr-ops">
        {RR2.apps.map((a) => {
          const pending = a.status !== "connected";
          const code = pending ? (a.detail.match(/code (\S+)/) || [])[1] : null;
          return (
            <div className={"rr-op" + (pending ? " is-action" : "")} key={a.name}>
              <span className="rr-op__lead">
                <span className="rr-op__name">{a.name}</span>
                <span className="rr-op__tag">{a.via}</span>
              </span>
              <span className="rr-op__say">
                {pending
                  ? "Waiting for the device code to be entered on this console."
                  : "Reads through your grants — never more than the grant behind it."}
              </span>
              <span className="rr-op__side">
                {pending ? (
                  <span className="rr-op__pending">
                    <span className="rr-op__code">{code}</span>
                    <span className="rr-op__meta">expires 9 min</span>
                    <button className="pdpp-btn pdpp-btn--sm" type="button">
                      Enter code
                    </button>
                  </span>
                ) : (
                  <span className="rr-op__settled">
                    <span className="pdpp-endorse pdpp-endorse--active">connected</span>
                    <span className="rr-op__meta">since {a.added}</span>
                  </span>
                )}
              </span>
            </div>
          );
        })}
        <div className="rr-end">
          <button className="rr-link" type="button">
            connect an app →
          </button>
          <span className="rr-end__note">apps read through grants — never more than the grant behind them</span>
        </div>
      </div>
    );
  }

  /* ─── Device exporters (de-souped) ─── */

  function ExportersView() {
    const [paused, setPaused] = useState({});
    return (
      <div className="rr-ops">
        {RR2.exporters.map((e) => {
          const isPaused = paused[e.device] != null ? paused[e.device] : e.status === "paused";
          return (
            <div className={"rr-op" + (isPaused ? " is-action" : "")} key={e.device}>
              <span className="rr-op__lead">
                <span className="rr-op__name">{e.device}</span>
                <span className="rr-op__tag">device push</span>
              </span>
              <span className="rr-op__say">Pushes straight to your server — nothing transits a third party.</span>
              <span className="rr-op__side">
                <span className="rr-op__settled">
                  {isPaused ? (
                    <span className="pdpp-endorse pdpp-endorse--revoked">paused</span>
                  ) : (
                    <span className="pdpp-endorse pdpp-endorse--active">exporting</span>
                  )}
                  <span className="rr-op__meta">{isPaused ? "—" : e.records + " records"}</span>
                </span>
                <button
                  className="pdpp-btn pdpp-btn--ghost pdpp-btn--sm"
                  onClick={() => setPaused((p) => ({ ...p, [e.device]: !isPaused }))}
                  type="button"
                >
                  {isPaused ? "Resume" : "Pause"}
                </button>
              </span>
            </div>
          );
        })}
        <div className="rr-end">
          <button className="rr-link" type="button">
            pair a device →
          </button>
          <span className="rr-end__note">device flow · approve the code on this console</span>
        </div>
      </div>
    );
  }

  /* ─── Event subscriptions (de-souped) ─── */

  function SubscriptionsView() {
    return (
      <div className="rr-ops">
        {RR2.subscriptions.map((s) => (
          <div className="rr-op" key={s.url}>
            <span className="rr-op__lead">
              <span className="rr-op__name rr-op__name--mono">{s.url}</span>
            </span>
            <span className="rr-op__events">
              {s.events.split(" · ").map((ev) => (
                <span className="rr-op__event" key={ev}>
                  {ev}
                </span>
              ))}
            </span>
            <span className="rr-op__side">
              <span className="rr-op__settled">
                <span className="pdpp-endorse pdpp-endorse--continuous">{s.status}</span>
                <button className="rr-link rr-op__test" type="button">
                  test
                </button>
              </span>
            </span>
          </div>
        ))}
        <div className="rr-end">
          <button className="rr-link" type="button">
            add a webhook →
          </button>
          <span className="rr-end__note">fires on protocol events · grant.created · grant.revoked · run.failed</span>
        </div>
      </div>
    );
  }

  /* ─── Overview attention list (de-souped, action-bearing) ─── */

  function AttentionList({ onGo }) {
    const items = [
      {
        sev: "fail",
        name: "First Meridian can't sync",
        say: "OFX session expired — transactions held at the Jun 10 cursor.",
        action: "Reauthorize",
        go: "syncs",
      },
      {
        sev: "warn",
        name: "TaxPrep Co grant expiring",
        say: "tax_docs.read · single use · still unused.",
        meta: "26 h left",
        go: "grants",
      },
      {
        sev: "warn",
        name: "Backups not configured",
        say: "Your copy deserves a copy — set a snapshot target.",
        action: "Set up",
        go: "deployment",
      },
    ];
    return (
      <div className="rr-ops">
        {items.map((it) => (
          <div className={"rr-op rr-op--attn is-" + it.sev} key={it.name}>
            <span className="rr-op__lead">
              <span className={"rr-op__sev rr-op__sev--" + it.sev}></span>
              <span className="rr-op__name">{it.name}</span>
            </span>
            <span className="rr-op__say">{it.say}</span>
            <span className="rr-op__side">
              {it.action ? (
                <button className="pdpp-btn pdpp-btn--sm" onClick={() => onGo(it.go)} type="button">
                  {it.action}
                </button>
              ) : (
                <button className="rr-link" onClick={() => onGo(it.go)} type="button">
                  {it.meta} →
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    );
  }

  Object.assign(window, {
    RRSyncsView: SyncsView,
    RRConnectView2: ConnectView,
    RRExportersView2: ExportersView,
    RRSubscriptionsView2: SubscriptionsView,
    RRAttentionList: AttentionList,
  });
})();
