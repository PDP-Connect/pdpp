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
      id: "pay_statements",
      connector: "Northstar HR",
      records: "312",
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
    },
    {
      id: "employment",
      connector: "Northstar HR",
      records: "4",
      fields: ["employer", "title", "start_date", "end_date", "manager_contact"],
    },
    {
      id: "transactions",
      connector: "First Meridian",
      records: "41,203",
      fields: ["date", "amount", "merchant", "category", "account_ref", "memo"],
    },
    {
      id: "listening_history",
      connector: "Tonal",
      records: "6,597",
      fields: ["track", "artist", "played_at", "device", "playlist_ref"],
    },
    {
      id: "tax_docs",
      connector: "Northstar HR",
      records: "12",
      fields: ["doc_type", "tax_year", "employer", "document_blob"],
    },
  ];

  const BASE_GRANTS = [
    {
      id: "grt_lngvw_01",
      client: "Longview Planning",
      purpose: "long_term_financial_planning",
      scopes: [
        { name: "pay_statements.read", terms: "append only · 2 yrs" },
        { name: "employment.read", terms: "current + 5 yrs" },
      ],
      declined: ["tax_docs.read"],
      status: "active",
      issued: "2025-10-14 09:22Z",
      expiry: "exp 2026-12-14",
      expiresFull: "2026-12-14 09:22Z",
      projections: {
        pay_statements: ["employer", "period_start", "period_end", "gross_pay", "net_pay"],
        employment: ["employer", "start_date", "end_date"],
      },
    },
    {
      id: "grt_cncrt_02",
      client: "Concert Recommendations",
      purpose: "live_event_suggestions",
      scopes: [{ name: "listening_history.read", terms: "rolling 12 mo" }],
      declined: [],
      status: "continuous",
      issued: "2026-01-30 18:04Z",
      expiry: "continuous",
      expiresFull: "renews monthly · next 2026-07-01",
      projections: { listening_history: ["track", "artist", "played_at"] },
    },
    {
      id: "grt_taxpr_03",
      client: "TaxPrep Co",
      purpose: "annual_filing_2025",
      scopes: [{ name: "tax_docs.read", terms: "single use" }],
      declined: [],
      status: "expiring",
      hoursLeft: 26,
      issued: "2026-06-09 11:40Z",
      expiry: "exp 2026-06-12",
      expiresFull: "2026-06-12 11:40Z",
      projections: { tax_docs: ["doc_type", "tax_year", "employer"] },
    },
    {
      id: "grt_xwise_09",
      client: "Crosswise Ads",
      purpose: "ad_personalization",
      scopes: [{ name: "transactions.read", terms: "90 d window" }],
      declined: [],
      status: "revoked",
      issued: "2026-02-11 08:15Z",
      revokedOn: "2026-05-02",
      revokedFull: "2026-05-02 14:40Z · by owner",
      expiry: "—",
      expiresFull: "—",
      projections: { transactions: ["date", "amount", "merchant"] },
    },
  ];

  const BASE_LOG = [
    {
      t: "2026-06-11 07:58Z",
      kind: "read",
      verb: "read",
      what: "pay_statements · 12 records · 5/8 fields",
      ref: "grt_lngvw_01",
    },
    {
      t: "2026-06-11 06:02Z",
      kind: "read",
      verb: "read",
      what: "listening_history · 214 records · 3/5 fields",
      ref: "grt_cncrt_02",
    },
    {
      t: "2026-06-10 22:17Z",
      kind: "read",
      verb: "read",
      what: "employment · 4 records · 3/5 fields",
      ref: "grt_lngvw_01",
    },
    {
      t: "2026-06-10 22:17Z",
      kind: "deny",
      verb: "deny",
      what: "tax_docs read attempt · scope not granted",
      ref: "grt_lngvw_01",
    },
    {
      t: "2026-06-09 11:40Z",
      kind: "consent",
      verb: "grant",
      what: "tax_docs.read · single use · TaxPrep Co",
      ref: "grt_taxpr_03",
    },
    {
      t: "2026-05-02 14:40Z",
      kind: "revoke",
      verb: "revoke",
      what: "transactions.read · Crosswise Ads · by owner",
      ref: "grt_xwise_09",
    },
    {
      t: "2026-05-02 14:39Z",
      kind: "deny",
      verb: "deny",
      what: "transactions read attempt · grant suspended",
      ref: "grt_xwise_09",
    },
  ];

  const INCOMING = {
    id: "req_atlas_7f2k",
    client: "Atlas Mortgage",
    purposeHuman: "mortgage pre-approval",
    scopes: [
      {
        name: "pay_statements.read",
        terms: "append only · 90 d",
        desc: "Employer, pay period, gross and net pay",
        allowed: true,
      },
      {
        name: "employment.read",
        terms: "current + 5 yrs",
        desc: "Employers and dates — no salary history",
        allowed: true,
      },
      { name: "transactions.read", terms: "90 d window", desc: "Spending detail from First Meridian", allowed: false },
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
    theme: "dark",
    density: "comfortable",
    carbonOffset: 9,
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
    overview: ["Overview", "where you stand"],
    explore: ["Explore", "the reading room · 10 connections · only you see this"],
    sources: ["Sources", "the loading dock · 10 instances · what arrives, from where, configured how"],
    traces: ["Traces", "every request, accounted for"],
    grants: ["Grants", ""],
    syncs: ["Syncs", "is your data arriving · schedule + result, per stream"],
    connect: ["Connect AI apps", "MCP · reads flow through grants"],
    deployment: ["Deployment", "readiness · endpoints · owner tokens"],
    exporters: ["Device exporters", "your devices, pushing home"],
    events: ["Event subscriptions", "webhooks on protocol events"],
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
      if (!navOpen) return undefined;
      function onKey(e) {
        if (e.key === "Escape") setNavOpen(false);
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [navOpen]);

    // Keyboard-first ledger: ↑↓ move selection, Escape backs out of a revoke.
    useEffect(() => {
      if (view !== "grants" || paletteOpen || requestState === "open") return undefined;
      function onKey(e) {
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
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
              status: "revoked",
              revokedOn: g.revokedOn || "2026-06-11",
              revokedFull: g.revokedFull || nowStamp() + " · by owner",
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
        id: "grt_atlas_05",
        client: INCOMING.client,
        purpose: "mortgage_preapproval",
        scopes: allowed.map(({ name, terms }) => ({ name, terms })),
        declined,
        status: "active",
        issued: nowStamp(),
        expiry: "exp 2026-09-09",
        expiresFull: "2026-09-09 · 90 d term",
        justAdded: true,
        projections: {
          pay_statements: ["employer", "period_start", "period_end", "gross_pay", "net_pay"],
          employment: ["employer", "start_date", "end_date"],
        },
      };
      setTimeout(() => {
        setExtraGrants((cur) => {
          const next = [newGrant, ...cur];
          saveState({ extraGrants: next.map(({ justAdded, ...g }) => g), requestState: "approved" });
          return next;
        });
        addLog({
          t: nowStamp(),
          kind: "consent",
          verb: "grant",
          what: `${allowed.length} scopes · ${declined.length} declined · ${INCOMING.client}`,
          ref: newGrant.id,
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
        t: nowStamp(),
        kind: "deny",
        verb: "refuse",
        what: `access request refused · ${INCOMING.client}`,
        ref: INCOMING.id,
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
        t: nowStamp(),
        kind: "revoke",
        verb: "revoke",
        what: `${g.scopes.map((s) => s.name).join(" · ")} · ${g.client} · by owner`,
        ref: g.id,
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
      setExploreSeed({ con: conId, stream: streamName, n: Date.now() });
      setView("explore");
    }

    const paletteItems = [
      ...NAV.filter((n) => n.id).map((n) => ({ label: n.label, kind: "view", run: () => setView(n.id) })),
      ...grants.map((g) => ({
        label: g.client + " — " + g.id,
        kind: "grant",
        run: () => {
          setView("grants");
          setSelected(g.id);
        },
      })),
      ...STREAMS.map((s) => ({ label: s.id, kind: "stream", run: () => setView("sources") })),
      { label: "Reauthorize First Meridian", kind: "action", run: () => setView("syncs") },
      ...(requestState === "pending"
        ? [{ label: "Review Atlas Mortgage request", kind: "action", run: () => setRequestState("open") }]
        : []),
      { label: "Toggle theme", kind: "action", run: () => setTweak("theme", t.theme === "dark" ? "light" : "dark") },
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
              <span className="rr-side__mark"></span>
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
            <div className={"rr-page" + (view === "grants" ? " rr-page--split" : "")}>
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
                      <span className="pdpp-table__h"></span>
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
                <span className="rr-side__mark"></span>
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
                      className={"rr-nav-item" + (view === item.id ? " is-active" : "")}
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
              if (!pressing) setRequestState("pending");
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
