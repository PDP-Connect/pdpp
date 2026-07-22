// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* RECORDROOM — data + state + app shell (full console surface). */
(() => {
  const { useState, useEffect, useMemo } = React;
  const {
    RRSidebarFull,
    RRGrantRow,
    RRInspector,
    RRStreamSheet,
    RRActivityLog,
    RRCeremony,
    RRTracesView,
    RROverviewView,
    RRExploreView,
    RRSourcesView,
    RRSourcesView2,
    RRRunsView,
    RRSchedulesView,
    RRConnectView,
    RRDeploymentView,
    RRExportersView,
    RRSubscriptionsView,
    RRCommandPalette,
    RRSyncsView,
    RRConnectView2,
    RRExportersView2,
    RRSubscriptionsView2,
    RRAttentionList,
    RROverview2,
    useTweaks,
    TweaksPanel,
    TweakSection,
    TweakSlider,
    TweakRadio,
    TweakButton,
  } = window;

  /* ─── Fixture data ─── */

  const STREAMS = [
    {
      connector: "Northstar HR",
      fields: [
        "employer",
        "period_start",
        "period_end",
        "gross_pay",
        "net_pay",
        "taxes_withheld",
        "benefits_detail",
        "bank_routing",
      ],
      id: "pay_statements",
      records: "312",
    },
    {
      connector: "Northstar HR",
      fields: ["employer", "title", "start_date", "end_date", "manager_contact"],
      id: "employment",
      records: "4",
    },
    {
      connector: "First Meridian",
      fields: ["date", "amount", "merchant", "category", "account_ref", "memo"],
      id: "transactions",
      records: "41,203",
    },
    {
      connector: "Tonal",
      fields: ["track", "artist", "played_at", "device", "playlist_ref"],
      id: "listening_history",
      records: "6,597",
    },
    {
      connector: "Northstar HR",
      fields: ["doc_type", "tax_year", "employer", "document_blob"],
      id: "tax_docs",
      records: "12",
    },
  ];

  const BASE_GRANTS = [
    {
      client: "Longview Planning",
      declined: ["tax_docs.read"],
      expiresFull: "2026-12-14 09:22Z",
      expiry: "exp 2026-12-14",
      id: "grt_lngvw_01",
      issued: "2025-10-14 09:22Z",
      projections: {
        employment: ["employer", "start_date", "end_date"],
        pay_statements: ["employer", "period_start", "period_end", "gross_pay", "net_pay"],
      },
      purpose: "long_term_financial_planning",
      scopes: [
        { name: "pay_statements.read", terms: "append only · 2 yrs" },
        { name: "employment.read", terms: "current + 5 yrs" },
      ],
      status: "active",
    },
    {
      client: "Concert Recommendations",
      declined: [],
      expiresFull: "renews monthly · next 2026-07-01",
      expiry: "continuous",
      id: "grt_cncrt_02",
      issued: "2026-01-30 18:04Z",
      projections: { listening_history: ["track", "artist", "played_at"] },
      purpose: "live_event_suggestions",
      scopes: [{ name: "listening_history.read", terms: "rolling 12 mo" }],
      status: "continuous",
    },
    {
      client: "TaxPrep Co",
      declined: [],
      expiresFull: "2026-06-12 11:40Z",
      expiry: "exp 2026-06-12",
      hoursLeft: 26,
      id: "grt_taxpr_03",
      issued: "2026-06-09 11:40Z",
      projections: { tax_docs: ["doc_type", "tax_year", "employer"] },
      purpose: "annual_filing_2025",
      scopes: [{ name: "tax_docs.read", terms: "single use" }],
      status: "expiring",
    },
    {
      client: "Crosswise Ads",
      declined: [],
      expiresFull: "—",
      expiry: "—",
      id: "grt_xwise_09",
      issued: "2026-02-11 08:15Z",
      projections: { transactions: ["date", "amount", "merchant"] },
      purpose: "ad_personalization",
      revokedFull: "2026-05-02 14:40Z · by owner",
      revokedOn: "2026-05-02",
      scopes: [{ name: "transactions.read", terms: "90 d window" }],
      status: "revoked",
    },
  ];

  const BASE_LOG = [
    {
      kind: "read",
      ref: "grt_lngvw_01",
      t: "2026-06-11 07:58Z",
      verb: "read",
      what: "pay_statements · 12 records · 5/8 fields",
    },
    {
      kind: "read",
      ref: "grt_cncrt_02",
      t: "2026-06-11 06:02Z",
      verb: "read",
      what: "listening_history · 214 records · 3/5 fields",
    },
    {
      kind: "read",
      ref: "grt_lngvw_01",
      t: "2026-06-10 22:17Z",
      verb: "read",
      what: "employment · 4 records · 3/5 fields",
    },
    {
      kind: "deny",
      ref: "grt_lngvw_01",
      t: "2026-06-10 22:17Z",
      verb: "deny",
      what: "tax_docs read attempt · scope not granted",
    },
    {
      kind: "consent",
      ref: "grt_taxpr_03",
      t: "2026-06-09 11:40Z",
      verb: "grant",
      what: "tax_docs.read · single use · TaxPrep Co",
    },
    {
      kind: "revoke",
      ref: "grt_xwise_09",
      t: "2026-05-02 14:40Z",
      verb: "revoke",
      what: "transactions.read · Crosswise Ads · by owner",
    },
    {
      kind: "deny",
      ref: "grt_xwise_09",
      t: "2026-05-02 14:39Z",
      verb: "deny",
      what: "transactions read attempt · grant suspended",
    },
  ];

  const INCOMING = {
    client: "Atlas Mortgage",
    id: "req_atlas_7f2k",
    purposeHuman: "mortgage pre-approval",
    scopes: [
      {
        allowed: true,
        desc: "Employer, pay period, gross and net pay",
        name: "pay_statements.read",
        terms: "append only · 90 d",
      },
      {
        allowed: true,
        desc: "Employers and dates — no salary history",
        name: "employment.read",
        terms: "current + 5 yrs",
      },
      { allowed: false, desc: "Spending detail from First Meridian", name: "transactions.read", terms: "90 d window" },
    ],
  };

  /* ─── Persistence (additive; never clears foreign keys) ─── */

  const LS_KEY = "recordroom_state_v2";
  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY)) || {};
    } catch {
      return {};
    }
  }
  function saveState(patch) {
    const cur = loadState();
    localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...patch }));
  }

  function nowStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
  }

  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
    carbonOffset: 9,
    density: "comfortable",
    theme: "dark",
  } /*EDITMODE-END*/;

  const NAV = [
    { id: "explore", label: "Explore" },
    { group: "Collection" },
    { id: "syncs", label: "Syncs" },
    { id: "sources", label: "Sources" },
    { group: "Sharing" },
    { id: "grants", label: "Grants" },
    { id: "traces", label: "Traces" },
    { group: "Server" },
    { id: "connect", label: "Connect AI apps" },
    { id: "deployment", label: "Deployment" },
    { id: "exporters", label: "Device exporters" },
    { id: "events", label: "Event subscriptions" },
    { group: "Glance" },
    { id: "overview", label: "Standing" },
  ];

  const HEADS = {
    connect: ["Connect AI apps", "MCP · reads flow through grants"],
    deployment: ["Deployment", "readiness · endpoints · owner tokens"],
    events: ["Event subscriptions", "webhooks on protocol events"],
    explore: ["Explore", "the reading room · 10 connections · only you see this"],
    exporters: ["Device exporters", "your devices, pushing home"],
    grants: ["Grants", ""],
    overview: ["Overview", "where you stand"],
    sources: ["Sources", "the loading dock · 10 instances · what arrives, from where, configured how"],
    syncs: ["Syncs", "is your data arriving · schedule + result, per stream"],
    traces: ["Traces", "every request, accounted for"],
  };

  /* ─── App ─── */

  function App() {
    const persisted = useMemo(loadState, []);
    const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
    const [view, setView] = useState("explore");
    const [selected, setSelected] = useState("grt_lngvw_01");
    const [revoking, setRevoking] = useState(false);
    const [striking, setStriking] = useState(false);
    const [requestState, setRequestState] = useState(persisted.requestState || "pending");
    const [reqScopes, setReqScopes] = useState(INCOMING.scopes);
    const [pressing, setPressing] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [exploreSeed, setExploreSeed] = useState(null);
    const [navOpen, setNavOpen] = useState(false);
    const [extraGrants, setExtraGrants] = useState(persisted.extraGrants || []);
    const [revokedIds, setRevokedIds] = useState(persisted.revokedIds || []);
    const [extraLog, setExtraLog] = useState(persisted.extraLog || []);
    const [recents, setRecents] = useState(persisted.paletteRecents || []);

    useEffect(() => {
      document.documentElement.classList.toggle("dark", t.theme === "dark");
      document.documentElement.style.setProperty("--carbon-offset", t.carbonOffset + "px");
    }, [t.theme, t.carbonOffset]);

    useEffect(() => {
      function onKey(e) {
        if ((e.metaKey || e.ctrlKey) && e.key === "k") {
          e.preventDefault();
          setPaletteOpen((o) => !o);
        }
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
      if (!navOpen) {
        return;
      }
      function onKey(e) {
        if (e.key === "Escape") {
          setNavOpen(false);
        }
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [navOpen]);

    // Keyboard-first ledger: ↑↓ move selection, Escape backs out of a revoke.
    useEffect(() => {
      if (view !== "grants" || paletteOpen || requestState === "open") {
        return;
      }
      function onKey(e) {
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setSelected((cur) => {
            const i = grants.findIndex((g) => g.id === cur);
            const next = e.key === "ArrowDown" ? Math.min(i + 1, grants.length - 1) : Math.max(i - 1, 0);
            return grants[next].id;
          });
          setRevoking(false);
          setStriking(false);
        }
        if (e.key === "Escape") {
          setRevoking(false);
        }
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [view, paletteOpen, requestState, grants]);

    const grants = useMemo(() => {
      const all = [...extraGrants, ...BASE_GRANTS];
      return all.map((g) =>
        revokedIds.includes(g.id) && g.status !== "revoked"
          ? {
              ...g,
              revokedFull: g.revokedFull || nowStamp() + " · by owner",
              revokedOn: g.revokedOn || "2026-06-11",
              status: "revoked",
            }
          : g
      );
    }, [extraGrants, revokedIds]);

    const log = useMemo(() => [...extraLog, ...BASE_LOG], [extraLog]);
    const grant = grants.find((g) => g.id === selected) || null;
    const activeCount = grants.filter((g) => g.status !== "revoked").length;

    function addLog(entry) {
      setExtraLog((cur) => {
        const next = [{ ...entry, fresh: true }, ...cur];
        saveState({ extraLog: next.map(({ fresh, ...e }) => e) });
        return next;
      });
    }

    function approve() {
      setPressing(true);
      const allowed = reqScopes.filter((s) => s.allowed);
      const declined = reqScopes.filter((s) => !s.allowed).map((s) => s.name);
      const newGrant = {
        client: INCOMING.client,
        declined,
        expiresFull: "2026-09-09 · 90 d term",
        expiry: "exp 2026-09-09",
        id: "grt_atlas_05",
        issued: nowStamp(),
        justAdded: true,
        projections: {
          employment: ["employer", "start_date", "end_date"],
          pay_statements: ["employer", "period_start", "period_end", "gross_pay", "net_pay"],
        },
        purpose: "mortgage_preapproval",
        scopes: allowed.map(({ name, terms }) => ({ name, terms })),
        status: "active",
      };
      setTimeout(() => {
        setExtraGrants((cur) => {
          const next = [newGrant, ...cur];
          saveState({ extraGrants: next.map(({ justAdded, ...g }) => g), requestState: "approved" });
          return next;
        });
        addLog({
          kind: "consent",
          ref: newGrant.id,
          t: nowStamp(),
          verb: "grant",
          what: `${allowed.length} scopes · ${declined.length} declined · ${INCOMING.client}`,
        });
        setRequestState("approved");
        setPressing(false);
        setSelected(newGrant.id);
        setView("grants");
      }, 1900);
    }

    function refuse() {
      setRequestState("refused");
      saveState({ requestState: "refused" });
      addLog({
        kind: "deny",
        ref: INCOMING.id,
        t: nowStamp(),
        verb: "refuse",
        what: `access request refused · ${INCOMING.client}`,
      });
    }

    function confirmRevoke() {
      // Optimistic: the record flips NOW; the strike draws as confirmation, not as a wait.
      const g = grant;
      setStriking(true);
      setRevoking(false);
      setRevokedIds((cur) => {
        const next = [...cur, selected];
        saveState({ revokedIds: next });
        return next;
      });
      addLog({
        kind: "revoke",
        ref: g.id,
        t: nowStamp(),
        verb: "revoke",
        what: `${g.scopes.map((s) => s.name).join(" · ")} · ${g.client} · by owner`,
      });
      setTimeout(() => setStriking(false), 520);
    }

    function recordRecent(label) {
      setRecents((prev) => {
        const next = [label, ...prev.filter((l) => l !== label)].slice(0, 5);
        saveState({ paletteRecents: next });
        return next;
      });
    }

    function browseInExplore(conId, streamName) {
      setExploreSeed({ con: conId, n: Date.now(), stream: streamName });
      setView("explore");
    }

    const paletteItems = [
      ...NAV.filter((n) => n.id).map((n) => ({ kind: "view", label: n.label, run: () => setView(n.id) })),
      ...grants.map((g) => ({
        kind: "grant",
        label: g.client + " — " + g.id,
        run: () => {
          setView("grants");
          setSelected(g.id);
        },
      })),
      ...STREAMS.map((s) => ({ kind: "stream", label: s.id, run: () => setView("sources") })),
      { kind: "action", label: "Reauthorize First Meridian", run: () => setView("syncs") },
      ...(requestState === "pending"
        ? [{ kind: "action", label: "Review Atlas Mortgage request", run: () => setRequestState("open") }]
        : []),
      { kind: "action", label: "Toggle theme", run: () => setTweak("theme", t.theme === "dark" ? "light" : "dark") },
    ];

    const heads = {
      ...HEADS,
      grants: ["Grants", `${activeCount} in effect · ${grants.length - activeCount} struck · ↑↓ select`],
    };

    return (
      <div className="rr-app" data-density={t.density}>
        <RRSidebarFull
          counts={{ grants: grants.length, traces: window.RR2.traces.length }}
          nav={NAV}
          onView={setView}
          view={view}
        />
        <main className="rr-main">
          <header className="rr-head">
            <span className="rr-head__brand">
              <span className="rr-side__mark" />
              <span>Recordroom</span>
            </span>
            <span className="rr-head__crumb">rs.okafor.recordroom.net · pdpp 0.1.0</span>
            <div className="rr-head__actions">
              <button className="rr-chrome-btn" onClick={() => setPaletteOpen(true)} type="button">
                Jump <span className="rr-kbd">⌘K</span>
              </button>
              <button
                className="rr-chrome-btn"
                onClick={() => setTweak("theme", t.theme === "dark" ? "light" : "dark")}
                title={t.theme === "dark" ? "Switch to light" : "Switch to dark"}
                type="button"
              >
                {t.theme === "dark" ? "Dark" : "Light"}
              </button>
              <button className="rr-chrome-btn rr-menu-btn" onClick={() => setNavOpen(true)} type="button">
                Menu
              </button>
            </div>
          </header>
          <div className="rr-content" data-screen-label={view} key={view}>
            <div className={"rr-page" + (view === "grants" ? "rr-page--split" : "")}>
              <div className="rr-page-head">
                <h1 className="rr-page-head__t">{heads[view][0]}</h1>
                <span className="rr-page-head__s">{heads[view][1]}</span>
              </div>
              {view === "overview" && (
                <RROverview2
                  grants={grants}
                  onGo={setView}
                  onOpenGrant={(id) => {
                    setView("grants");
                    setSelected(id);
                  }}
                  onReview={() => setRequestState("open")}
                  requestState={requestState}
                />
              )}
              {view === "explore" && (
                <RRExploreView grants={grants} onGo={setView} onJump={() => setPaletteOpen(true)} seed={exploreSeed} />
              )}
              {view === "sources" && <RRSourcesView2 grants={grants} onBrowse={browseInExplore} onGo={setView} />}
              {view === "traces" && <RRTracesView />}
              {view === "grants" && (
                <div>
                  {requestState === "pending" && (
                    <div className="rr-incoming pdpp-carbon">
                      <div className="rr-incoming__sheet">
                        <span className="rr-incoming__text">
                          <span className="rr-incoming__title">Atlas Mortgage asks to read 3 streams</span>
                          <span className="rr-incoming__meta">
                            staged · req_atlas_7f2k · purpose: mortgage_preapproval
                          </span>
                        </span>
                        <button className="pdpp-btn pdpp-btn--sm" onClick={() => setRequestState("open")} type="button">
                          Review
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="pdpp-table rr-cols-grants">
                    <div className="pdpp-table__hrow">
                      <span className="pdpp-table__h" />
                      <span className="pdpp-table__h">client</span>
                      <span className="pdpp-table__h">scopes</span>
                      <span className="pdpp-table__h">status</span>
                      <span className="pdpp-table__h u-r">expires</span>
                    </div>
                    {grants.map((g) => (
                      <RRGrantRow
                        grant={g}
                        key={g.id}
                        onSelect={(id) => {
                          setSelected(id);
                          setRevoking(false);
                          setStriking(false);
                        }}
                        selected={selected === g.id}
                      />
                    ))}
                  </div>
                </div>
              )}
              {view === "grants" && (
                <RRInspector
                  grant={grant}
                  log={log}
                  onRevokeCancel={() => setRevoking(false)}
                  onRevokeConfirm={confirmRevoke}
                  onRevokeStart={() => setRevoking(true)}
                  revoking={revoking}
                  streams={STREAMS}
                  striking={striking}
                />
              )}
              {view === "syncs" && <RRSyncsView />}
              {view === "connect" && <RRConnectView2 />}
              {view === "deployment" && <RRDeploymentView />}
              {view === "exporters" && <RRExportersView2 />}
              {view === "events" && <RRSubscriptionsView2 />}
              {view === "activity" && <RRActivityLog entries={log} />}
            </div>
          </div>
        </main>

        {navOpen && (
          <div className="rr-drawer-overlay" onClick={() => setNavOpen(false)}>
            <nav className="rr-drawer" onClick={(e) => e.stopPropagation()}>
              <div className="rr-side__brand">
                <span className="rr-side__mark" />
                <span className="rr-side__name">Recordroom</span>
              </div>
              <div className="rr-drawer__nav">
                {NAV.map((item, i) =>
                  item.group ? (
                    <div className="rr-side__group" key={"g" + i}>
                      {item.group}
                    </div>
                  ) : (
                    <button
                      className={"rr-nav-item" + (view === item.id ? "is-active" : "")}
                      key={item.id}
                      onClick={() => {
                        setView(item.id);
                        setNavOpen(false);
                      }}
                      type="button"
                    >
                      <span>{item.label}</span>
                    </button>
                  )
                )}
              </div>
              <div className="rr-side__foot">
                <span className="rr-side__owner">M. Okafor</span>
                <span className="rr-side__host">rs.okafor.recordroom.net · pdpp 0.1.0</span>
              </div>
            </nav>
          </div>
        )}

        {requestState === "open" && (
          <RRCeremony
            onApprove={approve}
            onDismiss={() => {
              if (!pressing) {
                setRequestState("pending");
              }
            }}
            onRefuse={refuse}
            onToggle={(i) => setReqScopes((cur) => cur.map((s, j) => (j === i ? { ...s, allowed: !s.allowed } : s)))}
            pressing={pressing}
            request={{ ...INCOMING, scopes: reqScopes }}
          />
        )}

        <RRCommandPalette
          items={paletteItems}
          onClose={() => setPaletteOpen(false)}
          onExec={recordRecent}
          open={paletteOpen}
          recents={recents}
        />

        <TweaksPanel>
          <TweakSection label="Console" />
          <TweakRadio
            label="Theme"
            onChange={(v) => setTweak("theme", v)}
            options={["dark", "light"]}
            value={t.theme}
          />
          <TweakRadio
            label="Density"
            onChange={(v) => setTweak("density", v)}
            options={["comfortable", "compact"]}
            value={t.density}
          />
          <TweakSection label="Carbon" />
          <TweakSlider
            label="Offset"
            max={14}
            min={5}
            onChange={(v) => setTweak("carbonOffset", v)}
            unit="px"
            value={t.carbonOffset}
          />
          <TweakSection label="Demo" />
          <TweakButton
            label="Reset demo state"
            onClick={() => {
              localStorage.setItem(LS_KEY, "{}");
              location.reload();
            }}
          />
        </TweaksPanel>
      </div>
    );
  }

  ReactDOM.createRoot(document.getElementById("root")).render(<App />);
})();
