/* @ds-bundle: {"format":3,"namespace":"PDPPDesignSystem_b4e65a","components":[],"sourceHashes":{"explorer/app.jsx":"463d99bb2050","explorer/data.js":"a24956ad2caf","explorer/discover.jsx":"fa55e41caaae","explorer/dispatch.js":"7a5e0ee3bc0b","explorer/feed.jsx":"a18a7416a15b","explorer/peek.jsx":"59554ebb89bf","explorer/primitives.jsx":"562e7f581b4f","explorer/query-bar.jsx":"e177705267c8","explorer/query.js":"84de17a3e28b","explorer/tweaks-panel.jsx":"82c387552588","explorer/views-1.jsx":"30c80f80d6c2","explorer/views-2.jsx":"49a9ee7dfabd","labs/LivingGrant.jsx":"e597c103f94f","labs/SpecElements.jsx":"21db437de829","labs/TheAtlas.jsx":"a7284578491d","labs/TheContract.jsx":"9cffb6286b8d","labs/ThePurposes.jsx":"2dae75d6f94a","labs/TheSpecimen.jsx":"770787256d4b","labs/ThermalField.jsx":"4b151ad70ddf","recordroom/image-slot.js":"9309434cb09c","recordroom/rr-app.jsx":"3fbb14500988","recordroom/rr-components.jsx":"82830c20bdae","recordroom/rr-data.js":"b0d56346af80","recordroom/rr-explore-data.js":"c01dc326ae35","recordroom/rr-explore.jsx":"36fb800d80af","recordroom/rr-overview.jsx":"a4317ab3148a","recordroom/rr-record.jsx":"92e4890b7344","recordroom/rr-sources.jsx":"1d8d391c93a0","recordroom/rr-syncs.jsx":"0b8a3fe94d18","recordroom/rr-views2.jsx":"b067d0316048","recordroom/tweaks-panel.jsx":"6591467622ed","reinvention/boards-cadastral.jsx":"3a012eff9226","reinvention/boards-envelope.jsx":"b7ae39aa22aa","reinvention/boards-round2-real.jsx":"b406138572c7","reinvention/boards-round2.jsx":"0360398da582","reinvention/boards-round3.jsx":"8ee364a92061","reinvention/boards-strips.jsx":"e2e03e4a40ec","reinvention/design-canvas.jsx":"bd8746af6e58","ui_kits/web/ConsentCard.jsx":"a18446cf3a0a","ui_kits/web/GrantInspector.jsx":"8cc30fc78551","ui_kits/web/GrantsList.jsx":"b79e957be229","ui_kits/web/Hero.jsx":"7e5d9041b745","ui_kits/web/SiteHeader.jsx":"c54f10eb8c8f","ui_kits/web/StreamInventory.jsx":"f56108992c4e","ui_kits/web/Teaching.jsx":"fa0e942cc84f"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.PDPPDesignSystem_b4e65a = window.PDPPDesignSystem_b4e65a || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// explorer/app.jsx
try { (() => {
/* PDPP Explorer v2 — root app
 *
 * Single-canvas, query-driven. The query is the URL is the navigation.
 *   <topbar: brand · query · views · grant>
 *   <facet line>
 *   <main canvas: feed | dispatched view>     <peek slide-in>
 */

;
(() => {
  const {
    useState,
    useEffect,
    useMemo,
    useCallback
  } = React;
  const {
    runQuery,
    computeFacets
  } = window.PDPP_QUERY;
  const {
    detect,
    pickInitial,
    VIEW_ORDER
  } = window.PDPP_DISPATCH;
  const {
    fmtRelative,
    CAP_GLYPH,
    CAP_LABEL,
    NOW
  } = window.PDPPPrim;
  const APP_DEFAULTS = /*EDITMODE-BEGIN*/{
    "projectionDefault": false,
    "defaultMode": "lex"
  } /*EDITMODE-END*/;
  function App() {
    const {
      grant,
      connections,
      streams
    } = window.PDPP_DATA;
    const {
      TweaksPanel,
      useTweaks,
      TweakSection,
      TweakToggle,
      TweakRadio
    } = window;
    const [tweaks, setTweak] = useTweaks(APP_DEFAULTS);
    const [query, setQuery] = useState({
      chips: [],
      text: ""
    });
    const [mode, setMode] = useState(tweaks.defaultMode);
    const [queryFocused, setQueryFocused] = useState(false);
    const [selected, setSelected] = useState(null); // { stream, record }
    const [projection, setProjection] = useState(tweaks.projectionDefault);
    const [forcedView, setForcedView] = useState(null);
    const [whyOpen, setWhyOpen] = useState(false);

    // ── Hotkeys ──────────────────────────────────────────────────────
    useEffect(() => {
      function onKey(e) {
        const tag = (e.target.tagName ?? "").toLowerCase();
        const inField = tag === "input" || tag === "textarea";
        if (!inField && e.key === "/" && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          document.querySelector(".exp-query__text")?.focus();
        }
        if (e.key === "Escape") {
          if (selected) {
            setSelected(null);
            return;
          }
        }
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [selected]);

    // ── Hits + dispatch ─────────────────────────────────────────────
    const hits = useMemo(() => runQuery(query, streams), [query, streams]);
    const facets = useMemo(() => computeFacets(hits), [hits]);

    // Determine whether the result set is single-stream (route to dispatched view)
    // or multi-stream (route to unified feed).
    const uniqueStreams = useMemo(() => {
      const s = new Map();
      for (const h of hits) s.set(`${h.stream.connection_id}::${h.stream.name}`, h.stream);
      return [...s.values()];
    }, [hits]);
    const singleStream = uniqueStreams.length === 1 ? uniqueStreams[0] : null;

    // Capability dispatch for the single-stream case
    const dispatchResult = useMemo(() => singleStream ? detect(singleStream) : null, [singleStream]);
    const initialView = useMemo(() => singleStream ? pickInitial(singleStream) : "feed", [singleStream]);

    // Reset forcedView when the result-set shape changes
    useEffect(() => {
      setForcedView(null);
    }, [singleStream?.connection_id, singleStream?.name]);
    const activeView = forcedView ?? (singleStream ? initialView : "feed");

    // Capabilities visible in the view switcher.
    // For multi-stream, only "feed" is available; for single-stream, dispatch + table fallback.
    const availableViews = singleStream ? dispatchResult.capabilities : ["feed"];

    // ── Handlers ─────────────────────────────────────────────────────
    function openRecord(stream, record) {
      setSelected({
        stream,
        record
      });
    }
    function clearQuery() {
      setQuery({
        chips: [],
        text: ""
      });
    }
    function addChip(chip) {
      setQuery(q => {
        // de-dup
        const chips = q.chips.filter(c => !(c.field === chip.field && JSON.stringify(c.value) === JSON.stringify(chip.value)));
        return {
          ...q,
          chips: [...chips, chip]
        };
      });
    }
    function bodyForView() {
      if (activeView === "feed") {
        const isEmpty = query.chips.length === 0 && !query.text.trim();
        return /*#__PURE__*/React.createElement(window.FeedView, {
          hits: hits,
          onAddChip: addChip,
          onSelect: openRecord,
          selectedId: selected?.record?.id,
          showDiscover: isEmpty,
          streams: streams
        });
      }
      // Single-stream: filter the underlying stream records to those in our hits
      // (the query result), then mount the capability view over that subset.
      const hitIds = new Set(hits.map(h => h.record.id));
      const filteredStream = {
        ...singleStream,
        records: singleStream.records.filter(r => hitIds.has(r.id))
      };
      const viewProps = {
        stream: filteredStream,
        selectedId: selected?.record?.id,
        onSelect: r => openRecord(filteredStream, r),
        projection
      };
      switch (activeView) {
        case "table":
          return /*#__PURE__*/React.createElement(window.TableView, viewProps);
        case "timeline":
          return /*#__PURE__*/React.createElement(window.TimelineView, viewProps);
        case "conversation":
          return /*#__PURE__*/React.createElement(window.ConversationView, viewProps);
        case "ledger":
          return /*#__PURE__*/React.createElement(window.LedgerView, viewProps);
        case "gallery":
          return /*#__PURE__*/React.createElement(window.GalleryView, viewProps);
        case "map":
          return /*#__PURE__*/React.createElement(window.MapView, viewProps);
        case "calendar":
          return /*#__PURE__*/React.createElement(window.CalendarView, viewProps);
        case "chart":
          return /*#__PURE__*/React.createElement(window.ChartView, viewProps);
        case "reader":
          return /*#__PURE__*/React.createElement(window.ReaderView, viewProps);
        default:
          return /*#__PURE__*/React.createElement(window.FeedView, {
            hits: hits,
            onSelect: openRecord,
            selectedId: selected?.record?.id
          });
      }
    }
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "exp-app",
      "data-peek": selected ? "open" : "closed"
    }, /*#__PURE__*/React.createElement("header", {
      className: "exp-topbar"
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-topbar__brand",
      onClick: clearQuery,
      role: "button",
      style: {
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement("img", {
      alt: "pdpp",
      src: "explorer/assets/logo-mark.svg"
    }), /*#__PURE__*/React.createElement("span", {
      className: "exp-topbar__brand-name"
    }, "pdpp")), /*#__PURE__*/React.createElement("div", {
      className: "exp-topbar__center"
    }, /*#__PURE__*/React.createElement(window.QueryBar, {
      focused: queryFocused,
      mode: mode,
      onChange: setQuery,
      onFocusedChange: setQueryFocused,
      onModeChange: setMode,
      query: query,
      streams: streams
    })), /*#__PURE__*/React.createElement("div", {
      className: "exp-topbar__right"
    }, /*#__PURE__*/React.createElement(ViewSwitcher, {
      available: availableViews,
      dispatchResult: dispatchResult,
      isFeed: !singleStream,
      onChange: setForcedView,
      onWhy: () => setWhyOpen(x => !x),
      value: activeView,
      whyOpen: whyOpen
    }), /*#__PURE__*/React.createElement(GrantChip, {
      grant: grant,
      onToggleProjection: () => setProjection(x => !x),
      projection: projection
    }))), /*#__PURE__*/React.createElement(FacetLine, {
      activeView: activeView,
      facets: facets,
      hits: hits,
      onAddChip: addChip,
      query: query
    }), /*#__PURE__*/React.createElement("main", {
      className: "exp-main"
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-main__scroll"
    }, bodyForView())), selected ? /*#__PURE__*/React.createElement(window.Peek, {
      onClose: () => setSelected(null),
      projection: projection,
      record: selected.record,
      stream: selected.stream
    }) : null, whyOpen && dispatchResult ? /*#__PURE__*/React.createElement("div", {
      className: "exp-why",
      onClick: e => e.stopPropagation()
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-why__title"
    }, "Why these views?"), /*#__PURE__*/React.createElement("div", {
      className: "exp-why__sub"
    }, "Lit up from the stream's typed schema fields. Connector identity is irrelevant."), VIEW_ORDER.map(cap => /*#__PURE__*/React.createElement("div", {
      className: "exp-why__row",
      "data-active": dispatchResult.capabilities.includes(cap),
      key: cap
    }, /*#__PURE__*/React.createElement("span", {
      className: "exp-why__row-cap"
    }, dispatchResult.capabilities.includes(cap) ? "✓ " : "  ", CAP_LABEL[cap]), /*#__PURE__*/React.createElement("span", {
      className: "exp-why__row-fields"
    }, dispatchResult.capabilities.includes(cap) ? (dispatchResult.signals[cap] ?? []).join(" · ") || "—" : "no signal")))) : null), /*#__PURE__*/React.createElement(TweaksPanel, {
      title: "Tweaks"
    }, /*#__PURE__*/React.createElement(TweakSection, {
      title: "Search"
    }, /*#__PURE__*/React.createElement(TweakRadio, {
      label: "Default search mode",
      onChange: v => {
        setTweak("defaultMode", v);
        setMode(v);
      },
      options: [{
        value: "lex",
        label: "Lexical"
      }, {
        value: "sem",
        label: "Semantic"
      }, {
        value: "hyb",
        label: "Hybrid"
      }],
      value: tweaks.defaultMode
    })), /*#__PURE__*/React.createElement(TweakSection, {
      title: "Grant"
    }, /*#__PURE__*/React.createElement(TweakToggle, {
      label: "Project to granted fields by default",
      onChange: v => {
        setTweak("projectionDefault", v);
        setProjection(v);
      },
      value: tweaks.projectionDefault
    }))));
  }

  /* ─── ViewSwitcher ─────────────────────────────────────────────────── */

  function ViewSwitcher({
    available,
    value,
    onChange,
    isFeed,
    dispatchResult,
    onWhy,
    whyOpen
  }) {
    // When the result set spans multiple streams, the only option is "feed"
    // — there's nothing useful to switch to, so hide the chrome entirely.
    // The switcher only appears once the user has narrowed to one stream
    // and the stream's capability views can light up.
    if (isFeed) return null;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        position: "relative"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-views"
    }, window.PDPP_DISPATCH.VIEW_ORDER.map(cap => {
      if (!available.includes(cap)) return null;
      return /*#__PURE__*/React.createElement("button", {
        className: "exp-views__btn",
        "data-active": value === cap,
        key: cap,
        onClick: () => onChange(cap),
        title: CAP_LABEL[cap]
      }, /*#__PURE__*/React.createElement("span", {
        className: "exp-views__glyph"
      }, CAP_GLYPH[cap]), /*#__PURE__*/React.createElement("span", null, CAP_LABEL[cap].toLowerCase()));
    })), /*#__PURE__*/React.createElement("button", {
      onClick: onWhy,
      style: {
        border: "1px solid var(--border)",
        background: whyOpen ? "var(--muted)" : "var(--card)",
        borderRadius: 999,
        padding: "0.2rem 0.55rem",
        fontFamily: "var(--font-mono)",
        fontSize: "0.66rem",
        color: "var(--muted-foreground)",
        cursor: "pointer"
      },
      title: "Explain which views activated"
    }, "why?"));
  }

  /* ─── GrantChip (top bar) ─────────────────────────────────────────── */

  function GrantChip({
    grant,
    projection,
    onToggleProjection
  }) {
    const days = Math.ceil((new Date(grant.expires_at).getTime() - NOW) / 86_400_000);
    return /*#__PURE__*/React.createElement("button", {
      className: "exp-grant-chip",
      "data-proj-on": projection,
      onClick: onToggleProjection,
      title: `Grant ${grant.grant_id} · ${grant.client_display} · ${grant.granted_field_count}/${grant.total_field_count} fields. Click to toggle field projection.`
    }, /*#__PURE__*/React.createElement("span", {
      className: "exp-grant-chip__bug"
    }, "LV"), /*#__PURE__*/React.createElement("span", null, grant.client_display), /*#__PURE__*/React.createElement("span", {
      className: "exp-grant-chip__expires"
    }, "\xB7  ", days, "d  \xB7  ", projection ? "projected" : "all fields"));
  }

  /* ─── FacetLine ───────────────────────────────────────────────────── */

  function FacetLine({
    hits,
    facets,
    query,
    onAddChip,
    activeView
  }) {
    const totalCount = hits.length;
    const streamCount = facets.streams.length;
    const ppl = facets.people.length;
    const months = facets.months.length;
    return /*#__PURE__*/React.createElement("div", {
      className: "exp-facets"
    }, /*#__PURE__*/React.createElement("span", {
      className: "exp-facets__count"
    }, totalCount === 0 ? "no results" : totalCount === 1 ? "1 record" : `${totalCount.toLocaleString()} records`), totalCount > 0 ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
      className: "exp-facets__sep"
    }, "\xB7"), /*#__PURE__*/React.createElement("span", {
      className: "exp-facets__group"
    }, "spans ", months === 1 ? "1 month" : `${months} months`), streamCount > 0 ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
      className: "exp-facets__sep"
    }, "\xB7"), /*#__PURE__*/React.createElement("span", {
      className: "exp-facets__group"
    }, facets.streams.slice(0, 4).map(([s, c], i) => /*#__PURE__*/React.createElement("button", {
      className: "exp-facet",
      key: i,
      onClick: () => onAddChip({
        field: "stream",
        op: "in",
        value: [s.connector_id]
      })
    }, s.connector_id, /*#__PURE__*/React.createElement("span", {
      className: "exp-facet__count"
    }, c))), streamCount > 4 ? /*#__PURE__*/React.createElement("span", {
      style: {
        marginLeft: "0.3rem"
      }
    }, "+", streamCount - 4, " more") : null)) : null, ppl > 0 ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
      className: "exp-facets__sep"
    }, "\xB7"), /*#__PURE__*/React.createElement("span", {
      className: "exp-facets__group"
    }, facets.people.slice(0, 4).map(([p, c]) => {
      const first = window.PDPP_QUERY.firstNameToken(p);
      if (!first) return null;
      return /*#__PURE__*/React.createElement("button", {
        className: "exp-facet",
        key: p,
        onClick: () => onAddChip({
          field: "from",
          op: "is",
          value: first
        }),
        title: `Filter to ${p}`
      }, first, /*#__PURE__*/React.createElement("span", {
        className: "exp-facet__count"
      }, c));
    }))) : null, facets.categories.length > 0 ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
      className: "exp-facets__sep"
    }, "\xB7"), /*#__PURE__*/React.createElement("span", {
      className: "exp-facets__group"
    }, facets.categories.slice(0, 3).map(([cat, c]) => /*#__PURE__*/React.createElement("button", {
      className: "exp-facet",
      key: cat,
      onClick: () => onAddChip({
        field: "category",
        op: "is",
        value: cat
      })
    }, cat.toLowerCase().split(" ").join("·"), /*#__PURE__*/React.createElement("span", {
      className: "exp-facet__count"
    }, c))))) : null) : null, /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1
      }
    }), query.chips.length > 0 || query.text ? /*#__PURE__*/React.createElement("span", {
      className: "exp-facets__group",
      style: {
        marginRight: "0.4rem"
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "exp-facet",
      onClick: () => {
        const url = new URL(window.location.href);
        url.hash = "#" + encodeURIComponent(JSON.stringify(query));
        navigator.clipboard?.writeText(url.toString());
      },
      title: "Copy this view as a URL"
    }, "share view")) : null);
  }
  const root = ReactDOM.createRoot(document.getElementById("app"));
  root.render(/*#__PURE__*/React.createElement(App, null));
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "explorer/app.jsx", error: String((e && e.message) || e) }); }

// explorer/data.js
try { (() => {
/**
 * PDPP Explorer — seed data
 *
 * Mirrors what a real `/v1/schema` + `/v1/streams` response would look like
 * for a grant authorized across the bundled polyfill connectors. The
 * Explorer is dispatch-driven (see dispatch.js); none of this data is
 * special-cased by connector id anywhere downstream.
 *
 * Date anchor: May 24, 2026 (today).
 */

// ─── helpers ────────────────────────────────────────────────────────────
const NOW = new Date("2026-05-24T16:30:00-07:00").getTime();
const DAY = 86400_000;
const HOUR = 3600_000;
const MIN = 60_000;
const ago = ms => new Date(NOW - ms).toISOString();
const at = d => new Date(d).toISOString();
let _rid = 0;
const rid = prefix => `${prefix}_${(++_rid).toString(36).padStart(5, "0")}`;

// ─── grant ──────────────────────────────────────────────────────────────
const grant = {
  grant_id: "g_lv_2026_05_17_b91a",
  client_id: "longview.app",
  client_display: "Longview",
  client_summary: "Compensation planning workspace",
  status: "active",
  issued_at: ago(7 * DAY),
  expires_at: at(NOW + 14 * DAY),
  scope: "single_use_extended",
  access_mode: "continuous",
  granted_streams: ["gmail/messages", "slack/messages", "chase/transactions", "amazon/orders", "github/events", "strava/activities", "photos/media", "oura/sleep", "calendar/events"],
  granted_field_count: 47,
  total_field_count: 112
};

// ─── connections ────────────────────────────────────────────────────────
const connections = [{
  id: "c_gmail_p",
  connector_id: "gmail",
  display_name: "the owner@nunamak.com",
  group: "Google",
  account_kind: "personal"
}, {
  id: "c_gmail_w",
  connector_id: "gmail",
  display_name: "the owner@vana.org",
  group: "Google",
  account_kind: "work"
}, {
  id: "c_photos",
  connector_id: "google_takeout",
  display_name: "the owner@nunamak.com",
  group: "Google",
  account_kind: "personal"
}, {
  id: "c_slack",
  connector_id: "slack",
  display_name: "vana.slack.com",
  group: "Slack",
  account_kind: "work"
}, {
  id: "c_chase",
  connector_id: "chase",
  display_name: "Chase •6432",
  group: "Chase",
  account_kind: "personal"
}, {
  id: "c_amazon",
  connector_id: "amazon",
  display_name: "the owner@nunamak.com",
  group: "Amazon",
  account_kind: "personal"
}, {
  id: "c_github",
  connector_id: "github",
  display_name: "owner",
  group: "GitHub",
  account_kind: "personal"
}, {
  id: "c_strava",
  connector_id: "strava",
  display_name: "the owner Nunamaker",
  group: "Strava",
  account_kind: "personal"
}, {
  id: "c_oura",
  connector_id: "oura",
  display_name: "Ring Gen3 · silver",
  group: "Oura",
  account_kind: "personal"
}, {
  id: "c_ical",
  connector_id: "ical",
  display_name: "personal.ics",
  group: "Calendar",
  account_kind: "personal"
}];

// ─── streams: schema + records ──────────────────────────────────────────
// Schemas declare typed fields; dispatch.js infers capabilities from these.
// Records are flat JSON; views render them generically.

// GMAIL ─────────────────────────────────────────────────────────────────
const gmailFields = [{
  name: "id",
  type: "id",
  granted: true
}, {
  name: "thread_id",
  type: "id",
  granted: true
}, {
  name: "from",
  type: "person",
  granted: true
}, {
  name: "to",
  type: "person[]",
  granted: true
}, {
  name: "subject",
  type: "text",
  granted: true
}, {
  name: "snippet",
  type: "text",
  granted: true
}, {
  name: "body",
  type: "text",
  granted: false,
  redacted_reason: "client requested only headers + snippet"
}, {
  name: "date",
  type: "timestamp",
  granted: true
}, {
  name: "labels",
  type: "enum[]",
  granted: true
}, {
  name: "has_attachment",
  type: "boolean",
  granted: true
}];
const gmailViews = ["all", "unread", "this_week", "starred"];
const gmailPersonalRecords = [{
  id: rid("gm"),
  thread_id: "t01",
  from: "Maya Chen <maya.chen@figma.com>",
  to: ["the owner@nunamak.com"],
  subject: "re: portfolio review thursday",
  snippet: "Thursday 2pm still works on my end. I'll bring the redlines from the consent flow we talked about — curious what you think of the copper rule on…",
  date: ago(2 * HOUR),
  labels: ["Inbox", "Starred"],
  has_attachment: false,
  body: "Thursday 2pm still works on my end. I'll bring the redlines from the consent flow we talked about — curious what you think of the copper rule on the grant inspector. Also: I think I figured out the weird thing with the right-pane scrim, I'll show you in person.\n\nMaya"
}, {
  id: rid("gm"),
  thread_id: "t02",
  from: "Southwest Airlines <noreply@iluv.southwest.com>",
  to: ["the owner@nunamak.com"],
  subject: "Your trip to Austin is confirmed — May 31",
  snippet: "Confirmation L4M2QP · the owner Nunamaker · SFO → AUS · Sat May 31 · 6:35a · Wanna Get Away+",
  date: ago(8 * HOUR),
  labels: ["Inbox", "Travel"],
  has_attachment: true
}, {
  id: rid("gm"),
  thread_id: "t03",
  from: "Anthropic <noreply@account.anthropic.com>",
  to: ["the owner@nunamak.com"],
  subject: "Your monthly receipt",
  snippet: "Receipt for May 2026 — Claude Pro $20.00 charged to Visa ending in 6432. Thanks for being a subscriber.",
  date: ago(1 * DAY + 4 * HOUR),
  labels: ["Inbox", "Receipts"],
  has_attachment: true
}, {
  id: rid("gm"),
  thread_id: "t04",
  from: "mom <ellen.nunamaker@gmail.com>",
  to: ["the owner@nunamak.com"],
  subject: "the chickens",
  snippet: "Hattie laid a green egg today!! It's the size of a quarter. Sending pics. Dad says hi and is mad about the gutters again.",
  date: ago(2 * DAY),
  labels: ["Inbox"],
  has_attachment: true
}, {
  id: rid("gm"),
  thread_id: "t05",
  from: "Tara Patel <tara@longview.app>",
  to: ["the owner@nunamak.com"],
  subject: "Longview client integration — grant ready?",
  snippet: "Hi the owner — we got our scoped grant approved this morning. Wanted to flag: we're noticing some streams come back with `connection_id` populated and some without…",
  date: ago(3 * DAY + 6 * HOUR),
  labels: ["Inbox"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "t06",
  from: "Strava <no-reply@strava.com>",
  to: ["the owner@nunamak.com"],
  subject: "Your weekly summary: 31.4 mi",
  snippet: "Nice work this week. 3 runs · 31.4 mi · 4h 48m · 1,247 ft elevation. New all-time best for May.",
  date: ago(4 * DAY),
  labels: ["Inbox", "Updates"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "t07",
  from: "Chase Online <no-reply@chase.com>",
  to: ["the owner@nunamak.com"],
  subject: "Alert: large purchase on •6432",
  snippet: "A $487.14 purchase at Apple Store was made on May 19. If this was you, no action needed. Otherwise reply STOP or call us.",
  date: ago(5 * DAY),
  labels: ["Inbox", "Banking"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "t08",
  from: "GitHub <noreply@github.com>",
  to: ["the owner@nunamak.com"],
  subject: "[vana-com/pdpp] PR #847 was merged: capability dispatch in explorer",
  snippet: "Merged by @maya-chen · 12 files changed · +482 −137",
  date: ago(6 * DAY),
  labels: ["Inbox", "Code"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "t09",
  from: "Spotify <no-reply@spotify.com>",
  to: ["the owner@nunamak.com"],
  subject: "Your minutes this month: 1,847",
  snippet: "You listened more than 87% of users in San Francisco this month. Top artist: Caroline Polachek. Top genre: art pop.",
  date: ago(8 * DAY),
  labels: ["Inbox"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "t10",
  from: "Maya Chen <maya.chen@figma.com>",
  to: ["the owner@nunamak.com"],
  subject: "stair brewery sat?",
  snippet: "they have the saison on tap again. 4ish? bring the dog",
  date: ago(12 * DAY),
  labels: ["Inbox", "Starred"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "t11",
  from: "Costco Wholesale <orders@costco.com>",
  to: ["the owner@nunamak.com"],
  subject: "Your Costco order is ready for pickup",
  snippet: "Order #C-58291 · Pickup window: May 14, 4–6pm · 8 items · Total: $213.47",
  date: ago(14 * DAY),
  labels: ["Inbox", "Receipts"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "t12",
  from: "ACLU <action@aclu.org>",
  to: ["the owner@nunamak.com"],
  subject: "the owner — your May donation receipt",
  snippet: "Thank you for your monthly $25 contribution. Tax receipt attached. Every dollar funds the fight.",
  date: ago(18 * DAY),
  labels: ["Inbox", "Receipts"],
  has_attachment: true
}];
const gmailWorkRecords = [{
  id: rid("gm"),
  thread_id: "t20",
  from: "a person Vasquez <a person@vana.org>",
  to: ["the owner@vana.org"],
  subject: "[PDPP] design review — explorer prototype",
  snippet: "Sending notes from yesterday. tldr: the field-projection toggle is the killer feature, lean into it. also: command-K should default to lexical not semantic.",
  date: ago(4 * HOUR),
  labels: ["Inbox", "Important"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "t21",
  from: "a person Vasquez <a person@vana.org>",
  to: ["the owner@vana.org", "maya@vana.org"],
  subject: "Re: launch readiness sync",
  snippet: "Pushing tomorrow's standup to 10:30 — Maya has the IETF call at 9. Agenda is in the doc, anyone can add.",
  date: ago(1 * DAY),
  labels: ["Inbox"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "t22",
  from: "Calendar <calendar-notification@google.com>",
  to: ["the owner@vana.org"],
  subject: "Invitation: PDPP biweekly (May 27)",
  snippet: "Wed May 27 · 11:00–11:30 · a person, Maya, the owner, Drew · Zoom · recurring biweekly",
  date: ago(2 * DAY),
  labels: ["Inbox", "Calendar"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "t23",
  from: "Drew Park <drew@vana.org>",
  to: ["the owner@vana.org"],
  subject: "fwd: from the IETF list",
  snippet: "Worth a read — the working group is converging on something close to PDPP's grant model. They're calling it scoped-read profiles.",
  date: ago(5 * DAY),
  labels: ["Inbox"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "t24",
  from: "1Password <noreply@1password.com>",
  to: ["the owner@vana.org"],
  subject: "New device signed in",
  snippet: "A new device (MacBook Pro · Safari 18) signed into your work vault from San Francisco, CA. If this was you, no action needed.",
  date: ago(8 * DAY),
  labels: ["Inbox", "Security"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "t25",
  from: "Notion <team@mail.notion.so>",
  to: ["the owner@vana.org"],
  subject: "a person shared a page with you: \"explorer copy passes\"",
  snippet: "a person Vasquez shared the page \"explorer copy passes\" in the Vana workspace. 14 comments waiting.",
  date: ago(10 * DAY),
  labels: ["Inbox"],
  has_attachment: false
}];

// SLACK ─────────────────────────────────────────────────────────────────
const slackFields = [{
  name: "id",
  type: "id",
  granted: true
}, {
  name: "channel_id",
  type: "id",
  granted: true
}, {
  name: "channel",
  type: "text",
  granted: true
}, {
  name: "thread_ts",
  type: "id",
  granted: true
}, {
  name: "author",
  type: "person",
  granted: true
}, {
  name: "text",
  type: "text",
  granted: true
}, {
  name: "ts",
  type: "timestamp",
  granted: true
}, {
  name: "reactions",
  type: "json",
  granted: true
}, {
  name: "is_dm",
  type: "boolean",
  granted: true
}];
const slackViews = ["all", "this_week", "channels", "dms", "threads_im_in"];
const slackRecords = [{
  id: rid("sl"),
  channel: "#eng-platform",
  channel_id: "C01",
  thread_ts: null,
  author: "a person Vasquez",
  text: "ok the dispatch is in. capability detection working for gmail/slack/chase. amazon/strava next.",
  ts: ago(45 * MIN),
  reactions: [{
    emoji: "🚀",
    count: 3
  }, {
    emoji: "👀",
    count: 1
  }],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "#eng-platform",
  channel_id: "C01",
  thread_ts: null,
  author: "the owner Nunamaker",
  text: "nice. how is it handling streams with mixed signals (e.g. photos has timestamp + geo + blob)?",
  ts: ago(40 * MIN),
  reactions: [],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "#eng-platform",
  channel_id: "C01",
  thread_ts: null,
  author: "a person Vasquez",
  text: "lights up all three views. table is always there as floor. honestly feels right",
  ts: ago(38 * MIN),
  reactions: [{
    emoji: "💯",
    count: 2
  }],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "#design",
  channel_id: "C02",
  thread_ts: null,
  author: "Maya Chen",
  text: "draft of the grant strip is in figma — i went with the always-visible variant. the dismissable one felt like an ad",
  ts: ago(3 * HOUR),
  reactions: [{
    emoji: "✅",
    count: 4
  }],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "#design",
  channel_id: "C02",
  thread_ts: null,
  author: "Drew Park",
  text: "agree. one note: the expires-in countdown should be subtle, not loud. red only in the last 24h",
  ts: ago(2 * HOUR + 50 * MIN),
  reactions: [{
    emoji: "👍",
    count: 2
  }],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "#general",
  channel_id: "C00",
  thread_ts: null,
  author: "a person Vasquez",
  text: "reminder: launch readiness sync tomorrow 10:30, not 9. agenda doc is open for additions",
  ts: ago(5 * HOUR),
  reactions: [{
    emoji: "🗓️",
    count: 7
  }],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "DM with Maya Chen",
  channel_id: "D01",
  thread_ts: null,
  author: "Maya Chen",
  text: "do you want me to bring the redlines printed thursday or just on screen?",
  ts: ago(1 * DAY + 2 * HOUR),
  reactions: [],
  is_dm: true
}, {
  id: rid("sl"),
  channel: "DM with Maya Chen",
  channel_id: "D01",
  thread_ts: null,
  author: "the owner Nunamaker",
  text: "screen is fine. coffee plan stands?",
  ts: ago(1 * DAY + 1 * HOUR + 50 * MIN),
  reactions: [{
    emoji: "☕",
    count: 1
  }],
  is_dm: true
}, {
  id: rid("sl"),
  channel: "DM with Maya Chen",
  channel_id: "D01",
  thread_ts: null,
  author: "Maya Chen",
  text: "yep. ritual @ 1:30. see you there",
  ts: ago(1 * DAY + 1 * HOUR + 45 * MIN),
  reactions: [],
  is_dm: true
}, {
  id: rid("sl"),
  channel: "#eng-platform",
  channel_id: "C01",
  thread_ts: null,
  author: "Drew Park",
  text: "btw the openapi spec for /v1/search now has the mode enum — lexical/semantic/hybrid. backwards compatible, mode is optional, defaults to lexical",
  ts: ago(1 * DAY + 6 * HOUR),
  reactions: [{
    emoji: "📘",
    count: 2
  }],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "#eng-platform",
  channel_id: "C01",
  thread_ts: null,
  author: "the owner Nunamaker",
  text: "the explorer is going to expose that as a pill in command-K. \"lex / sem / hybrid\". feels right",
  ts: ago(1 * DAY + 5 * HOUR + 30 * MIN),
  reactions: [{
    emoji: "💡",
    count: 1
  }],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "#general",
  channel_id: "C00",
  thread_ts: null,
  author: "Drew Park",
  text: "tara from longview shipped the demo client. it's running against our sandbox AS. genuinely cool to see external code requesting a scoped grant",
  ts: ago(2 * DAY),
  reactions: [{
    emoji: "🎉",
    count: 9
  }, {
    emoji: "🔥",
    count: 4
  }],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "#design",
  channel_id: "C02",
  thread_ts: null,
  author: "Maya Chen",
  text: "should the home screen lead with memories or with the heatmap? i keep flipping",
  ts: ago(2 * DAY + 4 * HOUR),
  reactions: [],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "#design",
  channel_id: "C02",
  thread_ts: null,
  author: "the owner Nunamaker",
  text: "memories. heatmap is dense — better as a second-fold module. memories is what you want to *open* the app for",
  ts: ago(2 * DAY + 3 * HOUR + 55 * MIN),
  reactions: [{
    emoji: "✨",
    count: 3
  }],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "#random",
  channel_id: "C03",
  thread_ts: null,
  author: "Drew Park",
  text: "hattie laid a green egg apparently. the owner has photographic evidence",
  ts: ago(2 * DAY + 8 * HOUR),
  reactions: [{
    emoji: "🥚",
    count: 6
  }, {
    emoji: "🐔",
    count: 4
  }],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "DM with a person Vasquez",
  channel_id: "D02",
  thread_ts: null,
  author: "a person Vasquez",
  text: "are you good to demo the explorer at the IETF thing wed? 15 min slot, second half can be Q&A",
  ts: ago(3 * DAY),
  reactions: [],
  is_dm: true
}, {
  id: rid("sl"),
  channel: "DM with a person Vasquez",
  channel_id: "D02",
  thread_ts: null,
  author: "the owner Nunamaker",
  text: "yes. i'll lead with the field-projection toggle. that's the moment.",
  ts: ago(3 * DAY - 10 * MIN),
  reactions: [{
    emoji: "💪",
    count: 1
  }],
  is_dm: true
}, {
  id: rid("sl"),
  channel: "#general",
  channel_id: "C00",
  thread_ts: null,
  author: "a person Vasquez",
  text: "spec working group put out 0.9-rc1. our reference impl validates clean against it. one minor breaking change in /v1/search results shape — drew's PR covers it",
  ts: ago(5 * DAY),
  reactions: [{
    emoji: "📦",
    count: 5
  }],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "#eng-platform",
  channel_id: "C01",
  thread_ts: null,
  author: "Maya Chen",
  text: "is anyone else seeing the chase connector eat its 2FA cookie between runs? it's been every-time-otp for two weeks",
  ts: ago(6 * DAY),
  reactions: [{
    emoji: "😩",
    count: 2
  }],
  is_dm: false
}, {
  id: rid("sl"),
  channel: "#eng-platform",
  channel_id: "C01",
  thread_ts: null,
  author: "Drew Park",
  text: "yeah — _tmprememberme is session-only. there's an open PR. it's a chase-side change in how they set the cookie",
  ts: ago(6 * DAY - 5 * MIN),
  reactions: [{
    emoji: "🔍",
    count: 1
  }],
  is_dm: false
}];

// CHASE ─────────────────────────────────────────────────────────────────
const chaseFields = [{
  name: "id",
  type: "id",
  granted: true
}, {
  name: "account_id",
  type: "id",
  granted: true
}, {
  name: "posted_at",
  type: "timestamp",
  granted: true
}, {
  name: "merchant",
  type: "text",
  granted: true
}, {
  name: "category",
  type: "enum",
  granted: true
}, {
  name: "amount",
  type: "currency",
  granted: true,
  currency: "USD"
}, {
  name: "balance_after",
  type: "currency",
  granted: false,
  redacted_reason: "running balance not in grant"
}, {
  name: "memo",
  type: "text",
  granted: true
}];
const chaseViews = ["all", "this_month", "by_category", "large_only"];
const chaseRecords = [{
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(6 * HOUR),
  merchant: "Blue Bottle Coffee — Mint Plaza",
  category: "Food & Drink",
  amount: -5.75,
  memo: ""
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(1 * DAY + 2 * HOUR),
  merchant: "Trader Joe's",
  category: "Groceries",
  amount: -67.42,
  memo: ""
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(1 * DAY + 8 * HOUR),
  merchant: "Caltrain · Mobile",
  category: "Transit",
  amount: -7.00,
  memo: "Mountain View → 22nd St"
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(2 * DAY),
  merchant: "Ritual Coffee Roasters",
  category: "Food & Drink",
  amount: -4.50,
  memo: ""
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(3 * DAY),
  merchant: "Pacific Gas & Electric",
  category: "Utilities",
  amount: -118.34,
  memo: "Bill payment"
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(4 * DAY),
  merchant: "Whole Foods",
  category: "Groceries",
  amount: -84.19,
  memo: ""
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(4 * DAY + 3 * HOUR),
  merchant: "Lyft · Ride",
  category: "Transit",
  amount: -14.20,
  memo: "Mission → Outer Sunset"
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(5 * DAY),
  merchant: "Apple Store — Stockton St",
  category: "Electronics",
  amount: -487.14,
  memo: "AirPods Max"
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(6 * DAY),
  merchant: "Stripe — Payroll Deposit",
  category: "Income",
  amount: 4_872.00,
  memo: "Vana May 1-15"
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(7 * DAY),
  merchant: "Rainbow Grocery",
  category: "Groceries",
  amount: -31.07,
  memo: ""
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(9 * DAY),
  merchant: "Comcast Internet",
  category: "Utilities",
  amount: -89.99,
  memo: ""
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(10 * DAY),
  merchant: "Tartine Bakery",
  category: "Food & Drink",
  amount: -12.50,
  memo: ""
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(11 * DAY),
  merchant: "Costco Wholesale",
  category: "Groceries",
  amount: -213.47,
  memo: ""
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(13 * DAY),
  merchant: "Amazon.com",
  category: "Shopping",
  amount: -42.18,
  memo: "Books"
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(15 * DAY),
  merchant: "Chevron · Castro",
  category: "Transit",
  amount: -52.40,
  memo: ""
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(17 * DAY),
  merchant: "ACLU of Northern California",
  category: "Donations",
  amount: -25.00,
  memo: "Monthly"
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(20 * DAY),
  merchant: "Stripe — Payroll Deposit",
  category: "Income",
  amount: 4_872.00,
  memo: "Vana April 16-30"
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(22 * DAY),
  merchant: "Bi-Rite Market",
  category: "Groceries",
  amount: -38.91,
  memo: ""
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(24 * DAY),
  merchant: "Hayes Valley Bakeworks",
  category: "Food & Drink",
  amount: -8.75,
  memo: ""
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: ago(26 * DAY),
  merchant: "Anthropic — Claude Pro",
  category: "Subscriptions",
  amount: -20.00,
  memo: ""
}];

// AMAZON ────────────────────────────────────────────────────────────────
const amazonFields = [{
  name: "id",
  type: "id",
  granted: true
}, {
  name: "ordered_at",
  type: "timestamp",
  granted: true
}, {
  name: "title",
  type: "text",
  granted: true
}, {
  name: "merchant",
  type: "text",
  granted: true
}, {
  name: "amount",
  type: "currency",
  granted: true,
  currency: "USD"
}, {
  name: "thumbnail",
  type: "blob",
  granted: true,
  media_type: "image/jpeg"
}, {
  name: "status",
  type: "enum",
  granted: true
}, {
  name: "tracking_id",
  type: "id",
  granted: false,
  redacted_reason: "out of scope"
}];
const amazonViews = ["all", "this_year", "by_seller"];
const amazonRecords = [{
  id: rid("az"),
  ordered_at: ago(2 * DAY),
  title: "Hario V60 Plastic Coffee Dripper, Size 02",
  merchant: "Hario Direct",
  amount: -14.99,
  thumbnail: "https://picsum.photos/seed/hario/240",
  status: "Delivered"
}, {
  id: rid("az"),
  ordered_at: ago(6 * DAY),
  title: "DK Bicycles Crank Brothers Eggbeater 3 Pedals",
  merchant: "Crank Brothers",
  amount: -129.95,
  thumbnail: "https://picsum.photos/seed/pedal/240",
  status: "Delivered"
}, {
  id: rid("az"),
  ordered_at: ago(11 * DAY),
  title: "Anker 737 Power Bank 24,000mAh 140W USB-C",
  merchant: "AnkerDirect",
  amount: -89.99,
  thumbnail: "https://picsum.photos/seed/anker/240",
  status: "Delivered"
}, {
  id: rid("az"),
  ordered_at: ago(13 * DAY),
  title: "The Address Book by Sophie Calle",
  merchant: "Siglio Press",
  amount: -42.18,
  thumbnail: "https://picsum.photos/seed/book/240",
  status: "Delivered"
}, {
  id: rid("az"),
  ordered_at: ago(18 * DAY),
  title: "Field Notes Original Kraft 3-Pack (Graph)",
  merchant: "Field Notes Brand",
  amount: -12.95,
  thumbnail: "https://picsum.photos/seed/fieldnotes/240",
  status: "Delivered"
}, {
  id: rid("az"),
  ordered_at: ago(22 * DAY),
  title: "Stanley IceFlow Flip Straw Tumbler 30oz",
  merchant: "Stanley",
  amount: -35.00,
  thumbnail: "https://picsum.photos/seed/stanley/240",
  status: "Delivered"
}];

// GITHUB ────────────────────────────────────────────────────────────────
const githubFields = [{
  name: "id",
  type: "id",
  granted: true
}, {
  name: "type",
  type: "enum",
  granted: true
}, {
  name: "repo",
  type: "text",
  granted: true
}, {
  name: "title",
  type: "text",
  granted: true
}, {
  name: "body",
  type: "text",
  granted: true
}, {
  name: "actor",
  type: "person",
  granted: true
}, {
  name: "created_at",
  type: "timestamp",
  granted: true
}, {
  name: "url",
  type: "url",
  granted: true
}, {
  name: "additions",
  type: "number",
  granted: true
}, {
  name: "deletions",
  type: "number",
  granted: true
}];
const githubViews = ["all", "commits", "prs", "issues"];
const githubRecords = [{
  id: rid("gh"),
  type: "PullRequest",
  repo: "vana-com/pdpp",
  title: "explorer: capability dispatch + tier-1 table view",
  body: "Implements the schema-signal dispatch we discussed. Streams now declare typed fields and the explorer infers timeline/map/gallery/ledger/conversation/calendar/reader/chart eligibility from the fields, not the connector id.",
  actor: "owner",
  created_at: ago(3 * HOUR),
  url: "https://github.com/vana-com/pdpp/pull/851",
  additions: 712,
  deletions: 184
}, {
  id: rid("gh"),
  type: "Push",
  repo: "vana-com/pdpp",
  title: "fix: peek panel respects field projection toggle",
  body: "Was showing all fields regardless of grant.",
  actor: "owner",
  created_at: ago(8 * HOUR),
  url: "https://github.com/vana-com/pdpp/commit/a47c2d1",
  additions: 28,
  deletions: 12
}, {
  id: rid("gh"),
  type: "PullRequest",
  repo: "vana-com/pdpp",
  title: "search: expose mode (lexical/semantic/hybrid)",
  body: "Propagates the new search mode enum through MCP and the dashboard search view.",
  actor: "drewpark",
  created_at: ago(1 * DAY + 2 * HOUR),
  url: "https://github.com/vana-com/pdpp/pull/848",
  additions: 412,
  deletions: 89
}, {
  id: rid("gh"),
  type: "PullRequest",
  repo: "vana-com/pdpp",
  title: "[merged] capability dispatch in explorer",
  body: "First version of the dispatch + table fallback. Connector-specific layouts will land in follow-up PRs.",
  actor: "mayachen",
  created_at: ago(6 * DAY),
  url: "https://github.com/vana-com/pdpp/pull/847",
  additions: 482,
  deletions: 137
}, {
  id: rid("gh"),
  type: "Issue",
  repo: "vana-com/pdpp",
  title: "chase connector loses trusted-device cookie between runs",
  body: "Every run requires fresh SMS OTP. Suspect _tmprememberme is session-only.",
  actor: "owner",
  created_at: ago(6 * DAY + 4 * HOUR),
  url: "https://github.com/vana-com/pdpp/issues/843",
  additions: 0,
  deletions: 0
}, {
  id: rid("gh"),
  type: "Push",
  repo: "owner/clawmeter",
  title: "0.4.2: nicer histogram colors",
  body: "Use copper for the bars and grey for the baseline.",
  actor: "owner",
  created_at: ago(9 * DAY),
  url: "https://github.com/owner/clawmeter/commit/9d7e3a2",
  additions: 14,
  deletions: 8
}, {
  id: rid("gh"),
  type: "PullRequest",
  repo: "vana-com/pdpp",
  title: "polyfill-connectors: scaffold loom + linkedin",
  body: "Manifest + connector shell only; selectors TBD with live co-pilot session.",
  actor: "owner",
  created_at: ago(12 * DAY),
  url: "https://github.com/vana-com/pdpp/pull/831",
  additions: 348,
  deletions: 0
}, {
  id: rid("gh"),
  type: "Issue",
  repo: "vana-com/pdpp",
  title: "MCP `search` mode pill not surfaced in agent skill",
  body: "We added the enum but the Claude skill instructions still pin mode=lexical.",
  actor: "annavasquez",
  created_at: ago(15 * DAY),
  url: "https://github.com/vana-com/pdpp/issues/827",
  additions: 0,
  deletions: 0
}, {
  id: rid("gh"),
  type: "Push",
  repo: "owner/dotfiles",
  title: "switch shell to ghostty + nushell",
  body: "no regrets",
  actor: "owner",
  created_at: ago(19 * DAY),
  url: "https://github.com/owner/dotfiles/commit/0c8a91f",
  additions: 84,
  deletions: 142
}, {
  id: rid("gh"),
  type: "PullRequest",
  repo: "vana-com/pdpp",
  title: "docs: human/protocol duality writeup",
  body: "Adds README section on the 2px copper-vs-blue temperature system.",
  actor: "mayachen",
  created_at: ago(23 * DAY),
  url: "https://github.com/vana-com/pdpp/pull/814",
  additions: 187,
  deletions: 14
}];

// STRAVA ────────────────────────────────────────────────────────────────
const stravaFields = [{
  name: "id",
  type: "id",
  granted: true
}, {
  name: "type",
  type: "enum",
  granted: true
}, {
  name: "title",
  type: "text",
  granted: true
}, {
  name: "started_at",
  type: "timestamp",
  granted: true
}, {
  name: "distance_m",
  type: "number",
  granted: true,
  unit: "meters"
}, {
  name: "duration_s",
  type: "number",
  granted: true,
  unit: "seconds"
}, {
  name: "elev_m",
  type: "number",
  granted: true,
  unit: "meters"
}, {
  name: "start_lat",
  type: "number",
  granted: true
}, {
  name: "start_lng",
  type: "number",
  granted: true
}, {
  name: "polyline",
  type: "geo",
  granted: false,
  redacted_reason: "route geometry not in grant"
}];
const stravaViews = ["all", "runs", "rides", "this_month"];
const stravaRecords = [{
  id: rid("st"),
  type: "Run",
  title: "Lunch trail loop · Glen Canyon",
  started_at: ago(7 * HOUR),
  distance_m: 8_240,
  duration_s: 2_730,
  elev_m: 187,
  start_lat: 37.7390,
  start_lng: -122.4408
}, {
  id: rid("st"),
  type: "Ride",
  title: "Marin Headlands · Hawk Hill",
  started_at: ago(2 * DAY + 4 * HOUR),
  distance_m: 38_700,
  duration_s: 6_840,
  elev_m: 612,
  start_lat: 37.8324,
  start_lng: -122.4795
}, {
  id: rid("st"),
  type: "Run",
  title: "Easy shakeout — Mission Dolores",
  started_at: ago(3 * DAY + 7 * HOUR),
  distance_m: 5_080,
  duration_s: 1_680,
  elev_m: 41,
  start_lat: 37.7585,
  start_lng: -122.4263
}, {
  id: rid("st"),
  type: "Run",
  title: "Sunday long — Lands End",
  started_at: ago(5 * DAY + 8 * HOUR),
  distance_m: 18_120,
  duration_s: 6_180,
  elev_m: 284,
  start_lat: 37.7820,
  start_lng: -122.5060
}, {
  id: rid("st"),
  type: "Ride",
  title: "Commute · Mission → Soma",
  started_at: ago(6 * DAY + 1 * HOUR),
  distance_m: 4_310,
  duration_s: 1_080,
  elev_m: 28,
  start_lat: 37.7599,
  start_lng: -122.4147
}, {
  id: rid("st"),
  type: "Run",
  title: "Track Tuesday — 6x800",
  started_at: ago(8 * DAY + 7 * HOUR),
  distance_m: 9_600,
  duration_s: 2_810,
  elev_m: 12,
  start_lat: 37.7311,
  start_lng: -122.4470
}, {
  id: rid("st"),
  type: "Ride",
  title: "Sausalito ferry loop",
  started_at: ago(11 * DAY + 9 * HOUR),
  distance_m: 52_400,
  duration_s: 9_120,
  elev_m: 487,
  start_lat: 37.8086,
  start_lng: -122.4108
}, {
  id: rid("st"),
  type: "Run",
  title: "Recovery — Bernal Heights",
  started_at: ago(13 * DAY + 8 * HOUR),
  distance_m: 4_700,
  duration_s: 1_620,
  elev_m: 91,
  start_lat: 37.7430,
  start_lng: -122.4140
}, {
  id: rid("st"),
  type: "Run",
  title: "Hill repeats — Sanchez stairs",
  started_at: ago(15 * DAY + 7 * HOUR),
  distance_m: 6_800,
  duration_s: 2_280,
  elev_m: 312,
  start_lat: 37.7510,
  start_lng: -122.4291
}, {
  id: rid("st"),
  type: "Ride",
  title: "GG Park to Ocean Beach",
  started_at: ago(18 * DAY + 10 * HOUR),
  distance_m: 14_200,
  duration_s: 2_640,
  elev_m: 78,
  start_lat: 37.7694,
  start_lng: -122.4862
}, {
  id: rid("st"),
  type: "Run",
  title: "Crissy Field flat",
  started_at: ago(22 * DAY + 7 * HOUR),
  distance_m: 7_300,
  duration_s: 2_460,
  elev_m: 22,
  start_lat: 37.8030,
  start_lng: -122.4660
}, {
  id: rid("st"),
  type: "Run",
  title: "Long — Presidio loop",
  started_at: ago(26 * DAY + 8 * HOUR),
  distance_m: 16_400,
  duration_s: 5_700,
  elev_m: 198,
  start_lat: 37.7989,
  start_lng: -122.4662
}];

// PHOTOS ────────────────────────────────────────────────────────────────
const photosFields = [{
  name: "id",
  type: "id",
  granted: true
}, {
  name: "taken_at",
  type: "timestamp",
  granted: true
}, {
  name: "caption",
  type: "text",
  granted: true
}, {
  name: "thumbnail",
  type: "blob",
  granted: true,
  media_type: "image/jpeg"
}, {
  name: "lat",
  type: "number",
  granted: true
}, {
  name: "lng",
  type: "number",
  granted: true
}, {
  name: "camera",
  type: "text",
  granted: false,
  redacted_reason: "EXIF stripped — out of scope"
}, {
  name: "people",
  type: "person[]",
  granted: false,
  redacted_reason: "face-detection metadata not in grant"
}];
const photosViews = ["all", "this_month", "starred", "by_place"];
const photosRecords = [{
  id: rid("ph"),
  taken_at: ago(6 * HOUR),
  caption: "morning light, kitchen",
  thumbnail: "https://picsum.photos/seed/morn-light/600",
  lat: 37.7599,
  lng: -122.4147
}, {
  id: rid("ph"),
  taken_at: ago(1 * DAY + 4 * HOUR),
  caption: "trail above Glen Park",
  thumbnail: "https://picsum.photos/seed/glen-trail/600",
  lat: 37.7390,
  lng: -122.4408
}, {
  id: rid("ph"),
  taken_at: ago(2 * DAY + 8 * HOUR),
  caption: "the green egg",
  thumbnail: "https://picsum.photos/seed/green-egg/600",
  lat: 39.5296,
  lng: -119.8138
}, {
  id: rid("ph"),
  taken_at: ago(3 * DAY),
  caption: "a person's whiteboard sketch",
  thumbnail: "https://picsum.photos/seed/whiteboard/600",
  lat: 37.7794,
  lng: -122.4078
}, {
  id: rid("ph"),
  taken_at: ago(4 * DAY + 7 * HOUR),
  caption: "fog rolling in, twin peaks",
  thumbnail: "https://picsum.photos/seed/fog-tp/600",
  lat: 37.7544,
  lng: -122.4477
}, {
  id: rid("ph"),
  taken_at: ago(6 * DAY),
  caption: "espresso, ritual",
  thumbnail: "https://picsum.photos/seed/espresso/600",
  lat: 37.7765,
  lng: -122.4243
}, {
  id: rid("ph"),
  taken_at: ago(8 * DAY),
  caption: "bike against the wall",
  thumbnail: "https://picsum.photos/seed/bike-wall/600",
  lat: 37.7599,
  lng: -122.4147
}, {
  id: rid("ph"),
  taken_at: ago(11 * DAY + 9 * HOUR),
  caption: "sausalito, mid ferry",
  thumbnail: "https://picsum.photos/seed/ferry/600",
  lat: 37.8590,
  lng: -122.4853
}, {
  id: rid("ph"),
  taken_at: ago(14 * DAY),
  caption: "library window",
  thumbnail: "https://picsum.photos/seed/library/600",
  lat: 37.7793,
  lng: -122.4162
}, {
  id: rid("ph"),
  taken_at: ago(17 * DAY),
  caption: "wet hydrant, Castro",
  thumbnail: "https://picsum.photos/seed/hydrant/600",
  lat: 37.7609,
  lng: -122.4351
}, {
  id: rid("ph"),
  taken_at: ago(20 * DAY),
  caption: "yellow door, Mission",
  thumbnail: "https://picsum.photos/seed/yellow-door/600",
  lat: 37.7595,
  lng: -122.4148
}, {
  id: rid("ph"),
  taken_at: ago(25 * DAY),
  caption: "old MUNI signal",
  thumbnail: "https://picsum.photos/seed/muni-sig/600",
  lat: 37.7707,
  lng: -122.4316
}];

// OURA ──────────────────────────────────────────────────────────────────
const ouraFields = [{
  name: "id",
  type: "id",
  granted: true
}, {
  name: "night_of",
  type: "timestamp",
  granted: true
}, {
  name: "score",
  type: "number",
  granted: true,
  unit: "0-100"
}, {
  name: "deep_min",
  type: "number",
  granted: true,
  unit: "minutes"
}, {
  name: "rem_min",
  type: "number",
  granted: true,
  unit: "minutes"
}, {
  name: "light_min",
  type: "number",
  granted: true,
  unit: "minutes"
}, {
  name: "hrv_ms",
  type: "number",
  granted: true,
  unit: "ms"
}, {
  name: "resting_hr",
  type: "number",
  granted: true,
  unit: "bpm"
}];
const ouraViews = ["all", "this_month", "low_score"];
const ouraRecords = Array.from({
  length: 14
}, (_, i) => ({
  id: rid("ou"),
  night_of: ago((i + 1) * DAY - 6 * HOUR),
  score: [82, 76, 88, 91, 71, 79, 85, 84, 67, 73, 88, 92, 80, 74][i],
  deep_min: [62, 51, 78, 81, 42, 58, 71, 69, 38, 47, 74, 82, 64, 49][i],
  rem_min: [108, 94, 121, 134, 81, 99, 117, 115, 73, 88, 119, 128, 105, 92][i],
  light_min: [212, 198, 234, 247, 174, 201, 226, 224, 165, 188, 230, 241, 218, 196][i],
  hrv_ms: [48, 42, 56, 61, 38, 44, 52, 51, 34, 41, 55, 59, 47, 43][i],
  resting_hr: [54, 56, 51, 50, 58, 55, 52, 53, 60, 57, 51, 50, 54, 56][i]
}));

// CALENDAR (iCal) ───────────────────────────────────────────────────────
const calendarFields = [{
  name: "id",
  type: "id",
  granted: true
}, {
  name: "title",
  type: "text",
  granted: true
}, {
  name: "start",
  type: "timestamp",
  granted: true
}, {
  name: "end",
  type: "timestamp",
  granted: true
}, {
  name: "location",
  type: "text",
  granted: true
}, {
  name: "attendees",
  type: "person[]",
  granted: true
}, {
  name: "description",
  type: "text",
  granted: false,
  redacted_reason: "description excluded by grant"
}];
const calendarViews = ["upcoming", "all", "this_week"];
const calendarRecords = [{
  id: rid("cal"),
  title: "Standup",
  start: at(NOW + 14 * HOUR),
  end: at(NOW + 14.5 * HOUR),
  location: "Zoom",
  attendees: ["a person Vasquez", "Maya Chen", "Drew Park", "the owner Nunamaker"]
}, {
  id: rid("cal"),
  title: "Coffee w/ Maya",
  start: at(NOW + 1 * DAY + 6 * HOUR),
  end: at(NOW + 1 * DAY + 7 * HOUR),
  location: "Ritual Coffee Mission",
  attendees: ["Maya Chen", "the owner Nunamaker"]
}, {
  id: rid("cal"),
  title: "Portfolio review w/ Maya",
  start: at(NOW + 3 * DAY + 5 * HOUR),
  end: at(NOW + 3 * DAY + 6 * HOUR),
  location: "Figma SF",
  attendees: ["Maya Chen", "the owner Nunamaker"]
}, {
  id: rid("cal"),
  title: "PDPP biweekly",
  start: at(NOW + 3 * DAY + 11 * HOUR),
  end: at(NOW + 3 * DAY + 11.5 * HOUR),
  location: "Zoom",
  attendees: ["a person Vasquez", "Maya Chen", "Drew Park", "the owner Nunamaker"]
}, {
  id: rid("cal"),
  title: "Flight SFO → AUS (Southwest L4M2QP)",
  start: at(NOW + 7 * DAY + 6.5 * HOUR),
  end: at(NOW + 7 * DAY + 10 * HOUR),
  location: "SFO Terminal 1",
  attendees: []
}, {
  id: rid("cal"),
  title: "Dentist · Dr. Mei",
  start: at(NOW + 9 * DAY + 9 * HOUR),
  end: at(NOW + 9 * DAY + 10 * HOUR),
  location: "1700 Castro St",
  attendees: []
}];

// ─── deep-time synthetic records ────────────────────────────────────
// Seeded records spanning ~8 years so the year strip / memories have
// substance to render against. Real users would have ~10× this.

const Y = (year, month, day, hour = 12) => new Date(Date.UTC(year, month - 1, day, hour, 0)).toISOString();
const deepGmail = [{
  id: rid("gm"),
  thread_id: "th1",
  from: "Maya Chen <maya.chen@figma.com>",
  to: ["the owner@nunamak.com"],
  subject: "happy birthday old man",
  snippet: "hope it's a good one. drinks tomorrow at zeitgeist?",
  date: Y(2025, 5, 24, 9),
  labels: ["Inbox", "Starred"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "th2",
  from: "United Airlines <flights@united.com>",
  to: ["the owner@nunamak.com"],
  subject: "Your flight to Tokyo on May 24 is confirmed",
  snippet: "SFO → NRT · UA837 · 11:40am · seat 14A",
  date: Y(2024, 5, 24, 7),
  labels: ["Inbox", "Travel"],
  has_attachment: true
}, {
  id: rid("gm"),
  thread_id: "th3",
  from: "a person Vasquez <a person@vana.org>",
  to: ["the owner@nunamak.com"],
  subject: "welcome to vana",
  snippet: "the owner — so glad to have you on board. Here's everything you need for your first week.",
  date: Y(2023, 8, 14, 10),
  labels: ["Inbox", "Important"],
  has_attachment: true
}, {
  id: rid("gm"),
  thread_id: "th4",
  from: "Apple <noreply@apple.com>",
  to: ["the owner@nunamak.com"],
  subject: "Your iPhone 13 is ready for pickup",
  snippet: "Order #W4729103 · Apple Store Stockton St",
  date: Y(2022, 9, 24, 14),
  labels: ["Inbox", "Receipts"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "th5",
  from: "mom <ellen.nunamaker@gmail.com>",
  to: ["the owner@nunamak.com"],
  subject: "the new puppy!!",
  snippet: "we named her hattie. sending all the photos.",
  date: Y(2021, 4, 11, 17),
  labels: ["Inbox"],
  has_attachment: true
}, {
  id: rid("gm"),
  thread_id: "th6",
  from: "Square <receipts@squareup.com>",
  to: ["the owner@nunamak.com"],
  subject: "Receipt from Ritual Coffee",
  snippet: "$4.50 · cortado · Tip $1.00",
  date: Y(2020, 3, 7, 9),
  labels: ["Inbox", "Receipts"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "th7",
  from: "OkCupid <noreply@okcupid.com>",
  to: ["the owner@nunamak.com"],
  subject: "You have a new match",
  snippet: "Someone liked you back. Open the app to chat.",
  date: Y(2019, 7, 22, 20),
  labels: ["Inbox"],
  has_attachment: false
}, {
  id: rid("gm"),
  thread_id: "th8",
  from: "Stanford Alumni <alumni@stanford.edu>",
  to: ["the owner@nunamak.com"],
  subject: "Class of 2014 — 5-year reunion",
  snippet: "Save the date: October 19, 2019. Memorial Auditorium.",
  date: Y(2018, 11, 2, 11),
  labels: ["Inbox"],
  has_attachment: false
}];
const deepPhotos = [{
  id: rid("ph"),
  taken_at: Y(2025, 5, 24, 9),
  caption: "birthday morning",
  thumbnail: "https://picsum.photos/seed/bd25/600",
  lat: 37.7599,
  lng: -122.4147
}, {
  id: rid("ph"),
  taken_at: Y(2024, 5, 24, 14),
  caption: "shinjuku at noon",
  thumbnail: "https://picsum.photos/seed/tokyo24/600",
  lat: 35.6895,
  lng: 139.6917
}, {
  id: rid("ph"),
  taken_at: Y(2023, 12, 31, 22),
  caption: "NYE rooftop",
  thumbnail: "https://picsum.photos/seed/nye23/600",
  lat: 37.7749,
  lng: -122.4194
}, {
  id: rid("ph"),
  taken_at: Y(2022, 9, 24, 15),
  caption: "new phone, first photo",
  thumbnail: "https://picsum.photos/seed/iph22/600",
  lat: 37.7768,
  lng: -122.4063
}, {
  id: rid("ph"),
  taken_at: Y(2021, 4, 11, 18),
  caption: "hattie, first day home",
  thumbnail: "https://picsum.photos/seed/hattie/600",
  lat: 39.5296,
  lng: -119.8138
}, {
  id: rid("ph"),
  taken_at: Y(2020, 6, 18, 19),
  caption: "balcony tomatoes, year 1",
  thumbnail: "https://picsum.photos/seed/toms/600",
  lat: 37.7599,
  lng: -122.4147
}, {
  id: rid("ph"),
  taken_at: Y(2019, 8, 4, 16),
  caption: "trout, Yellowstone",
  thumbnail: "https://picsum.photos/seed/yst19/600",
  lat: 44.4280,
  lng: -110.5885
}, {
  id: rid("ph"),
  taken_at: Y(2018, 6, 16, 12),
  caption: "graduation day",
  thumbnail: "https://picsum.photos/seed/grad18/600",
  lat: 37.4275,
  lng: -122.1697
}];
const deepChase = [{
  id: rid("ch"),
  account_id: "•6432",
  posted_at: Y(2025, 5, 24, 21),
  merchant: "Zeitgeist",
  category: "Food & Drink",
  amount: -38.00,
  memo: ""
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: Y(2024, 5, 24, 11),
  merchant: "United Airlines",
  category: "Travel",
  amount: -1_482.00,
  memo: "SFO → NRT"
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: Y(2022, 9, 24, 14),
  merchant: "Apple Store — Stockton St",
  category: "Electronics",
  amount: -1_099.00,
  memo: "iPhone 13"
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: Y(2020, 6, 14, 9),
  merchant: "Sloat Garden Center",
  category: "Home",
  amount: -84.40,
  memo: "soil, tomato cages"
}, {
  id: rid("ch"),
  account_id: "•6432",
  posted_at: Y(2018, 8, 1, 10),
  merchant: "Stripe — Payroll Deposit",
  category: "Income",
  amount: 3_200.00,
  memo: "first paycheck"
}];
const deepGithub = [{
  id: rid("gh"),
  type: "PullRequest",
  repo: "vana-com/pdpp",
  title: "init repo, README",
  body: "Hello world.",
  actor: "owner",
  created_at: Y(2023, 9, 1, 14),
  url: "https://github.com/vana-com/pdpp/pull/1",
  additions: 412,
  deletions: 0
}, {
  id: rid("gh"),
  type: "Push",
  repo: "owner/dotfiles",
  title: "first commit",
  body: "",
  actor: "owner",
  created_at: Y(2018, 7, 14, 21),
  url: "",
  additions: 87,
  deletions: 0
}, {
  id: rid("gh"),
  type: "PullRequest",
  repo: "owner/clawmeter",
  title: "0.1.0 — initial release",
  body: "",
  actor: "owner",
  created_at: Y(2020, 11, 19, 16),
  url: "",
  additions: 1_482,
  deletions: 0
}];
gmailPersonalRecords.push(...deepGmail);
photosRecords.push(...deepPhotos);
chaseRecords.push(...deepChase);
githubRecords.push(...deepGithub);

// ─── assembled streams ─────────────────────────────────────────────────
const streams = [{
  name: "messages",
  connector_id: "gmail",
  connection_id: "c_gmail_p",
  title: "Gmail · personal",
  icon: "✉",
  connection_display: "the owner@nunamak.com",
  record_count: 27_359,
  latest_at: gmailPersonalRecords[0].date,
  schema: {
    fields: gmailFields,
    views: gmailViews
  },
  records: gmailPersonalRecords
}, {
  name: "messages",
  connector_id: "gmail",
  connection_id: "c_gmail_w",
  title: "Gmail · work",
  icon: "✉",
  connection_display: "the owner@vana.org",
  record_count: 8_412,
  latest_at: gmailWorkRecords[0].date,
  schema: {
    fields: gmailFields,
    views: gmailViews
  },
  records: gmailWorkRecords
}, {
  name: "messages",
  connector_id: "slack",
  connection_id: "c_slack",
  title: "Slack · vana",
  icon: "▤",
  connection_display: "vana.slack.com",
  record_count: 14_028,
  latest_at: slackRecords[0].ts,
  schema: {
    fields: slackFields,
    views: slackViews
  },
  records: slackRecords
}, {
  name: "transactions",
  connector_id: "chase",
  connection_id: "c_chase",
  title: "Chase · •6432",
  icon: "$",
  connection_display: "•6432",
  record_count: 1_482,
  latest_at: chaseRecords[0].posted_at,
  schema: {
    fields: chaseFields,
    views: chaseViews
  },
  records: chaseRecords
}, {
  name: "orders",
  connector_id: "amazon",
  connection_id: "c_amazon",
  title: "Amazon · orders",
  icon: "▪",
  connection_display: "the owner@nunamak.com",
  record_count: 2_863,
  latest_at: amazonRecords[0].ordered_at,
  schema: {
    fields: amazonFields,
    views: amazonViews
  },
  records: amazonRecords
}, {
  name: "events",
  connector_id: "github",
  connection_id: "c_github",
  title: "GitHub · owner",
  icon: "<>",
  connection_display: "owner",
  record_count: 553,
  latest_at: githubRecords[0].created_at,
  schema: {
    fields: githubFields,
    views: githubViews
  },
  records: githubRecords
}, {
  name: "activities",
  connector_id: "strava",
  connection_id: "c_strava",
  title: "Strava · activities",
  icon: "↗",
  connection_display: "the owner Nunamaker",
  record_count: 412,
  latest_at: stravaRecords[0].started_at,
  schema: {
    fields: stravaFields,
    views: stravaViews
  },
  records: stravaRecords
}, {
  name: "media",
  connector_id: "google_takeout",
  connection_id: "c_photos",
  title: "Photos · Takeout",
  icon: "□",
  connection_display: "the owner@nunamak.com",
  record_count: 18_240,
  latest_at: photosRecords[0].taken_at,
  schema: {
    fields: photosFields,
    views: photosViews
  },
  records: photosRecords
}, {
  name: "sleep",
  connector_id: "oura",
  connection_id: "c_oura",
  title: "Oura · sleep",
  icon: "○",
  connection_display: "Ring Gen3",
  record_count: 421,
  latest_at: ouraRecords[0].night_of,
  schema: {
    fields: ouraFields,
    views: ouraViews
  },
  records: ouraRecords
}, {
  name: "events",
  connector_id: "ical",
  connection_id: "c_ical",
  title: "Calendar · personal",
  icon: "▭",
  connection_display: "personal.ics",
  record_count: 312,
  latest_at: calendarRecords[0].start,
  schema: {
    fields: calendarFields,
    views: calendarViews
  },
  records: calendarRecords
}];
window.PDPP_DATA = {
  grant,
  connections,
  streams,
  now: NOW
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "explorer/data.js", error: String((e && e.message) || e) }); }

// explorer/discover.jsx
try { (() => {
/* PDPP Explorer — Discoverables (Immich / Apple Photos / Spotify Wrapped / Strava)
 *
 * These render at the top of the feed when no filters are active, and
 * surface delightful, schema-driven navigation that works for ANY
 * connector — not just the bundled ones.
 *
 * Each component is purely a function of typed schema fields:
 *   - DayStory     — per-stream counts + numeric aggregates for "today"
 *   - EntityRails  — person / merchant / channel rails (Immich Faces, generalized)
 *   - ActivityStrip — 30-day density heatmap across granted streams (Strava)
 *   - findMemories — records from exactly N years/months ago (Apple Photos)
 */

;
(() => {
  const {
    useMemo
  } = React;
  const {
    fmtRelative,
    fmtClock,
    fmtDate,
    fmtDay,
    fmtCurrency,
    fmtDistance,
    initials,
    NOW
  } = window.PDPPPrim;

  // ─── helpers ─────────────────────────────────────────────────────────

  function recordTimeISO(stream, r) {
    const tf = stream.schema.fields.find(f => f.type === "timestamp")?.name ?? stream.schema.fields.find(f => /date|at$|night_of/i.test(f.name))?.name;
    return tf ? r[tf] : null;
  }
  function avatarColor(s) {
    let h = 0;
    for (let i = 0; i < (s ?? "").length; i++) h = h * 31 + s.charCodeAt(i) | 0;
    return `oklch(0.55 0.12 ${Math.abs(h) % 360})`;
  }
  function cleanPerson(s) {
    if (!s) return "";
    return String(s).replace(/<[^>]+>/g, "").trim();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Day Story — "Today across your data"
  //
  // References: Spotify Wrapped (story-card), Stripe Dashboard (key metrics)
  // Generalized: counts records per stream that touched today; pulls headline
  // numeric aggregates (sum of currency, sum of distance, average of score).
  // ═══════════════════════════════════════════════════════════════════════

  function DayStory({
    streams
  }) {
    const todayStart = useMemo(() => {
      const d = new Date(NOW);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }, []);
    const todayEnd = todayStart + 86_400_000;

    // Total records today
    const stats = useMemo(() => {
      const out = [];
      for (const s of streams) {
        const tf = s.schema.fields.find(f => f.type === "timestamp")?.name;
        if (!tf) continue;
        const today = s.records.filter(r => {
          const t = new Date(r[tf]).getTime();
          return t >= todayStart && t < todayEnd;
        });
        if (!today.length) continue;
        const fs = s.schema.fields;
        const cur = fs.find(f => f.type === "currency");
        const dist = fs.find(f => /^distance/i.test(f.name));
        const dur = fs.find(f => /^duration/i.test(f.name));
        const blob = fs.find(f => f.type === "blob" && (f.media_type ?? "").startsWith("image/"));
        const score = fs.find(f => f.name === "score");
        if (cur) {
          const net = today.reduce((x, r) => x + (r[cur.name] ?? 0), 0);
          out.push({
            stream: s,
            label: net < 0 ? "spent" : "received",
            value: fmtCurrency(net),
            n: today.length
          });
        } else if (dist) {
          const m = today.reduce((x, r) => x + (r[dist.name] ?? 0), 0);
          out.push({
            stream: s,
            label: "moved",
            value: fmtDistance(m),
            n: today.length
          });
        } else if (blob) {
          out.push({
            stream: s,
            label: "photo" + (today.length === 1 ? "" : "s"),
            value: String(today.length),
            n: today.length
          });
        } else if (score) {
          const avg = today.reduce((x, r) => x + (r[score.name] ?? 0), 0) / today.length;
          out.push({
            stream: s,
            label: "score",
            value: avg.toFixed(0),
            n: today.length
          });
        } else {
          out.push({
            stream: s,
            label: s.name,
            value: String(today.length),
            n: today.length
          });
        }
      }
      return out.sort((a, b) => b.n - a.n).slice(0, 4);
    }, [streams, todayStart, todayEnd]);
    if (!stats.length) return null;
    const totalToday = stats.reduce((x, s) => x + s.n, 0);
    return /*#__PURE__*/React.createElement("section", {
      className: "day-story"
    }, /*#__PURE__*/React.createElement("div", {
      className: "day-story__head"
    }, /*#__PURE__*/React.createElement("div", {
      className: "day-story__date"
    }, new Date(NOW).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric"
    })), /*#__PURE__*/React.createElement("div", {
      className: "day-story__title"
    }, /*#__PURE__*/React.createElement("b", null, totalToday), " record", totalToday === 1 ? "" : "s", " so far")), /*#__PURE__*/React.createElement("div", {
      className: "day-story__stats"
    }, stats.map(s => /*#__PURE__*/React.createElement("div", {
      className: "day-story__stat",
      key: `${s.stream.connection_id}::${s.stream.name}::${s.label}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "day-story__stat-value"
    }, s.value), /*#__PURE__*/React.createElement("div", {
      className: "day-story__stat-label"
    }, /*#__PURE__*/React.createElement("span", {
      className: "day-story__stat-glyph"
    }, s.stream.icon), " ", s.label)))));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Activity strip — 30-day density heatmap across ALL granted streams.
  //
  // References: Strava weekly summary, GitHub contribution graph.
  // Generalized: any stream with a timestamp contributes; intensity is total
  // record count per day.
  // ═══════════════════════════════════════════════════════════════════════

  function ActivityStrip({
    streams,
    onPickDay
  }) {
    const days = 30;
    const counts = useMemo(() => {
      const map = new Map();
      for (const s of streams) {
        const tf = s.schema.fields.find(f => f.type === "timestamp")?.name;
        if (!tf) continue;
        for (const r of s.records) {
          const t = r[tf];
          if (!t) continue;
          const d = t.slice(0, 10);
          map.set(d, (map.get(d) ?? 0) + 1);
        }
      }
      return map;
    }, [streams]);
    const max = Math.max(1, ...counts.values());
    const cells = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(NOW - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      const v = counts.get(key) ?? 0;
      const intensity = v === 0 ? 0 : 0.18 + 0.82 * (v / max);
      const isToday = i === 0;
      cells.push({
        key,
        d,
        v,
        intensity,
        isToday
      });
    }
    return /*#__PURE__*/React.createElement("section", {
      className: "actstrip"
    }, /*#__PURE__*/React.createElement("div", {
      className: "actstrip__head"
    }, /*#__PURE__*/React.createElement("div", {
      className: "actstrip__title"
    }, "last 30 days"), /*#__PURE__*/React.createElement("div", {
      className: "actstrip__legend"
    }, /*#__PURE__*/React.createElement("span", null, "less"), [0.18, 0.4, 0.6, 0.8, 1].map(i => /*#__PURE__*/React.createElement("span", {
      className: "actstrip__legend-cell",
      key: i,
      style: {
        background: `color-mix(in oklab, var(--foreground) ${Math.round(i * 100)}%, transparent)`
      }
    })), /*#__PURE__*/React.createElement("span", null, "more"))), /*#__PURE__*/React.createElement("div", {
      className: "actstrip__cells"
    }, cells.map(({
      key,
      d,
      v,
      intensity,
      isToday
    }) => /*#__PURE__*/React.createElement("button", {
      className: "actstrip__cell",
      "data-today": isToday,
      "data-zero": v === 0,
      key: key,
      onClick: () => onPickDay?.(key),
      style: {
        "--intensity": intensity
      },
      title: `${d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric"
      })} · ${v} record${v === 1 ? "" : "s"}`
    }, /*#__PURE__*/React.createElement("span", {
      className: "actstrip__cell-fill"
    }), /*#__PURE__*/React.createElement("span", {
      className: "actstrip__cell-day"
    }, d.getDate())))));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Entity rails — auto-extracted facets that work for any future connector.
  //
  // References: Immich Faces / Places / Things.
  // Generalized: scans every granted stream's schema for fields of type
  // `person`/`person[]` (PeopleRail), or named `merchant`/`payee`/`seller`
  // (MerchantRail), or `channel`/`channel_id` (ChannelRail). Each rail
  // only renders if its underlying field exists somewhere in the grant.
  // ═══════════════════════════════════════════════════════════════════════

  function PeopleRail({
    streams,
    onAddChip
  }) {
    const {
      firstNameToken
    } = window.PDPP_QUERY;
    const people = useMemo(() => {
      const map = new Map();
      for (const s of streams) {
        const personFields = s.schema.fields.filter(f => f.type === "person" || f.type === "person[]");
        if (!personFields.length) continue;
        for (const r of s.records) {
          for (const f of personFields) {
            const v = r[f.name];
            const list = Array.isArray(v) ? v : v ? [v] : [];
            for (const p of list) {
              const name = cleanPerson(p);
              if (!name) continue;
              const first = firstNameToken(p);
              if (!first) continue;
              if (!map.has(first)) map.set(first, {
                display: name,
                count: 0,
                first
              });
              map.get(first).count += 1;
            }
          }
        }
      }
      return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 12);
    }, [streams]);
    if (!people.length) return null;
    return /*#__PURE__*/React.createElement(Rail, {
      label: "People",
      sub: "across granted streams"
    }, people.map(p => /*#__PURE__*/React.createElement("button", {
      className: "rail__entity",
      key: p.first,
      onClick: () => onAddChip({
        field: "from",
        op: "is",
        value: p.first
      })
    }, /*#__PURE__*/React.createElement("span", {
      className: "rail__avatar",
      style: {
        background: avatarColor(p.display)
      }
    }, initials(p.display)), /*#__PURE__*/React.createElement("span", {
      className: "rail__entity-name"
    }, p.first), /*#__PURE__*/React.createElement("span", {
      className: "rail__entity-count"
    }, p.count))));
  }
  function MerchantRail({
    streams,
    onAddChip
  }) {
    const merchants = useMemo(() => {
      const map = new Map();
      for (const s of streams) {
        const merchField = s.schema.fields.find(f => /merchant|payee|counterparty|seller|store/i.test(f.name))?.name;
        if (!merchField) continue;
        const amtField = s.schema.fields.find(f => f.type === "currency")?.name;
        for (const r of s.records) {
          const m = r[merchField];
          if (!m || typeof m !== "string") continue;
          if (!map.has(m)) map.set(m, {
            name: m,
            count: 0,
            total: 0
          });
          const entry = map.get(m);
          entry.count += 1;
          if (amtField) entry.total += r[amtField] ?? 0;
        }
      }
      return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 10);
    }, [streams]);
    if (!merchants.length) return null;
    return /*#__PURE__*/React.createElement(Rail, {
      label: "Merchants",
      sub: "recent activity"
    }, merchants.map(m => /*#__PURE__*/React.createElement("button", {
      className: "rail__entity",
      key: m.name,
      onClick: () => onAddChip({
        field: "text",
        op: "contains",
        value: m.name.split(/[\s·•]/)[0]
      }),
      title: `${m.count} record${m.count === 1 ? "" : "s"}`
    }, /*#__PURE__*/React.createElement("span", {
      className: "rail__avatar rail__avatar--mono",
      style: {
        background: avatarColor(m.name)
      }
    }, m.name.replace(/[^a-z]/gi, "")[0]?.toUpperCase() ?? "·"), /*#__PURE__*/React.createElement("span", {
      className: "rail__entity-name"
    }, m.name.split(/[—·•·-]/)[0].trim().slice(0, 20)), /*#__PURE__*/React.createElement("span", {
      className: "rail__entity-count"
    }, m.count))));
  }
  function ChannelRail({
    streams,
    onAddChip
  }) {
    const channels = useMemo(() => {
      const map = new Map();
      for (const s of streams) {
        const ch = s.schema.fields.find(f => /^channel$/i.test(f.name))?.name;
        if (!ch) continue;
        for (const r of s.records) {
          const v = r[ch];
          if (!v) continue;
          if (!map.has(v)) map.set(v, {
            name: v,
            count: 0
          });
          map.get(v).count += 1;
        }
      }
      return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 8);
    }, [streams]);
    if (!channels.length) return null;
    return /*#__PURE__*/React.createElement(Rail, {
      label: "Channels",
      sub: "conversations"
    }, channels.map(c => /*#__PURE__*/React.createElement("button", {
      className: "rail__entity rail__entity--channel",
      key: c.name,
      onClick: () => onAddChip({
        field: "channel",
        op: "is",
        value: c.name
      })
    }, /*#__PURE__*/React.createElement("span", {
      className: "rail__entity-name"
    }, c.name.startsWith("DM") ? c.name : c.name), /*#__PURE__*/React.createElement("span", {
      className: "rail__entity-count"
    }, c.count))));
  }
  function Rail({
    label,
    sub,
    children
  }) {
    return /*#__PURE__*/React.createElement("section", {
      className: "rail"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rail__head"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "rail__label"
    }, label), /*#__PURE__*/React.createElement("span", {
      className: "rail__sub"
    }, sub)), /*#__PURE__*/React.createElement("div", {
      className: "rail__scroll"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rail__row"
    }, children)));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Memories — surface records from N years or months ago.
  //
  // Reference: Apple Photos "On this day".
  // Generalized: any record with a timestamp; we look for exactly N×365 days
  // ago and N×30 days ago. Returns up to 3 hits.
  // ═══════════════════════════════════════════════════════════════════════

  function findMemories(streams) {
    const out = [];
    const today = new Date(NOW);
    const m = today.getMonth();
    const d = today.getDate();
    // Anniversaries we care about: same month/day, going back as far as data allows
    const targetYears = [];
    for (let yearsAgo = 1; yearsAgo <= 15; yearsAgo++) {
      targetYears.push(today.getFullYear() - yearsAgo);
    }
    const seen = new Set();
    for (const ya of targetYears) {
      const day = new Date(Date.UTC(ya, m, d)).toISOString().slice(0, 10);
      for (const s of streams) {
        const tf = s.schema.fields.find(f => f.type === "timestamp")?.name;
        if (!tf) continue;
        for (const r of s.records) {
          if (r[tf]?.slice(0, 10) === day) {
            const key = `${s.connection_id}::${r.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const yearsAgo = today.getFullYear() - ya;
            out.push({
              stream: s,
              record: r,
              label: yearsAgo === 1 ? "1 year ago" : `${yearsAgo} years ago`
            });
            if (out.length >= 4) return out;
          }
        }
      }
    }
    // Fallback: same day-of-month last month
    if (out.length < 2) {
      const lastMonth = new Date(today.getFullYear(), m - 1, d).toISOString().slice(0, 10);
      for (const s of streams) {
        const tf = s.schema.fields.find(f => f.type === "timestamp")?.name;
        if (!tf) continue;
        for (const r of s.records) {
          if (r[tf]?.slice(0, 10) === lastMonth) {
            out.push({
              stream: s,
              record: r,
              label: "1 month ago"
            });
            if (out.length >= 4) return out;
          }
        }
      }
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // YearStrip — Apple Photos "Years" zoom level
  //
  // One cell per year across the grant's full time horizon. Density encodes
  // per-year record count. Click to add a `year:YYYY` chip. This is the
  // move that makes a 20-year personal archive feel navigable.
  // ═══════════════════════════════════════════════════════════════════════

  function YearStrip({
    streams,
    onAddChip
  }) {
    const years = useMemo(() => {
      const map = new Map();
      let earliest = null,
        latest = null;
      for (const s of streams) {
        const tf = s.schema.fields.find(f => f.type === "timestamp")?.name;
        if (!tf) continue;
        for (const r of s.records) {
          const t = r[tf];
          if (!t) continue;
          const y = Number(t.slice(0, 4));
          if (Number.isFinite(y)) {
            map.set(y, (map.get(y) ?? 0) + 1);
            if (earliest == null || y < earliest) earliest = y;
            if (latest == null || y > latest) latest = y;
          }
        }
      }
      if (earliest == null) return [];
      const list = [];
      for (let y = earliest; y <= latest; y++) {
        list.push({
          year: y,
          count: map.get(y) ?? 0
        });
      }
      return list;
    }, [streams]);
    if (years.length < 2) return null;
    const max = Math.max(1, ...years.map(y => y.count));
    const total = years.reduce((x, y) => x + y.count, 0);
    const span = years.length;
    const thisYear = new Date(NOW).getFullYear();
    return /*#__PURE__*/React.createElement("section", {
      className: "yearstrip"
    }, /*#__PURE__*/React.createElement("div", {
      className: "yearstrip__head"
    }, /*#__PURE__*/React.createElement("div", {
      className: "yearstrip__title"
    }, /*#__PURE__*/React.createElement("span", {
      className: "yearstrip__eyebrow"
    }, "all time"), /*#__PURE__*/React.createElement("span", {
      className: "yearstrip__count"
    }, total.toLocaleString(), " records"), /*#__PURE__*/React.createElement("span", {
      className: "yearstrip__span"
    }, "spans ", span, " year", span === 1 ? "" : "s", " \xB7 ", years[0].year, " \u2192 ", years[years.length - 1].year))), /*#__PURE__*/React.createElement("div", {
      className: "yearstrip__cells"
    }, years.map(({
      year,
      count
    }) => {
      const intensity = count === 0 ? 0 : 0.2 + 0.8 * (count / max);
      const isThis = year === thisYear;
      return /*#__PURE__*/React.createElement("button", {
        className: "yearstrip__cell",
        "data-this": isThis,
        "data-zero": count === 0,
        key: year,
        onClick: () => onAddChip({
          field: "year",
          op: "is",
          value: year
        }),
        title: `${year} — ${count.toLocaleString()} record${count === 1 ? "" : "s"}`
      }, /*#__PURE__*/React.createElement("span", {
        className: "yearstrip__bar",
        style: {
          height: `${Math.round(intensity * 100)}%`
        }
      }), /*#__PURE__*/React.createElement("span", {
        className: "yearstrip__year"
      }, String(year).slice(2)));
    })));
  }
  window.PDPP_DISCOVER = {
    DayStory,
    ActivityStrip,
    PeopleRail,
    MerchantRail,
    ChannelRail,
    YearStrip,
    findMemories
  };
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "explorer/discover.jsx", error: String((e && e.message) || e) }); }

// explorer/dispatch.js
try { (() => {
/**
 * PDPP Explorer — capability dispatch
 *
 * Takes a stream (schema + sample records) and returns the set of views
 * that should light up. Pure function of the schema's field types — never
 * branches on connector_id or stream name.
 *
 * Tier 1: Table is always returned (it's the floor).
 * Tier 2: Capability views are added based on detected schema signals.
 * Tier 3: An optional `preferred_view` may come in from outside the connector
 *         manifest (e.g. schema annotation or user override). We honor it
 *         only if the view is actually activated by Tier 2.
 */

const VIEW_ORDER = [
// Order matters: pickInitial picks the first activated capability that
// isn't "table". So we put the most semantically-specific views first
// (ledger > conversation > gallery > calendar > map > reader > chart >
// timeline > table). A stream that lights up multiple gets the most
// informative default. Users can override via the view switcher.
"ledger", "conversation", "gallery", "calendar", "map", "reader", "chart", "timeline", "table"];
const FIELD_HINTS = {
  // Lexical clues used in addition to type. Always lowercased before match.
  author: ["author", "from", "sender", "user", "user_id", "actor"],
  body: ["body", "text", "message", "content", "snippet"],
  thread: ["thread_id", "thread_ts", "channel", "channel_id", "conversation_id", "conv_id"],
  geo: ["lat", "lng", "longitude", "latitude", "geo", "location", "polyline", "coords"],
  amount: ["amount", "value", "price", "total"],
  ts_lex: ["date", "ts", "occurred_at", "created_at", "started_at", "taken_at", "posted_at", "night_of", "ordered_at"],
  start: ["start", "starts_at", "start_at", "begin"],
  end: ["end", "ends_at", "end_at", "finish"],
  title: ["title", "subject", "name", "headline"]
};
function namesByHint(fields, hintKey) {
  const hints = FIELD_HINTS[hintKey];
  return fields.filter(f => hints.includes(String(f.name).toLowerCase())).map(f => f.name);
}
function detect(stream) {
  const fields = stream.schema?.fields ?? [];
  const fieldByName = Object.fromEntries(fields.map(f => [f.name, f]));
  const names = new Set(fields.map(f => f.name));
  const has = n => names.has(n);
  const ofType = t => fields.filter(f => f.type === t).map(f => f.name);
  const activated = new Set();
  /** Map of capability → array of field names that triggered it (the "why"). */
  const signals = {};
  const declare = (cap, fields) => {
    activated.add(cap);
    signals[cap] = fields.filter(Boolean);
  };

  // Find a temporal anchor: explicit type=timestamp, else lexical fallback.
  const tsFields = ofType("timestamp");
  const tsLex = namesByHint(fields, "ts_lex");
  const timeField = tsFields[0] ?? tsLex[0];

  // ─── timeline ─────────────────────────────────────────────────────
  // Any record carrying a temporal anchor is timeline-able.
  if (timeField) declare("timeline", [timeField]);

  // ─── map ──────────────────────────────────────────────────────────
  // Explicit geo type, or lat+lng pair, or named geo fields.
  const geoFields = ofType("geo");
  const latField = fields.find(f => /^lat(itude)?$/i.test(f.name))?.name;
  const lngField = fields.find(f => /^l(ng|on|ongitude)$/i.test(f.name))?.name;
  if (geoFields.length || latField && lngField) {
    declare("map", [...geoFields, latField, lngField]);
  }

  // ─── gallery ──────────────────────────────────────────────────────
  // A blob field with image media type, or a clearly-named thumb/image.
  const blobImg = fields.find(f => f.type === "blob" && (f.media_type ?? "").startsWith("image/"));
  const namedImg = fields.find(f => /thumb|image|photo|picture|avatar/i.test(f.name) && (f.type === "blob" || f.type === "url"));
  if (blobImg || namedImg) declare("gallery", [(blobImg ?? namedImg).name]);

  // ─── ledger ──────────────────────────────────────────────────────
  // Currency type, or numeric `amount`/`value` field.
  const currencyField = fields.find(f => f.type === "currency");
  const amountField = currencyField ?? fields.find(f => f.type === "number" && namesByHint([f], "amount").length);
  if (amountField) {
    const counterparty = fields.find(f => /merchant|payee|counterparty|recipient|seller/i.test(f.name));
    declare("ledger", [amountField.name, counterparty?.name].filter(Boolean));
  }

  // ─── conversation ────────────────────────────────────────────────
  // author + text-body + (thread or to). Detected lexically because most
  // schemas don't declare type="message".
  const authorFields = namesByHint(fields, "author");
  const bodyFields = namesByHint(fields, "body");
  const threadFields = namesByHint(fields, "thread");
  const hasTo = has("to") || has("recipient") || has("recipients");
  if (authorFields.length && bodyFields.length && (threadFields.length || hasTo)) {
    declare("conversation", [authorFields[0], bodyFields[0], threadFields[0] ?? (hasTo ? "to" : undefined)]);
  }

  // ─── calendar ────────────────────────────────────────────────────
  // start + (end or duration), with a title nice to have.
  const startFields = namesByHint(fields, "start");
  const endFields = namesByHint(fields, "end");
  const hasDuration = fields.some(f => /^duration/i.test(f.name));
  if (startFields.length && (endFields.length || hasDuration)) {
    declare("calendar", [startFields[0], endFields[0] ?? "duration"]);
  }

  // ─── reader ──────────────────────────────────────────────────────
  // title + long body, no thread (which would route to conversation).
  const titleFields = namesByHint(fields, "title");
  if (titleFields.length && bodyFields.length && !threadFields.length) {
    declare("reader", [titleFields[0], bodyFields[0]]);
  }

  // ─── chart / heatmap ─────────────────────────────────────────────
  // Temporal anchor + at least one numeric measure. We exclude obvious
  // non-measures (lat/lng/id-ish fields) so location streams don't
  // accidentally light up the chart view.
  const isMeasure = f => f.type === "number" && !/^(lat|lng|longitude|latitude|id|.*_id|.*_count)$/i.test(f.name);
  const measures = fields.filter(isMeasure).map(f => f.name);
  if (timeField && measures.length) declare("chart", [timeField, ...measures.slice(0, 3)]);

  // ─── table ───────────────────────────────────────────────────────
  // Always.
  activated.add("table");
  signals.table = ["(any record)"];

  // Order capabilities by VIEW_ORDER for deterministic UI.
  const ordered = VIEW_ORDER.filter(v => activated.has(v));
  return {
    capabilities: ordered,
    signals
  };
}

/**
 * Decide the initial view for a stream.
 * 1. Honor user override (client-side, persisted) if it activated.
 * 2. Honor advisory hint (from out-of-manifest annotation) if it activated.
 * 3. Otherwise pick the highest-ranked activated capability.
 */
function pickInitial(stream, {
  override,
  hint
} = {}) {
  const {
    capabilities
  } = detect(stream);
  if (override && capabilities.includes(override)) return override;
  if (hint && capabilities.includes(hint)) return hint;
  // Prefer richer views by default; table only if nothing else matched.
  const ranked = capabilities.filter(c => c !== "table");
  return ranked[0] ?? "table";
}
window.PDPP_DISPATCH = {
  detect,
  pickInitial,
  VIEW_ORDER
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "explorer/dispatch.js", error: String((e && e.message) || e) }); }

// explorer/feed.jsx
try { (() => {
/* PDPP Explorer — Feed with type-aware cards
 *
 * The card kind is dispatched from the stream's schema signals — same
 * function the view picker uses. Any future connector whose schema
 * carries currency renders as a money card; whose schema carries
 * blob+image renders as a photo card; etc. No connector identity is
 * referenced anywhere.
 *
 * On every viewport the feed is a single column of stacked cards,
 * separated by sticky day headers. This is the canonical view.
 */

;
(() => {
  const {
    useMemo
  } = React;
  const {
    fmtRelative,
    fmtClock,
    fmtDay,
    fmtCurrency,
    fmtDuration,
    fmtDistance,
    initials
  } = window.PDPPPrim;
  const {
    detect
  } = window.PDPP_DISPATCH;

  // ─── Per-record card kind ─────────────────────────────────────────────
  // Reuses the stream-level dispatch to pick a card. "feed-generic" is
  // the universal fallback.
  const KIND_FOR_CAP = {
    conversation: "message",
    ledger: "money",
    gallery: "photo",
    calendar: "event",
    chart: "activity",
    reader: "reader",
    map: "location",
    timeline: "generic",
    table: "generic"
  };
  function cardKindForStream(stream) {
    const {
      capabilities
    } = detect(stream);
    // The first non-table capability wins — same priority order as views.
    for (const cap of capabilities) {
      if (cap === "table") continue;
      return KIND_FOR_CAP[cap] ?? "generic";
    }
    return "generic";
  }

  // ─── Field probes (lexical only — no connector branches) ──────────────
  function findField(stream, regex) {
    return stream.schema.fields.find(f => regex.test(f.name))?.name;
  }
  function findFieldByType(stream, type) {
    return stream.schema.fields.find(f => f.type === type)?.name;
  }
  function findImageField(stream) {
    const blob = stream.schema.fields.find(f => f.type === "blob" && (f.media_type ?? "").startsWith("image/"));
    if (blob) return blob.name;
    return stream.schema.fields.find(f => /thumb|image|photo|picture/i.test(f.name) && (f.type === "blob" || f.type === "url"))?.name;
  }
  function recordTimeISO(stream, r) {
    const tf = findFieldByType(stream, "timestamp") ?? findField(stream, /date|at$|night_of/i);
    return tf ? r[tf] : null;
  }
  function cleanPerson(s) {
    if (!s) return "";
    return String(s).replace(/<[^>]+>/g, "").trim();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Card components — each is small, opinionated, generic over the schema.
  // ═══════════════════════════════════════════════════════════════════════

  function CardEyebrow({
    stream,
    time,
    light
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: `card__eyebrow ${light ? "is-light" : ""}`
    }, /*#__PURE__*/React.createElement("span", {
      className: "card__eyebrow-glyph"
    }, stream.icon), /*#__PURE__*/React.createElement("span", {
      className: "card__eyebrow-stream"
    }, stream.connector_id), /*#__PURE__*/React.createElement("span", {
      className: "card__eyebrow-conn"
    }, "\xB7 ", stream.connection_display), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "card__eyebrow-time"
    }, time ? fmtClock(time) : "—"));
  }
  function MessageCard({
    stream,
    record,
    selected,
    onClick
  }) {
    const authorField = findField(stream, /^from$|author|sender|actor/i) ?? findFieldByType(stream, "person");
    const bodyField = findField(stream, /body|snippet|text|message|content/i);
    const subjField = findField(stream, /subject|title/i);
    const chanField = findField(stream, /channel/i);
    const author = cleanPerson(record[authorField]);
    const time = recordTimeISO(stream, record);
    return /*#__PURE__*/React.createElement("article", {
      className: "card card--message",
      "data-selected": selected,
      onClick: onClick
    }, /*#__PURE__*/React.createElement(CardEyebrow, {
      stream: stream,
      time: time
    }), /*#__PURE__*/React.createElement("div", {
      className: "card__row card__row--message"
    }, /*#__PURE__*/React.createElement("span", {
      className: "card__avatar",
      style: {
        background: avatarColor(author)
      }
    }, initials(author)), /*#__PURE__*/React.createElement("div", {
      className: "card__col"
    }, /*#__PURE__*/React.createElement("div", {
      className: "card__name"
    }, author), chanField && record[chanField] ? /*#__PURE__*/React.createElement("div", {
      className: "card__channel"
    }, record[chanField]) : null)), subjField && record[subjField] ? /*#__PURE__*/React.createElement("div", {
      className: "card__title"
    }, record[subjField]) : null, /*#__PURE__*/React.createElement("div", {
      className: "card__body"
    }, record[bodyField]), Array.isArray(record.reactions) && record.reactions.length ? /*#__PURE__*/React.createElement("div", {
      className: "card__react"
    }, record.reactions.map((rx, i) => /*#__PURE__*/React.createElement("span", {
      key: i
    }, rx.emoji, " ", rx.count))) : null);
  }
  function MoneyCard({
    stream,
    record,
    selected,
    onClick
  }) {
    const amtField = findFieldByType(stream, "currency") ?? findField(stream, /^amount$/i);
    const merchField = findField(stream, /merchant|payee|counterparty|seller/i);
    const catField = findField(stream, /category|kind/i);
    const memoField = findField(stream, /memo|note|description/i);
    const amount = record[amtField] ?? 0;
    const time = recordTimeISO(stream, record);
    return /*#__PURE__*/React.createElement("article", {
      className: "card card--money",
      "data-selected": selected,
      onClick: onClick
    }, /*#__PURE__*/React.createElement(CardEyebrow, {
      stream: stream,
      time: time
    }), /*#__PURE__*/React.createElement("div", {
      className: `card__amount ${amount > 0 ? "is-pos" : ""}`
    }, fmtCurrency(amount)), /*#__PURE__*/React.createElement("div", {
      className: "card__title"
    }, record[merchField] ?? record.title), /*#__PURE__*/React.createElement("div", {
      className: "card__meta-row"
    }, record[catField] ? /*#__PURE__*/React.createElement("span", {
      className: "card__chip"
    }, record[catField]) : null, record[memoField] ? /*#__PURE__*/React.createElement("span", {
      className: "card__meta-text"
    }, record[memoField]) : null));
  }
  function PhotoCard({
    stream,
    record,
    selected,
    onClick
  }) {
    const imgField = findImageField(stream);
    const capField = findField(stream, /caption|title|subject/i);
    const time = recordTimeISO(stream, record);
    // Variable aspect ratios so the feed breathes (Apple Photos masonry feel).
    // Deterministic per record so it doesn't reshuffle.
    const aspectClass = ["is-4x3", "is-3x4", "is-1x1", "is-16x9"][hashId(record.id) % 4];
    return /*#__PURE__*/React.createElement("article", {
      className: `card card--photo ${aspectClass}`,
      "data-selected": selected,
      onClick: onClick
    }, /*#__PURE__*/React.createElement("div", {
      className: "card__photo"
    }, /*#__PURE__*/React.createElement("img", {
      alt: record[capField] ?? "",
      loading: "lazy",
      src: record[imgField]
    }), /*#__PURE__*/React.createElement("div", {
      className: "card__photo-scrim"
    }), /*#__PURE__*/React.createElement(CardEyebrow, {
      light: true,
      stream: stream,
      time: time
    }), /*#__PURE__*/React.createElement("div", {
      className: "card__photo-caption"
    }, record[capField])));
  }
  function hashId(s) {
    let h = 0;
    for (let i = 0; i < (s ?? "").length; i++) h = h * 31 + s.charCodeAt(i) | 0;
    return Math.abs(h);
  }
  function EventCard({
    stream,
    record,
    selected,
    onClick
  }) {
    const titleField = findField(stream, /title|subject|name/i);
    const locField = findField(stream, /location|place/i);
    const startField = findField(stream, /^start/i) ?? findFieldByType(stream, "timestamp");
    const endField = findField(stream, /^end/i);
    const attendField = findField(stream, /attendees|participants/i);
    const start = record[startField];
    const end = record[endField];
    return /*#__PURE__*/React.createElement("article", {
      className: "card card--event",
      "data-selected": selected,
      onClick: onClick
    }, /*#__PURE__*/React.createElement(CardEyebrow, {
      stream: stream,
      time: start
    }), /*#__PURE__*/React.createElement("div", {
      className: "card__event-time"
    }, start ? fmtClock(start) : "", " ", end ? `– ${fmtClock(end)}` : ""), /*#__PURE__*/React.createElement("div", {
      className: "card__title"
    }, record[titleField]), record[locField] ? /*#__PURE__*/React.createElement("div", {
      className: "card__body"
    }, record[locField]) : null, Array.isArray(record[attendField]) && record[attendField].length ? /*#__PURE__*/React.createElement("div", {
      className: "card__meta-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "card__meta-text"
    }, record[attendField].length, " attendee", record[attendField].length === 1 ? "" : "s")) : null);
  }
  function ActivityCard({
    stream,
    record,
    selected,
    onClick
  }) {
    const titleField = findField(stream, /title|name/i);
    const typeField = findField(stream, /^type$/i);
    const distField = findField(stream, /distance/i);
    const durField = findField(stream, /^duration|^elapsed/i);
    const elevField = findField(stream, /elev/i);
    // Sleep-like streams: score + sleep stages
    const scoreField = findField(stream, /^score|^value$/i);
    const time = recordTimeISO(stream, record);
    const stats = [];
    if (distField && record[distField] != null) stats.push({
      label: "distance",
      value: fmtDistance(record[distField])
    });
    if (durField && record[durField] != null) stats.push({
      label: "duration",
      value: fmtDuration(record[durField])
    });
    if (elevField && record[elevField] != null) stats.push({
      label: "elevation",
      value: `${Math.round(record[elevField])}m`
    });
    if (!stats.length && scoreField && record[scoreField] != null) stats.push({
      label: scoreField,
      value: String(record[scoreField])
    });
    return /*#__PURE__*/React.createElement("article", {
      className: "card card--activity",
      "data-selected": selected,
      onClick: onClick
    }, /*#__PURE__*/React.createElement(CardEyebrow, {
      stream: stream,
      time: time
    }), /*#__PURE__*/React.createElement("div", {
      className: "card__title"
    }, record[titleField] ?? record[typeField] ?? "Activity"), /*#__PURE__*/React.createElement("div", {
      className: "card__stats"
    }, stats.map(s => /*#__PURE__*/React.createElement("div", {
      className: "card__stat",
      key: s.label
    }, /*#__PURE__*/React.createElement("div", {
      className: "card__stat-value"
    }, s.value), /*#__PURE__*/React.createElement("div", {
      className: "card__stat-label"
    }, s.label)))));
  }
  function ReaderCard({
    stream,
    record,
    selected,
    onClick
  }) {
    const titleField = findField(stream, /title|subject/i);
    const bodyField = findField(stream, /body|content/i);
    const actorField = findField(stream, /actor|author|user/i);
    const typeField = findField(stream, /^type$/i);
    const repoField = findField(stream, /repo|project/i);
    const time = recordTimeISO(stream, record);
    return /*#__PURE__*/React.createElement("article", {
      className: "card card--reader",
      "data-selected": selected,
      onClick: onClick
    }, /*#__PURE__*/React.createElement(CardEyebrow, {
      stream: stream,
      time: time
    }), record[typeField] || record[repoField] ? /*#__PURE__*/React.createElement("div", {
      className: "card__meta-row"
    }, record[typeField] ? /*#__PURE__*/React.createElement("span", {
      className: "card__chip"
    }, record[typeField]) : null, record[repoField] ? /*#__PURE__*/React.createElement("span", {
      className: "card__meta-text"
    }, record[repoField]) : null) : null, /*#__PURE__*/React.createElement("div", {
      className: "card__title"
    }, record[titleField]), record[bodyField] ? /*#__PURE__*/React.createElement("div", {
      className: "card__body card__body--clamped"
    }, record[bodyField]) : null, record[actorField] ? /*#__PURE__*/React.createElement("div", {
      className: "card__meta-text",
      style: {
        marginTop: "0.5rem"
      }
    }, "by ", cleanPerson(record[actorField])) : null);
  }
  function LocationCard({
    stream,
    record,
    selected,
    onClick
  }) {
    const titleField = findField(stream, /title|caption|name/i);
    const latField = findField(stream, /^lat/i);
    const lngField = findField(stream, /^l(ng|on)/i);
    const time = recordTimeISO(stream, record);
    return /*#__PURE__*/React.createElement("article", {
      className: "card card--location",
      "data-selected": selected,
      onClick: onClick
    }, /*#__PURE__*/React.createElement(CardEyebrow, {
      stream: stream,
      time: time
    }), /*#__PURE__*/React.createElement("div", {
      className: "card__title"
    }, record[titleField] ?? "Location"), /*#__PURE__*/React.createElement("div", {
      className: "card__body card__body--mono"
    }, Number(record[latField]).toFixed(4), ", ", Number(record[lngField]).toFixed(4)));
  }
  function GenericCard({
    stream,
    record,
    selected,
    onClick
  }) {
    // Best-effort: pick a title-ish field, time, and 1–2 secondary values
    const titleField = findField(stream, /title|subject|name|merchant|caption/i);
    const time = recordTimeISO(stream, record);
    const secondary = stream.schema.fields.filter(f => f.granted && f.name !== titleField && f.type !== "id" && f.type !== "blob" && f.type !== "geo" && record[f.name] != null).slice(0, 3);
    return /*#__PURE__*/React.createElement("article", {
      className: "card card--generic",
      "data-selected": selected,
      onClick: onClick
    }, /*#__PURE__*/React.createElement(CardEyebrow, {
      stream: stream,
      time: time
    }), /*#__PURE__*/React.createElement("div", {
      className: "card__title"
    }, record[titleField] ?? record.id), /*#__PURE__*/React.createElement("div", {
      className: "card__kv-list"
    }, secondary.map(f => /*#__PURE__*/React.createElement("div", {
      className: "card__kv",
      key: f.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "card__kv-k"
    }, f.name), /*#__PURE__*/React.createElement("span", {
      className: "card__kv-v"
    }, String(record[f.name]).slice(0, 90))))));
  }
  const CARD_BY_KIND = {
    message: MessageCard,
    money: MoneyCard,
    photo: PhotoCard,
    event: EventCard,
    activity: ActivityCard,
    reader: ReaderCard,
    location: LocationCard,
    generic: GenericCard
  };

  // ─── Stable color from a string (used for message-card avatars) ─────
  function avatarColor(s) {
    let h = 0;
    for (let i = 0; i < (s ?? "").length; i++) h = h * 31 + s.charCodeAt(i) | 0;
    const hue = Math.abs(h) % 360;
    return `oklch(0.52 0.13 ${hue})`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FeedView — groups hits by day, picks a card per record's stream kind.
  // ═══════════════════════════════════════════════════════════════════════

  function FeedView({
    hits,
    selectedId,
    onSelect,
    showDiscover,
    streams,
    onAddChip
  }) {
    // Group by day
    const groups = useMemo(() => {
      const out = [];
      let lastDay = null;
      for (const h of hits) {
        const iso = recordTimeISO(h.stream, h.record);
        const day = iso ? iso.slice(0, 10) : "__no_date__";
        if (day !== lastDay) {
          out.push({
            day,
            items: []
          });
          lastDay = day;
        }
        out[out.length - 1].items.push(h);
      }
      return out;
    }, [hits]);
    const memories = useMemo(() => showDiscover ? window.PDPP_DISCOVER.findMemories(streams ?? []) : [], [showDiscover, streams]);
    const {
      DayStory,
      ActivityStrip,
      PeopleRail,
      MerchantRail,
      ChannelRail,
      YearStrip
    } = window.PDPP_DISCOVER ?? {};
    if (!hits.length) {
      return /*#__PURE__*/React.createElement("div", {
        className: "feed"
      }, showDiscover && DayStory ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(DayStory, {
        streams: streams ?? []
      }), /*#__PURE__*/React.createElement(ActivityStrip, {
        streams: streams ?? []
      }), /*#__PURE__*/React.createElement(YearStrip, {
        onAddChip: onAddChip,
        streams: streams ?? []
      }), /*#__PURE__*/React.createElement(PeopleRail, {
        onAddChip: onAddChip,
        streams: streams ?? []
      }), /*#__PURE__*/React.createElement(MerchantRail, {
        onAddChip: onAddChip,
        streams: streams ?? []
      }), /*#__PURE__*/React.createElement(ChannelRail, {
        onAddChip: onAddChip,
        streams: streams ?? []
      }), /*#__PURE__*/React.createElement("div", {
        className: "feed__empty"
      }, /*#__PURE__*/React.createElement("div", {
        className: "feed__empty-title"
      }, "All caught up for today."), /*#__PURE__*/React.createElement("div", {
        className: "feed__empty-sub"
      }, "Pick a person, a merchant, or a channel above to wander further back."))) : /*#__PURE__*/React.createElement("div", {
        className: "feed__empty"
      }, /*#__PURE__*/React.createElement("div", {
        className: "feed__empty-title"
      }, "Nothing here."), /*#__PURE__*/React.createElement("div", {
        className: "feed__empty-sub"
      }, "Remove a filter, or try semantic search.")));
    }
    return /*#__PURE__*/React.createElement("div", {
      className: "feed"
    }, showDiscover && DayStory ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(DayStory, {
      streams: streams ?? []
    }), /*#__PURE__*/React.createElement(ActivityStrip, {
      streams: streams ?? []
    }), /*#__PURE__*/React.createElement(YearStrip, {
      onAddChip: onAddChip,
      streams: streams ?? []
    }), /*#__PURE__*/React.createElement(PeopleRail, {
      onAddChip: onAddChip,
      streams: streams ?? []
    }), /*#__PURE__*/React.createElement(MerchantRail, {
      onAddChip: onAddChip,
      streams: streams ?? []
    }), /*#__PURE__*/React.createElement(ChannelRail, {
      onAddChip: onAddChip,
      streams: streams ?? []
    })) : null, memories.length ? /*#__PURE__*/React.createElement("section", {
      className: "memories"
    }, /*#__PURE__*/React.createElement("header", {
      className: "memories__head"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "memories__title"
    }, "On this day"), /*#__PURE__*/React.createElement("span", {
      className: "memories__sub"
    }, memories.length, " memor", memories.length === 1 ? "y" : "ies")), /*#__PURE__*/React.createElement("div", {
      className: "memories__cards"
    }, memories.map(({
      stream,
      record,
      label
    }) => {
      const kind = cardKindForStream(stream);
      const Card = CARD_BY_KIND[kind] ?? GenericCard;
      return /*#__PURE__*/React.createElement("div", {
        className: "memory",
        key: `mem::${stream.connection_id}::${record.id}`
      }, /*#__PURE__*/React.createElement("div", {
        className: "memory__label"
      }, label), /*#__PURE__*/React.createElement(Card, {
        onClick: () => onSelect(stream, record),
        record: record,
        selected: selectedId === record.id,
        stream: stream
      }));
    }))) : null, groups.map(({
      day,
      items
    }) => /*#__PURE__*/React.createElement("section", {
      className: "feed__group",
      key: day
    }, /*#__PURE__*/React.createElement("header", {
      className: "feed__day"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "feed__day-label"
    }, day === "__no_date__" ? "Undated" : fmtDay(day + "T12:00:00Z")), /*#__PURE__*/React.createElement("span", {
      className: "feed__day-count"
    }, items.length)), /*#__PURE__*/React.createElement("div", {
      className: "feed__cards"
    }, items.map(({
      stream,
      record
    }) => {
      const kind = cardKindForStream(stream);
      const Card = CARD_BY_KIND[kind] ?? GenericCard;
      return /*#__PURE__*/React.createElement(Card, {
        key: `${stream.connection_id}::${record.id}`,
        onClick: () => onSelect(stream, record),
        record: record,
        selected: selectedId === record.id,
        stream: stream
      });
    })))));
  }
  window.FeedView = FeedView;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "explorer/feed.jsx", error: String((e && e.message) || e) }); }

// explorer/peek.jsx
try { (() => {
/* IIFE-WRAPPED */
;
(() => {
  /* PDPP Explorer — Peek panel (record detail)
   *
   * Right pane that slides in when a record is selected. Surfaces:
   * - Title + meta
   * - Each schema field, with granted/redacted state explicit
   * - The actual /v1/streams/.../records/<id> URL the explorer is reading
   */

  const {
    fmtRelative,
    fmtDate,
    fmtCurrency,
    fmtDuration,
    fmtDistance,
    Avatar: PeekAvatar
  } = window.PDPPPrim;
  function Peek({
    stream,
    record,
    onClose,
    projection
  }) {
    if (!stream || !record) return null;
    const fields = stream.schema.fields;
    const granted = fields.filter(f => f.granted);
    const redacted = fields.filter(f => !f.granted);
    const visibleFields = projection ? granted : fields;
    const title = record.subject ?? record.title ?? record.merchant ?? record.text ?? record.caption ?? record.id;
    const timeField = fields.find(f => f.type === "timestamp")?.name;
    function renderValue(field) {
      const v = record[field.name];
      if (v == null) return /*#__PURE__*/React.createElement("span", {
        style: {
          color: "var(--muted-foreground)"
        }
      }, "\u2014");
      if (field.type === "timestamp") return /*#__PURE__*/React.createElement("span", {
        style: {
          fontFamily: "var(--font-mono)"
        }
      }, new Date(v).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short"
      }));
      if (field.type === "currency") return /*#__PURE__*/React.createElement("span", {
        style: {
          fontFamily: "var(--font-mono)",
          color: v > 0 ? "var(--success)" : "var(--foreground)"
        }
      }, fmtCurrency(v));
      if (field.type === "number") {
        if (field.unit === "meters") return /*#__PURE__*/React.createElement("span", {
          style: {
            fontFamily: "var(--font-mono)"
          }
        }, fmtDistance(v), " ", /*#__PURE__*/React.createElement("small", {
          style: {
            color: "var(--muted-foreground)"
          }
        }, "(", v.toLocaleString(), " m)"));
        if (field.unit === "seconds") return /*#__PURE__*/React.createElement("span", {
          style: {
            fontFamily: "var(--font-mono)"
          }
        }, fmtDuration(v));
        return /*#__PURE__*/React.createElement("span", {
          style: {
            fontFamily: "var(--font-mono)"
          }
        }, v.toLocaleString(), field.unit ? /*#__PURE__*/React.createElement("small", {
          style: {
            color: "var(--muted-foreground)"
          }
        }, " ", field.unit) : null);
      }
      if (field.type === "id") return /*#__PURE__*/React.createElement("code", {
        style: {
          fontSize: "0.72rem",
          color: "var(--muted-foreground)"
        }
      }, v);
      if (field.type === "url") return /*#__PURE__*/React.createElement("a", {
        href: v,
        rel: "noreferrer",
        style: {
          color: "var(--primary)",
          textDecoration: "underline"
        },
        target: "_blank"
      }, v);
      if (field.type === "blob") {
        if ((field.media_type ?? "").startsWith("image/")) {
          return /*#__PURE__*/React.createElement("img", {
            alt: "",
            src: v,
            style: {
              maxWidth: "100%",
              borderRadius: 4,
              marginTop: 4
            }
          });
        }
        return /*#__PURE__*/React.createElement("code", {
          style: {
            fontSize: "0.72rem"
          }
        }, "blob: ", v);
      }
      if (field.type === "person") return /*#__PURE__*/React.createElement("span", null, String(v).replace(/<[^>]+>/g, "").trim());
      if (Array.isArray(v)) {
        if (v.length === 0) return /*#__PURE__*/React.createElement("span", {
          style: {
            color: "var(--muted-foreground)"
          }
        }, "[]");
        if (typeof v[0] === "object") return /*#__PURE__*/React.createElement("pre", {
          style: {
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            whiteSpace: "pre-wrap"
          }
        }, JSON.stringify(v, null, 2));
        return /*#__PURE__*/React.createElement("span", null, v.join(", "));
      }
      return /*#__PURE__*/React.createElement("span", {
        className: `exp-peek__field-value ${String(v).length > 80 ? "long" : ""}`
      }, String(v));
    }
    return /*#__PURE__*/React.createElement("aside", {
      className: "exp-peek"
    }, /*#__PURE__*/React.createElement("button", {
      className: "exp-peek__close",
      onClick: onClose,
      title: "Close"
    }, "\xD7"), /*#__PURE__*/React.createElement("div", {
      className: "exp-peek__head"
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-peek__eyebrow"
    }, stream.connector_id, " / ", stream.name), /*#__PURE__*/React.createElement("h2", {
      className: "exp-peek__title"
    }, title), /*#__PURE__*/React.createElement("div", {
      className: "exp-peek__meta"
    }, /*#__PURE__*/React.createElement("span", null, record.id), timeField ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, fmtRelative(record[timeField]))) : null, /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, "connection ", stream.connection_display))), /*#__PURE__*/React.createElement("div", {
      className: "exp-peek__body"
    }, visibleFields.map(f => {
      const isRedacted = !f.granted;
      if (isRedacted && projection) return null;
      return /*#__PURE__*/React.createElement("div", {
        className: "exp-peek__field",
        "data-redacted": isRedacted,
        key: f.name
      }, /*#__PURE__*/React.createElement("span", {
        className: "exp-peek__field-name"
      }, f.name), /*#__PURE__*/React.createElement("div", {
        className: "exp-peek__field-value"
      }, isRedacted ? /*#__PURE__*/React.createElement("span", null, "redacted \u2014 ", f.redacted_reason ?? "out of scope") : renderValue(f)));
    }), projection && redacted.length ? /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: "0.9rem",
        fontFamily: "var(--font-mono)",
        fontSize: "0.7rem",
        color: "var(--muted-foreground)"
      }
    }, "+", redacted.length, " field", redacted.length === 1 ? "" : "s", " hidden by projection") : null, /*#__PURE__*/React.createElement("div", {
      className: "exp-peek__source"
    }, /*#__PURE__*/React.createElement("b", null, "GET"), " /v1/streams/", /*#__PURE__*/React.createElement("b", null, stream.name), "/records/", /*#__PURE__*/React.createElement("b", null, record.id), "\n", /*#__PURE__*/React.createElement("span", {
      style: {
        opacity: 0.7
      }
    }, "?connection_id=", stream.connection_id))));
  }
  window.Peek = Peek;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "explorer/peek.jsx", error: String((e && e.message) || e) }); }

// explorer/primitives.jsx
try { (() => {
/* IIFE-WRAPPED */
;
(() => {
  /* PDPP Explorer — shared primitives + format helpers
   *
   * Tiny, view-agnostic building blocks. Exported on window so the
   * babel-split view files can pick them up.
   */

  const {
    useState,
    useEffect,
    useMemo,
    useRef,
    useCallback
  } = React;

  // ─── Format helpers ───────────────────────────────────────────────────

  const NOW = window.PDPP_DATA?.now ?? Date.now();
  function fmtRelative(iso) {
    const t = new Date(iso).getTime();
    const d = NOW - t;
    if (Math.abs(d) < 60_000) return d < 0 ? "in <1m" : "just now";
    if (Math.abs(d) < 3_600_000) {
      const m = Math.round(Math.abs(d) / 60_000);
      return d < 0 ? `in ${m}m` : `${m}m ago`;
    }
    if (Math.abs(d) < 86_400_000) {
      const h = Math.round(Math.abs(d) / 3_600_000);
      return d < 0 ? `in ${h}h` : `${h}h ago`;
    }
    const days = Math.round(Math.abs(d) / 86_400_000);
    if (days < 30) return d < 0 ? `in ${days}d` : `${days}d ago`;
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric"
    });
  }
  function fmtClock(iso) {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit"
    });
  }
  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric"
    });
  }
  function fmtDay(iso) {
    const d = new Date(iso);
    const today = new Date(NOW);
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (sameDay(d, today)) return "Today";
    const y = new Date(NOW - 86_400_000);
    if (sameDay(d, y)) return "Yesterday";
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric"
    });
  }
  function fmtCurrency(n) {
    const sign = n < 0 ? "−" : n > 0 ? "+" : "";
    const abs = Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return `${sign}$${abs}`;
  }
  function fmtDuration(seconds) {
    const m = Math.round(seconds / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
  }
  function fmtDistance(meters) {
    const mi = meters / 1609.34;
    return `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  }

  // ─── Initials avatar ──────────────────────────────────────────────────

  function initials(label) {
    if (!label) return "·";
    const cleaned = label.replace(/<[^>]+>/g, "").trim();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "·";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function Avatar({
    label,
    size = 28
  }) {
    return /*#__PURE__*/React.createElement("span", {
      className: "exp-conv__avatar",
      style: {
        width: size,
        height: size,
        fontSize: size * 0.4,
        borderRadius: Math.round(size * 0.22)
      }
    }, initials(label));
  }

  // ─── Heatmap (GitHub-style; weeks across, days down) ──────────────────

  function Heatmap({
    values,
    days = 84,
    color = "var(--foreground)"
  }) {
    // values: array of {date: iso, count: number} keyed by yyyy-mm-dd
    const map = new Map();
    for (const v of values || []) {
      const key = v.date.slice(0, 10);
      map.set(key, (map.get(key) ?? 0) + (v.count ?? 1));
    }
    const max = Math.max(1, ...map.values());
    const cells = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(NOW - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      const v = map.get(key) ?? 0;
      const intensity = v === 0 ? 0 : Math.min(1, 0.18 + 0.82 * (v / max));
      cells.push(/*#__PURE__*/React.createElement("span", {
        key: key,
        className: "exp-heatmap__cell",
        title: `${key} · ${v}`,
        style: {
          background: v === 0 ? "var(--muted)" : `color-mix(in oklab, ${color} ${Math.round(intensity * 100)}%, transparent)`
        }
      }));
    }
    return /*#__PURE__*/React.createElement("div", {
      className: "exp-heatmap"
    }, cells);
  }

  // ─── Tiny sparkline ────────────────────────────────────────────────────

  function Sparkline({
    values,
    width = 120,
    height = 28,
    color = "var(--foreground)"
  }) {
    if (!values?.length) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const step = width / (values.length - 1 || 1);
    const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v - min) / range * height).toFixed(1)}`).join(" ");
    return /*#__PURE__*/React.createElement("svg", {
      width: width,
      height: height,
      style: {
        display: "block"
      }
    }, /*#__PURE__*/React.createElement("polyline", {
      fill: "none",
      stroke: color,
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      points: points
    }), /*#__PURE__*/React.createElement("circle", {
      cx: (values.length - 1) * step,
      cy: height - (values[values.length - 1] - min) / range * height,
      r: "2",
      fill: color
    }));
  }

  // ─── Capability icons (glyphs, not icons-as-an-iconset) ────────────────

  const CAP_GLYPH = {
    table: "▦",
    timeline: "│",
    conversation: "❝",
    ledger: "$",
    gallery: "▥",
    map: "◎",
    calendar: "▤",
    chart: "↟",
    reader: "¶"
  };
  const CAP_LABEL = {
    table: "Table",
    timeline: "Timeline",
    conversation: "Conversation",
    ledger: "Ledger",
    gallery: "Gallery",
    map: "Map",
    calendar: "Calendar",
    chart: "Chart",
    reader: "Reader"
  };

  // ─── Useful: useKeyboard for cmd-k ─────────────────────────────────────

  function useGlobalKey(key, modifiers, handler) {
    useEffect(() => {
      function onKey(e) {
        const meta = modifiers.includes("meta") ? e.metaKey || e.ctrlKey : true;
        if (e.key.toLowerCase() === key.toLowerCase() && meta) {
          e.preventDefault();
          handler(e);
        }
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [key, handler, modifiers]);
  }

  // ─── Stream-record utilities ───────────────────────────────────────────

  /** Find the timestamp field in a stream's records by checking the schema. */
  function getTimeField(stream) {
    const fs = stream.schema?.fields ?? [];
    return (fs.find(f => f.type === "timestamp") ?? fs.find(f => /date|ts|at_$|^at$|night_of/i.test(f.name)))?.name;
  }
  function getRecordTime(stream, record) {
    const f = getTimeField(stream);
    return f ? record[f] : null;
  }

  /** Returns the field labelled as "title" for the record, with sensible fallbacks. */
  function getRecordTitle(stream, record) {
    return record.subject ?? record.title ?? record.merchant ?? record.text ?? record.caption ?? record.snippet ?? record.id;
  }
  window.PDPPPrim = {
    fmtRelative,
    fmtClock,
    fmtDate,
    fmtDay,
    fmtCurrency,
    fmtDuration,
    fmtDistance,
    Avatar,
    Heatmap,
    Sparkline,
    CAP_GLYPH,
    CAP_LABEL,
    useGlobalKey,
    getTimeField,
    getRecordTime,
    getRecordTitle,
    initials,
    NOW
  };
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "explorer/primitives.jsx", error: String((e && e.message) || e) }); }

// explorer/query-bar.jsx
try { (() => {
/* PDPP Explorer — Query bar
 *
 * One bar. Chips + free text input + lex/sem/hybrid mode pill.
 * Backspace at empty input removes the last chip. Suggestions appear
 * below as the user types and can be added via ↓+Enter or by clicking.
 */

;
(() => {
  const {
    useState,
    useEffect,
    useRef,
    useMemo
  } = React;
  const {
    suggestChips
  } = window.PDPP_QUERY;
  function chipLabel(c) {
    if (c.field === "stream") {
      const v = Array.isArray(c.value) ? c.value.join(", ") : c.value;
      return {
        field: "stream",
        op: "in",
        value: v
      };
    }
    if (c.field === "amount") return {
      field: "amount",
      op: c.op,
      value: `$${c.value}`
    };
    if (c.field === "month") return {
      field: "month",
      op: "",
      value: monthLabel(c.value)
    };
    if (c.field === "year") return {
      field: "year",
      op: "",
      value: String(c.value)
    };
    if (c.field === "has") return {
      field: "has",
      op: "",
      value: c.value
    };
    if (c.field === "category") return {
      field: "category",
      op: "",
      value: c.value
    };
    return {
      field: c.field,
      op: "",
      value: String(c.value)
    };
  }
  function monthLabel(s) {
    if (!s) return "";
    const d = new Date(s + "-15");
    return d.toLocaleDateString("en-US", {
      month: "short",
      year: "numeric"
    }).toLowerCase();
  }
  function QueryBar({
    query,
    onChange,
    streams,
    mode,
    onModeChange,
    focused,
    onFocusedChange
  }) {
    const [text, setText] = useState(query.text ?? "");
    const [suggestionIdx, setSuggestionIdx] = useState(0);
    const inputRef = useRef(null);
    useEffect(() => {
      setText(query.text ?? "");
    }, [query.text]);
    const suggestions = useMemo(() => {
      if (!text.trim()) return [];
      return suggestChips(text, streams);
    }, [text, streams]);
    useEffect(() => {
      setSuggestionIdx(0);
    }, [suggestions.length]);
    function commitText(newText) {
      onChange({
        ...query,
        text: newText
      });
    }
    function addChip(chip) {
      // Replace existing chip with same field+op (avoid dup `from:` etc), except for `stream:` which we accumulate.
      let chips = [...query.chips];
      if (chip.field === "stream") {
        const existing = chips.find(c => c.field === "stream");
        if (existing) {
          const merged = Array.isArray(existing.value) ? existing.value : [existing.value];
          const newV = Array.isArray(chip.value) ? chip.value : [chip.value];
          existing.value = Array.from(new Set([...merged, ...newV]));
        } else {
          chips.push(chip);
        }
      } else {
        chips = chips.filter(c => !(c.field === chip.field && c.op === chip.op));
        chips.push(chip);
      }
      onChange({
        chips,
        text: ""
      });
      setText("");
      inputRef.current?.focus();
    }
    function removeChipAt(i) {
      const chips = [...query.chips];
      chips.splice(i, 1);
      onChange({
        ...query,
        chips
      });
      inputRef.current?.focus();
    }
    function onKeyDown(e) {
      if (e.key === "Backspace" && text === "" && query.chips.length > 0) {
        removeChipAt(query.chips.length - 1);
        return;
      }
      if (suggestions.length === 0) {
        if (e.key === "Enter") commitText(text);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggestionIdx(i => Math.min(i + 1, suggestions.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggestionIdx(i => Math.max(i - 1, 0));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const sel = suggestions[suggestionIdx];
        if (sel) addChip(sel.chip);else commitText(text);
      }
      if (e.key === "Escape") {
        setText("");
        commitText("");
      }
    }

    // Debounce text changes into the query
    useEffect(() => {
      const t = setTimeout(() => {
        if (text !== query.text) commitText(text);
      }, 180);
      return () => clearTimeout(t);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [text]);
    const showSuggest = focused && suggestions.length > 0;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        position: "relative"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-query",
      "data-focused": focused,
      onClick: () => inputRef.current?.focus()
    }, query.chips.map((c, i) => {
      const lab = chipLabel(c);
      return /*#__PURE__*/React.createElement("button", {
        className: "exp-chip",
        key: i,
        onClick: e => {
          e.stopPropagation();
          removeChipAt(i);
        },
        title: `${lab.field}${lab.op ? " " + lab.op : ""}: ${lab.value}`,
        type: "button"
      }, /*#__PURE__*/React.createElement("span", {
        className: "exp-chip__field"
      }, lab.field), lab.op ? /*#__PURE__*/React.createElement("span", {
        className: "exp-chip__op"
      }, lab.op) : /*#__PURE__*/React.createElement("span", {
        className: "exp-chip__op"
      }, ":"), /*#__PURE__*/React.createElement("span", {
        className: "exp-chip__value"
      }, lab.value), /*#__PURE__*/React.createElement("span", {
        className: "exp-chip__remove"
      }, "\xD7"));
    }), /*#__PURE__*/React.createElement("input", {
      className: "exp-query__text",
      onBlur: () => setTimeout(() => onFocusedChange(false), 120),
      onChange: e => setText(e.target.value),
      onFocus: () => onFocusedChange(true),
      onKeyDown: onKeyDown,
      placeholder: query.chips.length ? "narrow…" : "Search everything",
      ref: inputRef,
      spellCheck: "false",
      type: "text",
      value: text
    }), /*#__PURE__*/React.createElement("span", {
      className: "exp-query__hint"
    }, /*#__PURE__*/React.createElement("kbd", {
      className: "exp-kbd"
    }, "/")), /*#__PURE__*/React.createElement("span", {
      className: "exp-query__mode"
    }, ["lex", "sem", "hyb"].map(m => /*#__PURE__*/React.createElement("button", {
      className: "exp-query__mode-btn",
      "data-on": mode === m,
      key: m,
      onClick: e => {
        e.stopPropagation();
        onModeChange(m);
      },
      title: {
        lex: "Lexical search",
        sem: "Semantic search",
        hyb: "Hybrid"
      }[m],
      type: "button"
    }, m)))), showSuggest ? /*#__PURE__*/React.createElement("div", {
      className: "exp-suggest"
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-suggest__label"
    }, "add filter"), suggestions.map((s, i) => /*#__PURE__*/React.createElement("div", {
      className: "exp-suggest__row",
      "data-selected": i === suggestionIdx,
      key: i,
      onMouseDown: e => {
        e.preventDefault();
        addChip(s.chip);
      },
      onMouseEnter: () => setSuggestionIdx(i)
    }, /*#__PURE__*/React.createElement("span", {
      className: "exp-suggest__row-kind"
    }, s.chip.field), /*#__PURE__*/React.createElement("span", {
      className: "exp-suggest__row-label"
    }, s.label.replace(/^[^:]+:\s*/, "")), /*#__PURE__*/React.createElement("span", {
      className: "exp-suggest__row-hint"
    }, s.hint))), /*#__PURE__*/React.createElement("div", {
      className: "exp-suggest__divider"
    }), /*#__PURE__*/React.createElement("div", {
      className: "exp-suggest__row",
      onMouseDown: e => {
        e.preventDefault();
        commitText(text);
      },
      style: {
        paddingTop: "0.5rem",
        paddingBottom: "0.5rem"
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "exp-suggest__row-kind"
    }, "text"), /*#__PURE__*/React.createElement("span", {
      className: "exp-suggest__row-label"
    }, "search for \u201C", text, "\u201D"), /*#__PURE__*/React.createElement("span", {
      className: "exp-suggest__row-hint"
    }, /*#__PURE__*/React.createElement("kbd", {
      className: "exp-kbd"
    }, "\u21B5")))) : null);
  }
  window.QueryBar = QueryBar;
  window.queryChipLabel = chipLabel;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "explorer/query-bar.jsx", error: String((e && e.message) || e) }); }

// explorer/query.js
try { (() => {
/* PDPP Explorer — query model
 *
 * A query is { chips: Chip[], text: string }. Chips compose with AND.
 *
 * Chip shapes:
 *   { field: "stream",   op: "in", value: ["gmail","slack"] }
 *   { field: "from",     op: "is", value: "maya" }            // matches any person-typed field
 *   { field: "month",    op: "is", value: "2026-05" }
 *   { field: "year",     op: "is", value: 2026 }
 *   { field: "amount",   op: ">",  value: 100 }
 *   { field: "has",      op: "is", value: "image" | "attachment" | "geo" }
 *   { field: "category", op: "is", value: "Food & Drink" }
 *
 * The query runs ACROSS streams and returns flat hits:
 *   { stream, record, score }
 *
 * The Explorer then uses dispatch over the *result set* (intersection of
 * schemas in the matched streams) to pick the right view.
 */

;
(() => {
  const FIELD_ALIASES = {
    from: ["from", "sender", "author", "actor", "user"],
    to: ["to", "recipient", "recipients"],
    text: ["subject", "snippet", "body", "text", "message", "content", "title", "caption", "merchant", "memo"],
    amount: ["amount", "value", "total"],
    cat: ["category"],
    type: ["type"]
  };
  function normPerson(p) {
    if (p == null) return "";
    if (Array.isArray(p)) return p.map(normPerson).join(" ");
    return String(p).toLowerCase();
  }

  /** Reduce a person field's raw text to a short, human-friendly first token.
   * Handles "Maya Chen <maya@figma.com>", "the owner@nunamak.com", and arrays.
   */
  function firstNameToken(person) {
    if (!person) return "";
    if (Array.isArray(person)) person = person[0];
    let s = String(person).replace(/<[^>]+>/g, "").trim();
    if (!s) return "";
    // If it's an email-only string, take the local part and split on punctuation
    if (s.includes("@") && !/\s/.test(s)) {
      s = s.split("@")[0].replace(/[._-]+/g, " ");
    }
    const tok = s.split(/\s+/)[0];
    return tok.toLowerCase();
  }
  function recordMatchesChip(stream, r, chip) {
    switch (chip.field) {
      case "stream":
        {
          const v = Array.isArray(chip.value) ? chip.value : [chip.value];
          return v.some(x => stream.connector_id === x || stream.name === x || `${stream.connector_id}/${stream.name}` === x);
        }
      case "connection":
        {
          const v = Array.isArray(chip.value) ? chip.value : [chip.value];
          return v.includes(stream.connection_id);
        }
      case "from":
        {
          const target = String(chip.value).toLowerCase();
          const candidateFields = stream.schema.fields.filter(f => FIELD_ALIASES.from.some(alias => f.name.toLowerCase().includes(alias)) || f.type === "person" || f.type === "person[]");
          return candidateFields.some(f => normPerson(r[f.name]).includes(target));
        }
      case "with":
      case "to":
        {
          const target = String(chip.value).toLowerCase();
          // matches author OR recipient OR text body
          const fs = stream.schema.fields;
          return fs.some(f => (f.type === "person" || f.type === "person[]" || f.type === "text") && normPerson(r[f.name]).includes(target));
        }
      case "month":
        {
          const fs = stream.schema.fields;
          const tf = fs.find(f => f.type === "timestamp")?.name;
          return tf ? r[tf]?.slice(0, 7) === chip.value : false;
        }
      case "year":
        {
          const fs = stream.schema.fields;
          const tf = fs.find(f => f.type === "timestamp")?.name;
          return tf ? r[tf]?.slice(0, 4) === String(chip.value) : false;
        }
      case "since":
        {
          const fs = stream.schema.fields;
          const tf = fs.find(f => f.type === "timestamp")?.name;
          return tf ? new Date(r[tf]).getTime() >= new Date(chip.value).getTime() : false;
        }
      case "amount":
        {
          const fs = stream.schema.fields;
          const af = fs.find(f => f.type === "currency")?.name ?? fs.find(f => /amount/i.test(f.name))?.name;
          if (!af) return false;
          const x = Math.abs(r[af] ?? 0);
          if (chip.op === ">") return x > Number(chip.value);
          if (chip.op === "<") return x < Number(chip.value);
          if (chip.op === "=") return x === Number(chip.value);
          return false;
        }
      case "category":
        {
          const fs = stream.schema.fields;
          const cf = fs.find(f => /category/i.test(f.name))?.name;
          return cf ? r[cf] === chip.value : false;
        }
      case "type":
        {
          return r.type === chip.value;
        }
      case "channel":
        {
          const target = String(chip.value).toLowerCase();
          return ["channel", "channel_id"].some(k => String(r[k] ?? "").toLowerCase().includes(target));
        }
      case "has":
        {
          if (chip.value === "image") {
            return stream.schema.fields.some(f => f.type === "blob" && (f.media_type ?? "").startsWith("image/")) || stream.schema.fields.some(f => /thumb|image|photo|picture/i.test(f.name) && (f.type === "blob" || f.type === "url") && r[f.name]);
          }
          if (chip.value === "geo") {
            return ["lat", "latitude"].some(n => r[n] != null);
          }
          if (chip.value === "attachment") {
            return r.has_attachment === true;
          }
          return false;
        }
      default:
        return true;
    }
  }
  function textMatches(stream, r, text) {
    if (!text || !text.trim()) return true;
    const q = text.toLowerCase();
    const fields = stream.schema.fields.filter(f => ["text", "person"].includes(f.type) || /title|subject|snippet|body|text|caption|merchant|memo|name/i.test(f.name));
    for (const f of fields) {
      const v = r[f.name];
      if (typeof v === "string" && v.toLowerCase().includes(q)) return true;
    }
    return false;
  }

  /** Run a query and return flat hits across streams. */
  function runQuery(query, allStreams) {
    const hits = [];
    for (const s of allStreams) {
      // Cheap stream-level rejection: if there's a `stream:` chip and this stream doesn't match, skip.
      const streamChips = query.chips.filter(c => c.field === "stream" || c.field === "connection");
      if (streamChips.length && !streamChips.every(c => recordMatchesChip(s, s.records[0] ?? {}, c))) continue;
      for (const r of s.records) {
        // Apply non-stream chips
        const passes = query.chips.filter(c => c.field !== "stream" && c.field !== "connection").every(c => recordMatchesChip(s, r, c));
        if (!passes) continue;
        if (!textMatches(s, r, query.text)) continue;
        hits.push({
          stream: s,
          record: r
        });
      }
    }
    // Sort by time field if available, otherwise by id (stable enough for the prototype)
    hits.sort((a, b) => {
      const ta = recordTime(a.stream, a.record);
      const tb = recordTime(b.stream, b.record);
      return (tb ?? 0) - (ta ?? 0);
    });
    return hits;
  }
  function recordTime(s, r) {
    const tf = s.schema.fields.find(f => f.type === "timestamp")?.name;
    return tf && r[tf] ? new Date(r[tf]).getTime() : null;
  }

  /* ─── facets ───────────────────────────────────────────────────────────
   * Given a set of hits, compute small facet breakdowns the user can click
   * to add chips. All facets are derived from schema, not connector id.
   */
  function computeFacets(hits) {
    const streamCounts = new Map();
    const monthCounts = new Map();
    const peopleCounts = new Map();
    const catCounts = new Map();
    for (const {
      stream,
      record
    } of hits) {
      streamCounts.set(stream, (streamCounts.get(stream) ?? 0) + 1);
      const t = recordTime(stream, record);
      if (t) {
        const m = new Date(t).toISOString().slice(0, 7);
        monthCounts.set(m, (monthCounts.get(m) ?? 0) + 1);
      }
      for (const f of stream.schema.fields) {
        if (f.type === "person" || f.type === "person[]") {
          const v = record[f.name];
          const list = Array.isArray(v) ? v : v ? [v] : [];
          for (const p of list) {
            const name = String(p).replace(/<[^>]+>/g, "").trim();
            if (name) peopleCounts.set(name, (peopleCounts.get(name) ?? 0) + 1);
          }
        }
        if (/category/i.test(f.name)) {
          const v = record[f.name];
          if (v) catCounts.set(v, (catCounts.get(v) ?? 0) + 1);
        }
      }
    }
    return {
      streams: [...streamCounts.entries()].sort((a, b) => b[1] - a[1]),
      months: [...monthCounts.entries()].sort((a, b) => b[0].localeCompare(a[0])),
      people: [...peopleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
      categories: [...catCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    };
  }

  /* ─── chip suggestions for typed text ─────────────────────────────────
   * Tokens a user might type at the end of the query box, before adding
   * a chip. Returns up to 6 suggestions.
   */
  function suggestChips(text, allStreams) {
    const t = (text ?? "").trim().toLowerCase();
    if (!t) return [];
    const out = [];

    // Stream suggestions
    const seenStreams = new Set();
    for (const s of allStreams) {
      if (s.connector_id.includes(t) || s.name.includes(t) || s.title.toLowerCase().includes(t)) {
        const key = s.connector_id;
        if (!seenStreams.has(key)) {
          seenStreams.add(key);
          out.push({
            kind: "chip",
            chip: {
              field: "stream",
              op: "in",
              value: [key]
            },
            label: `stream: ${key}`,
            hint: s.title
          });
        }
      }
    }
    // Person suggestions (across streams)
    const seenPpl = new Set();
    for (const s of allStreams) {
      const personFields = s.schema.fields.filter(f => f.type === "person" || f.type === "person[]");
      for (const r of s.records) {
        for (const f of personFields) {
          const v = r[f.name];
          const list = Array.isArray(v) ? v : v ? [v] : [];
          for (const p of list) {
            const display = String(p).replace(/<[^>]+>/g, "").trim();
            const first = firstNameToken(p);
            if (!first || !first.includes(t)) continue;
            if (seenPpl.has(first)) continue;
            seenPpl.add(first);
            out.push({
              kind: "chip",
              chip: {
                field: "from",
                op: "is",
                value: first
              },
              label: `from: ${first}`,
              hint: display
            });
            if (out.length > 4) break;
          }
          if (out.length > 6) break;
        }
        if (out.length > 6) break;
      }
      if (out.length > 6) break;
    }
    return out.slice(0, 6);
  }
  window.PDPP_QUERY = {
    runQuery,
    computeFacets,
    suggestChips,
    recordTime,
    firstNameToken
  };
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "explorer/query.js", error: String((e && e.message) || e) }); }

// explorer/tweaks-panel.jsx
try { (() => {
// tweaks-panel.jsx
// Reusable Tweaks shell + form-control helpers.
//
// Owns the host protocol (listens for __activate_edit_mode / __deactivate_edit_mode,
// posts __edit_mode_available / __edit_mode_set_keys / __edit_mode_dismissed) so
// individual prototypes don't re-roll it. Ships a consistent set of controls so you
// don't hand-draw <input type="range">, segmented radios, steppers, etc.
//
// Usage (in an HTML file that loads React + Babel):
//
//   const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
//     "primaryColor": "#D97757",
//     "palette": ["#D97757", "#29261b", "#f6f4ef"],
//     "fontSize": 16,
//     "density": "regular",
//     "dark": false
//   }/*EDITMODE-END*/;
//
//   function App() {
//     const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
//     return (
//       <div style={{ fontSize: t.fontSize, color: t.primaryColor }}>
//         Hello
//         <TweaksPanel>
//           <TweakSection label="Typography" />
//           <TweakSlider label="Font size" value={t.fontSize} min={10} max={32} unit="px"
//                        onChange={(v) => setTweak('fontSize', v)} />
//           <TweakRadio  label="Density" value={t.density}
//                        options={['compact', 'regular', 'comfy']}
//                        onChange={(v) => setTweak('density', v)} />
//           <TweakSection label="Theme" />
//           <TweakColor  label="Primary" value={t.primaryColor}
//                        options={['#D97757', '#2A6FDB', '#1F8A5B', '#7A5AE0']}
//                        onChange={(v) => setTweak('primaryColor', v)} />
//           <TweakColor  label="Palette" value={t.palette}
//                        options={[['#D97757', '#29261b', '#f6f4ef'],
//                                  ['#475569', '#0f172a', '#f1f5f9']]}
//                        onChange={(v) => setTweak('palette', v)} />
//           <TweakToggle label="Dark mode" value={t.dark}
//                        onChange={(v) => setTweak('dark', v)} />
//         </TweaksPanel>
//       </div>
//     );
//   }
//
// ─────────────────────────────────────────────────────────────────────────────

const __TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    transform:scale(var(--dc-inv-zoom,1));transform-origin:bottom right;
    background:rgba(250,249,247,.78);color:#29261b;
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgba(255,255,255,.6);border-radius:14px;
    box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18);
    font:11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgba(41,38,27,.55);
    width:22px;height:22px;border-radius:6px;cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:rgba(0,0,0,.06);color:#29261b}
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.15) transparent}
  .twk-body::-webkit-scrollbar{width:8px}
  .twk-body::-webkit-scrollbar-track{background:transparent;margin:2px}
  .twk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:4px;
    border:2px solid transparent;background-clip:content-box}
  .twk-body::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.25);
    border:2px solid transparent;background-clip:content-box}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgba(41,38,27,.72)}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-val{color:rgba(41,38,27,.5);font-variant-numeric:tabular-nums}

  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgba(41,38,27,.45);padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}

  .twk-field{appearance:none;box-sizing:border-box;width:100%;min-width:0;height:26px;padding:0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;
    background:rgba(255,255,255,.6);color:inherit;font:inherit;outline:none}
  .twk-field:focus{border-color:rgba(0,0,0,.25);background:rgba(255,255,255,.85)}
  select.twk-field{padding-right:22px;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(0,0,0,.5)' d='M0 0h10L5 6z'/></svg>");
    background-repeat:no-repeat;background-position:right 8px center}

  .twk-slider{appearance:none;-webkit-appearance:none;width:100%;height:4px;margin:6px 0;
    border-radius:999px;background:rgba(0,0,0,.12);outline:none}
  .twk-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
    width:14px;height:14px;border-radius:50%;background:#fff;
    border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}
  .twk-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
    background:#fff;border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}

  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:rgba(0,0,0,.06);user-select:none}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(0,0,0,.12);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:inherit;font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:default;padding:4px 6px;line-height:1.2;
    overflow-wrap:anywhere}

  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgba(0,0,0,.15);transition:background .15s;cursor:default;padding:0}
  .twk-toggle[data-on="1"]{background:#34c759}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}

  .twk-num{display:flex;align-items:center;box-sizing:border-box;min-width:0;height:26px;padding:0 0 0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;background:rgba(255,255,255,.6)}
  .twk-num-lbl{font-weight:500;color:rgba(41,38,27,.6);cursor:ew-resize;
    user-select:none;padding-right:8px}
  .twk-num input{flex:1;min-width:0;height:100%;border:0;background:transparent;
    font:inherit;font-variant-numeric:tabular-nums;text-align:right;padding:0 8px 0 0;
    outline:none;color:inherit;-moz-appearance:textfield}
  .twk-num input::-webkit-inner-spin-button,.twk-num input::-webkit-outer-spin-button{
    -webkit-appearance:none;margin:0}
  .twk-num-unit{padding-right:8px;color:rgba(41,38,27,.45)}

  .twk-btn{appearance:none;height:26px;padding:0 12px;border:0;border-radius:7px;
    background:rgba(0,0,0,.78);color:#fff;font:inherit;font-weight:500;cursor:default}
  .twk-btn:hover{background:rgba(0,0,0,.88)}
  .twk-btn.secondary{background:rgba(0,0,0,.06);color:inherit}
  .twk-btn.secondary:hover{background:rgba(0,0,0,.1)}

  .twk-swatch{appearance:none;-webkit-appearance:none;width:56px;height:22px;
    border:.5px solid rgba(0,0,0,.1);border-radius:6px;padding:0;cursor:default;
    background:transparent;flex-shrink:0}
  .twk-swatch::-webkit-color-swatch-wrapper{padding:0}
  .twk-swatch::-webkit-color-swatch{border:0;border-radius:5.5px}
  .twk-swatch::-moz-color-swatch{border:0;border-radius:5.5px}

  .twk-chips{display:flex;gap:6px}
  .twk-chip{position:relative;appearance:none;flex:1;min-width:0;height:46px;
    padding:0;border:0;border-radius:6px;overflow:hidden;cursor:default;
    box-shadow:0 0 0 .5px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.06);
    transition:transform .12s cubic-bezier(.3,.7,.4,1),box-shadow .12s}
  .twk-chip:hover{transform:translateY(-1px);
    box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 4px 10px rgba(0,0,0,.12)}
  .twk-chip[data-on="1"]{box-shadow:0 0 0 1.5px rgba(0,0,0,.85),
    0 2px 6px rgba(0,0,0,.15)}
  .twk-chip>span{position:absolute;top:0;bottom:0;right:0;width:34%;
    display:flex;flex-direction:column;box-shadow:-1px 0 0 rgba(0,0,0,.1)}
  .twk-chip>span>i{flex:1;box-shadow:0 -1px 0 rgba(0,0,0,.1)}
  .twk-chip>span>i:first-child{box-shadow:none}
  .twk-chip svg{position:absolute;top:6px;left:6px;width:13px;height:13px;
    filter:drop-shadow(0 1px 1px rgba(0,0,0,.3))}
`;

// ── useTweaks ───────────────────────────────────────────────────────────────
// Single source of truth for tweak values. setTweak persists via the host
// (__edit_mode_set_keys → host rewrites the EDITMODE block on disk).
function useTweaks(defaults) {
  const [values, setValues] = React.useState(defaults);
  // Accepts either setTweak('key', value) or setTweak({ key: value, ... }) so a
  // useState-style call doesn't write a "[object Object]" key into the persisted
  // JSON block.
  const setTweak = React.useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === 'object' && keyOrEdits !== null ? keyOrEdits : {
      [keyOrEdits]: val
    };
    setValues(prev => ({
      ...prev,
      ...edits
    }));
    window.parent.postMessage({
      type: '__edit_mode_set_keys',
      edits
    }, '*');
    // Same-window signal so in-page listeners (deck-stage rail thumbnails)
    // can react — the parent message only reaches the host, not peers.
    window.dispatchEvent(new CustomEvent('tweakchange', {
      detail: edits
    }));
  }, []);
  return [values, setTweak];
}

// ── TweaksPanel ─────────────────────────────────────────────────────────────
// Floating shell. Registers the protocol listener BEFORE announcing
// availability — if the announce ran first, the host's activate could land
// before our handler exists and the toolbar toggle would silently no-op.
// The close button posts __edit_mode_dismissed so the host's toolbar toggle
// flips off in lockstep; the host echoes __deactivate_edit_mode back which
// is what actually hides the panel.
function TweaksPanel({
  title = 'Tweaks',
  children
}) {
  const [open, setOpen] = React.useState(false);
  const dragRef = React.useRef(null);
  const offsetRef = React.useRef({
    x: 16,
    y: 16
  });
  const PAD = 16;
  const clampToViewport = React.useCallback(() => {
    const panel = dragRef.current;
    if (!panel) return;
    const w = panel.offsetWidth,
      h = panel.offsetHeight;
    const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
    const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
    offsetRef.current = {
      x: Math.min(maxRight, Math.max(PAD, offsetRef.current.x)),
      y: Math.min(maxBottom, Math.max(PAD, offsetRef.current.y))
    };
    panel.style.right = offsetRef.current.x + 'px';
    panel.style.bottom = offsetRef.current.y + 'px';
  }, []);
  React.useEffect(() => {
    if (!open) return;
    clampToViewport();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', clampToViewport);
      return () => window.removeEventListener('resize', clampToViewport);
    }
    const ro = new ResizeObserver(clampToViewport);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [open, clampToViewport]);
  React.useEffect(() => {
    const onMsg = e => {
      const t = e?.data?.type;
      if (t === '__activate_edit_mode') setOpen(true);else if (t === '__deactivate_edit_mode') setOpen(false);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({
      type: '__edit_mode_available'
    }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);
  const dismiss = () => {
    setOpen(false);
    window.parent.postMessage({
      type: '__edit_mode_dismissed'
    }, '*');
  };
  const onDragStart = e => {
    const panel = dragRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const sx = e.clientX,
      sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = ev => {
      offsetRef.current = {
        x: startRight - (ev.clientX - sx),
        y: startBottom - (ev.clientY - sy)
      };
      clampToViewport();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  if (!open) return null;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("style", null, __TWEAKS_STYLE), /*#__PURE__*/React.createElement("div", {
    ref: dragRef,
    className: "twk-panel",
    "data-omelette-chrome": "",
    style: {
      right: offsetRef.current.x,
      bottom: offsetRef.current.y
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-hd",
    onMouseDown: onDragStart
  }, /*#__PURE__*/React.createElement("b", null, title), /*#__PURE__*/React.createElement("button", {
    className: "twk-x",
    "aria-label": "Close tweaks",
    onMouseDown: e => e.stopPropagation(),
    onClick: dismiss
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    className: "twk-body"
  }, children)));
}

// ── Layout helpers ──────────────────────────────────────────────────────────

function TweakSection({
  label,
  children
}) {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "twk-sect"
  }, label), children);
}
function TweakRow({
  label,
  value,
  children,
  inline = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: inline ? 'twk-row twk-row-h' : 'twk-row'
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-lbl"
  }, /*#__PURE__*/React.createElement("span", null, label), value != null && /*#__PURE__*/React.createElement("span", {
    className: "twk-val"
  }, value)), children);
}

// ── Controls ────────────────────────────────────────────────────────────────

function TweakSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label,
    value: `${value}${unit}`
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    className: "twk-slider",
    min: min,
    max: max,
    step: step,
    value: value,
    onChange: e => onChange(Number(e.target.value))
  }));
}
function TweakToggle({
  label,
  value,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "twk-row twk-row-h"
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-lbl"
  }, /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "twk-toggle",
    "data-on": value ? '1' : '0',
    role: "switch",
    "aria-checked": !!value,
    onClick: () => onChange(!value)
  }, /*#__PURE__*/React.createElement("i", null)));
}
function TweakRadio({
  label,
  value,
  options,
  onChange
}) {
  const trackRef = React.useRef(null);
  const [dragging, setDragging] = React.useState(false);
  // The active value is read by pointer-move handlers attached for the lifetime
  // of a drag — ref it so a stale closure doesn't fire onChange for every move.
  const valueRef = React.useRef(value);
  valueRef.current = value;

  // Segments wrap mid-word once per-segment width runs out. The track is
  // ~248px (280 panel − 28 body pad − 4 seg pad), each button loses 12px
  // to its own padding, and 11.5px system-ui averages ~6.3px/char — so 2
  // options fit ~16 chars each, 3 fit ~10. Past that (or >3 options), fall
  // back to a dropdown rather than wrap.
  const labelLen = o => String(typeof o === 'object' ? o.label : o).length;
  const maxLen = options.reduce((m, o) => Math.max(m, labelLen(o)), 0);
  const fitsAsSegments = maxLen <= ({
    2: 16,
    3: 10
  }[options.length] ?? 0);
  if (!fitsAsSegments) {
    // <select> emits strings — map back to the original option value so the
    // fallback stays type-preserving (numbers, booleans) like the segment path.
    const resolve = s => {
      const m = options.find(o => String(typeof o === 'object' ? o.value : o) === s);
      return m === undefined ? s : typeof m === 'object' ? m.value : m;
    };
    return /*#__PURE__*/React.createElement(TweakSelect, {
      label: label,
      value: value,
      options: options,
      onChange: s => onChange(resolve(s))
    });
  }
  const opts = options.map(o => typeof o === 'object' ? o : {
    value: o,
    label: o
  });
  const idx = Math.max(0, opts.findIndex(o => o.value === value));
  const n = opts.length;
  const segAt = clientX => {
    const r = trackRef.current.getBoundingClientRect();
    const inner = r.width - 4;
    const i = Math.floor((clientX - r.left - 2) / inner * n);
    return opts[Math.max(0, Math.min(n - 1, i))].value;
  };
  const onPointerDown = e => {
    setDragging(true);
    const v0 = segAt(e.clientX);
    if (v0 !== valueRef.current) onChange(v0);
    const move = ev => {
      if (!trackRef.current) return;
      const v = segAt(ev.clientX);
      if (v !== valueRef.current) onChange(v);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("div", {
    ref: trackRef,
    role: "radiogroup",
    onPointerDown: onPointerDown,
    className: dragging ? 'twk-seg dragging' : 'twk-seg'
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-seg-thumb",
    style: {
      left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
      width: `calc((100% - 4px) / ${n})`
    }
  }), opts.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.value,
    type: "button",
    role: "radio",
    "aria-checked": o.value === value
  }, o.label))));
}
function TweakSelect({
  label,
  value,
  options,
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("select", {
    className: "twk-field",
    value: value,
    onChange: e => onChange(e.target.value)
  }, options.map(o => {
    const v = typeof o === 'object' ? o.value : o;
    const l = typeof o === 'object' ? o.label : o;
    return /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, l);
  })));
}
function TweakText({
  label,
  value,
  placeholder,
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("input", {
    className: "twk-field",
    type: "text",
    value: value,
    placeholder: placeholder,
    onChange: e => onChange(e.target.value)
  }));
}
function TweakNumber({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange
}) {
  const clamp = n => {
    if (min != null && n < min) return min;
    if (max != null && n > max) return max;
    return n;
  };
  const startRef = React.useRef({
    x: 0,
    val: 0
  });
  const onScrubStart = e => {
    e.preventDefault();
    startRef.current = {
      x: e.clientX,
      val: value
    };
    const decimals = (String(step).split('.')[1] || '').length;
    const move = ev => {
      const dx = ev.clientX - startRef.current.x;
      const raw = startRef.current.val + dx * step;
      const snapped = Math.round(raw / step) * step;
      onChange(clamp(Number(snapped.toFixed(decimals))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "twk-num"
  }, /*#__PURE__*/React.createElement("span", {
    className: "twk-num-lbl",
    onPointerDown: onScrubStart
  }, label), /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: value,
    min: min,
    max: max,
    step: step,
    onChange: e => onChange(clamp(Number(e.target.value)))
  }), unit && /*#__PURE__*/React.createElement("span", {
    className: "twk-num-unit"
  }, unit));
}

// Relative-luminance contrast pick — checkmarks drawn over a swatch need to
// read on both #111 and #fafafa without per-option configuration. Hex input
// only (#rgb / #rrggbb); named or rgb()/hsl() colors fall through to "light".
function __twkIsLight(hex) {
  const h = String(hex).replace('#', '');
  const x = h.length === 3 ? h.replace(/./g, c => c + c) : h.padEnd(6, '0');
  const n = parseInt(x.slice(0, 6), 16);
  if (Number.isNaN(n)) return true;
  const r = n >> 16 & 255,
    g = n >> 8 & 255,
    b = n & 255;
  return r * 299 + g * 587 + b * 114 > 148000;
}
const __TwkCheck = ({
  light
}) => /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 14 14",
  "aria-hidden": "true"
}, /*#__PURE__*/React.createElement("path", {
  d: "M3 7.2 5.8 10 11 4.2",
  fill: "none",
  strokeWidth: "2.2",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  stroke: light ? 'rgba(0,0,0,.78)' : '#fff'
}));

// TweakColor — curated color/palette picker. Each option is either a single
// hex string or an array of 1-5 hex strings; the card adapts — a lone color
// renders solid, a palette renders colors[0] as the hero (left ~2/3) with the
// rest stacked in a sharp column on the right. onChange emits the
// option in the shape it was passed (string stays string, array stays array).
// Without options it falls back to the native color input for back-compat.
function TweakColor({
  label,
  value,
  options,
  onChange
}) {
  if (!options || !options.length) {
    return /*#__PURE__*/React.createElement("div", {
      className: "twk-row twk-row-h"
    }, /*#__PURE__*/React.createElement("div", {
      className: "twk-lbl"
    }, /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("input", {
      type: "color",
      className: "twk-swatch",
      value: value,
      onChange: e => onChange(e.target.value)
    }));
  }
  // Native <input type=color> emits lowercase hex per the HTML spec, so
  // compare case-insensitively. String() guards JSON.stringify(undefined),
  // which returns the primitive undefined (no .toLowerCase).
  const key = o => String(JSON.stringify(o)).toLowerCase();
  const cur = key(value);
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-chips",
    role: "radiogroup"
  }, options.map((o, i) => {
    const colors = Array.isArray(o) ? o : [o];
    const [hero, ...rest] = colors;
    const sup = rest.slice(0, 4);
    const on = key(o) === cur;
    return /*#__PURE__*/React.createElement("button", {
      key: i,
      type: "button",
      className: "twk-chip",
      role: "radio",
      "aria-checked": on,
      "data-on": on ? '1' : '0',
      "aria-label": colors.join(', '),
      title: colors.join(' · '),
      style: {
        background: hero
      },
      onClick: () => onChange(o)
    }, sup.length > 0 && /*#__PURE__*/React.createElement("span", null, sup.map((c, j) => /*#__PURE__*/React.createElement("i", {
      key: j,
      style: {
        background: c
      }
    }))), on && /*#__PURE__*/React.createElement(__TwkCheck, {
      light: __twkIsLight(hero)
    }));
  })));
}
function TweakButton({
  label,
  onClick,
  secondary = false
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: secondary ? 'twk-btn secondary' : 'twk-btn',
    onClick: onClick
  }, label);
}
Object.assign(window, {
  useTweaks,
  TweaksPanel,
  TweakSection,
  TweakRow,
  TweakSlider,
  TweakToggle,
  TweakRadio,
  TweakSelect,
  TweakText,
  TweakNumber,
  TweakColor,
  TweakButton
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "explorer/tweaks-panel.jsx", error: String((e && e.message) || e) }); }

// explorer/views-1.jsx
try { (() => {
/* IIFE-WRAPPED */
;
(() => {
  /* PDPP Explorer — views part 1: Table, Timeline, Conversation, Reader */

  const {
    fmtRelative,
    fmtClock,
    fmtDate,
    fmtDay,
    fmtCurrency,
    fmtDuration,
    fmtDistance,
    Avatar,
    getTimeField,
    getRecordTime,
    getRecordTitle
  } = window.PDPPPrim;

  /* ─── TABLE VIEW (the universal floor) ─────────────────────────────────
   *
   * Picks columns generically: prefer timestamp first, then human-readable
   * scalars (text, currency, enum, number, person), then everything else
   * stays in the peek. Currency right-aligns. Long text gets truncated.
   */
  function TableView({
    stream,
    selectedId,
    onSelect,
    projection
  }) {
    const fields = stream.schema.fields;
    const visibleFields = projection ? fields.filter(f => f.granted) : fields;

    // Column priority: timestamp first, then text/enum/person/currency/number,
    // then booleans, then anything else.
    const priority = f => {
      if (f.type === "timestamp") return 0;
      if (f.type === "text" && /title|subject|merchant|name/i.test(f.name)) return 1;
      if (f.type === "person") return 2;
      if (f.type === "text") return 3;
      if (f.type === "enum") return 4;
      if (f.type === "currency") return 5;
      if (f.type === "number") return 6;
      return 9;
    };
    const cols = [...visibleFields].filter(f => f.type !== "id" && f.type !== "blob" && f.type !== "geo" && f.type !== "json" && f.type !== "person[]").sort((a, b) => priority(a) - priority(b)).slice(0, 5);
    function renderCell(field, record) {
      const v = record[field.name];
      if (v == null) return /*#__PURE__*/React.createElement("span", {
        className: "mono"
      }, "\u2014");
      if (field.type === "timestamp") {
        return /*#__PURE__*/React.createElement("span", {
          className: "mono num"
        }, fmtRelative(v));
      }
      if (field.type === "currency") {
        return /*#__PURE__*/React.createElement("span", {
          className: `num mono ${v > 0 ? "pos" : ""}`
        }, fmtCurrency(v));
      }
      if (field.type === "number") {
        let display = v.toLocaleString();
        if (field.unit === "meters") display = fmtDistance(v);else if (field.unit === "seconds") display = fmtDuration(v);
        return /*#__PURE__*/React.createElement("span", {
          className: "num mono"
        }, display);
      }
      if (field.type === "boolean") return /*#__PURE__*/React.createElement("span", {
        className: "mono"
      }, v ? "yes" : "—");
      if (field.type === "enum" || field.type === "enum[]") {
        const arr = Array.isArray(v) ? v : [v];
        return /*#__PURE__*/React.createElement("span", {
          className: "mono"
        }, arr.slice(0, 2).join(", "));
      }
      if (field.type === "person") return /*#__PURE__*/React.createElement("span", null, String(v).replace(/<[^>]+>/g, "").trim());
      return /*#__PURE__*/React.createElement("span", {
        className: "truncate",
        title: String(v)
      }, String(v));
    }
    return /*#__PURE__*/React.createElement("div", {
      style: {
        overflowX: "auto"
      }
    }, /*#__PURE__*/React.createElement("table", {
      className: "exp-table"
    }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, cols.map(c => /*#__PURE__*/React.createElement("th", {
      key: c.name
    }, c.name)))), /*#__PURE__*/React.createElement("tbody", null, stream.records.map(r => /*#__PURE__*/React.createElement("tr", {
      key: r.id,
      "data-selected": selectedId === r.id,
      onClick: () => onSelect(r)
    }, cols.map(c => /*#__PURE__*/React.createElement("td", {
      key: c.name
    }, renderCell(c, r))))))));
  }

  /* ─── TIMELINE VIEW ────────────────────────────────────────────────────
   *
   * Day-grouped reverse-chrono list. Right-rail scrubber jumps to a month.
   * Works for any stream with a timestamp field.
   */
  function TimelineView({
    stream,
    selectedId,
    onSelect
  }) {
    const tf = getTimeField(stream);
    if (!tf) return /*#__PURE__*/React.createElement("div", {
      className: "exp-empty"
    }, "No timestamp field in schema.");
    const sorted = [...stream.records].sort((a, b) => new Date(b[tf]) - new Date(a[tf]));

    // Group by day
    const days = [];
    let lastDay = "";
    for (const r of sorted) {
      const day = r[tf]?.slice(0, 10);
      if (day !== lastDay) {
        days.push({
          day,
          items: []
        });
        lastDay = day;
      }
      days[days.length - 1].items.push(r);
    }

    // Months for the scrubber
    const monthsSet = new Map();
    for (const r of sorted) {
      const m = r[tf]?.slice(0, 7);
      monthsSet.set(m, (monthsSet.get(m) ?? 0) + 1);
    }
    const months = [...monthsSet.entries()];
    return /*#__PURE__*/React.createElement("div", {
      className: "exp-tl"
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-tl__list"
    }, days.map(({
      day,
      items
    }) => /*#__PURE__*/React.createElement("div", {
      key: day
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-tl__day-label"
    }, fmtDay(day + "T12:00:00Z"), " \xB7 ", items.length, " record", items.length === 1 ? "" : "s"), items.map(r => /*#__PURE__*/React.createElement("div", {
      className: "exp-tl__row",
      "data-selected": selectedId === r.id,
      key: r.id,
      onClick: () => onSelect(r)
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-tl__time"
    }, fmtClock(r[tf])), /*#__PURE__*/React.createElement("div", {
      className: "exp-tl__content"
    }, /*#__PURE__*/React.createElement("b", null, getRecordTitle(stream, r)), /*#__PURE__*/React.createElement("small", null, [r.from, r.author, r.actor, r.merchant, r.title, r.channel].filter(Boolean).slice(0, 1).join(" · ") || r.id))))))), /*#__PURE__*/React.createElement("div", {
      className: "exp-tl__scrubber"
    }, months.map(([m, count]) => /*#__PURE__*/React.createElement("span", {
      className: "exp-tl__scrubber-month",
      key: m,
      "data-active": true
    }, new Date(m + "-15").toLocaleDateString("en-US", {
      month: "short"
    }), " ", /*#__PURE__*/React.createElement("span", {
      style: {
        opacity: 0.6
      }
    }, count)))));
  }

  /* ─── CONVERSATION VIEW ─────────────────────────────────────────────────
   *
   * Two cols: channel rail + thread list. Works for any record with an
   * (author|from) + (text|body) + (thread/channel|to) shape.
   */
  function ConversationView({
    stream,
    selectedId,
    onSelect
  }) {
    // Determine field names from schema
    const fields = stream.schema.fields;
    const authorField = fields.find(f => /author|from|sender|user/i.test(f.name))?.name;
    const bodyField = fields.find(f => /body|text|message|content|snippet/i.test(f.name))?.name;
    const channelField = fields.find(f => /channel|thread|conversation/i.test(f.name) && f.type !== "id")?.name ?? fields.find(f => /channel|thread|conversation/i.test(f.name))?.name;
    const subjectField = fields.find(f => /subject|title/i.test(f.name))?.name;
    const timeField = getTimeField(stream);
    const recipField = fields.find(f => f.name === "to")?.name;

    // Group by channel/thread
    const groups = new Map();
    for (const r of stream.records) {
      const key = r[channelField] ?? r[subjectField] ?? (recipField ? `to:${(r[recipField] ?? []).join(",")}` : "—");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const channels = [...groups.entries()].sort((a, b) => {
      const ta = Math.max(...a[1].map(r => new Date(r[timeField] ?? 0)));
      const tb = Math.max(...b[1].map(r => new Date(r[timeField] ?? 0)));
      return tb - ta;
    });
    const [active, setActive] = useState(channels[0]?.[0]);
    const activeRecords = (groups.get(active) ?? []).slice().sort((a, b) => new Date(a[timeField] ?? 0) - new Date(b[timeField] ?? 0));
    return /*#__PURE__*/React.createElement("div", {
      className: "exp-conv"
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-conv__channels"
    }, channels.map(([name, items]) => /*#__PURE__*/React.createElement("button", {
      className: "exp-conv__channel",
      "data-active": active === name,
      key: name,
      onClick: () => setActive(name)
    }, /*#__PURE__*/React.createElement("span", null, name), /*#__PURE__*/React.createElement("span", {
      className: "exp-conv__channel-count"
    }, items.length)))), /*#__PURE__*/React.createElement("div", {
      className: "exp-conv__list"
    }, activeRecords.map(r => /*#__PURE__*/React.createElement("div", {
      className: "exp-conv__msg",
      "data-selected": selectedId === r.id,
      key: r.id,
      onClick: () => onSelect(r)
    }, /*#__PURE__*/React.createElement(Avatar, {
      label: r[authorField]
    }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "exp-conv__head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "exp-conv__head-name"
    }, String(r[authorField] ?? "·").replace(/<[^>]+>/g, "").trim()), /*#__PURE__*/React.createElement("span", {
      className: "exp-conv__head-time"
    }, fmtRelative(r[timeField])), subjectField && r[subjectField] ? /*#__PURE__*/React.createElement("span", {
      className: "exp-conv__head-channel"
    }, "\xB7 ", r[subjectField]) : null), /*#__PURE__*/React.createElement("div", {
      className: "exp-conv__text"
    }, r[bodyField]), Array.isArray(r.reactions) && r.reactions.length > 0 ? /*#__PURE__*/React.createElement("div", {
      className: "exp-conv__react"
    }, r.reactions.map((rx, i) => /*#__PURE__*/React.createElement("span", {
      key: i
    }, rx.emoji, " ", rx.count))) : null)))));
  }

  /* ─── READER VIEW ──────────────────────────────────────────────────────
   *
   * Title + long body. Used for GitHub PR/issue bodies, etc.
   */
  function ReaderView({
    stream,
    selectedId,
    onSelect
  }) {
    const fields = stream.schema.fields;
    const titleField = fields.find(f => /title|subject/i.test(f.name))?.name;
    const bodyField = fields.find(f => /body|content/i.test(f.name))?.name;
    const timeField = getTimeField(stream);
    const actorField = fields.find(f => /actor|author|from|user/i.test(f.name))?.name;
    const sorted = [...stream.records].sort((a, b) => new Date(b[timeField] ?? 0) - new Date(a[timeField] ?? 0));
    return /*#__PURE__*/React.createElement("div", {
      className: "exp-rdr"
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-rdr__list"
    }, sorted.map(r => /*#__PURE__*/React.createElement("div", {
      className: "exp-rdr__item",
      "data-selected": selectedId === r.id,
      key: r.id,
      onClick: () => onSelect(r)
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-rdr__item-meta"
    }, /*#__PURE__*/React.createElement("span", null, r.type ?? r[actorField] ?? ""), /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, r.repo ?? ""), /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, fmtRelative(r[timeField]))), /*#__PURE__*/React.createElement("h3", {
      className: "exp-rdr__item-title"
    }, r[titleField]), /*#__PURE__*/React.createElement("p", {
      className: "exp-rdr__item-body"
    }, r[bodyField])))));
  }
  Object.assign(window, {
    TableView,
    TimelineView,
    ConversationView,
    ReaderView
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "explorer/views-1.jsx", error: String((e && e.message) || e) }); }

// explorer/views-2.jsx
try { (() => {
/* IIFE-WRAPPED */
;
(() => {
  /* PDPP Explorer — views part 2: Ledger, Gallery, Map, Calendar, Chart */

  const {
    fmtRelative,
    fmtClock,
    fmtDate,
    fmtDay,
    fmtCurrency,
    fmtDuration,
    fmtDistance,
    Heatmap,
    Sparkline,
    getTimeField,
    getRecordTitle,
    NOW
  } = window.PDPPPrim;

  /* ─── LEDGER VIEW ──────────────────────────────────────────────────────
   *
   * Month-strip + transactions list + category breakdown.
   * Generalized: works on any stream with a currency-typed field.
   */
  function LedgerView({
    stream,
    selectedId,
    onSelect
  }) {
    const fields = stream.schema.fields;
    const amountField = (fields.find(f => f.type === "currency") ?? fields.find(f => f.type === "number" && /amount/i.test(f.name)))?.name;
    const merchantField = fields.find(f => /merchant|payee|counterparty|seller/i.test(f.name))?.name;
    const catField = fields.find(f => /category|kind|type/i.test(f.name) && f.type === "enum")?.name;
    const timeField = getTimeField(stream);
    const memoField = fields.find(f => /memo|note|description/i.test(f.name))?.name;

    // Month strip
    const monthBuckets = useMonths(stream.records, timeField);
    const [activeMonth, setActiveMonth] = useState(monthBuckets[0]?.key ?? null);
    const visible = stream.records.filter(r => r[timeField]?.slice(0, 7) === activeMonth);
    const sorted = [...visible].sort((a, b) => new Date(b[timeField]) - new Date(a[timeField]));

    // Category breakdown
    const cats = new Map();
    for (const r of visible) {
      const cat = r[catField] ?? "Other";
      cats.set(cat, (cats.get(cat) ?? 0) + Math.abs(r[amountField] ?? 0));
    }
    const catEntries = [...cats.entries()].sort((a, b) => b[1] - a[1]);
    const catMax = Math.max(1, ...catEntries.map(c => c[1]));
    return /*#__PURE__*/React.createElement("div", {
      className: "exp-ledger"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "exp-ledger__month-strip"
    }, monthBuckets.map(m => /*#__PURE__*/React.createElement("button", {
      className: "exp-ledger__month",
      "data-active": m.key === activeMonth,
      key: m.key,
      onClick: () => setActiveMonth(m.key)
    }, /*#__PURE__*/React.createElement("span", {
      className: "exp-ledger__month-label"
    }, m.label), /*#__PURE__*/React.createElement("span", {
      className: "exp-ledger__month-amount"
    }, fmtCurrency(m.net))))), /*#__PURE__*/React.createElement("div", {
      className: "exp-ledger__rows"
    }, sorted.map(r => /*#__PURE__*/React.createElement("div", {
      className: "exp-ledger__row",
      "data-selected": selectedId === r.id,
      key: r.id,
      onClick: () => onSelect(r)
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-ledger__row-date"
    }, fmtDate(r[timeField])), /*#__PURE__*/React.createElement("div", {
      className: "exp-ledger__row-merchant"
    }, r[merchantField] ?? r.title ?? "—", r[memoField] ? /*#__PURE__*/React.createElement("small", null, r[memoField]) : null), /*#__PURE__*/React.createElement("div", {
      className: "exp-ledger__row-cat"
    }, r[catField] ?? "—"), /*#__PURE__*/React.createElement("div", {
      className: `exp-ledger__row-amount ${r[amountField] > 0 ? "pos" : ""}`
    }, fmtCurrency(r[amountField] ?? 0)))))), /*#__PURE__*/React.createElement("aside", {
      className: "exp-ledger__side"
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-ledger__side-label"
    }, "By category"), catEntries.map(([name, amt]) => /*#__PURE__*/React.createElement("div", {
      className: "exp-ledger__side-row",
      key: name
    }, /*#__PURE__*/React.createElement("span", {
      className: "exp-ledger__side-row-cat"
    }, name), /*#__PURE__*/React.createElement("span", {
      className: "exp-ledger__side-bar",
      style: {
        "--pct": `${amt / catMax * 100}%`
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "exp-ledger__side-row-amt"
    }, fmtCurrency(-amt))))));
  }
  function useMonths(records, timeField) {
    const buckets = new Map();
    for (const r of records) {
      const k = r[timeField]?.slice(0, 7);
      if (!k) continue;
      if (!buckets.has(k)) buckets.set(k, {
        key: k,
        net: 0,
        count: 0
      });
      buckets.get(k).net += r.amount ?? 0;
      buckets.get(k).count += 1;
    }
    const list = [...buckets.values()].sort((a, b) => b.key.localeCompare(a.key));
    return list.slice(0, 6).map(b => ({
      ...b,
      label: new Date(b.key + "-15").toLocaleDateString("en-US", {
        month: "short"
      })
    }));
  }

  /* ─── GALLERY VIEW ─────────────────────────────────────────────────────
   *
   * Justified-grid masonry-ish for any stream with a blob image / url image field.
   */
  function GalleryView({
    stream,
    selectedId,
    onSelect
  }) {
    const fields = stream.schema.fields;
    const imgField = (fields.find(f => f.type === "blob" && (f.media_type ?? "").startsWith("image/")) ?? fields.find(f => /thumb|image|photo|picture/i.test(f.name)))?.name;
    const capField = fields.find(f => /caption|title|subject/i.test(f.name))?.name;
    const timeField = getTimeField(stream);
    const sorted = [...stream.records].sort((a, b) => new Date(b[timeField] ?? 0) - new Date(a[timeField] ?? 0));
    return /*#__PURE__*/React.createElement("div", {
      className: "exp-gal"
    }, sorted.map(r => /*#__PURE__*/React.createElement("div", {
      className: "exp-gal__item",
      "data-selected": selectedId === r.id,
      key: r.id,
      onClick: () => onSelect(r)
    }, /*#__PURE__*/React.createElement("img", {
      alt: r[capField] ?? "",
      loading: "lazy",
      src: r[imgField]
    }), capField ? /*#__PURE__*/React.createElement("div", {
      className: "exp-gal__cap"
    }, r[capField]) : null)));
  }

  /* ─── MAP VIEW ─────────────────────────────────────────────────────────
   *
   * Stylized rectangular projection — not a real map, just enough geography
   * to read multiple pins as a place. For a generalized explorer this is
   * meant as a quick locator; a real impl would mount mapbox/maplibre here.
   */
  function MapView({
    stream,
    selectedId,
    onSelect
  }) {
    const fields = stream.schema.fields;
    const latField = fields.find(f => /^lat(itude)?$/i.test(f.name))?.name;
    const lngField = fields.find(f => /^l(ng|on|ongitude)$/i.test(f.name))?.name;
    const labelField = fields.find(f => /title|caption|subject/i.test(f.name))?.name;
    const timeField = getTimeField(stream);
    if (!latField || !lngField) return /*#__PURE__*/React.createElement("div", {
      className: "exp-empty"
    }, "Stream carries no usable geo fields.");
    const pts = stream.records.filter(r => r[latField] != null && r[lngField] != null);
    if (!pts.length) return /*#__PURE__*/React.createElement("div", {
      className: "exp-empty"
    }, "No records carry coordinates in this window.");
    const lats = pts.map(p => p[latField]);
    const lngs = pts.map(p => p[lngField]);
    // Pad bbox slightly so pins don't sit on the edges
    const minLat = Math.min(...lats) - 0.005;
    const maxLat = Math.max(...lats) + 0.005;
    const minLng = Math.min(...lngs) - 0.005;
    const maxLng = Math.max(...lngs) + 0.005;
    function projX(lng) {
      const range = maxLng - minLng || 1;
      return (lng - minLng) / range * 100;
    }
    function projY(lat) {
      const range = maxLat - minLat || 1;
      return (1 - (lat - minLat) / range) * 100;
    }
    return /*#__PURE__*/React.createElement("div", {
      className: "exp-map"
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-map__grid"
    }), pts.map(r => /*#__PURE__*/React.createElement("div", {
      className: "exp-map__pin",
      "data-selected": selectedId === r.id,
      key: r.id,
      onClick: () => onSelect(r),
      style: {
        left: `${projX(r[lngField])}%`,
        top: `${projY(r[latField])}%`
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "exp-map__pin-dot"
    }), /*#__PURE__*/React.createElement("span", {
      className: "exp-map__pin-label"
    }, (r[labelField] ?? r.title ?? "·").slice(0, 28), " \xB7 ", fmtDate(r[timeField])))), /*#__PURE__*/React.createElement("div", {
      className: "exp-map__legend"
    }, pts.length, " record", pts.length === 1 ? "" : "s", " \xB7 bbox ", minLat.toFixed(2), ",", minLng.toFixed(2), " \u2192 ", maxLat.toFixed(2), ",", maxLng.toFixed(2)));
  }

  /* ─── CALENDAR VIEW ────────────────────────────────────────────────────
   *
   * 6-week month grid anchored on `today`. Records with start/end (or
   * any timestamp field) render as inline event chips.
   */
  function CalendarView({
    stream,
    selectedId,
    onSelect
  }) {
    const fields = stream.schema.fields;
    const startField = fields.find(f => /^start/i.test(f.name))?.name ?? getTimeField(stream);
    const titleField = fields.find(f => /title|subject|name/i.test(f.name))?.name;
    const today = new Date(NOW);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    // Start the grid on the Sunday before (or equal to) the 1st.
    const gridStart = new Date(monthStart);
    gridStart.setDate(monthStart.getDate() - monthStart.getDay());
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      cells.push(d);
    }
    const byDate = new Map();
    for (const r of stream.records) {
      if (!r[startField]) continue;
      const key = r[startField].slice(0, 10);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(r);
    }
    const dayKey = d => d.toISOString().slice(0, 10);
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: "0.75rem",
        fontFamily: "var(--font-mono)",
        fontSize: "0.78rem",
        color: "var(--muted-foreground)"
      }
    }, today.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric"
    })), /*#__PURE__*/React.createElement("div", {
      className: "exp-cal"
    }, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => /*#__PURE__*/React.createElement("div", {
      className: "exp-cal__dow",
      key: d
    }, d)), cells.map(d => {
      const isToday = dayKey(d) === dayKey(today);
      const isOther = d.getMonth() !== today.getMonth();
      const evts = byDate.get(dayKey(d)) ?? [];
      return /*#__PURE__*/React.createElement("div", {
        className: "exp-cal__day",
        "data-other": isOther,
        "data-today": isToday,
        key: dayKey(d)
      }, /*#__PURE__*/React.createElement("span", {
        className: "exp-cal__day-num"
      }, d.getDate()), evts.map(r => /*#__PURE__*/React.createElement("span", {
        className: "exp-cal__event",
        "data-selected": selectedId === r.id,
        key: r.id,
        onClick: e => {
          e.stopPropagation();
          onSelect(r);
        }
      }, r[titleField] ?? r.title ?? "·")));
    })));
  }

  /* ─── CHART VIEW ───────────────────────────────────────────────────────
   *
   * For each numeric measure, render a heatmap (day density) + sparkline.
   * Generic: doesn't care what stream.
   */
  function ChartView({
    stream
  }) {
    const fields = stream.schema.fields;
    const timeField = getTimeField(stream);
    const isMeasure = f => f.type === "number" && !/^(lat|lng|longitude|latitude|id|.*_id|.*_count)$/i.test(f.name);
    const measures = fields.filter(isMeasure);

    // Aggregate per-day count for the activity heatmap
    const dayCounts = new Map();
    for (const r of stream.records) {
      const d = r[timeField]?.slice(0, 10);
      if (!d) continue;
      dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
    }
    const heatValues = [...dayCounts.entries()].map(([date, count]) => ({
      date,
      count
    }));

    // Sparklines: for each measure, sort by time and take last 30 values
    function valuesForMeasure(f) {
      return [...stream.records].filter(r => r[f.name] != null && r[timeField]).sort((a, b) => new Date(a[timeField]) - new Date(b[timeField])).map(r => r[f.name]);
    }
    return /*#__PURE__*/React.createElement("div", {
      className: "exp-chart-grid"
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-chart-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "exp-chart-card__head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "exp-chart-card__title"
    }, "Activity \xB7 last 12 weeks"), /*#__PURE__*/React.createElement("span", {
      className: "exp-chart-card__sub"
    }, stream.records.length, " records \xB7 ", dayCounts.size, " active days")), /*#__PURE__*/React.createElement(Heatmap, {
      days: 84,
      values: heatValues
    })), measures.map(f => {
      const values = valuesForMeasure(f);
      if (!values.length) return null;
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      const latest = values[values.length - 1];
      return /*#__PURE__*/React.createElement("div", {
        className: "exp-chart-card",
        key: f.name
      }, /*#__PURE__*/React.createElement("div", {
        className: "exp-chart-card__head"
      }, /*#__PURE__*/React.createElement("span", {
        className: "exp-chart-card__title"
      }, f.name), /*#__PURE__*/React.createElement("span", {
        className: "exp-chart-card__sub"
      }, "latest ", /*#__PURE__*/React.createElement("b", {
        style: {
          color: "var(--foreground)"
        }
      }, formatMeasure(f, latest)), " · ", "avg ", formatMeasure(f, avg))), /*#__PURE__*/React.createElement(Sparkline, {
        color: "var(--primary)",
        height: 48,
        values: values,
        width: 520
      }));
    }));
  }
  function formatMeasure(f, v) {
    if (f.unit === "meters") return fmtDistance(v);
    if (f.unit === "seconds") return fmtDuration(v);
    if (typeof v === "number") return v.toFixed(v % 1 === 0 ? 0 : 1);
    return String(v);
  }
  Object.assign(window, {
    LedgerView,
    GalleryView,
    MapView,
    CalendarView,
    ChartView
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "explorer/views-2.jsx", error: String((e && e.message) || e) }); }

// labs/LivingGrant.jsx
try { (() => {
// LivingGrant — the centerpiece. A grant as a breathing thermal object,
// with real records flowing through it in real time.

const {
  useState,
  useEffect,
  useRef
} = React;

// A small deterministic fake record stream
const RECORD_STREAM = [{
  e: 'Acme Co',
  p: '2025-09-16→30',
  g: '$4,812.50',
  n: '$3,622.18'
}, {
  e: 'Acme Co',
  p: '2025-09-01→15',
  g: '$4,812.50',
  n: '$3,622.18'
}, {
  e: 'Acme Co',
  p: '2025-08-16→31',
  g: '$4,812.50',
  n: '$3,624.42'
}, {
  e: 'Acme Co',
  p: '2025-08-01→15',
  g: '$4,812.50',
  n: '$3,624.42'
}, {
  e: 'Acme Co',
  p: '2025-07-16→31',
  g: '$4,812.50',
  n: '$3,624.42'
}, {
  e: 'Acme Co',
  p: '2025-07-01→15',
  g: '$4,756.00',
  n: '$3,580.12'
}, {
  e: 'Acme Co',
  p: '2025-06-16→30',
  g: '$4,756.00',
  n: '$3,580.12'
}, {
  e: 'Acme Co',
  p: '2025-06-01→15',
  g: '$4,756.00',
  n: '$3,580.12'
}];
const LivingGrant = () => {
  const [cursor, setCursor] = useState(0);
  const [paused, setPaused] = useState(false);
  const [thermal, setThermal] = useState(0.62); // 0 = pure human, 1 = pure protocol

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setCursor(c => (c + 1) % RECORD_STREAM.length), 1800);
    return () => clearInterval(t);
  }, [paused]);
  const thermalColor = `color-mix(in oklch, var(--human) ${(1 - thermal) * 100}%, var(--protocol) ${thermal * 100}%)`;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 0,
      border: '1px solid var(--rule)',
      background: 'var(--paper)',
      position: 'relative',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 2,
      background: 'var(--thermal)',
      opacity: 0.8
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '40px 36px',
      borderRight: '1px solid var(--rule)',
      position: 'relative',
      background: `linear-gradient(135deg, var(--human-wash), transparent 65%)`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "gutter",
    style: {
      color: 'var(--human)'
    }
  }, "\xA72 \xB7 HOLDER"), /*#__PURE__*/React.createElement("span", {
    className: "gutter num"
  }, "you")), /*#__PURE__*/React.createElement("div", {
    className: "t-section",
    style: {
      marginTop: 18,
      maxWidth: 340
    }
  }, /*#__PURE__*/React.createElement("em", null, "Longview"), " is reading your ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--human)'
    }
  }, "pay statements"), "."), /*#__PURE__*/React.createElement("div", {
    className: "t-body",
    style: {
      marginTop: 14,
      maxWidth: 360
    }
  }, "Every other Friday since ", /*#__PURE__*/React.createElement("span", {
    className: "num",
    style: {
      color: 'var(--ink)'
    }
  }, "Oct 14"), ". They see the employer, period, and gross and net pay. They cannot see your bank, address, or anything else."), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 24,
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, ['pay_statements.read', 'employment.read'].map(s => /*#__PURE__*/React.createElement("div", {
    key: s,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: 999,
      background: 'var(--live)',
      animation: 'pulse-dot 1.6s ease-in-out infinite'
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "t-mono",
    style: {
      color: 'var(--ink)'
    }
  }, s), /*#__PURE__*/React.createElement("span", {
    className: "t-mono",
    style: {
      color: 'var(--ink-faint)',
      marginLeft: 'auto'
    }
  }, "live"))), ['tax_docs.read', 'identity.read', 'transactions.read'].map(s => /*#__PURE__*/React.createElement("div", {
    key: s,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      opacity: 0.35
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: 999,
      background: 'var(--ink-whisper)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "t-mono",
    style: {
      color: 'var(--ink-faint)'
    }
  }, s), /*#__PURE__*/React.createElement("span", {
    className: "t-mono",
    style: {
      color: 'var(--ink-faint)',
      marginLeft: 'auto'
    }
  }, "\u2014")))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 32,
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-paper",
    style: {
      height: 36,
      fontSize: 13
    }
  }, "Revoke grant"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-ghost",
    style: {
      height: 36,
      fontSize: 13
    }
  }, "Adjust scope \u2192"))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '40px 36px',
      position: 'relative',
      background: `linear-gradient(225deg, var(--protocol-wash), transparent 65%)`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "gutter num"
  }, "grt_longview01"), /*#__PURE__*/React.createElement("span", {
    className: "gutter",
    style: {
      color: 'var(--protocol)'
    }
  }, "ISSUER \xB7 \xA75")), /*#__PURE__*/React.createElement("div", {
    className: "t-section",
    style: {
      marginTop: 18,
      maxWidth: 340,
      textAlign: 'right',
      marginLeft: 'auto'
    }
  }, /*#__PURE__*/React.createElement("em", null, "Longview"), " holds a ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--protocol)'
    }
  }, "grant"), ", not a key."), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 24,
      border: '1px solid var(--rule)',
      borderRadius: 2,
      overflow: 'hidden',
      background: 'var(--paper-warm)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 0.8fr 0.8fr',
      padding: '6px 12px',
      background: 'var(--paper)',
      borderBottom: '1px solid var(--rule)'
    }
  }, ['employer', 'pay_period', 'gross', 'net'].map(h => /*#__PURE__*/React.createElement("span", {
    key: h,
    className: "gutter",
    style: {
      fontSize: 9.5
    }
  }, h))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 140,
      position: 'relative',
      overflow: 'hidden'
    }
  }, RECORD_STREAM.map((r, i) => {
    const offset = (i - cursor + RECORD_STREAM.length) % RECORD_STREAM.length;
    const y = offset * 20 - 10;
    const opacity = offset === 0 ? 1 : offset < 4 ? 0.8 - offset * 0.15 : 0;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        position: 'absolute',
        top: y,
        left: 0,
        right: 0,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 0.8fr 0.8fr',
        padding: '2px 12px',
        opacity,
        transition: 'top 400ms var(--ease-read), opacity 400ms'
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "t-mono",
      style: {
        color: 'var(--ink)',
        fontSize: 11.5
      }
    }, r.e), /*#__PURE__*/React.createElement("span", {
      className: "t-mono num",
      style: {
        color: 'var(--ink-soft)',
        fontSize: 11.5
      }
    }, r.p), /*#__PURE__*/React.createElement("span", {
      className: "t-mono num",
      style: {
        color: 'var(--ink-soft)',
        fontSize: 11.5
      }
    }, r.g), /*#__PURE__*/React.createElement("span", {
      className: "t-mono num",
      style: {
        color: 'var(--ink)',
        fontSize: 11.5
      }
    }, r.n));
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: 40,
      background: 'linear-gradient(transparent, var(--paper-warm))',
      pointerEvents: 'none'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '6px 12px',
      borderTop: '1px solid var(--rule)',
      display: 'flex',
      justifyContent: 'space-between',
      background: 'var(--paper)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "gutter",
    style: {
      fontSize: 9.5
    }
  }, "cursor: ", String(cursor).padStart(3, '0'), " / \u221E"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setPaused(p => !p),
    className: "gutter",
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontSize: 9.5,
      color: 'var(--protocol)'
    }
  }, paused ? '▸ resume' : '‖ pause'))), /*#__PURE__*/React.createElement("div", {
    className: "t-small",
    style: {
      marginTop: 16
    }
  }, "The resource server drops any field not named in the grant. Purpose is declared, not enforced. Revocation is authoritative at the issuer.")), /*#__PURE__*/React.createElement("div", {
    style: {
      gridColumn: '1 / -1',
      padding: '20px 36px',
      borderTop: '1px solid var(--rule)',
      display: 'flex',
      alignItems: 'center',
      gap: 20,
      background: 'var(--paper-warm)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "gutter"
  }, "thermal \u2192"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      position: 'relative',
      height: 2,
      background: 'var(--thermal)',
      borderRadius: 999,
      cursor: 'pointer'
    },
    onClick: e => {
      const rect = e.currentTarget.getBoundingClientRect();
      setThermal(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '50%',
      left: `${thermal * 100}%`,
      width: 14,
      height: 14,
      borderRadius: 999,
      background: thermalColor,
      transform: 'translate(-50%, -50%)',
      border: '2px solid var(--paper)',
      boxShadow: '0 0 0 1px ' + thermalColor
    }
  })), /*#__PURE__*/React.createElement("span", {
    className: "gutter num",
    style: {
      color: thermalColor,
      minWidth: 70,
      textAlign: 'right'
    }
  }, thermal < 0.35 ? 'HOLDER' : thermal > 0.65 ? 'ISSUER' : 'BOUNDARY', " \xB7 ", Math.round(thermal * 100), "\xB0")));
};
window.LivingGrant = LivingGrant;
})(); } catch (e) { __ds_ns.__errors.push({ path: "labs/LivingGrant.jsx", error: String((e && e.message) || e) }); }

// labs/SpecElements.jsx
try { (() => {
// SpecPage — the whole thing as a reimagined document.

const NightToggle = () => {
  const [night, setNight] = useState(() => localStorage.getItem('pdpp-view') === 'night');
  useEffect(() => {
    document.documentElement.dataset.view = night ? 'night' : 'day';
    localStorage.setItem('pdpp-view', night ? 'night' : 'day');
  }, [night]);
  return /*#__PURE__*/React.createElement("button", {
    onClick: () => setNight(n => !n),
    className: "gutter",
    style: {
      background: 'none',
      border: '1px solid var(--rule-deep)',
      padding: '6px 10px',
      cursor: 'pointer',
      color: 'var(--ink-soft)',
      fontSize: 10,
      borderRadius: 2
    }
  }, night ? '◐ night' : '◑ day');
};

// Typographic mark — a 'P' with a serif terminal, drawn in paper over ink
const MarkP = ({
  size = 32
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    width: size,
    height: size,
    background: 'var(--ink)',
    color: 'var(--paper)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--font-serif)',
    fontWeight: 500,
    fontSize: size * 0.58,
    letterSpacing: '-0.04em',
    position: 'relative',
    fontVariationSettings: '"opsz" 144'
  }
}, "P", /*#__PURE__*/React.createElement("span", {
  style: {
    position: 'absolute',
    bottom: 3,
    right: 3,
    width: 3,
    height: 3,
    background: 'var(--human)',
    borderRadius: 999
  }
}));

// The gutter-numbered spec row — like a printed RFC
const SpecRow = ({
  num,
  t,
  children,
  tone
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: '80px 1fr',
    gap: 24,
    padding: '22px 0',
    borderTop: '1px solid var(--rule)'
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "gutter num",
  style: {
    color: tone === 'human' ? 'var(--human)' : tone === 'protocol' ? 'var(--protocol)' : 'var(--ink-faint)'
  }
}, "\xA7", num)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-serif)',
    fontSize: 22,
    lineHeight: 1.3,
    letterSpacing: '-0.015em',
    color: 'var(--ink)'
  }
}, t), children && /*#__PURE__*/React.createElement("div", {
  className: "t-body",
  style: {
    marginTop: 8,
    maxWidth: 620
  }
}, children)));

// The thermal legend — a compact key that shows what the two colors mean
const ThermalLegend = () => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'stretch',
    border: '1px solid var(--rule)',
    borderRadius: 2,
    overflow: 'hidden'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1,
    padding: '14px 18px',
    background: 'linear-gradient(90deg, var(--human-wash), transparent)'
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "gutter",
  style: {
    color: 'var(--human)'
  }
}, "HOLDER SIDE"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    marginTop: 4,
    color: 'var(--ink)'
  }
}, "warm \xB7 declarative \xB7 consent")), /*#__PURE__*/React.createElement("div", {
  style: {
    width: 1,
    background: 'var(--thermal)',
    opacity: 0.5
  }
}), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1,
    padding: '14px 18px',
    background: 'linear-gradient(270deg, var(--protocol-wash), transparent)',
    textAlign: 'right'
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "gutter",
  style: {
    color: 'var(--protocol)'
  }
}, "ISSUER SIDE"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    marginTop: 4,
    color: 'var(--ink)'
  }
}, "cool \xB7 enforcing \xB7 precise")));

// Purpose taxonomy — a visual vocabulary for why data is requested
const PURPOSES = [{
  c: 'planning',
  gloss: 'forecast futures',
  tone: 0.2
}, {
  c: 'verification',
  gloss: 'prove a fact',
  tone: 0.4
}, {
  c: 'underwriting',
  gloss: 'assess risk',
  tone: 0.55
}, {
  c: 'research',
  gloss: 'learn in aggregate',
  tone: 0.75
}, {
  c: 'fulfillment',
  gloss: 'complete a request',
  tone: 0.9
}];
const PurposeTaxonomy = () => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    border: '1px solid var(--rule)'
  }
}, PURPOSES.map((p, i) => {
  const color = `color-mix(in oklch, var(--human) ${(1 - p.tone) * 100}%, var(--protocol) ${p.tone * 100}%)`;
  return /*#__PURE__*/React.createElement("div", {
    key: p.c,
    style: {
      display: 'grid',
      gridTemplateColumns: '32px 1fr 1fr auto',
      alignItems: 'center',
      padding: '14px 18px',
      borderTop: i > 0 ? '1px solid var(--rule)' : 'none',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "num t-mono",
    style: {
      color: 'var(--ink-whisper)'
    }
  }, String(i + 1).padStart(2, '0')), /*#__PURE__*/React.createElement("span", {
    className: "t-mono",
    style: {
      color
    }
  }, p.c), /*#__PURE__*/React.createElement("span", {
    className: "t-body",
    style: {
      fontStyle: 'italic',
      fontFamily: 'var(--font-serif)',
      fontWeight: 300
    }
  }, "\"", p.gloss, "\""), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 60,
      height: 3,
      background: color,
      borderRadius: 999
    }
  }));
}));

// Footer — a colophon in the RFC style
const Colophon = () => /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '48px 0 64px',
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 32,
    borderTop: '1px solid var(--rule)'
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "gutter"
}, "DOCUMENT"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    marginTop: 8,
    color: 'var(--ink)'
  }
}, "PDPP-0.1.0 \xB7 draft 3"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    color: 'var(--ink-faint)',
    marginTop: 2
  }
}, "2026-04-19")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "gutter"
}, "SET"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    marginTop: 8,
    color: 'var(--ink)'
  }
}, "Fraunces \xB7 Geist \xB7 JetBrains Mono"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    color: 'var(--ink-faint)',
    marginTop: 2
  }
}, "ligatures on \xB7 tabular figures")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "gutter"
}, "PRINTED"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    marginTop: 8,
    color: 'var(--ink)'
  }
}, "paper oklch(0.985 0.005 85)"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    color: 'var(--ink-faint)',
    marginTop: 2
  }
}, "ink oklch(0.16 0.01 60)")), /*#__PURE__*/React.createElement("div", {
  style: {
    textAlign: 'right'
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "gutter"
}, "COLOPHON"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    marginTop: 8,
    color: 'var(--ink)'
  }
}, "vana-com/pdpp"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    color: 'var(--ink-faint)',
    marginTop: 2,
    fontStyle: 'italic',
    fontFamily: 'var(--font-serif)'
  }
}, "\"the grant is the artifact\"")));
window.NightToggle = NightToggle;
window.MarkP = MarkP;
window.SpecRow = SpecRow;
window.ThermalLegend = ThermalLegend;
window.PurposeTaxonomy = PurposeTaxonomy;
window.Colophon = Colophon;
})(); } catch (e) { __ds_ns.__errors.push({ path: "labs/SpecElements.jsx", error: String((e && e.message) || e) }); }

// labs/TheAtlas.jsx
try { (() => {
// TheAtlas — the spec as a visual index. Purposes, scopes, and temperatures laid out as a map.

const SCOPES_MAP = [{
  s: 'pay_statements',
  fields: 6,
  reads: 48,
  axis: 0.35
}, {
  s: 'employment',
  fields: 4,
  reads: 12,
  axis: 0.45
}, {
  s: 'tax_documents',
  fields: 5,
  reads: 6,
  axis: 0.4
}, {
  s: 'identity',
  fields: 3,
  reads: 23,
  axis: 0.7
}, {
  s: 'transactions',
  fields: 8,
  reads: 94,
  axis: 0.55
}, {
  s: 'health_records',
  fields: 12,
  reads: 2,
  axis: 0.25
}, {
  s: 'location',
  fields: 2,
  reads: 156,
  axis: 0.85
}];
const TheAtlas = () => {
  const maxReads = Math.max(...SCOPES_MAP.map(s => s.reads));
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: '96px 64px',
      borderBottom: '1px solid var(--rule)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1200,
      margin: '0 auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      marginBottom: 40
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "gutter"
  }, "\xA74 \xB7 THE ATLAS"), /*#__PURE__*/React.createElement("h2", {
    className: "t-section",
    style: {
      margin: '12px 0 0'
    }
  }, "Every stream is a ", /*#__PURE__*/React.createElement("em", null, "temperature"), "."), /*#__PURE__*/React.createElement("p", {
    className: "t-body",
    style: {
      marginTop: 10,
      maxWidth: 560
    }
  }, "Warmer streams are intimate \u2014 held close by the person who owns them. Cooler streams are transactional \u2014 issued and acknowledged by machines. The thermal axis runs under every design decision.")), /*#__PURE__*/React.createElement(ThermalLegend, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid var(--rule)',
      borderRadius: 2,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '10px 20px',
      background: 'var(--paper-warm)',
      borderBottom: '1px solid var(--rule)',
      display: 'grid',
      gridTemplateColumns: '200px 80px 1fr 80px',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "gutter"
  }, "stream"), /*#__PURE__*/React.createElement("span", {
    className: "gutter"
  }, "fields"), /*#__PURE__*/React.createElement("span", {
    className: "gutter"
  }, "temperature \xB7 warmer to cooler"), /*#__PURE__*/React.createElement("span", {
    className: "gutter",
    style: {
      textAlign: 'right'
    }
  }, "reads/24h")), SCOPES_MAP.map((s, i) => {
    const color = `color-mix(in oklch, var(--human) ${(1 - s.axis) * 100}%, var(--protocol) ${s.axis * 100}%)`;
    return /*#__PURE__*/React.createElement("div", {
      key: s.s,
      style: {
        padding: '16px 20px',
        display: 'grid',
        gridTemplateColumns: '200px 80px 1fr 80px',
        gap: 16,
        alignItems: 'center',
        borderTop: i > 0 ? '1px solid var(--rule)' : 'none'
      }
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
      className: "t-mono",
      style: {
        color: 'var(--ink)',
        fontSize: 13
      }
    }, s.s)), /*#__PURE__*/React.createElement("span", {
      className: "t-mono num",
      style: {
        color: 'var(--ink-soft)'
      }
    }, s.fields), /*#__PURE__*/React.createElement("div", {
      style: {
        position: 'relative',
        height: 24,
        display: 'flex',
        alignItems: 'center'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        position: 'absolute',
        inset: 0,
        background: 'var(--thermal)',
        opacity: 0.08,
        borderRadius: 2
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        position: 'absolute',
        left: `${s.axis * 100}%`,
        top: 0,
        bottom: 0,
        width: 3,
        background: color,
        transform: 'translateX(-50%)',
        boxShadow: `0 0 0 3px color-mix(in oklch, ${color} 25%, transparent)`
      }
    }), [0.25, 0.5, 0.75].map(t => /*#__PURE__*/React.createElement("div", {
      key: t,
      style: {
        position: 'absolute',
        left: `${t * 100}%`,
        top: '50%',
        width: 1,
        height: 4,
        background: 'var(--rule-deep)',
        transform: 'translate(-50%, -50%)'
      }
    }))), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: 'right',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 40,
        height: 2,
        background: 'var(--rule-deep)',
        borderRadius: 999,
        overflow: 'hidden',
        position: 'relative'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        position: 'absolute',
        inset: 0,
        right: `${(1 - s.reads / maxReads) * 100}%`,
        background: color
      }
    })), /*#__PURE__*/React.createElement("span", {
      className: "t-mono num",
      style: {
        color: 'var(--ink)',
        fontSize: 12,
        minWidth: 28,
        textAlign: 'right'
      }
    }, s.reads)));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 24,
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      gap: 24
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "t-small",
    style: {
      fontStyle: 'italic',
      fontFamily: 'var(--font-serif)',
      borderLeft: '2px solid var(--human)',
      paddingLeft: 14
    }
  }, "\"A location stream is colder than a pay stream, because its provenance has already been abstracted by the device.\""), /*#__PURE__*/React.createElement("div", {
    className: "t-small",
    style: {
      fontFamily: 'var(--font-serif)',
      textAlign: 'center'
    }
  }, "\u2014 from the annotated spec, footnote 4.11"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'right'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "gutter"
  }, "also see"), /*#__PURE__*/React.createElement("div", {
    className: "t-mono",
    style: {
      marginTop: 6,
      color: 'var(--protocol)'
    }
  }, "\xA74.2 field projection"), /*#__PURE__*/React.createElement("div", {
    className: "t-mono",
    style: {
      color: 'var(--protocol)'
    }
  }, "\xA74.3 stream modes")))));
};
window.TheAtlas = TheAtlas;
})(); } catch (e) { __ds_ns.__errors.push({ path: "labs/TheAtlas.jsx", error: String((e && e.message) || e) }); }

// labs/TheContract.jsx
try { (() => {
// TheContract — a typographic manifesto. Big serif, set like a declaration, with mono annotations in the margin.

const TheContract = () => /*#__PURE__*/React.createElement("section", {
  style: {
    padding: '120px 64px',
    position: 'relative',
    borderBottom: '1px solid var(--rule)'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 1200,
    margin: '0 auto',
    display: 'grid',
    gridTemplateColumns: '140px 1fr 140px',
    gap: 48
  }
}, /*#__PURE__*/React.createElement("aside", {
  style: {
    paddingTop: 32
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "gutter",
  style: {
    color: 'var(--ink-faint)'
  }
}, "\xA71.1 \u2014 \xA71.4"), /*#__PURE__*/React.createElement("div", {
  className: "t-small",
  style: {
    marginTop: 8,
    fontStyle: 'italic',
    fontFamily: 'var(--font-serif)',
    fontWeight: 300
  }
}, "Read aloud. Every clause matters.")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "gutter",
  style: {
    color: 'var(--ink-faint)'
  }
}, "THE FOUR COMMITMENTS"), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 16,
    fontFamily: 'var(--font-serif)',
    fontWeight: 300,
    fontSize: 'clamp(36px, 4.2vw, 56px)',
    lineHeight: 1.2,
    letterSpacing: '-0.02em'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 28
  }
}, /*#__PURE__*/React.createElement("span", {
  className: "num",
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 14,
    color: 'var(--human)',
    verticalAlign: 'top',
    marginRight: 14,
    letterSpacing: '0.05em'
  }
}, "I."), "The ", /*#__PURE__*/React.createElement("em", {
  style: {
    fontStyle: 'italic',
    color: 'var(--human)'
  }
}, "holder"), " decides what may be read, for how long, and why."), /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 28
  }
}, /*#__PURE__*/React.createElement("span", {
  className: "num",
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 14,
    color: 'var(--protocol)',
    verticalAlign: 'top',
    marginRight: 14,
    letterSpacing: '0.05em'
  }
}, "II."), "The ", /*#__PURE__*/React.createElement("em", {
  style: {
    fontStyle: 'italic',
    color: 'var(--protocol)'
  }
}, "issuer"), " drops every field not named in the grant."), /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 28
  }
}, /*#__PURE__*/React.createElement("span", {
  className: "num",
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 14,
    color: 'var(--ink-soft)',
    verticalAlign: 'top',
    marginRight: 14,
    letterSpacing: '0.05em'
  }
}, "III."), "The ", /*#__PURE__*/React.createElement("em", {
  style: {
    fontStyle: 'italic'
  }
}, "client"), " states a purpose. The purpose becomes part of the record."), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
  className: "num",
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 14,
    color: 'var(--voided)',
    verticalAlign: 'top',
    marginRight: 14,
    letterSpacing: '0.05em'
  }
}, "IV."), /*#__PURE__*/React.createElement("em", {
  style: {
    fontStyle: 'italic',
    color: 'var(--voided)'
  }
}, "Revocation"), " is a hard stop. Authoritative at the issuer. No appeals.")), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 60,
    display: 'flex',
    alignItems: 'center',
    gap: 18
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1,
    height: 1,
    background: 'var(--rule)'
  }
}), /*#__PURE__*/React.createElement("div", {
  className: "gutter"
}, "so that"), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1,
    height: 1,
    background: 'var(--rule)'
  }
})), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 60,
    fontFamily: 'var(--font-serif)',
    fontWeight: 400,
    fontStyle: 'italic',
    fontSize: 'clamp(28px, 3.2vw, 42px)',
    lineHeight: 1.3,
    letterSpacing: '-0.015em',
    color: 'var(--ink-soft)'
  }
}, "Consent becomes", ' ', /*#__PURE__*/React.createElement("span", {
  style: {
    color: 'var(--ink)',
    fontStyle: 'normal',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.78em',
    padding: '2px 10px',
    background: 'var(--paper-warm)',
    borderBottom: '2px solid var(--human)',
    letterSpacing: '-0.01em'
  }
}, "portable"), ", access becomes", ' ', /*#__PURE__*/React.createElement("span", {
  style: {
    color: 'var(--ink)',
    fontStyle: 'normal',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.78em',
    padding: '2px 10px',
    background: 'var(--paper-warm)',
    borderBottom: '2px solid var(--protocol)',
    letterSpacing: '-0.01em'
  }
}, "granular"), ", and data stops being a key to steal.")), /*#__PURE__*/React.createElement("aside", {
  style: {
    paddingTop: 32,
    textAlign: 'right'
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "gutter",
  style: {
    color: 'var(--ink-faint)'
  }
}, "RATIFIED"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    marginTop: 8,
    color: 'var(--ink)'
  }
}, "2026-04-19"), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 12,
    display: 'inline-block'
  }
}, /*#__PURE__*/React.createElement("svg", {
  width: "80",
  height: "40",
  viewBox: "0 0 80 40",
  style: {
    display: 'block',
    marginLeft: 'auto'
  }
}, /*#__PURE__*/React.createElement("path", {
  d: "M4 30 C 12 10, 24 10, 30 26 S 52 34, 58 14 S 72 20, 76 28",
  stroke: "var(--ink)",
  strokeWidth: "1.2",
  fill: "none",
  strokeLinecap: "round",
  opacity: "0.55"
}))), /*#__PURE__*/React.createElement("div", {
  className: "t-small",
  style: {
    marginTop: 6,
    fontStyle: 'italic',
    fontFamily: 'var(--font-serif)'
  }
}, "the committee"))));
window.TheContract = TheContract;
})(); } catch (e) { __ds_ns.__errors.push({ path: "labs/TheContract.jsx", error: String((e && e.message) || e) }); }

// labs/ThePurposes.jsx
try { (() => {
// ThePurposes — a typographic bestiary of purpose codes, each with its own voice.
// This is the brand's most opinionated page: purpose as a taxonomy of intent.

const ThePurposes = () => /*#__PURE__*/React.createElement("section", {
  style: {
    padding: '96px 64px',
    borderBottom: '1px solid var(--rule)'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 1200,
    margin: '0 auto'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 64,
    alignItems: 'end',
    marginBottom: 48
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "gutter"
}, "\xA73 \xB7 PURPOSES"), /*#__PURE__*/React.createElement("h2", {
  className: "t-section",
  style: {
    margin: '12px 0 0'
  }
}, "Every grant ", /*#__PURE__*/React.createElement("em", null, "states why"), ".")), /*#__PURE__*/React.createElement("p", {
  className: "t-body",
  style: {
    margin: 0
  }
}, "A ", /*#__PURE__*/React.createElement("span", {
  className: "chip chip-protocol"
}, "purpose_code"), " is a machine-readable commitment. The spec ships five canonical purposes; implementations may extend them, but the shape \u2014 verb, object, scope \u2014 never changes.")), /*#__PURE__*/React.createElement(PurposeTaxonomy, null), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 48,
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 48,
    alignItems: 'start'
  }
}, /*#__PURE__*/React.createElement(SpecRow, {
  num: "3.1",
  t: "Purpose is declared, not enforced.",
  tone: "protocol"
}, "The protocol does not police downstream use \u2014 it records the commitment. Policing is the job of courts, auditors, and reputation markets. The record is what makes those possible."), /*#__PURE__*/React.createElement(SpecRow, {
  num: "3.2",
  t: "A purpose cannot be silently broadened.",
  tone: "human"
}, "Changing a purpose on an existing grant requires re-consent. The old grant revokes, a new grant issues, the new purpose appears in its own signed artifact. Purposes do not drift."))));
window.ThePurposes = ThePurposes;
})(); } catch (e) { __ds_ns.__errors.push({ path: "labs/ThePurposes.jsx", error: String((e && e.message) || e) }); }

// labs/TheSpecimen.jsx
try { (() => {
// TheSpecimen — the type system shown as a specimen page, in the way a foundry would.

const TheSpecimen = () => /*#__PURE__*/React.createElement("section", {
  style: {
    padding: '96px 64px',
    borderBottom: '1px solid var(--rule)'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 1200,
    margin: '0 auto'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: '280px 1fr',
    gap: 48
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "gutter"
}, "\xA76 \xB7 SPECIMEN"), /*#__PURE__*/React.createElement("h2", {
  className: "t-section",
  style: {
    margin: '12px 0 0',
    fontSize: 38
  }
}, "Three faces, one voice."), /*#__PURE__*/React.createElement("p", {
  className: "t-body",
  style: {
    marginTop: 16
  }
}, "A serif speaks for the protocol. A sans-serif speaks for the person. A monospace speaks for the machine. All three share a paper."), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 40,
    display: 'flex',
    flexDirection: 'column',
    gap: 24
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "gutter"
}, "DISPLAY"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    marginTop: 4,
    color: 'var(--ink)'
  }
}, "Fraunces"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    color: 'var(--ink-faint)'
  }
}, "opsz 144 \xB7 wght 300\u2013500")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "gutter"
}, "TEXT"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    marginTop: 4,
    color: 'var(--ink)'
  }
}, "Geist"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    color: 'var(--ink-faint)'
  }
}, "wght 300\u2013600")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "gutter"
}, "MACHINE"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    marginTop: 4,
    color: 'var(--ink)'
  }
}, "JetBrains Mono"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    color: 'var(--ink-faint)'
  }
}, "tnum, cv02, ss01")))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  style: {
    borderTop: '1px solid var(--rule-deep)',
    borderBottom: '1px solid var(--rule)',
    padding: '32px 0',
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between'
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-serif)',
    fontSize: 200,
    lineHeight: 1,
    fontWeight: 300,
    letterSpacing: '-0.05em',
    fontVariationSettings: '"opsz" 144'
  }
}, "Aa"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-serif)',
    fontSize: 200,
    lineHeight: 1,
    fontStyle: 'italic',
    fontWeight: 400,
    letterSpacing: '-0.04em',
    color: 'var(--human)',
    fontVariationSettings: '"opsz" 144'
  }
}, "Aa"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-sans)',
    fontSize: 200,
    lineHeight: 1,
    fontWeight: 500,
    letterSpacing: '-0.05em'
  }
}, "Aa"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 160,
    lineHeight: 1,
    fontWeight: 400,
    color: 'var(--protocol)'
  }
}, "Aa")), /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '32px 0',
    borderBottom: '1px solid var(--rule)'
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "gutter"
}, "PANGRAM \xB7 serif / italic / sans / mono"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-serif)',
    fontSize: 32,
    lineHeight: 1.2,
    marginTop: 12,
    fontWeight: 400,
    fontVariationSettings: '"opsz" 72'
  }
}, "The grant is the artifact, not the key."), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-serif)',
    fontSize: 32,
    lineHeight: 1.2,
    fontStyle: 'italic',
    fontWeight: 300,
    color: 'var(--human)',
    fontVariationSettings: '"opsz" 72'
  }
}, "The holder decides what may be read, and why."), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-sans)',
    fontSize: 22,
    lineHeight: 1.5,
    marginTop: 12,
    color: 'var(--ink-soft)'
  }
}, "Clients request named records and fields. Every response stays inside the grant."), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    lineHeight: 1.6,
    marginTop: 12,
    color: 'var(--protocol)'
  }
}, "GET /v1/streams/pay_statements/records \xA0\xB7\xA0 grant_id=grt_longview01 \xA0\xB7\xA0 200 OK")), /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '32px 0',
    borderBottom: '1px solid var(--rule)'
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "gutter"
}, "LEDGER \xB7 tabular figures \xB7 mono + serif"), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 48,
    marginTop: 16
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "num",
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 22,
    lineHeight: 1.5,
    color: 'var(--ink)'
  }
}, /*#__PURE__*/React.createElement("div", null, "2025-10-14  09:22:07Z"), /*#__PURE__*/React.createElement("div", null, "2025-10-28  09:22:07Z"), /*#__PURE__*/React.createElement("div", null, "2025-11-11  09:22:07Z"), /*#__PURE__*/React.createElement("div", {
  style: {
    color: 'var(--voided)'
  }
}, "2025-11-25  14:08:02Z  \u2715")), /*#__PURE__*/React.createElement("div", {
  className: "num",
  style: {
    fontFamily: 'var(--font-serif)',
    fontSize: 22,
    lineHeight: 1.5,
    color: 'var(--ink)',
    fontVariationSettings: '"opsz" 72, "tnum"',
    fontFeatureSettings: '"tnum"'
  }
}, /*#__PURE__*/React.createElement("div", null, "$4,812.50 \xA0 gross"), /*#__PURE__*/React.createElement("div", null, "$3,622.18 \xA0 net"), /*#__PURE__*/React.createElement("div", null, "$1,190.32 \xA0 withheld"), /*#__PURE__*/React.createElement("div", {
  style: {
    color: 'var(--human)',
    fontStyle: 'italic'
  }
}, "\u2014 every fortnight"))))))));
window.TheSpecimen = TheSpecimen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "labs/TheSpecimen.jsx", error: String((e && e.message) || e) }); }

// labs/ThermalField.jsx
try { (() => {
// The two additional hero moments — the overture and the manifesto

// ThermalField — an atmospheric opening. The thermal gradient as page-sized presence.
const ThermalField = () => /*#__PURE__*/React.createElement("section", {
  style: {
    position: 'relative',
    padding: '44px 64px 72px',
    borderBottom: '1px solid var(--rule)',
    overflow: 'hidden'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    background: `
        radial-gradient(ellipse 900px 400px at 20% 30%, var(--human-wash), transparent 60%),
        radial-gradient(ellipse 1000px 500px at 85% 70%, var(--protocol-wash), transparent 60%)
      `
  }
}), /*#__PURE__*/React.createElement("header", {
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    position: 'relative',
    zIndex: 1
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 14
  }
}, /*#__PURE__*/React.createElement(MarkP, {
  size: 28
}), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-serif)',
    fontSize: 17,
    letterSpacing: '-0.015em',
    lineHeight: 1
  }
}, "Personal Data Portability Protocol"), /*#__PURE__*/React.createElement("div", {
  className: "gutter",
  style: {
    marginTop: 3
  }
}, "v0.1.0 \xB7 draft 3 \xB7 2026-04-19"))), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 10
  }
}, /*#__PURE__*/React.createElement("a", {
  href: "#",
  className: "gutter",
  style: {
    color: 'var(--ink-soft)',
    textDecoration: 'none'
  }
}, "spec"), /*#__PURE__*/React.createElement("a", {
  href: "#",
  className: "gutter",
  style: {
    color: 'var(--ink-soft)',
    textDecoration: 'none'
  }
}, "reference"), /*#__PURE__*/React.createElement("a", {
  href: "#",
  className: "gutter",
  style: {
    color: 'var(--ink-soft)',
    textDecoration: 'none'
  }
}, "errata"), /*#__PURE__*/React.createElement("span", {
  style: {
    width: 1,
    height: 14,
    background: 'var(--rule-deep)',
    margin: '0 4px'
  }
}), /*#__PURE__*/React.createElement(NightToggle, null))), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: '180px 1fr 180px',
    alignItems: 'center',
    gap: 40,
    position: 'relative',
    zIndex: 1,
    marginTop: 72
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    borderLeft: '2px solid var(--human)',
    paddingLeft: 16
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "gutter",
  style: {
    color: 'var(--human)'
  }
}, "HOLDER"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    marginTop: 6,
    color: 'var(--ink)'
  }
}, "you"), /*#__PURE__*/React.createElement("div", {
  className: "t-small",
  style: {
    marginTop: 2,
    fontStyle: 'italic',
    fontFamily: 'var(--font-serif)'
  }
}, "your data, your terms")), /*#__PURE__*/React.createElement("h1", {
  className: "t-display",
  style: {
    margin: 0,
    textAlign: 'center'
  }
}, "The grant is the ", /*#__PURE__*/React.createElement("em", null, "artifact,"), /*#__PURE__*/React.createElement("br", null), "not the ", /*#__PURE__*/React.createElement("span", {
  style: {
    color: 'var(--protocol)'
  }
}, "key"), "."), /*#__PURE__*/React.createElement("div", {
  style: {
    borderRight: '2px solid var(--protocol)',
    paddingRight: 16,
    textAlign: 'right'
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "gutter",
  style: {
    color: 'var(--protocol)'
  }
}, "ISSUER"), /*#__PURE__*/React.createElement("div", {
  className: "t-mono",
  style: {
    marginTop: 6,
    color: 'var(--ink)'
  }
}, "the server"), /*#__PURE__*/React.createElement("div", {
  className: "t-small",
  style: {
    marginTop: 2,
    fontStyle: 'italic',
    fontFamily: 'var(--font-serif)'
  }
}, "boundary, not barrier"))), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 56,
    height: 1,
    background: 'var(--thermal)',
    opacity: 0.5,
    position: 'relative',
    zIndex: 1
  }
}), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    alignItems: 'end',
    gap: 48,
    marginTop: 40,
    position: 'relative',
    zIndex: 1
  }
}, /*#__PURE__*/React.createElement("p", {
  className: "t-lede",
  style: {
    margin: 0,
    maxWidth: 620
  }
}, "An open specification for how personal user data flows through the digital economy under ", /*#__PURE__*/React.createElement("span", {
  style: {
    color: 'var(--ink)'
  }
}, "authorization-first, purpose-bound"), " access. Clients request named records and fields. Every response stays inside the grant."), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 10,
    alignItems: 'center'
  }
}, /*#__PURE__*/React.createElement("button", {
  className: "btn btn-ink"
}, "Read the spec \u2192"), /*#__PURE__*/React.createElement("button", {
  className: "btn btn-paper"
}, "Reference implementation"))));
window.ThermalField = ThermalField;
})(); } catch (e) { __ds_ns.__errors.push({ path: "labs/ThermalField.jsx", error: String((e && e.message) || e) }); }

// recordroom/image-slot.js
try { (() => {
// @ds-adherence-ignore -- omelette starter scaffold (raw elements/hex/px by design)
/* BEGIN USAGE */
/**
 * <image-slot> — user-fillable image placeholder.
 *
 * Drop this into a deck, mockup, or page wherever you want the user to
 * supply an image. You control the slot's shape and size; the user fills it
 * by dragging an image file onto it (or clicking to browse). The dropped
 * image persists across reloads via a .image-slots.state.json sidecar —
 * same read-via-fetch / write-via-window.omelette pattern as
 * design_canvas.jsx, so the filled slot shows on share links, downloaded
 * zips, and PPTX export. Outside the omelette runtime the slot is read-only.
 *
 * The host bridge only allows sidecar writes at the project root, so the
 * HTML that uses this component is assumed to live at the project root too
 * (same constraint as design_canvas.jsx).
 *
 * Attributes:
 *   id           Persistence key. REQUIRED for the drop to survive reload —
 *                every slot on the page needs a distinct id.
 *   shape        'rect' | 'rounded' | 'circle' | 'pill'   (default 'rounded')
 *                'circle' applies 50% border-radius; on a non-square slot
 *                that's an ellipse — set equal width and height for a true
 *                circle.
 *   radius       Corner radius in px for 'rounded'.       (default 12)
 *   mask         Any CSS clip-path value. Overrides `shape` — use this for
 *                hexagons, blobs, arbitrary polygons.
 *   fit          object-fit: cover | contain | fill.       (default 'cover')
 *                With cover (the default) double-clicking the filled slot
 *                enters a reframe mode: the whole image spills past the mask
 *                (translucent outside, opaque inside), drag to reposition,
 *                corner-drag to scale. The crop persists alongside the image
 *                in the sidecar. contain/fill stay static.
 *   position     object-position for fit=contain|fill.     (default '50% 50%')
 *   placeholder  Empty-state caption.                      (default 'Drop an image')
 *   src          Optional initial/fallback image URL. A user drop overrides
 *                it; clearing the drop reveals src again.
 *
 * Size and layout come from ordinary CSS on the element — width/height
 * inline or from a parent grid — so it composes with any layout.
 *
 * Usage:
 *   <image-slot id="hero"   style="width:800px;height:450px" shape="rounded" radius="20"
 *               placeholder="Drop a hero image"></image-slot>
 *   <image-slot id="avatar" style="width:120px;height:120px" shape="circle"></image-slot>
 *   <image-slot id="kite"   style="width:300px;height:300px"
 *               mask="polygon(50% 0, 100% 50%, 50% 100%, 0 50%)"></image-slot>
 */
/* END USAGE */

(() => {
  const STATE_FILE = '.image-slots.state.json';
  // 2× a ~600px slot in a 1920-wide deck — retina-sharp without making the
  // sidecar enormous. A 1200px WebP at q=0.85 is ~150-300KB.
  const MAX_DIM = 1200;
  // Raster formats only. SVG is excluded (can carry script; createImageBitmap
  // on SVG blobs is inconsistent). GIF is excluded because the canvas
  // re-encode keeps only the first frame, so an animated GIF would silently
  // go still — better to reject than surprise.
  const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'];

  // ── Shared sidecar store ────────────────────────────────────────────────
  // One fetch + immediate write-on-change for every <image-slot> on the
  // page. Reads via fetch() so viewing works anywhere the HTML and sidecar
  // are served together; writes go through window.omelette.writeFile, which
  // the host allowlists to *.state.json basenames only.
  const subs = new Set();
  let slots = {};
  // ids explicitly cleared before the sidecar fetch resolved — otherwise
  // the merge below can't tell "never set" from "just deleted" and would
  // resurrect the sidecar's stale value.
  const tombstones = new Set();
  let loaded = false;
  let loadP = null;
  function load() {
    if (loadP) return loadP;
    loadP = fetch(STATE_FILE).then(r => r.ok ? r.json() : null).then(j => {
      // Merge: sidecar loses to any in-memory change that raced ahead of
      // the fetch (drop or clear) so neither is clobbered by hydration.
      if (j && typeof j === 'object') {
        const merged = Object.assign({}, j, slots);
        // A framing-only write that raced ahead of hydration must not
        // drop a user image that's only on disk — inherit u from the
        // sidecar for any in-memory entry that lacks one.
        for (const k in slots) {
          if (merged[k] && !merged[k].u && j[k]) {
            merged[k].u = typeof j[k] === 'string' ? j[k] : j[k].u;
          }
        }
        for (const id of tombstones) delete merged[id];
        slots = merged;
      }
      tombstones.clear();
    }).catch(() => {}).then(() => {
      loaded = true;
      subs.forEach(fn => fn());
    });
    return loadP;
  }

  // Serialize writes so two near-simultaneous drops on different slots
  // can't reorder at the backend and leave the sidecar with only the
  // first. A save requested mid-flight just marks dirty and re-fires on
  // completion with the then-current slots.
  let saving = false;
  let saveDirty = false;
  function save() {
    if (saving) {
      saveDirty = true;
      return;
    }
    const w = window.omelette && window.omelette.writeFile;
    if (!w) return;
    saving = true;
    Promise.resolve(w(STATE_FILE, JSON.stringify(slots))).catch(() => {}).then(() => {
      saving = false;
      if (saveDirty) {
        saveDirty = false;
        save();
      }
    });
  }
  const S_MAX = 5;
  const clampS = s => Math.max(1, Math.min(S_MAX, s));

  // Normalize a stored slot value. Pre-reframe sidecars stored a bare
  // data-URL string; newer ones store {u, s, x, y}. Either shape is valid.
  function getSlot(id) {
    const v = slots[id];
    if (!v) return null;
    return typeof v === 'string' ? {
      u: v,
      s: 1,
      x: 0,
      y: 0
    } : v;
  }
  function setSlot(id, val) {
    if (!id) return;
    if (val) {
      slots[id] = val;
      tombstones.delete(id);
    } else {
      delete slots[id];
      if (!loaded) tombstones.add(id);
    }
    subs.forEach(fn => fn());
    // A drop is rare + high-value — write immediately so nav-away can't lose
    // it. Gate on the initial read so we don't overwrite a sidecar we haven't
    // merged yet; the merge in load() keeps this change once the read lands.
    if (loaded) save();else load().then(save);
  }

  // ── Image downscale ─────────────────────────────────────────────────────
  // Encode through a canvas so the sidecar carries resized bytes, not the
  // raw upload. Longest side is capped at 2× the slot's rendered width
  // (retina) and at MAX_DIM. WebP keeps alpha and is ~10× smaller than PNG
  // for photos, so there's no need for per-image format picking.
  async function toDataUrl(file, targetW) {
    const bitmap = await createImageBitmap(file);
    try {
      const cap = Math.min(MAX_DIM, Math.max(1, Math.round(targetW * 2)) || MAX_DIM);
      const scale = Math.min(1, cap / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      return canvas.toDataURL('image/webp', 0.85);
    } finally {
      bitmap.close && bitmap.close();
    }
  }

  // ── Custom element ──────────────────────────────────────────────────────
  const stylesheet = ':host{display:inline-block;position:relative;vertical-align:top;' + '  font:13px/1.3 system-ui,-apple-system,sans-serif;color:rgba(0,0,0,.55);width:240px;height:160px}' + '.frame{position:absolute;inset:0;overflow:hidden;background:rgba(0,0,0,.04)}' +
  // .frame img (clipped) and .spill (unclipped ghost + handles) share the
  // same left/top/width/height in frame-%, computed by _applyView(), so the
  // inside-mask crop and the outside-mask spill stay pixel-aligned.
  '.frame img{position:absolute;max-width:none;transform:translate(-50%,-50%);' + '  -webkit-user-drag:none;user-select:none;touch-action:none}' +
  // Reframe mode (double-click): the full image spills past the mask. The
  // spill layer is sized to the IMAGE bounds so its corners are where the
  // resize handles belong. The ghost <img> inside is translucent; the real
  // clipped <img> underneath shows the opaque in-mask crop.
  '.spill{position:absolute;transform:translate(-50%,-50%);display:none;z-index:1;' + '  cursor:grab;touch-action:none}' + ':host([data-panning]) .spill{cursor:grabbing}' + '.spill .ghost{position:absolute;inset:0;width:100%;height:100%;opacity:.35;' + '  pointer-events:none;-webkit-user-drag:none;user-select:none;' + '  box-shadow:0 0 0 1px rgba(0,0,0,.2),0 12px 32px rgba(0,0,0,.2)}' + '.spill .handle{position:absolute;width:12px;height:12px;border-radius:50%;' + '  background:#fff;box-shadow:0 0 0 1.5px #c96442,0 1px 3px rgba(0,0,0,.3);' + '  transform:translate(-50%,-50%)}' + '.spill .handle[data-c=nw]{left:0;top:0;cursor:nwse-resize}' + '.spill .handle[data-c=ne]{left:100%;top:0;cursor:nesw-resize}' + '.spill .handle[data-c=sw]{left:0;top:100%;cursor:nesw-resize}' + '.spill .handle[data-c=se]{left:100%;top:100%;cursor:nwse-resize}' + ':host([data-reframe]){z-index:10}' + ':host([data-reframe]) .spill{display:block}' + ':host([data-reframe]) .frame{box-shadow:0 0 0 2px #c96442}' + '.empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' + '  justify-content:center;gap:6px;text-align:center;padding:12px;box-sizing:border-box;' + '  cursor:pointer;user-select:none}' + '.empty svg{opacity:.45}' + '.empty .cap{max-width:90%;font-weight:500;letter-spacing:.01em}' + '.empty .sub{font-size:11px}' + '.empty .sub u{text-underline-offset:2px;text-decoration-color:rgba(0,0,0,.25)}' + '.empty:hover .sub u{color:rgba(0,0,0,.75);text-decoration-color:currentColor}' + ':host([data-over]) .frame{outline:2px solid #c96442;outline-offset:-2px;' + '  background:rgba(201,100,66,.10)}' + '.ring{position:absolute;inset:0;pointer-events:none;border:1.5px dashed rgba(0,0,0,.25);' + '  transition:border-color .12s}' + ':host([data-over]) .ring{border-color:#c96442}' + ':host([data-filled]) .ring{display:none}' +
  // Controls sit BELOW the mask (top:100%), absolutely positioned so the
  // author-declared slot height is unaffected. The gap is padding, not a
  // top offset, so the hover target stays contiguous with the frame.
  '.ctl{position:absolute;top:100%;left:50%;transform:translateX(-50%);padding-top:8px;' + '  display:flex;gap:6px;opacity:0;pointer-events:none;transition:opacity .12s;z-index:2;' + '  white-space:nowrap}' + ':host([data-filled][data-editable]:hover) .ctl,:host([data-reframe]) .ctl' + '  {opacity:1;pointer-events:auto}' + '.ctl button{appearance:none;border:0;border-radius:6px;padding:5px 10px;cursor:pointer;' + '  background:rgba(0,0,0,.65);color:#fff;font:11px/1 system-ui,-apple-system,sans-serif;' + '  backdrop-filter:blur(6px)}' + '.ctl button:hover{background:rgba(0,0,0,.8)}' + '.err{position:absolute;left:8px;bottom:8px;right:8px;color:#b3261e;font-size:11px;' + '  background:rgba(255,255,255,.85);padding:4px 6px;border-radius:5px;pointer-events:none}';
  const icon = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' + 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>' + '<path d="m21 15-5-5L5 21"/></svg>';
  class ImageSlot extends HTMLElement {
    static get observedAttributes() {
      return ['shape', 'radius', 'mask', 'fit', 'position', 'placeholder', 'src', 'id'];
    }
    constructor() {
      super();
      const root = this.attachShadow({
        mode: 'open'
      });
      // .spill and .ctl sit OUTSIDE .frame so overflow:hidden + border-radius
      // on the frame (circle, pill, rounded) can't clip them.
      root.innerHTML = '<style>' + stylesheet + '</style>' + '<div class="frame" part="frame">' + '  <img part="image" alt="" draggable="false" style="display:none">' + '  <div class="empty" part="empty">' + icon + '    <div class="cap"></div>' + '    <div class="sub">or <u>browse files</u></div></div>' + '  <div class="ring" part="ring"></div>' + '</div>' + '<div class="spill">' + '  <img class="ghost" alt="" draggable="false">' + '  <div class="handle" data-c="nw"></div><div class="handle" data-c="ne"></div>' + '  <div class="handle" data-c="sw"></div><div class="handle" data-c="se"></div>' + '</div>' + '<div class="ctl"><button data-act="replace" title="Replace image">Replace</button>' + '  <button data-act="clear" title="Remove image">Remove</button></div>' + '<input type="file" accept="' + ACCEPT.join(',') + '" hidden>';
      this._frame = root.querySelector('.frame');
      this._ring = root.querySelector('.ring');
      this._img = root.querySelector('.frame img');
      this._empty = root.querySelector('.empty');
      this._cap = root.querySelector('.cap');
      this._sub = root.querySelector('.sub');
      this._spill = root.querySelector('.spill');
      this._ghost = root.querySelector('.ghost');
      this._err = null;
      this._input = root.querySelector('input');
      this._depth = 0;
      this._gen = 0;
      this._view = {
        s: 1,
        x: 0,
        y: 0
      };
      this._subFn = () => this._render();
      // Shadow-DOM listeners live with the shadow DOM — bound once here so
      // disconnect/reconnect (e.g. React remount) doesn't stack handlers.
      this._empty.addEventListener('click', () => this._input.click());
      root.addEventListener('click', e => {
        const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'replace') {
          this._exitReframe(true);
          this._input.click();
        }
        if (act === 'clear') {
          this._exitReframe(false);
          this._gen++;
          this._local = null;
          if (this.id) setSlot(this.id, null);else this._render();
        }
      });
      this._input.addEventListener('change', () => {
        const f = this._input.files && this._input.files[0];
        if (f) this._ingest(f);
        this._input.value = '';
      });
      // naturalWidth/Height aren't known until load — re-apply so the cover
      // baseline is computed from real dimensions, not the 100%×100% fallback.
      this._img.addEventListener('load', () => this._applyView());
      // Gated on editable + fit=cover so share links and contain/fill slots
      // stay static.
      this.addEventListener('dblclick', e => {
        if (!this.hasAttribute('data-editable') || !this._reframes()) return;
        e.preventDefault();
        if (this.hasAttribute('data-reframe')) this._exitReframe(true);else this._enterReframe();
      });
      // Pan + resize both originate on the spill layer. A handle pointerdown
      // drives an aspect-locked resize anchored at the opposite corner; any
      // other pointerdown on the spill pans. Offsets are frame-% so a
      // reframed slot survives responsive resize / PPTX export.
      this._spill.addEventListener('pointerdown', e => {
        if (e.button !== 0 || !this.hasAttribute('data-reframe')) return;
        e.preventDefault();
        e.stopPropagation();
        this._spill.setPointerCapture(e.pointerId);
        const rect = this.getBoundingClientRect();
        const fw = rect.width || 1,
          fh = rect.height || 1;
        const corner = e.target.getAttribute && e.target.getAttribute('data-c');
        let move;
        if (corner) {
          // Resize about the OPPOSITE corner. Viewport-px throughout (rect
          // fw/fh, not clientWidth) so the math survives a transform:scale()
          // ancestor — deck_stage renders slides scaled-to-fit.
          const iw = this._img.naturalWidth || 1,
            ih = this._img.naturalHeight || 1;
          const base = Math.max(fw / iw, fh / ih);
          const sx = corner.includes('e') ? 1 : -1;
          const sy = corner.includes('s') ? 1 : -1;
          const s0 = this._view.s;
          const w0 = iw * base * s0,
            h0 = ih * base * s0;
          const cx0 = (50 + this._view.x) / 100 * fw;
          const cy0 = (50 + this._view.y) / 100 * fh;
          const ox = cx0 - sx * w0 / 2,
            oy = cy0 - sy * h0 / 2;
          const diag0 = Math.hypot(w0, h0);
          const ux = sx * w0 / diag0,
            uy = sy * h0 / diag0;
          move = ev => {
            const proj = (ev.clientX - rect.left - ox) * ux + (ev.clientY - rect.top - oy) * uy;
            const s = clampS(s0 * proj / diag0);
            const d = diag0 * s / s0;
            this._view.s = s;
            this._view.x = (ox + ux * d / 2) / fw * 100 - 50;
            this._view.y = (oy + uy * d / 2) / fh * 100 - 50;
            this._clampView();
            this._applyView();
          };
        } else {
          this.setAttribute('data-panning', '');
          const start = {
            px: e.clientX,
            py: e.clientY,
            x: this._view.x,
            y: this._view.y
          };
          move = ev => {
            this._view.x = start.x + (ev.clientX - start.px) / fw * 100;
            this._view.y = start.y + (ev.clientY - start.py) / fh * 100;
            this._clampView();
            this._applyView();
          };
        }
        const up = () => {
          try {
            this._spill.releasePointerCapture(e.pointerId);
          } catch {}
          this._spill.removeEventListener('pointermove', move);
          this._spill.removeEventListener('pointerup', up);
          this._spill.removeEventListener('pointercancel', up);
          this.removeAttribute('data-panning');
          this._dragUp = null;
        };
        // Stashed so _exitReframe (Escape / outside-click mid-drag) can
        // tear the capture + listeners down synchronously.
        this._dragUp = up;
        this._spill.addEventListener('pointermove', move);
        this._spill.addEventListener('pointerup', up);
        this._spill.addEventListener('pointercancel', up);
      });
      // Wheel zoom stays available inside reframe mode as a trackpad nicety —
      // zooms toward the cursor (offset' = cursor·(1-k) + offset·k).
      this.addEventListener('wheel', e => {
        if (!this.hasAttribute('data-reframe')) return;
        e.preventDefault();
        const r = this.getBoundingClientRect();
        const cx = (e.clientX - r.left) / r.width * 100 - 50;
        const cy = (e.clientY - r.top) / r.height * 100 - 50;
        const prev = this._view.s;
        const next = clampS(prev * Math.pow(1.0015, -e.deltaY));
        if (next === prev) return;
        const k = next / prev;
        this._view.s = next;
        this._view.x = cx * (1 - k) + this._view.x * k;
        this._view.y = cy * (1 - k) + this._view.y * k;
        this._clampView();
        this._applyView();
      }, {
        passive: false
      });
    }
    connectedCallback() {
      // Warn once per page — an id-less slot works for the session but
      // cannot persist, and two id-less slots would share nothing.
      if (!this.id && !ImageSlot._warned) {
        ImageSlot._warned = true;
        console.warn('<image-slot> without an id will not persist its dropped image.');
      }
      this.addEventListener('dragenter', this);
      this.addEventListener('dragover', this);
      this.addEventListener('dragleave', this);
      this.addEventListener('drop', this);
      subs.add(this._subFn);
      // width%/height% in _applyView encode the frame aspect at call time —
      // a host resize (responsive grid, pane divider) would stretch the
      // image until the next _render. Re-render on size change: _render()
      // re-seeds _view from stored before clamp/apply, so a shrink→grow
      // cycle round-trips instead of ratcheting x/y toward the narrower
      // frame's clamp range.
      this._ro = new ResizeObserver(() => this._render());
      this._ro.observe(this);
      load();
      this._render();
    }
    disconnectedCallback() {
      subs.delete(this._subFn);
      this.removeEventListener('dragenter', this);
      this.removeEventListener('dragover', this);
      this.removeEventListener('dragleave', this);
      this.removeEventListener('drop', this);
      if (this._ro) {
        this._ro.disconnect();
        this._ro = null;
      }
      this._exitReframe(false);
    }
    _enterReframe() {
      if (this.hasAttribute('data-reframe')) return;
      this.setAttribute('data-reframe', '');
      this._applyView();
      // Close on click outside (the spill handler stopPropagation()s so
      // in-image drags don't reach this) and on Escape. Listeners are held
      // on the instance so _exitReframe / disconnectedCallback can detach
      // exactly what was attached.
      this._outside = e => {
        if (e.composedPath && e.composedPath().includes(this)) return;
        this._exitReframe(true);
      };
      this._esc = e => {
        if (e.key === 'Escape') this._exitReframe(true);
      };
      document.addEventListener('pointerdown', this._outside, true);
      document.addEventListener('keydown', this._esc, true);
    }
    _exitReframe(commit) {
      if (!this.hasAttribute('data-reframe')) return;
      if (this._dragUp) this._dragUp();
      this.removeAttribute('data-reframe');
      this.removeAttribute('data-panning');
      if (this._outside) document.removeEventListener('pointerdown', this._outside, true);
      if (this._esc) document.removeEventListener('keydown', this._esc, true);
      this._outside = this._esc = null;
      if (commit) this._commitView();
    }
    attributeChangedCallback() {
      if (this.shadowRoot) this._render();
    }

    // handleEvent — one listener object for all four drag events keeps the
    // add/remove symmetric and the depth counter correct.
    handleEvent(e) {
      if (e.type === 'dragenter' || e.type === 'dragover') {
        // Without preventDefault the browser never fires 'drop'.
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        if (e.type === 'dragenter') this._depth++;
        this.setAttribute('data-over', '');
      } else if (e.type === 'dragleave') {
        // dragenter/leave fire for every descendant crossing — count depth
        // so hovering the icon inside the empty state doesn't flicker.
        if (--this._depth <= 0) {
          this._depth = 0;
          this.removeAttribute('data-over');
        }
      } else if (e.type === 'drop') {
        e.preventDefault();
        e.stopPropagation();
        this._depth = 0;
        this.removeAttribute('data-over');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this._ingest(f);
      }
    }
    async _ingest(file) {
      this._setError(null);
      if (!file || ACCEPT.indexOf(file.type) < 0) {
        this._setError('Drop a PNG, JPEG, WebP, or AVIF image.');
        return;
      }
      // toDataUrl can take hundreds of ms on a large photo. A Clear or a
      // newer drop during that window would be clobbered when this await
      // resumes — bump + capture a generation so stale encodes bail.
      const gen = ++this._gen;
      try {
        const w = this.clientWidth || this.offsetWidth || MAX_DIM;
        const url = await toDataUrl(file, w);
        if (gen !== this._gen) return;
        // Only exit reframe once the new image is in hand — a rejected type
        // or decode failure leaves the in-progress crop untouched.
        this._exitReframe(false);
        const val = {
          u: url,
          s: 1,
          x: 0,
          y: 0
        };
        setSlot(this.id || '', val);
        // Keep a session-local copy for id-less slots so the drop still
        // shows, even though it cannot persist.
        if (!this.id) {
          this._local = val;
          this._render();
        }
      } catch (err) {
        if (gen !== this._gen) return;
        this._setError('Could not read that image.');
        console.warn('<image-slot> ingest failed:', err);
      }
    }
    _setError(msg) {
      if (this._err) {
        this._err.remove();
        this._err = null;
      }
      if (!msg) return;
      const d = document.createElement('div');
      d.className = 'err';
      d.textContent = msg;
      this.shadowRoot.appendChild(d);
      this._err = d;
      setTimeout(() => {
        if (this._err === d) {
          d.remove();
          this._err = null;
        }
      }, 3000);
    }

    // Reframing (pan/resize) is only meaningful for fit=cover — contain/fill
    // keep the old object-fit path and double-click is a no-op.
    _reframes() {
      return this.hasAttribute('data-filled') && (this.getAttribute('fit') || 'cover') === 'cover';
    }

    // Cover-baseline geometry, shared by clamp/apply/resize. Null until the
    // img has loaded (naturalWidth is 0 before that) or when the slot has no
    // layout box — ResizeObserver fires with a 0×0 rect under display:none,
    // and clamping against a degenerate 1×1 frame would silently pull the
    // stored pan toward zero.
    _geom() {
      const iw = this._img.naturalWidth,
        ih = this._img.naturalHeight;
      const fw = this.clientWidth,
        fh = this.clientHeight;
      if (!iw || !ih || !fw || !fh) return null;
      return {
        iw,
        ih,
        fw,
        fh,
        base: Math.max(fw / iw, fh / ih)
      };
    }
    _clampView() {
      // Pan range on each axis is half the overflow past the frame edge.
      const g = this._geom();
      if (!g) return;
      const mx = Math.max(0, (g.iw * g.base * this._view.s / g.fw - 1) * 50);
      const my = Math.max(0, (g.ih * g.base * this._view.s / g.fh - 1) * 50);
      this._view.x = Math.max(-mx, Math.min(mx, this._view.x));
      this._view.y = Math.max(-my, Math.min(my, this._view.y));
    }
    _applyView() {
      const g = this._geom();
      const fit = this.getAttribute('fit') || 'cover';
      if (fit !== 'cover' || !g) {
        // Non-cover, or dimensions not known yet (before img load).
        this._img.style.width = '100%';
        this._img.style.height = '100%';
        this._img.style.left = '50%';
        this._img.style.top = '50%';
        this._img.style.objectFit = fit;
        this._img.style.objectPosition = this.getAttribute('position') || '50% 50%';
        return;
      }
      // Cover baseline: img fills the frame on its tighter axis at s=1, so
      // pan works immediately on the overflowing axis without zooming first.
      // Width/height and left/top are all frame-% — depends only on the
      // frame aspect ratio, so a responsive resize keeps the same crop. The
      // spill layer mirrors the same box so its corners = image corners.
      const k = g.base * this._view.s;
      const w = g.iw * k / g.fw * 100 + '%';
      const h = g.ih * k / g.fh * 100 + '%';
      const l = 50 + this._view.x + '%';
      const t = 50 + this._view.y + '%';
      this._img.style.width = w;
      this._img.style.height = h;
      this._img.style.left = l;
      this._img.style.top = t;
      this._img.style.objectFit = '';
      this._spill.style.width = w;
      this._spill.style.height = h;
      this._spill.style.left = l;
      this._spill.style.top = t;
    }
    _commitView() {
      const v = {
        s: this._view.s,
        x: this._view.x,
        y: this._view.y
      };
      if (this._userUrl) v.u = this._userUrl;
      // Framing-only (no u) persists too so an author-src slot remembers its
      // crop; clearing the sidecar still falls through to src=.
      if (this.id) setSlot(this.id, v);else {
        this._local = v;
      }
    }
    _render() {
      // Shape / mask. Presets use border-radius so the dashed ring can
      // follow the rounded outline; clip-path is only applied for an
      // explicit `mask` (the ring is hidden there since a rectangle
      // dashed border chopped by an arbitrary polygon looks broken).
      const mask = this.getAttribute('mask');
      const shape = (this.getAttribute('shape') || 'rounded').toLowerCase();
      let radius = '';
      if (shape === 'circle') radius = '50%';else if (shape === 'pill') radius = '9999px';else if (shape === 'rounded') {
        const n = parseFloat(this.getAttribute('radius'));
        radius = (Number.isFinite(n) ? n : 12) + 'px';
      }
      this._frame.style.borderRadius = mask ? '' : radius;
      this._frame.style.clipPath = mask || '';
      this._ring.style.borderRadius = mask ? '' : radius;
      this._ring.style.display = mask ? 'none' : '';

      // Controls and reframe entry gate on this so share links stay read-only.
      const editable = !!(window.omelette && window.omelette.writeFile);
      this.toggleAttribute('data-editable', editable);
      this._sub.style.display = editable ? '' : 'none';

      // Content. The sidecar is also writable by the agent's write_file
      // tool, so its value isn't guaranteed canvas-originated — only accept
      // data:image/ URLs from it. The `src` attribute is author-controlled
      // (Claude wrote it into the HTML) so it passes through unchanged.
      let stored = this.id ? getSlot(this.id) : this._local;
      if (stored && stored.u && !/^data:image\//i.test(stored.u)) stored = null;
      const srcAttr = this.getAttribute('src') || '';
      this._userUrl = stored && stored.u || null;
      const url = this._userUrl || srcAttr;
      // Don't clobber an in-flight reframe with a store-triggered re-render.
      if (!this.hasAttribute('data-reframe')) {
        this._view = {
          s: stored && Number.isFinite(stored.s) ? clampS(stored.s) : 1,
          x: stored && Number.isFinite(stored.x) ? stored.x : 0,
          y: stored && Number.isFinite(stored.y) ? stored.y : 0
        };
      }
      this._cap.textContent = this.getAttribute('placeholder') || 'Drop an image';
      // Toggle via style.display — the [hidden] attribute alone loses to
      // the display:flex / display:block rules in the stylesheet above.
      if (url) {
        if (this._img.getAttribute('src') !== url) {
          this._img.src = url;
          this._ghost.src = url;
        }
        this._img.style.display = 'block';
        this._empty.style.display = 'none';
        this.setAttribute('data-filled', '');
        this._clampView();
        this._applyView();
      } else {
        this._img.style.display = 'none';
        this._img.removeAttribute('src');
        this._ghost.removeAttribute('src');
        this._empty.style.display = 'flex';
        this.removeAttribute('data-filled');
      }
    }
  }
  if (!customElements.get('image-slot')) {
    customElements.define('image-slot', ImageSlot);
  }
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "recordroom/image-slot.js", error: String((e && e.message) || e) }); }

// recordroom/rr-app.jsx
try { (() => {
/* RECORDROOM — data + state + app shell (full console surface). */
;
(() => {
  const {
    useState,
    useEffect,
    useMemo
  } = React;
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
    TweakButton
  } = window;

  /* ─── Fixture data ─── */

  const STREAMS = [{
    id: "pay_statements",
    connector: "Northstar HR",
    records: "312",
    fields: ["employer", "period_start", "period_end", "gross_pay", "net_pay", "taxes_withheld", "benefits_detail", "bank_routing"]
  }, {
    id: "employment",
    connector: "Northstar HR",
    records: "4",
    fields: ["employer", "title", "start_date", "end_date", "manager_contact"]
  }, {
    id: "transactions",
    connector: "First Meridian",
    records: "41,203",
    fields: ["date", "amount", "merchant", "category", "account_ref", "memo"]
  }, {
    id: "listening_history",
    connector: "Tonal",
    records: "6,597",
    fields: ["track", "artist", "played_at", "device", "playlist_ref"]
  }, {
    id: "tax_docs",
    connector: "Northstar HR",
    records: "12",
    fields: ["doc_type", "tax_year", "employer", "document_blob"]
  }];
  const BASE_GRANTS = [{
    id: "grt_lngvw_01",
    client: "Longview Planning",
    purpose: "long_term_financial_planning",
    scopes: [{
      name: "pay_statements.read",
      terms: "append only · 2 yrs"
    }, {
      name: "employment.read",
      terms: "current + 5 yrs"
    }],
    declined: ["tax_docs.read"],
    status: "active",
    issued: "2025-10-14 09:22Z",
    expiry: "exp 2026-12-14",
    expiresFull: "2026-12-14 09:22Z",
    projections: {
      pay_statements: ["employer", "period_start", "period_end", "gross_pay", "net_pay"],
      employment: ["employer", "start_date", "end_date"]
    }
  }, {
    id: "grt_cncrt_02",
    client: "Concert Recommendations",
    purpose: "live_event_suggestions",
    scopes: [{
      name: "listening_history.read",
      terms: "rolling 12 mo"
    }],
    declined: [],
    status: "continuous",
    issued: "2026-01-30 18:04Z",
    expiry: "continuous",
    expiresFull: "renews monthly · next 2026-07-01",
    projections: {
      listening_history: ["track", "artist", "played_at"]
    }
  }, {
    id: "grt_taxpr_03",
    client: "TaxPrep Co",
    purpose: "annual_filing_2025",
    scopes: [{
      name: "tax_docs.read",
      terms: "single use"
    }],
    declined: [],
    status: "expiring",
    hoursLeft: 26,
    issued: "2026-06-09 11:40Z",
    expiry: "exp 2026-06-12",
    expiresFull: "2026-06-12 11:40Z",
    projections: {
      tax_docs: ["doc_type", "tax_year", "employer"]
    }
  }, {
    id: "grt_xwise_09",
    client: "Crosswise Ads",
    purpose: "ad_personalization",
    scopes: [{
      name: "transactions.read",
      terms: "90 d window"
    }],
    declined: [],
    status: "revoked",
    issued: "2026-02-11 08:15Z",
    revokedOn: "2026-05-02",
    revokedFull: "2026-05-02 14:40Z · by owner",
    expiry: "—",
    expiresFull: "—",
    projections: {
      transactions: ["date", "amount", "merchant"]
    }
  }];
  const BASE_LOG = [{
    t: "2026-06-11 07:58Z",
    kind: "read",
    verb: "read",
    what: "pay_statements · 12 records · 5/8 fields",
    ref: "grt_lngvw_01"
  }, {
    t: "2026-06-11 06:02Z",
    kind: "read",
    verb: "read",
    what: "listening_history · 214 records · 3/5 fields",
    ref: "grt_cncrt_02"
  }, {
    t: "2026-06-10 22:17Z",
    kind: "read",
    verb: "read",
    what: "employment · 4 records · 3/5 fields",
    ref: "grt_lngvw_01"
  }, {
    t: "2026-06-10 22:17Z",
    kind: "deny",
    verb: "deny",
    what: "tax_docs read attempt · scope not granted",
    ref: "grt_lngvw_01"
  }, {
    t: "2026-06-09 11:40Z",
    kind: "consent",
    verb: "grant",
    what: "tax_docs.read · single use · TaxPrep Co",
    ref: "grt_taxpr_03"
  }, {
    t: "2026-05-02 14:40Z",
    kind: "revoke",
    verb: "revoke",
    what: "transactions.read · Crosswise Ads · by owner",
    ref: "grt_xwise_09"
  }, {
    t: "2026-05-02 14:39Z",
    kind: "deny",
    verb: "deny",
    what: "transactions read attempt · grant suspended",
    ref: "grt_xwise_09"
  }];
  const INCOMING = {
    id: "req_atlas_7f2k",
    client: "Atlas Mortgage",
    purposeHuman: "mortgage pre-approval",
    scopes: [{
      name: "pay_statements.read",
      terms: "append only · 90 d",
      desc: "Employer, pay period, gross and net pay",
      allowed: true
    }, {
      name: "employment.read",
      terms: "current + 5 yrs",
      desc: "Employers and dates — no salary history",
      allowed: true
    }, {
      name: "transactions.read",
      terms: "90 d window",
      desc: "Spending detail from First Meridian",
      allowed: false
    }]
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
    localStorage.setItem(LS_KEY, JSON.stringify({
      ...cur,
      ...patch
    }));
  }
  function nowStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
  }
  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "theme": "dark",
    "density": "comfortable",
    "carbonOffset": 9
  } /*EDITMODE-END*/;
  const NAV = [{
    id: "explore",
    label: "Explore"
  }, {
    group: "Collection"
  }, {
    id: "syncs",
    label: "Syncs"
  }, {
    id: "sources",
    label: "Sources"
  }, {
    group: "Sharing"
  }, {
    id: "grants",
    label: "Grants"
  }, {
    id: "traces",
    label: "Traces"
  }, {
    group: "Server"
  }, {
    id: "connect",
    label: "Connect AI apps"
  }, {
    id: "deployment",
    label: "Deployment"
  }, {
    id: "exporters",
    label: "Device exporters"
  }, {
    id: "events",
    label: "Event subscriptions"
  }, {
    group: "Glance"
  }, {
    id: "overview",
    label: "Standing"
  }];
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
    events: ["Event subscriptions", "webhooks on protocol events"]
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
          setPaletteOpen(o => !o);
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
          setSelected(cur => {
            const i = grants.findIndex(g => g.id === cur);
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
      return all.map(g => revokedIds.includes(g.id) && g.status !== "revoked" ? {
        ...g,
        status: "revoked",
        revokedOn: g.revokedOn || "2026-06-11",
        revokedFull: g.revokedFull || nowStamp() + " · by owner"
      } : g);
    }, [extraGrants, revokedIds]);
    const log = useMemo(() => [...extraLog, ...BASE_LOG], [extraLog]);
    const grant = grants.find(g => g.id === selected) || null;
    const activeCount = grants.filter(g => g.status !== "revoked").length;
    function addLog(entry) {
      setExtraLog(cur => {
        const next = [{
          ...entry,
          fresh: true
        }, ...cur];
        saveState({
          extraLog: next.map(({
            fresh,
            ...e
          }) => e)
        });
        return next;
      });
    }
    function approve() {
      setPressing(true);
      const allowed = reqScopes.filter(s => s.allowed);
      const declined = reqScopes.filter(s => !s.allowed).map(s => s.name);
      const newGrant = {
        id: "grt_atlas_05",
        client: INCOMING.client,
        purpose: "mortgage_preapproval",
        scopes: allowed.map(({
          name,
          terms
        }) => ({
          name,
          terms
        })),
        declined,
        status: "active",
        issued: nowStamp(),
        expiry: "exp 2026-09-09",
        expiresFull: "2026-09-09 · 90 d term",
        justAdded: true,
        projections: {
          pay_statements: ["employer", "period_start", "period_end", "gross_pay", "net_pay"],
          employment: ["employer", "start_date", "end_date"]
        }
      };
      setTimeout(() => {
        setExtraGrants(cur => {
          const next = [newGrant, ...cur];
          saveState({
            extraGrants: next.map(({
              justAdded,
              ...g
            }) => g),
            requestState: "approved"
          });
          return next;
        });
        addLog({
          t: nowStamp(),
          kind: "consent",
          verb: "grant",
          what: `${allowed.length} scopes · ${declined.length} declined · ${INCOMING.client}`,
          ref: newGrant.id
        });
        setRequestState("approved");
        setPressing(false);
        setSelected(newGrant.id);
        setView("grants");
      }, 1900);
    }
    function refuse() {
      setRequestState("refused");
      saveState({
        requestState: "refused"
      });
      addLog({
        t: nowStamp(),
        kind: "deny",
        verb: "refuse",
        what: `access request refused · ${INCOMING.client}`,
        ref: INCOMING.id
      });
    }
    function confirmRevoke() {
      // Optimistic: the record flips NOW; the strike draws as confirmation, not as a wait.
      const g = grant;
      setStriking(true);
      setRevoking(false);
      setRevokedIds(cur => {
        const next = [...cur, selected];
        saveState({
          revokedIds: next
        });
        return next;
      });
      addLog({
        t: nowStamp(),
        kind: "revoke",
        verb: "revoke",
        what: `${g.scopes.map(s => s.name).join(" · ")} · ${g.client} · by owner`,
        ref: g.id
      });
      setTimeout(() => setStriking(false), 520);
    }
    function recordRecent(label) {
      setRecents(prev => {
        const next = [label, ...prev.filter(l => l !== label)].slice(0, 5);
        saveState({
          paletteRecents: next
        });
        return next;
      });
    }
    function browseInExplore(conId, streamName) {
      setExploreSeed({
        con: conId,
        stream: streamName,
        n: Date.now()
      });
      setView("explore");
    }
    const paletteItems = [...NAV.filter(n => n.id).map(n => ({
      label: n.label,
      kind: "view",
      run: () => setView(n.id)
    })), ...grants.map(g => ({
      label: g.client + " — " + g.id,
      kind: "grant",
      run: () => {
        setView("grants");
        setSelected(g.id);
      }
    })), ...STREAMS.map(s => ({
      label: s.id,
      kind: "stream",
      run: () => setView("sources")
    })), {
      label: "Reauthorize First Meridian",
      kind: "action",
      run: () => setView("syncs")
    }, ...(requestState === "pending" ? [{
      label: "Review Atlas Mortgage request",
      kind: "action",
      run: () => setRequestState("open")
    }] : []), {
      label: "Toggle theme",
      kind: "action",
      run: () => setTweak("theme", t.theme === "dark" ? "light" : "dark")
    }];
    const heads = {
      ...HEADS,
      grants: ["Grants", `${activeCount} in effect · ${grants.length - activeCount} struck · ↑↓ select`]
    };
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-app",
      "data-density": t.density
    }, /*#__PURE__*/React.createElement(RRSidebarFull, {
      counts: {
        grants: grants.length,
        traces: window.RR2.traces.length
      },
      nav: NAV,
      onView: setView,
      view: view
    }), /*#__PURE__*/React.createElement("main", {
      className: "rr-main"
    }, /*#__PURE__*/React.createElement("header", {
      className: "rr-head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-head__brand"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-side__mark"
    }), /*#__PURE__*/React.createElement("span", null, "Recordroom")), /*#__PURE__*/React.createElement("span", {
      className: "rr-head__crumb"
    }, "rs.okafor.recordroom.net \xB7 pdpp 0.1.0"), /*#__PURE__*/React.createElement("div", {
      className: "rr-head__actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rr-chrome-btn",
      onClick: () => setPaletteOpen(true),
      type: "button"
    }, "Jump ", /*#__PURE__*/React.createElement("span", {
      className: "rr-kbd"
    }, "\u2318K")), /*#__PURE__*/React.createElement("button", {
      className: "rr-chrome-btn",
      onClick: () => setTweak("theme", t.theme === "dark" ? "light" : "dark"),
      title: t.theme === "dark" ? "Switch to light" : "Switch to dark",
      type: "button"
    }, t.theme === "dark" ? "Dark" : "Light"), /*#__PURE__*/React.createElement("button", {
      className: "rr-chrome-btn rr-menu-btn",
      onClick: () => setNavOpen(true),
      type: "button"
    }, "Menu"))), /*#__PURE__*/React.createElement("div", {
      className: "rr-content",
      "data-screen-label": view,
      key: view
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-page" + (view === "grants" ? " rr-page--split" : "")
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-page-head"
    }, /*#__PURE__*/React.createElement("h1", {
      className: "rr-page-head__t"
    }, heads[view][0]), /*#__PURE__*/React.createElement("span", {
      className: "rr-page-head__s"
    }, heads[view][1])), view === "overview" && /*#__PURE__*/React.createElement(RROverview2, {
      grants: grants,
      onGo: setView,
      onOpenGrant: id => {
        setView("grants");
        setSelected(id);
      },
      onReview: () => setRequestState("open"),
      requestState: requestState
    }), view === "explore" && /*#__PURE__*/React.createElement(RRExploreView, {
      grants: grants,
      onGo: setView,
      onJump: () => setPaletteOpen(true),
      seed: exploreSeed
    }), view === "sources" && /*#__PURE__*/React.createElement(RRSourcesView2, {
      grants: grants,
      onBrowse: browseInExplore,
      onGo: setView
    }), view === "traces" && /*#__PURE__*/React.createElement(RRTracesView, null), view === "grants" && /*#__PURE__*/React.createElement("div", null, requestState === "pending" && /*#__PURE__*/React.createElement("div", {
      className: "rr-incoming pdpp-carbon"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-incoming__sheet"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-incoming__text"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-incoming__title"
    }, "Atlas Mortgage asks to read 3 streams"), /*#__PURE__*/React.createElement("span", {
      className: "rr-incoming__meta"
    }, "staged \xB7 req_atlas_7f2k \xB7 purpose: mortgage_preapproval")), /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--sm",
      onClick: () => setRequestState("open"),
      type: "button"
    }, "Review"))), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-table rr-cols-grants"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-table__hrow"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "client"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "scopes"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "status"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h u-r"
    }, "expires")), grants.map(g => /*#__PURE__*/React.createElement(RRGrantRow, {
      grant: g,
      key: g.id,
      onSelect: id => {
        setSelected(id);
        setRevoking(false);
        setStriking(false);
      },
      selected: selected === g.id
    })))), view === "grants" && /*#__PURE__*/React.createElement(RRInspector, {
      grant: grant,
      log: log,
      onRevokeCancel: () => setRevoking(false),
      onRevokeConfirm: confirmRevoke,
      onRevokeStart: () => setRevoking(true),
      revoking: revoking,
      streams: STREAMS,
      striking: striking
    }), view === "syncs" && /*#__PURE__*/React.createElement(RRSyncsView, null), view === "connect" && /*#__PURE__*/React.createElement(RRConnectView2, null), view === "deployment" && /*#__PURE__*/React.createElement(RRDeploymentView, null), view === "exporters" && /*#__PURE__*/React.createElement(RRExportersView2, null), view === "events" && /*#__PURE__*/React.createElement(RRSubscriptionsView2, null), view === "activity" && /*#__PURE__*/React.createElement(RRActivityLog, {
      entries: log
    })))), navOpen && /*#__PURE__*/React.createElement("div", {
      className: "rr-drawer-overlay",
      onClick: () => setNavOpen(false)
    }, /*#__PURE__*/React.createElement("nav", {
      className: "rr-drawer",
      onClick: e => e.stopPropagation()
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-side__brand"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-side__mark"
    }), /*#__PURE__*/React.createElement("span", {
      className: "rr-side__name"
    }, "Recordroom")), /*#__PURE__*/React.createElement("div", {
      className: "rr-drawer__nav"
    }, NAV.map((item, i) => item.group ? /*#__PURE__*/React.createElement("div", {
      className: "rr-side__group",
      key: "g" + i
    }, item.group) : /*#__PURE__*/React.createElement("button", {
      className: "rr-nav-item" + (view === item.id ? " is-active" : ""),
      key: item.id,
      onClick: () => {
        setView(item.id);
        setNavOpen(false);
      },
      type: "button"
    }, /*#__PURE__*/React.createElement("span", null, item.label)))), /*#__PURE__*/React.createElement("div", {
      className: "rr-side__foot"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-side__owner"
    }, "M. Okafor"), /*#__PURE__*/React.createElement("span", {
      className: "rr-side__host"
    }, "rs.okafor.recordroom.net \xB7 pdpp 0.1.0")))), requestState === "open" && /*#__PURE__*/React.createElement(RRCeremony, {
      onApprove: approve,
      onDismiss: () => {
        if (!pressing) setRequestState("pending");
      },
      onRefuse: refuse,
      onToggle: i => setReqScopes(cur => cur.map((s, j) => j === i ? {
        ...s,
        allowed: !s.allowed
      } : s)),
      pressing: pressing,
      request: {
        ...INCOMING,
        scopes: reqScopes
      }
    }), /*#__PURE__*/React.createElement(RRCommandPalette, {
      items: paletteItems,
      onClose: () => setPaletteOpen(false),
      onExec: recordRecent,
      open: paletteOpen,
      recents: recents
    }), /*#__PURE__*/React.createElement(TweaksPanel, null, /*#__PURE__*/React.createElement(TweakSection, {
      label: "Console"
    }), /*#__PURE__*/React.createElement(TweakRadio, {
      label: "Theme",
      onChange: v => setTweak("theme", v),
      options: ["dark", "light"],
      value: t.theme
    }), /*#__PURE__*/React.createElement(TweakRadio, {
      label: "Density",
      onChange: v => setTweak("density", v),
      options: ["comfortable", "compact"],
      value: t.density
    }), /*#__PURE__*/React.createElement(TweakSection, {
      label: "Carbon"
    }), /*#__PURE__*/React.createElement(TweakSlider, {
      label: "Offset",
      max: 14,
      min: 5,
      onChange: v => setTweak("carbonOffset", v),
      unit: "px",
      value: t.carbonOffset
    }), /*#__PURE__*/React.createElement(TweakSection, {
      label: "Demo"
    }), /*#__PURE__*/React.createElement(TweakButton, {
      label: "Reset demo state",
      onClick: () => {
        localStorage.setItem(LS_KEY, "{}");
        location.reload();
      }
    })));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "recordroom/rr-app.jsx", error: String((e && e.message) || e) }); }

// recordroom/rr-components.jsx
try { (() => {
/* RECORDROOM — view components. Data lives in rr-app.jsx; these render it. */
;
(() => {
  const {
    useState,
    useEffect
  } = React;

  /* ─── Shared bits ─── */

  function Endorse({
    status,
    hours
  }) {
    const map = {
      active: ["pdpp-endorse--active", "active"],
      continuous: ["pdpp-endorse--continuous", "continuous"],
      expiring: ["pdpp-endorse--expiring", `expiring ${hours}h`],
      revoked: ["pdpp-endorse--revoked", "revoked"]
    };
    const [cls, label] = map[status] || map.active;
    return /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse " + cls
    }, label);
  }
  function Sidebar({
    view,
    onView,
    counts
  }) {
    const items = [["grants", "Grants", counts.grants], ["streams", "Streams", counts.streams], ["activity", "Activity", counts.activity]];
    return /*#__PURE__*/React.createElement("aside", {
      className: "rr-side"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-side__brand"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-side__mark"
    }), /*#__PURE__*/React.createElement("span", {
      className: "rr-side__name"
    }, "Recordroom")), /*#__PURE__*/React.createElement("nav", {
      className: "rr-side__nav"
    }, items.map(([id, label, n]) => /*#__PURE__*/React.createElement("button", {
      className: "rr-nav-item" + (view === id ? " is-active" : ""),
      key: id,
      onClick: () => onView(id),
      type: "button"
    }, /*#__PURE__*/React.createElement("span", null, label), /*#__PURE__*/React.createElement("span", {
      className: "rr-nav-item__count"
    }, n)))), /*#__PURE__*/React.createElement("div", {
      className: "rr-side__spacer"
    }), /*#__PURE__*/React.createElement("div", {
      className: "rr-side__foot"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-side__owner"
    }, "M. Okafor"), /*#__PURE__*/React.createElement("span", {
      className: "rr-side__host"
    }, "rs.okafor.recordroom.net \xB7 pdpp 0.1.0")));
  }
  function SidebarFull({
    view,
    onView,
    nav,
    counts
  }) {
    return /*#__PURE__*/React.createElement("aside", {
      className: "rr-side"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-side__brand"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-side__mark"
    }), /*#__PURE__*/React.createElement("span", {
      className: "rr-side__name"
    }, "Recordroom")), /*#__PURE__*/React.createElement("nav", {
      className: "rr-side__nav",
      style: {
        overflowY: "auto"
      }
    }, nav.map((item, i) => item.group ? /*#__PURE__*/React.createElement("div", {
      className: "rr-side__group",
      key: "g" + i
    }, item.group) : /*#__PURE__*/React.createElement("button", {
      className: "rr-nav-item" + (view === item.id ? " is-active" : ""),
      key: item.id,
      onClick: () => onView(item.id),
      type: "button"
    }, /*#__PURE__*/React.createElement("span", null, item.label), item.id === "grants" && /*#__PURE__*/React.createElement("span", {
      className: "rr-nav-item__count"
    }, counts.grants), item.id === "traces" && /*#__PURE__*/React.createElement("span", {
      className: "rr-nav-item__count"
    }, counts.traces)))), /*#__PURE__*/React.createElement("div", {
      className: "rr-side__spacer"
    }), /*#__PURE__*/React.createElement("div", {
      className: "rr-side__foot"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-side__owner"
    }, "M. Okafor"), /*#__PURE__*/React.createElement("span", {
      className: "rr-side__host"
    }, "rs.okafor.recordroom.net \xB7 pdpp 0.1.0"), /*#__PURE__*/React.createElement("span", {
      className: "rr-side__motto"
    }, "your data, at home"), /*#__PURE__*/React.createElement("div", {
      className: "rr-env"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-env__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-env__dot"
    }), /*#__PURE__*/React.createElement("span", {
      className: "rr-env__label"
    }, "AS"), /*#__PURE__*/React.createElement("span", {
      className: "rr-env__url"
    }, "as.okafor.recordroom.net")), /*#__PURE__*/React.createElement("span", {
      className: "rr-env__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-env__dot"
    }), /*#__PURE__*/React.createElement("span", {
      className: "rr-env__label"
    }, "RS"), /*#__PURE__*/React.createElement("span", {
      className: "rr-env__url"
    }, "rs.okafor.recordroom.net")))));
  }

  /* ─── Grants view ─── */

  function monogram(name) {
    const words = name.split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
  }
  function GrantRow({
    grant,
    selected,
    onSelect
  }) {
    const cls = "pdpp-data-row" + (grant.status === "revoked" ? " pdpp-data-row--revoked" : "") + (grant.justAdded ? " pdpp-data-row--landed" : "");
    return /*#__PURE__*/React.createElement("button", {
      className: "rr-row-btn" + (selected ? " is-selected" : ""),
      onClick: () => onSelect(grant.id),
      type: "button"
    }, /*#__PURE__*/React.createElement("div", {
      className: cls,
      style: {
        "--cols": "inherit"
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-monogram"
    }, monogram(grant.client)), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__who"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__title"
    }, grant.client), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__id"
    }, grant.id)), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__detail"
    }, grant.scopes.map(s => s.name).join(" · ")), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement(Endorse, {
      hours: grant.hoursLeft,
      status: grant.status
    })), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__meta"
    }, grant.status === "revoked" ? grant.revokedOn : grant.expiry)));
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
    browsing: "Your browsing"
  };
  function Inspector({
    grant,
    streams,
    log,
    revoking,
    striking,
    onRevokeStart,
    onRevokeConfirm,
    onRevokeCancel
  }) {
    if (!grant) {
      return /*#__PURE__*/React.createElement("div", {
        className: "rr-inspector"
      }, /*#__PURE__*/React.createElement("div", {
        className: "rr-inspector__empty"
      }, "Select a grant to read your copy."));
    }
    const revoked = grant.status === "revoked";
    const granted = grant.scopes.map(s => {
      const sid = s.name.split(".")[0];
      const stream = (streams || []).find(x => x.id === sid);
      const proj = grant.projections && grant.projections[sid] || [];
      const dropped = stream ? stream.fields.filter(f => !proj.includes(f)) : [];
      return {
        sid,
        s,
        proj,
        total: stream ? stream.fields.length : null,
        dropped
      };
    });
    const reads = (log || []).filter(e => e.ref === grant.id && e.kind === "read");
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-inspector"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-carbon rr-anim-swap",
      key: grant.id
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__head"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "pdpp-sheet__title",
      style: {
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis"
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-strikeable" + (striking ? " rr-strike-go" : "")
    }, grant.client, /*#__PURE__*/React.createElement("span", {
      className: "rr-strikeable__line"
    }))), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-sheet__serial"
    }, grant.id)), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__body"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-kv"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-kv__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__k"
    }, "status"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__v"
    }, /*#__PURE__*/React.createElement(Endorse, {
      hours: grant.hoursLeft,
      status: grant.status
    }))), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-kv__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__k"
    }, "purpose"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__v"
    }, fmtToken(grant.purpose))), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-kv__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__k"
    }, revoked ? "revoked" : "expires"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__v"
    }, revoked ? grant.revokedFull : grant.expiresFull))), /*#__PURE__*/React.createElement("div", {
      className: "rr-insp-label"
    }, "What ", grant.client.split(" ")[0], " can assemble"), granted.map(({
      sid,
      s,
      proj,
      total
    }) => /*#__PURE__*/React.createElement("div", {
      className: "rr-insp-item",
      key: sid
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-insp-item__t"
    }, STREAM_HUMAN[sid] || sid), /*#__PURE__*/React.createElement("span", {
      className: "rr-insp-item__s"
    }, proj.length, total ? ` of ${total}` : "", " fields cross \xB7 ", s.terms), /*#__PURE__*/React.createElement("span", {
      className: "rr-insp-item__f"
    }, proj.join(" · ")))), (granted.some(g => g.dropped.length > 0) || grant.declined.length > 0) && /*#__PURE__*/React.createElement("div", {
      className: "rr-insp-label"
    }, "What stays yours"), granted.filter(g => g.dropped.length > 0).map(({
      sid,
      dropped
    }) => /*#__PURE__*/React.createElement("div", {
      className: "rr-insp-keep",
      key: sid
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-insp-keep__what"
    }, dropped.join(" · ")), /*#__PURE__*/React.createElement("span", {
      className: "rr-insp-keep__why"
    }, "projected out of ", sid, " \u2014 never crosses"))), grant.declined.map(d => /*#__PURE__*/React.createElement("div", {
      className: "rr-insp-keep",
      key: d
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-insp-keep__what rr-insp-keep__what--declined"
    }, d), /*#__PURE__*/React.createElement("span", {
      className: "rr-insp-keep__why"
    }, "declined by you at consent"))), reads.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "rr-insp-pulse"
    }, reads.length, " read", reads.length === 1 ? "" : "s", " on record \xB7 last ", reads[0].t.slice(5))), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__foot"
    }, !revoking && /*#__PURE__*/React.createElement("span", {
      className: "pdpp-copyline"
    }, "Carbon \u2014 your copy stays here"), !revoked && !revoking && /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--destructive pdpp-btn--sm",
      onClick: onRevokeStart,
      type: "button"
    }, "Revoke"), !revoked && revoking && /*#__PURE__*/React.createElement("span", {
      style: {
        display: "flex",
        gap: 8,
        marginLeft: "auto"
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--ghost pdpp-btn--sm",
      onClick: onRevokeCancel,
      type: "button"
    }, "Keep"), /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--destructive pdpp-btn--sm",
      onClick: onRevokeConfirm,
      type: "button"
    }, "Confirm revoke")), revoked && /*#__PURE__*/React.createElement("span", {
      className: "pdpp-typed-sm",
      style: {
        color: "var(--muted-foreground)"
      }
    }, "struck, not erased")))));
  }

  /* ─── Streams view ─── */

  function StreamSheet({
    stream,
    grants
  }) {
    const [lens, setLens] = useState(null); // grant id or null
    const lensGrant = lens ? grants.find(g => g.id === lens) : null;
    const projected = lensGrant ? lensGrant.projections[stream.id] : null;
    const granted = grants.filter(g => g.status !== "revoked" && g.projections[stream.id]);
    return /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet rr-stream"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__head"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "pdpp-sheet__title"
    }, stream.id), /*#__PURE__*/React.createElement("span", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10
      }
    }, granted.map(g => /*#__PURE__*/React.createElement("button", {
      className: "rr-lens" + (lens === g.id ? " is-on" : ""),
      key: g.id,
      onClick: () => setLens(lens === g.id ? null : g.id),
      type: "button"
    }, lens === g.id ? "view as " + g.client : "view as " + g.client)), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-sheet__serial"
    }, stream.connector, " \xB7 ", stream.records, " records"))), /*#__PURE__*/React.createElement("div", {
      className: "rr-stream__fields"
    }, stream.fields.map(f => {
      const dropped = projected && !projected.includes(f);
      return /*#__PURE__*/React.createElement("span", {
        className: "rr-field-chip" + (dropped ? " rr-field-chip--dropped" : ""),
        key: f
      }, f);
    })), projected && /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__foot"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-typed-sm",
      style: {
        color: "var(--primary)"
      }
    }, projected.length, " of ", stream.fields.length, " fields cross \xB7 projection enforced at the server")));
  }

  /* ─── Activity view ─── */

  function ActivityLog({
    entries
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-log"
    }, entries.map((e, i) => /*#__PURE__*/React.createElement("div", {
      className: "rr-log__row" + (e.fresh ? " rr-log__row--new" : ""),
      key: entries.length - i
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-log__t"
    }, e.t), /*#__PURE__*/React.createElement("span", {
      className: "rr-log__verb rr-log__verb--" + e.kind
    }, e.verb), /*#__PURE__*/React.createElement("span", {
      className: "rr-log__what"
    }, e.what), /*#__PURE__*/React.createElement("span", {
      className: "rr-log__ref"
    }, e.ref))));
  }

  /* ─── The consent ceremony ─── */

  function Ceremony({
    request,
    pressing,
    onToggle,
    onApprove,
    onRefuse,
    onDismiss
  }) {
    useEffect(() => {
      function onKey(e) {
        if (e.key === "Escape") onDismiss();
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [onDismiss]);
    const allowed = request.scopes.filter(s => s.allowed);
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-overlay",
      onClick: pressing ? undefined : onDismiss
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-ceremony rr-paper-scope" + (pressing ? " is-pressing" : ""),
      onClick: e => e.stopPropagation()
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-carbon"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-ceremony__kicker-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-eyebrow"
    }, "Access request \xB7 staged"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-sheet__serial"
    }, request.id)), /*#__PURE__*/React.createElement("div", {
      className: "rr-ceremony__body"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "rr-ceremony__title"
    }, request.client, " asks to read ", request.scopes.length, " streams"), /*#__PURE__*/React.createElement("p", {
      className: "rr-ceremony__sub"
    }, "Purpose: ", request.purposeHuman, ". Decide stream by stream \u2014 anything you decline stays on the record as declined."), /*#__PURE__*/React.createElement("div", {
      className: "rr-ceremony__scopes"
    }, request.scopes.map((s, i) => /*#__PURE__*/React.createElement("div", {
      className: "rr-scope-decide" + (s.allowed ? "" : " rr-scope-decide--off"),
      key: s.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-scope-decide__name"
    }, s.name), /*#__PURE__*/React.createElement("span", {
      className: "rr-scope-decide__terms"
    }, s.terms), /*#__PURE__*/React.createElement("button", {
      className: "rr-allow" + (s.allowed ? " is-on" : ""),
      disabled: pressing,
      onClick: () => onToggle(i),
      type: "button"
    }, s.allowed ? "allow" : "declined"), /*#__PURE__*/React.createElement("span", {
      className: "rr-scope-decide__desc"
    }, s.desc))))), /*#__PURE__*/React.createElement("div", {
      className: "rr-ceremony__foot"
    }, !pressing && /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--ghost",
      onClick: onRefuse,
      type: "button"
    }, "Refuse all"), !pressing && /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--human",
      disabled: allowed.length === 0,
      onClick: onApprove,
      style: allowed.length === 0 ? {
        opacity: 0.45,
        cursor: "default"
      } : null,
      type: "button"
    }, "Approve ", allowed.length, " ", allowed.length === 1 ? "stream" : "streams"), pressing && /*#__PURE__*/React.createElement("span", {
      className: "pdpp-copyline rr-press-reveal"
    }, "Carbon pressed \u2014 your copy stays here"), pressing && /*#__PURE__*/React.createElement("span", {
      className: "pdpp-typed-sm rr-press-reveal",
      style: {
        color: "var(--muted-foreground)"
      }
    }, "recording grant\u2026"))))));
  }
  Object.assign(window, {
    RREndorse: Endorse,
    RRSidebar: Sidebar,
    RRSidebarFull: SidebarFull,
    RRGrantRow: GrantRow,
    RRInspector: Inspector,
    RRStreamSheet: StreamSheet,
    RRActivityLog: ActivityLog,
    RRCeremony: Ceremony
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "recordroom/rr-components.jsx", error: String((e && e.message) || e) }); }

// recordroom/rr-data.js
try { (() => {
/* RECORDROOM — fixture data for the full console surface (window.RR2). */
window.RR2 = {
  traces: [{
    id: "trc_9f2k0419",
    t: "2026-06-11 07:58:12Z",
    client: "Longview Planning",
    grant: "grt_lngvw_01",
    stream: "pay_statements",
    op: "records.query",
    records: 12,
    fields: "5/8",
    dur: "42 ms",
    decision: "allow",
    steps: [["token", "DPoP verified · client longview_planning_v1"], ["grant", "grt_lngvw_01 active · purpose long_term_financial_planning"], ["projection", "8 fields requested → 5 allowed by grant"], ["response", "12 records · append-only cursor advanced · 42 ms"]]
  }, {
    id: "trc_3km1180a",
    t: "2026-06-11 06:02:44Z",
    client: "Concert Recommendations",
    grant: "grt_cncrt_02",
    stream: "listening_history",
    op: "records.query",
    records: 214,
    fields: "3/5",
    dur: "61 ms",
    decision: "allow",
    steps: [["token", "DPoP verified · client concert_recs_v2"], ["grant", "grt_cncrt_02 continuous · rolling 12 mo window"], ["projection", "5 fields requested → 3 allowed by grant"], ["response", "214 records · 61 ms"]]
  }, {
    id: "trc_77fe2c01",
    t: "2026-06-10 22:17:09Z",
    client: "Longview Planning",
    grant: "grt_lngvw_01",
    stream: "employment",
    op: "records.query",
    records: 4,
    fields: "3/5",
    dur: "12 ms",
    decision: "allow",
    steps: [["token", "DPoP verified · client longview_planning_v1"], ["grant", "grt_lngvw_01 active · purpose long_term_financial_planning"], ["projection", "5 fields requested → 3 allowed by grant"], ["response", "4 records · 12 ms"]]
  }, {
    id: "trc_b2d90377",
    t: "2026-06-10 22:17:08Z",
    client: "Longview Planning",
    grant: "grt_lngvw_01",
    stream: "tax_docs",
    op: "records.query",
    records: 0,
    fields: "—",
    dur: "4 ms",
    decision: "deny",
    reason: "scope not granted",
    steps: [["token", "DPoP verified · client longview_planning_v1"], ["grant", "tax_docs.read not in grant — declined by owner at consent"], ["deny", "request refused · nothing crossed · 4 ms"]]
  }, {
    id: "trc_8d114b2e",
    t: "2026-05-02 14:39:51Z",
    client: "Crosswise Ads",
    grant: "grt_xwise_09",
    stream: "transactions",
    op: "records.query",
    records: 0,
    fields: "—",
    dur: "6 ms",
    decision: "deny",
    reason: "grant revoked",
    steps: [["token", "DPoP verified · client crosswise_ads_v1"], ["grant", "grt_xwise_09 revoked 2026-05-02 14:40Z · by owner"], ["deny", "request refused · revocation authoritative at server · 6 ms"]]
  }],
  runs: [{
    id: "run_a6e201",
    connector: "Northstar HR",
    stream: "pay_statements",
    started: "2026-06-11 06:00Z",
    dur: "18 s",
    upserts: 2,
    cursor: "→ 2026-06-01",
    status: "ok"
  }, {
    id: "run_a6e1f4",
    connector: "Tonal",
    stream: "listening_history",
    started: "2026-06-11 05:45Z",
    dur: "7 s",
    upserts: 96,
    cursor: "→ 05:45Z",
    status: "ok"
  }, {
    id: "run_a6df02",
    connector: "First Meridian",
    stream: "transactions",
    started: "2026-06-11 05:00Z",
    dur: "31 s",
    upserts: 41,
    cursor: "→ 06-10",
    status: "ok"
  }, {
    id: "run_a6d0c8",
    connector: "First Meridian",
    stream: "transactions",
    started: "2026-06-10 05:00Z",
    dur: "2 s",
    upserts: 0,
    cursor: "held",
    status: "failed",
    note: "OFX session expired — reauthorize connector"
  }, {
    id: "run_a6cf11",
    connector: "Northstar HR",
    stream: "employment",
    started: "2026-06-10 06:00Z",
    dur: "4 s",
    upserts: 0,
    cursor: "—",
    status: "ok"
  }],
  schedules: [{
    connector: "Northstar HR",
    stream: "pay_statements",
    cadence: "daily · 06:00Z",
    next: "2026-06-12 06:00Z",
    last: "ok"
  }, {
    connector: "Northstar HR",
    stream: "employment",
    cadence: "daily · 06:00Z",
    next: "2026-06-12 06:00Z",
    last: "ok"
  }, {
    connector: "First Meridian",
    stream: "transactions",
    cadence: "daily · 05:00Z",
    next: "2026-06-12 05:00Z",
    last: "failed"
  }, {
    connector: "Tonal",
    stream: "listening_history",
    cadence: "every 15 min",
    next: "06:00Z",
    last: "ok"
  }, {
    connector: "Northstar HR",
    stream: "tax_docs",
    cadence: "yearly · Feb 01",
    next: "2027-02-01",
    last: "ok"
  }],
  sources: [{
    name: "Northstar HR",
    kind: "employer payroll",
    streams: "pay_statements · employment · tax_docs",
    auth: "service token",
    authOk: true,
    last: "2026-06-11 06:00Z"
  }, {
    name: "First Meridian",
    kind: "bank · OFX",
    streams: "transactions",
    auth: "session expired",
    authOk: false,
    last: "2026-06-11 05:00Z"
  }, {
    name: "Tonal",
    kind: "music service",
    streams: "listening_history",
    auth: "oauth refresh",
    authOk: true,
    last: "2026-06-11 05:45Z"
  }],
  feed: [{
    t: "06-11 06:00Z",
    stream: "pay_statements",
    body: "Acme Co · 2026-05 · gross $5,210.00 · net $3,508.12",
    id: "rec_ps_0312"
  }, {
    t: "06-11 05:45Z",
    stream: "listening_history",
    body: "96 plays upserted · Tonal",
    id: "rec_lh_6597"
  }, {
    t: "06-11 05:00Z",
    stream: "transactions",
    body: "41 records · First Meridian · 06-10 cursor",
    id: "rec_tx_41203"
  }, {
    t: "06-10 06:00Z",
    stream: "pay_statements",
    body: "Acme Co · 2026-05 · correction · taxes_withheld",
    id: "rec_ps_0311"
  }, {
    t: "06-09 11:38Z",
    stream: "tax_docs",
    body: "W-2 · 2025 · Acme Co · document_blob 218 KB",
    id: "rec_td_0012"
  }, {
    t: "06-08 06:00Z",
    stream: "employment",
    body: "Acme Co · senior analyst · 2023-04 → present",
    id: "rec_em_0004"
  }],
  apps: [{
    name: "Claude Desktop",
    via: "MCP · stdio bridge",
    status: "connected",
    detail: "reads via grants only · no owner token",
    added: "2026-03-02"
  }, {
    name: "Cursor",
    via: "MCP · device code",
    status: "pending",
    detail: "code KZT-44Q · expires in 9 min",
    added: "—"
  }],
  checks: [{
    name: "AS discovery",
    detail: "/.well-known/oauth-authorization-server · 200",
    ok: true
  }, {
    name: "RS discovery",
    detail: "/.well-known/oauth-protected-resource · 200",
    ok: true
  }, {
    name: "TLS certificate",
    detail: "rs.okafor.recordroom.net · expires 2026-09-01",
    ok: true
  }, {
    name: "Owner password",
    detail: "set · gates consent, devices, console",
    ok: true
  }, {
    name: "Version",
    detail: "pdpp 0.1.0 · reference implementation · current",
    ok: true
  }, {
    name: "Backups",
    detail: "no snapshot target configured",
    ok: false
  }],
  tokens: [{
    id: "tok_owner_01",
    label: "CLI on framework",
    created: "2026-04-18",
    last: "2026-06-10 21:12Z"
  }],
  exporters: [{
    device: "iPhone 15 · Photos exporter",
    last: "2026-06-10 21:12Z",
    records: "1,204",
    status: "ok"
  }, {
    device: "MacBook · Browser history",
    last: "paused by owner",
    records: "—",
    status: "paused"
  }],
  subscriptions: [{
    url: "https://hooks.okafor.net/pdpp",
    events: "grant.created · grant.revoked",
    status: "active"
  }, {
    url: "ntfy.sh/okafor-recordroom",
    events: "run.failed",
    status: "active"
  }]
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "recordroom/rr-data.js", error: String((e && e.message) || e) }); }

// recordroom/rr-explore-data.js
try { (() => {
/* RECORDROOM — Explore/Sources fixtures. Models the real shape of a
   personal server: connection INSTANCES are the unit of identity (two
   Gmails with different configs, two Claude Codes on different machines),
   stream names overlap incidentally, records carry full fields and
   relationships, some fields are images. Fictional persona data. */
window.RRX = {
  now: "2026-06-12",
  totalOnServer: "48,120",
  days: [["2026-06-12", "Fri, Jun 12"], ["2026-06-11", "Thu, Jun 11"], ["2026-06-10", "Wed, Jun 10"]],
  spark: [2, 1, 3, 2, 1, 2, 4, 3, 2, 1, 2, 3, 5, 4, 3, 2, 4, 6, 5, 7, 6, 8, 7, 9, 8, 10, 12, 9, 11, 16],
  connections: [{
    id: "cdx",
    name: "Codex CLI — peregrine",
    kind: "codex",
    status: "active",
    cin: "cin_cdx_91ad02",
    account: "local agent · stdio bridge",
    config: "full session capture",
    added: "2026-02-11",
    auth: "device-bound key",
    schedule: "live",
    lastRun: "streaming",
    streams: [{
      name: "sessions",
      records: "1,204",
      cursor: "live",
      searchable: true,
      last: "7 min ago"
    }, {
      name: "messages",
      records: "18,440",
      cursor: "live",
      searchable: true,
      last: "22 min ago"
    }, {
      name: "function_calls",
      records: "22,901",
      cursor: "live",
      searchable: false,
      last: "22 min ago"
    }]
  }, {
    id: "cc1",
    name: "Claude Code — MacBook",
    kind: "claude-code",
    status: "active",
    cin: "cin_cc_77b210",
    account: "local agent · MacBook",
    config: "sessions + messages + attachments",
    added: "2026-01-08",
    auth: "device-bound key",
    schedule: "live",
    lastRun: "streaming",
    streams: [{
      name: "sessions",
      records: "312",
      cursor: "live",
      searchable: true,
      last: "20 h ago"
    }, {
      name: "messages",
      records: "4,180",
      cursor: "live",
      searchable: true,
      last: "20 h ago"
    }, {
      name: "attachments",
      records: "96",
      cursor: "live",
      searchable: false,
      last: "3 d ago"
    }, {
      name: "skills",
      records: "14",
      cursor: "live",
      searchable: true,
      last: "9 d ago"
    }]
  }, {
    id: "cc2",
    name: "Claude Code — build VM",
    kind: "claude-code",
    status: "revoked",
    cin: "cin_cc_2a96ef",
    account: "local agent · build VM",
    config: "sessions + messages",
    added: "2026-03-02",
    auth: "revoked May 28",
    schedule: "—",
    lastRun: "refused (revoked)",
    streams: [{
      name: "sessions",
      records: "88",
      cursor: "frozen May 28",
      searchable: true,
      last: "May 28"
    }, {
      name: "messages",
      records: "1,402",
      cursor: "frozen May 28",
      searchable: true,
      last: "May 28"
    }, {
      name: "attachments",
      records: "12",
      cursor: "frozen May 28",
      searchable: false,
      last: "May 24"
    }, {
      name: "skills",
      records: "6",
      cursor: "frozen May 28",
      searchable: true,
      last: "May 12"
    }]
  }, {
    id: "gm1",
    name: "Gmail — personal",
    kind: "gmail",
    status: "active",
    cin: "cin_gm_410c2b",
    account: "m.okafor@gmail.example",
    config: "all mail · bodies + attachments",
    added: "2025-11-20",
    auth: "oauth refresh ok",
    schedule: "every 15 min",
    lastRun: "ok · 31 min ago",
    streams: [{
      name: "messages",
      records: "31,007",
      cursor: "→ 14:28Z",
      searchable: true,
      last: "31 min ago"
    }, {
      name: "threads",
      records: "12,884",
      cursor: "→ 14:28Z",
      searchable: true,
      last: "31 min ago"
    }, {
      name: "message_bodies",
      records: "30,910",
      cursor: "→ 14:28Z",
      searchable: true,
      last: "31 min ago"
    }, {
      name: "attachments",
      records: "2,114",
      cursor: "→ 13:02Z",
      searchable: false,
      last: "2 h ago"
    }]
  }, {
    id: "gm2",
    name: "Gmail — work (filtered)",
    kind: "gmail",
    status: "active",
    cin: "cin_gm_88e1f0",
    account: "m.okafor@acme.example",
    config: "label:receipts + label:travel only",
    added: "2026-04-02",
    auth: "oauth refresh ok",
    schedule: "hourly",
    lastRun: "ok · 50 min ago",
    streams: [{
      name: "messages",
      records: "1,201",
      cursor: "→ 14:10Z",
      searchable: true,
      last: "20 h ago"
    }, {
      name: "threads",
      records: "884",
      cursor: "→ 14:10Z",
      searchable: true,
      last: "20 h ago"
    }, {
      name: "attachments",
      records: "310",
      cursor: "→ 14:10Z",
      searchable: false,
      last: "20 h ago"
    }]
  }, {
    id: "gh",
    name: "GitHub — mokafor",
    kind: "github",
    status: "active",
    cin: "cin_gh_53aa19",
    account: "github.com/mokafor",
    config: "repos + daily stats",
    added: "2026-01-15",
    auth: "fine-grained token ok",
    schedule: "hourly",
    lastRun: "ok · 23 min ago",
    streams: [{
      name: "repositories",
      records: "41",
      cursor: "→ 14:40Z",
      searchable: true,
      last: "23 min ago"
    }, {
      name: "user_stats",
      records: "365",
      cursor: "→ today",
      searchable: false,
      last: "15 h ago"
    }]
  }, {
    id: "cg",
    name: "ChatGPT — personal",
    kind: "chatgpt",
    status: "active",
    cin: "cin_cg_b042d8",
    account: "everyone@okafor.example",
    config: "conversations + messages",
    added: "2026-02-28",
    auth: "session export ok",
    schedule: "daily · 06:00Z",
    lastRun: "ok · 9 h ago",
    streams: [{
      name: "conversations",
      records: "871",
      cursor: "→ 06-12",
      searchable: true,
      last: "2 h ago"
    }, {
      name: "messages",
      records: "12,030",
      cursor: "→ 06-12",
      searchable: true,
      last: "2 h ago"
    }]
  }, {
    id: "fm",
    name: "First Meridian — checking",
    kind: "bank",
    status: "reauth",
    cin: "cin_fm_206b11",
    account: "checking ····4417",
    config: "transactions + statements + balances",
    added: "2025-12-01",
    auth: "OFX session expired",
    schedule: "daily · 05:00Z",
    lastRun: "failed · 06-11",
    streams: [{
      name: "transactions",
      records: "41,203",
      cursor: "held at 06-10",
      searchable: true,
      last: "2 d ago"
    }, {
      name: "statements",
      records: "72",
      cursor: "→ May",
      searchable: false,
      last: "12 d ago"
    }, {
      name: "balances",
      records: "365",
      cursor: "held at 06-10",
      searchable: false,
      last: "2 d ago"
    }]
  }, {
    id: "nh",
    name: "Northstar HR",
    kind: "payroll",
    status: "active",
    cin: "cin_nh_e3391c",
    account: "employee 41880 · Acme Co",
    config: "pay + employment + tax docs",
    added: "2025-10-02",
    auth: "service token ok",
    schedule: "with payroll",
    lastRun: "ok · 33 min ago",
    streams: [{
      name: "pay_statements",
      records: "313",
      cursor: "→ Jun 12",
      searchable: true,
      last: "33 min ago"
    }, {
      name: "employment",
      records: "4",
      cursor: "→ current",
      searchable: true,
      last: "4 d ago"
    }, {
      name: "tax_docs",
      records: "12",
      cursor: "→ 2025",
      searchable: false,
      last: "Feb 02"
    }]
  }, {
    id: "tn",
    name: "Tonal",
    kind: "music",
    status: "active",
    cin: "cin_tn_77f024",
    account: "m.okafor",
    config: "listening history",
    added: "2026-01-30",
    auth: "oauth refresh ok",
    schedule: "every 15 min",
    lastRun: "ok · 12 min ago",
    streams: [{
      name: "listening_history",
      records: "6,597",
      cursor: "→ 05:41Z",
      searchable: true,
      last: "9 h ago"
    }]
  }],
  partial: {
    con: "cc2",
    revokedOn: "May 28",
    streams: ["sessions", "messages", "attachments", "skills"],
    raw: "RS /v1/streams/sessions/records → 400 connector_instance_inactive · req_b8d6ec07"
  },
  records: [/* ── Fri, Jun 12 ── */
  {
    id: "rec_cdx_s_0911",
    con: "cdx",
    stream: "sessions",
    day: "2026-06-12",
    rel: "7 min ago",
    title: "Pick up yesterday's auth review thread and summarize the open items…",
    fields: [["prompt", "Pick up yesterday's auth review thread and summarize the open items…"], ["model", "gpt-5.5"], ["turns", "31"], ["started", "2026-06-12 14:48Z"]]
  }, {
    id: "rec_cdx_s_0910",
    con: "cdx",
    stream: "sessions",
    day: "2026-06-12",
    rel: "22 min ago",
    title: "Bounded task: implement admin management for the waitlist service…",
    links: [["messages in session", "rec_cdx_m_4410"], ["tool calls", "rec_cdx_f_fold1"]],
    fields: [["prompt", "Bounded task: implement admin management for the waitlist service…"], ["model", "gpt-5.5 · low"], ["turns", "58"], ["started", "2026-06-12 14:21Z"]]
  }, {
    id: "rec_cdx_m_4410",
    con: "cdx",
    stream: "messages",
    day: "2026-06-12",
    rel: "22 min ago",
    role: "assistant",
    title: "All checks are green — build, tests, typecheck. PR is ready for review.",
    links: [["session", "rec_cdx_s_0910"]],
    fields: [["role", "assistant"], ["session", "ses_a41"], ["chars", "212"], ["content", "All checks are green — build, tests, typecheck. PR is ready for review."]]
  }, {
    id: "rec_cdx_m_4409",
    con: "cdx",
    stream: "messages",
    day: "2026-06-12",
    rel: "22 min ago",
    role: "developer",
    degraded: true,
    title: "no text — tool turn",
    links: [["session", "rec_cdx_s_0910"]],
    fields: [["role", "developer"], ["session", "ses_a41"], ["content", "— (tool output only)"]]
  }, {
    id: "rec_cdx_f_fold1",
    con: "cdx",
    stream: "function_calls",
    day: "2026-06-12",
    rel: "22 min ago",
    fold: 9,
    title: "9 tool calls in 4 minutes",
    snippet: "exec_command ×6 · write_stdin ×3",
    links: [["session", "rec_cdx_s_0910"]],
    fields: [["calls", "9"], ["span", "4 min"], ["breakdown", "exec_command ×6 · write_stdin ×3"], ["session", "ses_a41"]]
  }, {
    id: "rec_gh_r_0182",
    con: "gh",
    stream: "repositories",
    day: "2026-06-12",
    rel: "23 min ago",
    title: "recordroom",
    fields: [["repo", "mokafor/recordroom"], ["visibility", "private"], ["pushed", "2026-06-12 14:39Z"], ["open_prs", "2"]]
  }, {
    id: "rec_gm1_t_2210",
    con: "gm1",
    stream: "threads",
    day: "2026-06-12",
    rel: "31 min ago",
    title: "Your June 12 pay is on its way",
    links: [["message", "rec_gm1_m_5121"], ["body", "rec_gm1_b_5121"]],
    fields: [["subject", "Your June 12 pay is on its way"], ["messages", "1"], ["participants", "payroll@northstar-hr.example"]]
  }, {
    id: "rec_gm1_m_5121",
    con: "gm1",
    stream: "messages",
    day: "2026-06-12",
    rel: "31 min ago",
    degraded: true,
    title: "no subject",
    snippet: "received 14:28Z · from payroll@northstar-hr.example",
    links: [["thread", "rec_gm1_t_2210"], ["body", "rec_gm1_b_5121"]],
    fields: [["from", "payroll@northstar-hr.example"], ["received", "2026-06-12 14:28Z"], ["subject", "—"], ["size", "12 KB"]]
  }, {
    id: "rec_gm1_b_5121",
    con: "gm1",
    stream: "message_bodies",
    day: "2026-06-12",
    rel: "31 min ago",
    degraded: true,
    title: "message body · utf-8 · 38 KB",
    links: [["message", "rec_gm1_m_5121"], ["thread", "rec_gm1_t_2210"]],
    fields: [["charset", "utf-8"], ["bytes", "38,114"], ["message_ref", "rec_gm1_m_5121"], ["text", "Hi M. — your pay for the period ending Jun 12 has been issued…"]]
  }, {
    id: "rec_ps_0313",
    con: "nh",
    stream: "pay_statements",
    day: "2026-06-12",
    rel: "33 min ago",
    title: "Acme Co · Jun 2026",
    snippet: "net $3,508.12",
    fields: [["employer", "Acme Co"], ["period_start", "2026-06-01"], ["period_end", "2026-06-12"], ["gross_pay", "$5,210.00"], ["net_pay", "$3,508.12"], ["taxes_withheld", "$1,214.38"], ["benefits_detail", "401k 5% · health PPO"], ["bank_routing", "checking ····4417"]]
  }, {
    id: "rec_gh_r_0181",
    con: "gh",
    stream: "repositories",
    day: "2026-06-12",
    rel: "1 h ago",
    title: "pdpp-spec",
    fields: [["repo", "mokafor/pdpp-spec"], ["visibility", "public"], ["pushed", "2026-06-12 14:02Z"], ["open_prs", "0"]]
  }, {
    id: "rec_cg_c_0871",
    con: "cg",
    stream: "conversations",
    day: "2026-06-12",
    rel: "2 h ago",
    title: "Summarize my May spending by category",
    fields: [["title", "Summarize my May spending by category"], ["messages", "14"], ["model", "gpt-5.5"], ["started", "2026-06-12 12:40Z"]]
  }, {
    id: "rec_cdx_s_fold2",
    con: "cdx",
    stream: "sessions",
    day: "2026-06-12",
    rel: "3–11 h ago",
    fold: 4,
    title: "4 connector test pings",
    snippet: "\u201cReply with exactly: ok\u201d ×4",
    fields: [["pings", "4"], ["span", "8 h"], ["prompt", "Reply with exactly: ok"]]
  }, {
    id: "rec_lh_6597",
    con: "tn",
    stream: "listening_history",
    day: "2026-06-12",
    rel: "9 h ago",
    title: "Hejira — Joni Mitchell",
    snippet: "kitchen speaker · 05:41Z",
    fields: [["track", "Hejira"], ["artist", "Joni Mitchell"], ["played_at", "2026-06-12 05:41Z"], ["device", "kitchen speaker"], ["playlist_ref", "morning"]]
  }, {
    id: "rec_lh_6596",
    con: "tn",
    stream: "listening_history",
    day: "2026-06-12",
    rel: "9 h ago",
    title: "Pyramids — Frank Ocean",
    snippet: "kitchen speaker · 05:32Z",
    fields: [["track", "Pyramids"], ["artist", "Frank Ocean"], ["played_at", "2026-06-12 05:32Z"], ["device", "kitchen speaker"], ["playlist_ref", "morning"]]
  }, {
    id: "rec_gh_u_0044",
    con: "gh",
    stream: "user_stats",
    day: "2026-06-12",
    rel: "15 h ago",
    degraded: true,
    title: "daily stats snapshot · 2026-06-12",
    fields: [["date", "2026-06-12"], ["commits", "9"], ["prs_opened", "1"], ["reviews", "3"]]
  }, /* ── Thu, Jun 11 ── */
  {
    id: "rec_gm1_m_5108",
    con: "gm1",
    stream: "messages",
    day: "2026-06-11",
    rel: "16 h ago",
    title: "New sign-in detected on your hosting account",
    snippet: "Chrome on macOS · Tacoma, WA",
    fields: [["from", "security@hosting.example"], ["subject", "New sign-in detected on your hosting account"], ["received", "2026-06-11 23:09Z"], ["size", "9 KB"]]
  }, {
    id: "rec_cc1_s_0392",
    con: "cc1",
    stream: "sessions",
    day: "2026-06-11",
    rel: "20 h ago",
    title: "Refactor the DS compiler's error messages for clarity…",
    links: [["messages in session", "rec_cc1_m_1840"]],
    fields: [["prompt", "Refactor the DS compiler's error messages for clarity…"], ["model", "fable-4"], ["turns", "22"], ["started", "2026-06-11 19:02Z"]]
  }, {
    id: "rec_cc1_m_1840",
    con: "cc1",
    stream: "messages",
    day: "2026-06-11",
    rel: "20 h ago",
    role: "assistant",
    title: "Renamed the diagnostics — all 14 fixtures pass.",
    links: [["session", "rec_cc1_s_0392"]],
    fields: [["role", "assistant"], ["session", "ses_c12"], ["chars", "148"], ["content", "Renamed the diagnostics — all 14 fixtures pass."]]
  }, {
    id: "rec_gm2_m_7011",
    con: "gm2",
    stream: "messages",
    day: "2026-06-11",
    rel: "20 h ago",
    title: "Receipt — storage unit autopay",
    snippet: "label:receipts · next payment 7/11",
    links: [["attachment", "rec_gm2_a_0310"]],
    fields: [["from", "billing@extraspace.example"], ["subject", "Receipt — storage unit autopay"], ["label", "receipts"], ["received", "2026-06-11 19:40Z"], ["size", "640 KB"]]
  }, {
    id: "rec_gm2_a_0310",
    con: "gm2",
    stream: "attachments",
    day: "2026-06-11",
    rel: "20 h ago",
    image: true,
    title: "receipt-scan.jpg",
    snippet: "image/jpeg · 412 KB",
    links: [["message", "rec_gm2_m_7011"]],
    fields: [["filename", "receipt-scan.jpg"], ["content_type", "image/jpeg"], ["bytes", "412,381"], ["message_ref", "rec_gm2_m_7011"]]
  }, {
    id: "rec_cg_m_3301",
    con: "cg",
    stream: "messages",
    day: "2026-06-11",
    rel: "20 h ago",
    role: "system",
    degraded: true,
    title: "no text — system turn",
    fields: [["role", "system"], ["conversation", "cnv_864"], ["content", "—"]]
  }, {
    id: "rec_cg_c_0864",
    con: "cg",
    stream: "conversations",
    day: "2026-06-11",
    rel: "21 h ago",
    title: "Quick meatball recipes",
    fields: [["title", "Quick meatball recipes"], ["messages", "6"], ["model", "gpt-5.5"], ["started", "2026-06-11 18:55Z"]]
  }, {
    id: "rec_gh_r_0179",
    con: "gh",
    stream: "repositories",
    day: "2026-06-11",
    rel: "22 h ago",
    title: "ds-compiler",
    fields: [["repo", "mokafor/ds-compiler"], ["visibility", "private"], ["pushed", "2026-06-11 17:20Z"], ["open_prs", "1"]]
  }, {
    id: "rec_lh_6580",
    con: "tn",
    stream: "listening_history",
    day: "2026-06-11",
    rel: "1 d ago",
    title: "Both Sides Now — Joni Mitchell",
    snippet: "living room · 22:14Z",
    fields: [["track", "Both Sides Now"], ["artist", "Joni Mitchell"], ["played_at", "2026-06-11 22:14Z"], ["device", "living room"], ["playlist_ref", "—"]]
  }, /* ── Wed, Jun 10 ── */
  {
    id: "rec_tx_41203",
    con: "fm",
    stream: "transactions",
    day: "2026-06-10",
    rel: "2 d ago",
    title: "Blue Bottle Coffee",
    snippet: "−$6.40 · coffee & cafes",
    fields: [["date", "2026-06-10"], ["amount", "−$6.40"], ["merchant", "Blue Bottle Coffee"], ["category", "coffee & cafes"], ["account_ref", "checking ····4417"], ["memo", "card present"]]
  }, {
    id: "rec_tx_41202",
    con: "fm",
    stream: "transactions",
    day: "2026-06-10",
    rel: "2 d ago",
    title: "Rainier Grocery",
    snippet: "−$54.20 · groceries",
    fields: [["date", "2026-06-10"], ["amount", "−$54.20"], ["merchant", "Rainier Grocery"], ["category", "groceries"], ["account_ref", "checking ····4417"], ["memo", "—"]]
  }, {
    id: "rec_tx_41195",
    con: "fm",
    stream: "transactions",
    day: "2026-06-10",
    rel: "2 d ago",
    title: "Hawthorne Property Mgmt",
    snippet: "−$1,850.00 · rent · june",
    fields: [["date", "2026-06-10"], ["amount", "−$1,850.00"], ["merchant", "Hawthorne Property Mgmt"], ["category", "rent"], ["account_ref", "checking ····4417"], ["memo", "june"]]
  }, {
    id: "rec_cc1_s_0388",
    con: "cc1",
    stream: "sessions",
    day: "2026-06-10",
    rel: "2 d ago",
    title: "Sketch the consent ceremony copy variants…",
    fields: [["prompt", "Sketch the consent ceremony copy variants…"], ["model", "fable-4"], ["turns", "9"], ["started", "2026-06-10 16:11Z"]]
  }, {
    id: "rec_gh_r_0175",
    con: "gh",
    stream: "repositories",
    day: "2026-06-10",
    rel: "2 d ago",
    title: "pdpp-explorer",
    fields: [["repo", "mokafor/pdpp-explorer"], ["visibility", "public"], ["pushed", "2026-06-10 15:44Z"], ["open_prs", "0"]]
  }]
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "recordroom/rr-explore-data.js", error: String((e && e.message) || e) }); }

// recordroom/rr-explore.jsx
try { (() => {
/* RECORDROOM — Explore: the reading room. One record viewer for the whole
   product. Owner-grade query power (typed operators, machine-parity query
   line), instance-true facets, full fields always, relationships, images.
   Sources is the loading dock; it links INTO this view, never duplicates it. */
;
(() => {
  const {
    useState,
    useEffect,
    useMemo
  } = React;
  const RRX = window.RRX;
  const {
    labelFor,
    nounFor,
    displayTitle,
    RecordBody
  } = window.RRREC;
  const conById = {};
  RRX.connections.forEach(c => {
    conById[c.id] = c;
  });
  const recById = {};
  RRX.records.forEach(r => {
    recById[r.id] = r;
  });

  /* Reverse links: every relationship reads in both directions. */
  const backlinks = {};
  RRX.records.forEach(r => {
    (r.links || []).forEach(([rel, id]) => {
      backlinks[id] = backlinks[id] || [];
      backlinks[id].push(["linked from " + r.stream, r.id]);
    });
  });
  function CopyMono({
    text
  }) {
    const [ok, setOk] = useState(false);
    return /*#__PURE__*/React.createElement("button", {
      className: "pdpp-sheet__serial rr-copyid",
      onClick: () => {
        navigator.clipboard && navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      },
      title: "Copy",
      type: "button"
    }, ok ? "copied" : text);
  }

  /* ── Query language: free text + typed operators, the same axes the RS
     API exposes. con: stream: role: has:image|link  is:folded  before:/after:
     <date>  field:value (matches any field key~value). Everything composes. */
  function parseQuery(q) {
    const out = {
      text: [],
      con: null,
      stream: null,
      role: null,
      hasImage: false,
      hasLink: false,
      folded: false,
      before: null,
      after: null,
      fields: [],
      tokens: []
    };
    q.trim().split(/\s+/).filter(Boolean).forEach(tok => {
      const m = tok.match(/^([a-z_]+):(.+)$/i);
      if (!m) {
        out.text.push(tok.toLowerCase());
        out.tokens.push({
          raw: tok,
          label: tok
        });
        return;
      }
      const k = m[1].toLowerCase(),
        v = m[2],
        kv = v.toLowerCase();
      if (k === "con") {
        out.con = kv;
        out.tokens.push({
          raw: tok,
          label: "in " + v
        });
      } else if (k === "stream") {
        out.stream = kv;
        out.tokens.push({
          raw: tok,
          label: "stream: " + v
        });
      } else if (k === "role") {
        out.role = kv;
        out.tokens.push({
          raw: tok,
          label: "role: " + v
        });
      } else if (k === "has" && kv === "image") {
        out.hasImage = true;
        out.tokens.push({
          raw: tok,
          label: "has image"
        });
      } else if (k === "has" && kv === "link") {
        out.hasLink = true;
        out.tokens.push({
          raw: tok,
          label: "has link"
        });
      } else if (k === "is" && kv === "folded") {
        out.folded = true;
        out.tokens.push({
          raw: tok,
          label: "folded"
        });
      } else if (k === "before") {
        out.before = v;
        out.tokens.push({
          raw: tok,
          label: "before " + v
        });
      } else if (k === "after") {
        out.after = v;
        out.tokens.push({
          raw: tok,
          label: "after " + v
        });
      } else {
        out.fields.push([k, kv]);
        out.tokens.push({
          raw: tok,
          label: k + ": " + v
        });
      }
    });
    return out;
  }
  function ExploreView({
    grants,
    onGo,
    onJump,
    seed
  }) {
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
        const ft = (r.fields || []).map(f => f[0] + " " + f[1]).join(" ");
        const hay = (r.title + " " + (r.snippet || "") + " " + r.stream + " " + con.name + " " + ft).toLowerCase();
        if (!parsed.text.every(t => hay.includes(t))) return false;
      }
      return true;
    }
    const rows = useMemo(() => {
      let list = RRX.records.filter(r => passes(r));
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
      if (range === "today") parts.push("since=" + RRX.now);else if (range === "7d") parts.push("since=2026-06-06");else if (range === "30d") parts.push("since=2026-05-13");
      if (parsed.text.length) parts.push("match=" + parsed.text.join("+"));
      parts.push("order=" + sort, "limit=50");
      return "GET /v1/records?" + parts.join("&");
    }, [parsed, range, conSel, streamSel, sort]);

    /* Streams facet: instance-true when a connection is selected;
       otherwise an explicit NAME-match filter (overlap is incidental). */
    const streamFacets = useMemo(() => {
      if (conSel) return conById[conSel].streams.map(s => [s.name, s.records]);
      const m = {};
      RRX.connections.forEach(c => c.streams.forEach(s => {
        m[s.name] = (m[s.name] || 0) + 1;
      }));
      return Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    }, [conSel]);
    const rec = recById[sel] || rows[0] || RRX.records[0];
    const recCon = conById[rec.con];
    const watchers = grants.filter(g => g.status !== "revoked" && g.projections && g.projections[rec.stream]);
    const lensGrant = lens ? watchers.find(g => g.id === lens) : null;
    const proj = lensGrant && rec.fields ? lensGrant.projections[rec.stream] : null;
    const baseFields = rec.fields || [];
    const shown = proj ? baseFields.filter(([k]) => proj.includes(k)) : baseFields;
    const kept = proj ? baseFields.filter(([k]) => !proj.includes(k)) : [];
    const fwdIds = new Set((rec.links || []).map(([, id]) => id));
    const related = [...(rec.links || []).map(([rel, id]) => [rel, id]), ...(backlinks[rec.id] || []).filter(([, id]) => !fwdIds.has(id))].filter(([, id]) => recById[id]);
    useEffect(() => {
      setLens(null);
    }, [sel]);
    useEffect(() => {
      function onKey(e) {
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        if (document.querySelector(".rr-overlay, .rr-palette-overlay")) return;
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const i = rows.findIndex(r => r.id === sel);
        const n = e.key === "ArrowDown" ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0);
        if (rows[n]) setSel(rows[n].id);
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [rows, sel]);
    const showPartial = !conSel || conSel === RRX.partial.con;
    const partialCon = conById[RRX.partial.con];
    const activeChips = [];
    if (conSel) activeChips.push({
      id: "con",
      label: conById[conSel].name,
      clear: () => setConSel(null)
    });
    if (streamSel) activeChips.push({
      id: "stream",
      label: "stream: " + streamSel,
      clear: () => setStreamSel(null)
    });
    if (range !== "all") activeChips.push({
      id: "range",
      label: range,
      clear: () => setRange("all")
    });
    parsed.tokens.forEach((tk, i) => activeChips.push({
      id: "tok" + i,
      label: tk.label,
      clear: () => setQ(q.split(/\s+/).filter(x => x !== tk.raw).join(" "))
    }));
    const clearAll = () => {
      setConSel(null);
      setStreamSel(null);
      setRange("all");
      setQ("");
    };
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-x"
    }, /*#__PURE__*/React.createElement("aside", {
      className: "rr-x-rail"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-x-facets"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-x-facets__label"
    }, "Connections"), RRX.connections.map(c => {
      const n = RRX.records.filter(r => r.con === c.id && passes(r, {
        ignoreCon: true
      })).length;
      return /*#__PURE__*/React.createElement("button", {
        className: "rr-x-facet" + (conSel === c.id ? " is-on" : "") + (c.status === "revoked" ? " is-revoked" : ""),
        key: c.id,
        onClick: () => {
          setConSel(conSel === c.id ? null : c.id);
          setStreamSel(null);
        },
        type: "button"
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-x-facet__name"
      }, c.name), c.status === "revoked" && /*#__PURE__*/React.createElement("span", {
        className: "rr-x-facet__flag"
      }, "off"), c.status === "reauth" && /*#__PURE__*/React.createElement("span", {
        className: "rr-x-facet__flag is-warn"
      }, "auth"), /*#__PURE__*/React.createElement("span", {
        className: "rr-x-facet__n"
      }, n || "—"));
    })), /*#__PURE__*/React.createElement("div", {
      className: "rr-x-facets"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-x-facets__label"
    }, conSel ? "Streams — " + conById[conSel].name : "Stream names"), !conSel && /*#__PURE__*/React.createElement("span", {
      className: "rr-x-facets__note"
    }, "names overlap across connections \u2014 this filters by name"), streamFacets.map(([s, n]) => /*#__PURE__*/React.createElement("button", {
      className: "rr-x-facet" + (streamSel === s ? " is-on" : ""),
      key: s,
      onClick: () => setStreamSel(streamSel === s ? null : s),
      type: "button"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-x-facet__name rr-x-facet__name--mono"
    }, s), /*#__PURE__*/React.createElement("span", {
      className: "rr-x-facet__n"
    }, conSel ? n : n + " conn"))))), /*#__PURE__*/React.createElement("div", {
      className: "rr-x-main"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-x-controls"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-x-searchrow"
    }, /*#__PURE__*/React.createElement("input", {
      className: "pdpp-input rr-x-search",
      onChange: e => setQ(e.target.value),
      placeholder: "Search names, fields, and values \u2014 or type an operator",
      type: "text",
      value: q
    }), /*#__PURE__*/React.createElement("div", {
      className: "rr-x-sort"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-x-sort__label"
    }, "sort"), /*#__PURE__*/React.createElement("button", {
      className: "rr-lens" + (sort === "newest" ? " is-on" : ""),
      onClick: () => setSort("newest"),
      type: "button"
    }, "newest"), /*#__PURE__*/React.createElement("button", {
      className: "rr-lens" + (sort === "oldest" ? " is-on" : ""),
      onClick: () => setSort("oldest"),
      type: "button"
    }, "oldest"))), /*#__PURE__*/React.createElement("div", {
      className: "rr-x-ranges"
    }, [["today", "today"], ["7d", "7d"], ["30d", "30d"], ["all", "all"]].map(([v, label]) => /*#__PURE__*/React.createElement("button", {
      className: "rr-lens" + (range === v ? " is-on" : ""),
      key: v,
      onClick: () => setRange(v),
      type: "button"
    }, label)), /*#__PURE__*/React.createElement("details", {
      className: "rr-x-help"
    }, /*#__PURE__*/React.createElement("summary", null, "operators"), /*#__PURE__*/React.createElement("div", {
      className: "rr-x-help__body"
    }, /*#__PURE__*/React.createElement("code", null, "con:"), " ", /*#__PURE__*/React.createElement("code", null, "stream:"), " ", /*#__PURE__*/React.createElement("code", null, "role:"), " ", /*#__PURE__*/React.createElement("code", null, "has:image"), " ", /*#__PURE__*/React.createElement("code", null, "has:link"), " ", /*#__PURE__*/React.createElement("code", null, "is:folded"), " ", /*#__PURE__*/React.createElement("code", null, "before:2026-06-11"), " ", /*#__PURE__*/React.createElement("code", null, "after:2026-06-10"), " ", /*#__PURE__*/React.createElement("code", null, "merchant:coffee"), " \u2014 combine freely; everything composes.")), /*#__PURE__*/React.createElement("button", {
      className: "rr-link rr-x-jump",
      onClick: onJump,
      type: "button"
    }, "jump to an id \u2192")), activeChips.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "rr-x-active"
    }, activeChips.map(c => /*#__PURE__*/React.createElement("button", {
      className: "rr-x-chip",
      key: c.id,
      onClick: c.clear,
      type: "button"
    }, c.label, /*#__PURE__*/React.createElement("span", {
      className: "rr-x-chip__x"
    }, "\xD7"))), /*#__PURE__*/React.createElement("button", {
      className: "rr-x-clearall",
      onClick: clearAll,
      type: "button"
    }, "clear all")), /*#__PURE__*/React.createElement("div", {
      className: "rr-x-compiled"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-x-compiled__label"
    }, "the same call any client makes:"), /*#__PURE__*/React.createElement(CopyMono, {
      text: compiled
    }))), /*#__PURE__*/React.createElement("p", {
      className: "rr-x-pulse__note"
    }, recordCount, " records shown \xB7 ", RRX.totalOnServer, " on your server"), showPartial && /*#__PURE__*/React.createElement("div", {
      className: "rr-x-partial"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rr-x-partial__head",
      onClick: () => setPartialOpen(!partialOpen),
      type: "button"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-x-partial__line"
    }, "Partial view \u2014 ", partialCon.name, " didn't answer for ", RRX.partial.streams.length, " streams"), /*#__PURE__*/React.createElement("span", {
      className: "rr-x-partial__toggle"
    }, partialOpen ? "less" : "why")), partialOpen && /*#__PURE__*/React.createElement("div", {
      className: "rr-x-partial__body"
    }, /*#__PURE__*/React.createElement("p", {
      className: "rr-x-partial__expl"
    }, "This connection was revoked ", RRX.partial.revokedOn, ". Its streams (", RRX.partial.streams.join(", "), ") refuse new reads \u2014 that's the revocation holding, not a fault. Records ingested before revocation remain on your server."), /*#__PURE__*/React.createElement("code", {
      className: "rr-x-partial__raw"
    }, RRX.partial.raw), /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      onClick: () => onGo("sources"),
      type: "button"
    }, "review in Sources \u2192"))), RRX.days.map(([day, label]) => {
      const dayRows = rows.filter(r => r.day === day);
      if (dayRows.length === 0) return null;
      return /*#__PURE__*/React.createElement("div", {
        className: "rr-x-day",
        key: day
      }, /*#__PURE__*/React.createElement("div", {
        className: "rr-x-day__head"
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-x-day__label"
      }, label), /*#__PURE__*/React.createElement("span", {
        className: "rr-x-day__n"
      }, dayRows.reduce((n, r) => n + (r.fold || 1), 0))), dayRows.map(r => /*#__PURE__*/React.createElement("button", {
        className: "rr-x-row" + (sel === r.id ? " is-selected" : "") + (r.fold ? " is-fold" : ""),
        key: r.id,
        onClick: () => setSel(r.id),
        type: "button"
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-x-row__attr"
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-x-row__stream"
      }, r.stream), /*#__PURE__*/React.createElement("span", {
        className: "rr-x-row__con"
      }, conById[r.con].name), /*#__PURE__*/React.createElement("span", {
        className: "rr-x-row__rel"
      }, r.rel)), /*#__PURE__*/React.createElement("span", {
        className: "rr-x-row__title" + (r.degraded ? " is-derived" : "")
      }, r.fold ? /*#__PURE__*/React.createElement("span", {
        className: "rr-x-mark"
      }, "folded") : null, r.image ? /*#__PURE__*/React.createElement("span", {
        className: "rr-x-mark"
      }, "image") : null, (() => {
        const dt = displayTitle(r);
        return dt.kicker ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
          className: "rr-x-kicker"
        }, dt.kicker), dt.primary) : dt.primary;
      })()), (r.role || r.snippet) && /*#__PURE__*/React.createElement("span", {
        className: "rr-x-row__snippet"
      }, r.role && /*#__PURE__*/React.createElement("span", {
        className: "rr-x-role"
      }, r.role), r.snippet))));
    }), rows.length === 0 && /*#__PURE__*/React.createElement("div", {
      className: "rr-x-empty"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-x-empty__line"
    }, "Nothing matches", q ? ` \u201c${q}\u201d` : "", " in this window."), /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      onClick: () => {
        setQ("");
        setConSel(null);
        setStreamSel(null);
        setRange("all");
      },
      type: "button"
    }, "clear filters \u2192"))), /*#__PURE__*/React.createElement("div", {
      className: "rr-inspector"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-anim-swap",
      key: rec.id + (lens || "you")
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__head"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "pdpp-sheet__title rr-x-sheet-title"
    }, (() => {
      const dt = displayTitle(rec);
      return dt.kicker ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
        className: "rr-x-kicker"
      }, dt.kicker), dt.primary) : dt.primary;
    })()), /*#__PURE__*/React.createElement(CopyMono, {
      text: rec.id
    })), watchers.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "rr-ex-lens"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-ex-lens__label"
    }, "read it as"), /*#__PURE__*/React.createElement("button", {
      className: "rr-lens" + (!lens ? " is-on" : ""),
      onClick: () => setLens(null),
      type: "button"
    }, "you"), watchers.map(g => /*#__PURE__*/React.createElement("button", {
      className: "rr-lens" + (lens === g.id ? " is-on" : ""),
      key: g.id,
      onClick: () => setLens(lens === g.id ? null : g.id),
      type: "button"
    }, g.client))), watchers.length === 0 && /*#__PURE__*/React.createElement("p", {
      className: "rr-ex-alone"
    }, /*#__PURE__*/React.createElement("b", null, "Only you can read this."), " No grant covers ", rec.stream, " on ", recCon.name, " \u2014 nothing here crosses."), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__body"
    }, /*#__PURE__*/React.createElement(RecordBody, {
      pairs: shown,
      rec: rec
    }), rec.fold && /*#__PURE__*/React.createElement("p", {
      className: "rr-x-foldnote"
    }, "Folded in the feed \u2014 every call is kept in the stream, unabridged."), rec.degraded && /*#__PURE__*/React.createElement("p", {
      className: "rr-x-foldnote"
    }, "Title derived from the fields below \u2014 every field is listed."), kept.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "rr-ex-keep"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-ex-keep__label"
    }, "Stays with you"), /*#__PURE__*/React.createElement("span", {
      className: "rr-ex-keep__fields"
    }, kept.map(([k]) => labelFor(k)).join(" · ")), /*#__PURE__*/React.createElement("span", {
      className: "rr-ex-keep__note"
    }, kept.length, " ", kept.length === 1 ? "field" : "fields", " never leave your server \u2014 never sent, not blacked out.")), related.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "rr-x-rel"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-ex-keep__label"
    }, "Connected"), related.map(([relName, id]) => {
      const dt = displayTitle(recById[id]);
      return /*#__PURE__*/React.createElement("button", {
        className: "rr-x-rel__row",
        key: relName + id,
        onClick: () => setSel(id),
        type: "button"
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-x-rel__k"
      }, relName), /*#__PURE__*/React.createElement("span", {
        className: "rr-x-rel__v"
      }, dt.kicker ? dt.kicker + " · " + dt.primary : dt.primary));
    }))), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__foot"
    }, proj ? /*#__PURE__*/React.createElement("span", {
      className: "pdpp-copyline"
    }, shown.length, " of ", baseFields.length, " fields cross to ", lensGrant.client, " \xB7 enforced on every read") : /*#__PURE__*/React.createElement("span", {
      className: "pdpp-typed-sm",
      style: {
        color: "var(--muted-foreground)"
      }
    }, baseFields.length, " fields \xB7 readable by you", watchers.length > 0 ? ` · ${watchers.length} ${watchers.length === 1 ? "grant reads" : "grants read"} a projection` : ""))))));
  }
  Object.assign(window, {
    RRExploreView: ExploreView
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "recordroom/rr-explore.jsx", error: String((e && e.message) || e) }); }

// recordroom/rr-overview.jsx
try { (() => {
/* RECORDROOM — "Standing": the home as the product's point of view.
   Person-first language, one hero truth, the owner's three questions,
   calm↔alarm emotional center, a deliberate warm reassurance moment. */
;
(() => {
  const {
    useState
  } = React;
  const RR2 = window.RR2;

  /* ── Plain-language lexicon: scope → what it means to a person ── */
  const SCOPE_HUMAN = {
    "pay_statements.read": "your pay",
    "employment.read": "your employment history",
    "listening_history.read": "what you listen to",
    "transactions.read": "your spending",
    "tax_docs.read": "your tax documents",
    "browsing.read": "your browsing"
  };
  function scopeHuman(name) {
    return SCOPE_HUMAN[name] || name.replace(/\.read$/, "").replace(/_/g, " ");
  }

  /* ── What holds BEARER access — acts as you, reads everything. The tier
        most owners actually use; grants are the scoped minority case. ── */
  const BEARER = [{
    who: "Claude Desktop",
    how: "owner token · MCP",
    last: "read everything · 2 h ago",
    kind: "app"
  }, {
    who: "CLI on framework",
    how: "owner token",
    last: "last used yesterday",
    kind: "key"
  }];
  function joinHuman(arr) {
    if (arr.length <= 1) return arr[0] || "";
    if (arr.length === 2) return arr[0] + " and " + arr[1];
    return arr.slice(0, -1).join(", ") + ", and " + arr[arr.length - 1];
  }
  const STREAM_RECORD_NOUN = {
    pay_statements: "pay records",
    employment: "employment records",
    listening_history: "listening records",
    tax_docs: "tax records",
    transactions: "transactions"
  };
  function recordNoun(stream) {
    return STREAM_RECORD_NOUN[stream] || stream.replace(/_/g, " ") + " records";
  }
  function relDay(t) {
    // t like "2026-06-11 07:58:12Z"; now is 2026-06-12
    const d = t.slice(0, 10);
    if (d === "2026-06-12") return "today";
    if (d === "2026-06-11") return "yesterday";
    if (d === "2026-05-02") return "May 2";
    return d.slice(5);
  }
  function Overview({
    grants,
    requestState,
    onReview,
    onGo,
    onOpenGrant
  }) {
    const [resolved, setResolved] = useState(false);
    const active = grants.filter(g => g.status !== "revoked");
    const pending = requestState === "pending";
    const hasFailure = !resolved; // First Meridian sync, part of the standing fixture

    /* ── The hero: one truth, computed from state ── */
    let hero;
    if (pending) {
      hero = {
        tone: "decide",
        kicker: "A request is waiting on you",
        line: /*#__PURE__*/React.createElement(React.Fragment, null, "Atlas Mortgage wants to read ", /*#__PURE__*/React.createElement("em", null, "your pay, employment, and spending"), "."),
        sub: "Nothing leaves until you say so — approve it one piece at a time.",
        cta: /*#__PURE__*/React.createElement("button", {
          className: "pdpp-btn pdpp-btn--human",
          onClick: onReview,
          type: "button"
        }, "Review the request")
      };
    } else if (hasFailure) {
      hero = {
        tone: "alarm",
        kicker: "One thing needs you",
        line: /*#__PURE__*/React.createElement(React.Fragment, null, "Your bank data ", /*#__PURE__*/React.createElement("em", null, "stopped arriving"), " on Jun 11."),
        sub: "First Meridian's connection expired. Nothing you already have is lost — but nothing new arrives until you reconnect.",
        cta: /*#__PURE__*/React.createElement("button", {
          className: "pdpp-btn pdpp-btn--sm",
          onClick: () => {
            setResolved(true);
          },
          type: "button"
        }, "Reconnect the bank")
      };
    } else {
      hero = {
        tone: "calm",
        kicker: "Where you stand",
        line: /*#__PURE__*/React.createElement(React.Fragment, null, "48,120 records from 10 sources \u2014 ", /*#__PURE__*/React.createElement("em", null, "all yours to read"), "."),
        sub: BEARER.length + " tokens can act as you, with full access. " + active.length + " apps read only the slices you granted. Revoke any of them instantly."
      };
    }

    /* ── What's crossed lately (humanized traces) ── */
    const lately = RR2.traces.slice(0, 4).map(tr => {
      if (tr.decision === "deny") {
        const why = tr.reason === "scope not granted" ? "you never allowed it" : tr.reason === "grant revoked" ? "you'd revoked it" : tr.reason;
        return {
          id: tr.id,
          when: relDay(tr.t),
          deny: true,
          text: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("b", null, tr.client), " tried to read ", tr.stream.replace(/_/g, " "), " \u2014 turned away, ", why, ".")
        };
      }
      return {
        id: tr.id,
        when: relDay(tr.t),
        deny: false,
        text: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("b", null, tr.client), " read ", tr.records, " ", recordNoun(tr.stream), " \u2014 ", tr.fields, " fields each.")
      };
    });
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-stand"
    }, /*#__PURE__*/React.createElement("section", {
      className: "rr-stand-hero is-" + hero.tone
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-stand-hero__kicker"
    }, hero.kicker), /*#__PURE__*/React.createElement("h1", {
      className: "rr-stand-hero__line"
    }, hero.line), /*#__PURE__*/React.createElement("p", {
      className: "rr-stand-hero__sub"
    }, hero.sub), hero.cta && /*#__PURE__*/React.createElement("div", {
      className: "rr-stand-hero__foot"
    }, hero.cta)), /*#__PURE__*/React.createElement("section", {
      className: "rr-stand-block"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-stand-block__head"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "rr-stand-block__title"
    }, "What can act as you"), /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      onClick: () => onGo("deployment"),
      type: "button"
    }, "owner tokens \u2192")), /*#__PURE__*/React.createElement("div", {
      className: "rr-bearer"
    }, BEARER.map(b => /*#__PURE__*/React.createElement("div", {
      className: "rr-bearer__row",
      key: b.who
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-bearer__who"
    }, b.who), /*#__PURE__*/React.createElement("span", {
      className: "rr-bearer__tag"
    }, "reads everything"), /*#__PURE__*/React.createElement("span", {
      className: "rr-bearer__how"
    }, b.how, " \xB7 ", b.last), /*#__PURE__*/React.createElement("button", {
      className: "rr-rel__revoke",
      onClick: () => onGo("deployment"),
      type: "button"
    }, "revoke"))), /*#__PURE__*/React.createElement("p", {
      className: "rr-bearer__note"
    }, "An owner token reads everything \u2014 every source, every field, exactly what you see. Keep the list short; revoke anytime."))), /*#__PURE__*/React.createElement("div", {
      className: "rr-stand-grid"
    }, /*#__PURE__*/React.createElement("section", {
      className: "rr-stand-block"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-stand-block__head"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "rr-stand-block__title"
    }, "Who can read parts of you"), /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      onClick: () => onGo("grants"),
      type: "button"
    }, "all grants \u2192")), /*#__PURE__*/React.createElement("div", {
      className: "rr-rel-list"
    }, active.map(g => /*#__PURE__*/React.createElement("div", {
      className: "rr-rel",
      key: g.id
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-rel__who"
    }, g.client), /*#__PURE__*/React.createElement("span", {
      className: "rr-rel__reads"
    }, "reads only ", joinHuman(g.scopes.map(s => scopeHuman(s.name)))), /*#__PURE__*/React.createElement("button", {
      className: "rr-rel__revoke",
      onClick: () => onOpenGrant(g.id),
      type: "button"
    }, "revoke"))), active.length === 0 && /*#__PURE__*/React.createElement("p", {
      className: "rr-stand-empty"
    }, "No grant is out. Nothing is shared \u2014 only you and what you've given a token read this server."))), /*#__PURE__*/React.createElement("section", {
      className: "rr-stand-block"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-stand-block__head"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "rr-stand-block__title"
    }, "What's been read"), /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      onClick: () => onGo("traces"),
      type: "button"
    }, "every read \u2192")), /*#__PURE__*/React.createElement("div", {
      className: "rr-lately"
    }, lately.map(e => /*#__PURE__*/React.createElement("div", {
      className: "rr-lately__row" + (e.deny ? " is-deny" : ""),
      key: e.id
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-lately__text"
    }, e.text), /*#__PURE__*/React.createElement("span", {
      className: "rr-lately__when"
    }, e.when)))))), /*#__PURE__*/React.createElement("section", {
      className: "rr-stand-block"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "rr-stand-block__title"
    }, "Anything wrong"), hasFailure ? window.RRAttentionList ? /*#__PURE__*/React.createElement(window.RRAttentionList, {
      onGo: onGo
    }) : null : /*#__PURE__*/React.createElement("div", {
      className: "rr-allclear"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-allclear__text"
    }, "Nothing needs you. Grants are within their limits, backups are on, and everything's syncing."))));
  }
  Object.assign(window, {
    RROverview2: Overview
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "recordroom/rr-overview.jsx", error: String((e && e.message) || e) }); }

// recordroom/rr-record.jsx
try { (() => {
/* RECORDROOM — the record type system. One sheet chrome, kind-aware bodies.
   Wire keys never leak alone: every field shows a human label AND its
   wire key (what a client literally receives). Long text gets a reading
   region; money gets tabular figures; derived titles get one grammar. */
;
(() => {
  /* ── Lexicon: wire key → human label. Fallback prettifies snake_case. ── */
  const FIELD_LABELS = {
    employer: "Employer",
    period_start: "Period start",
    period_end: "Period end",
    gross_pay: "Gross pay",
    net_pay: "Net pay",
    taxes_withheld: "Taxes withheld",
    benefits_detail: "Benefits",
    bank_routing: "Deposited to",
    date: "Date",
    amount: "Amount",
    merchant: "Merchant",
    category: "Category",
    account_ref: "Account",
    memo: "Memo",
    track: "Track",
    artist: "Artist",
    played_at: "Played",
    device: "Device",
    playlist_ref: "Playlist",
    from: "From",
    subject: "Subject",
    received: "Received",
    size: "Size",
    label: "Label",
    participants: "Participants",
    messages: "Messages",
    role: "Role",
    session: "Session",
    chars: "Length",
    content: "Message",
    model: "Model",
    charset: "Encoding",
    bytes: "Size",
    message_ref: "Message",
    text: "Body",
    repo: "Repository",
    visibility: "Visibility",
    pushed: "Last push",
    open_prs: "Open PRs",
    commits: "Commits",
    prs_opened: "PRs opened",
    reviews: "Reviews",
    title: "Title",
    started: "Started",
    prompt: "Prompt",
    turns: "Turns",
    calls: "Calls",
    span: "Over",
    breakdown: "Breakdown",
    pings: "Pings",
    filename: "File",
    content_type: "Type",
    doc_type: "Document",
    tax_year: "Tax year"
  };
  function prettify(k) {
    return k.replace(/_/g, " ").replace(/\bref\b/, "").trim().replace(/^\w/, c => c.toUpperCase());
  }
  function labelFor(k) {
    return FIELD_LABELS[k] || prettify(k);
  }
  const STREAM_NOUN = {
    messages: "message",
    message_bodies: "message body",
    threads: "thread",
    attachments: "attachment",
    sessions: "session",
    function_calls: "tool calls",
    conversations: "conversation",
    repositories: "repository",
    user_stats: "stats snapshot",
    pay_statements: "pay statement",
    transactions: "transaction",
    listening_history: "play",
    tax_docs: "document",
    employment: "record",
    balances: "balance",
    statements: "statement",
    skills: "skill",
    user: "record"
  };
  function nounFor(stream) {
    return STREAM_NOUN[stream] || "record";
  }
  function fieldMap(rec) {
    return Object.fromEntries((rec.fields || []).map(f => [f[0], f[1]]));
  }

  /* ── Kind dispatch — by field signature, not stream name (a "messages"
        stream is email from Gmail but an agent turn from Codex). ── */
  function kindOf(rec) {
    const k = new Set((rec.fields || []).map(f => f[0]));
    if (rec.image || k.has("filename") || k.has("content_type")) return "attachment";
    if (k.has("amount") || k.has("gross_pay") || k.has("net_pay")) return "money";
    if (k.has("track") || k.has("artist")) return "media";
    if (k.has("charset") && k.has("text")) return "body";
    if (k.has("role")) return "agent";
    if (k.has("from") || k.has("subject") || k.has("participants")) return "email";
    if (k.has("repo") || k.has("commits")) return "code";
    return "generic";
  }
  const MONEY_RE = /^[−-]?\$|^\$/;
  function isMoneyVal(v) {
    return typeof v === "string" && MONEY_RE.test(v);
  }
  function isLongVal(key, v) {
    return (key === "text" || key === "content") && typeof v === "string" && v.length > 56;
  }

  /* ── One derived-title grammar. Never "no X" — a quiet kicker + a fact. ── */
  function displayTitle(rec) {
    if (!rec.degraded) return {
      primary: rec.title,
      kicker: null
    };
    const f = fieldMap(rec);
    const noun = nounFor(rec.stream);
    let hint = "";
    if (f.from) hint = "from " + f.from;else if (f.role) hint = f.role + " turn";else if (f.bytes || f.charset) hint = [f.charset, f.bytes ? Math.round(String(f.bytes).replace(/[^\d]/g, "") / 1024) + " KB" : ""].filter(Boolean).join(" · ");else if (f.date) hint = f.date;
    return {
      primary: hint || noun,
      kicker: "untitled " + noun
    };
  }

  /* ── Dual-key field row ── */
  function Field({
    k,
    v
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-fld"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-fld__id"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-fld__label"
    }, labelFor(k)), /*#__PURE__*/React.createElement("span", {
      className: "rr-fld__wire"
    }, k)), /*#__PURE__*/React.createElement("span", {
      className: "rr-fld__val" + (isMoneyVal(v) ? " is-num" : "")
    }, v));
  }

  /* ── Kind-aware body: hero + image + reading region + dual-key fields ── */
  function RecordBody({
    rec,
    pairs
  }) {
    const kind = kindOf(rec);
    const present = key => pairs.find(([k]) => k === key);
    const heroKey = kind === "money" ? ["net_pay", "amount", "gross_pay"].find(k => present(k)) : null;
    const bodyPair = pairs.find(([k, v]) => isLongVal(k, v));
    const heroVal = heroKey ? present(heroKey)[1] : null;
    const negative = heroVal && /^[−-]/.test(heroVal);
    const captionParts = [];
    if (kind === "money") {
      ["merchant", "employer", "category", "period_end", "date"].forEach(k => {
        const p = present(k);
        if (p) captionParts.push(p[1]);
      });
    }
    const skip = new Set();
    if (heroKey) skip.add(heroKey);
    if (bodyPair) skip.add(bodyPair[0]);
    const rest = pairs.filter(([k]) => !skip.has(k));
    return /*#__PURE__*/React.createElement(React.Fragment, null, heroKey && /*#__PURE__*/React.createElement("div", {
      className: "rr-hero rr-hero--money"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-hero__amount" + (negative ? " is-neg" : "")
    }, heroVal), captionParts.length > 0 && /*#__PURE__*/React.createElement("span", {
      className: "rr-hero__cap"
    }, captionParts.slice(0, 2).join(" · ")), /*#__PURE__*/React.createElement("span", {
      className: "rr-hero__wire"
    }, labelFor(heroKey), " \xB7 ", /*#__PURE__*/React.createElement("span", {
      className: "rr-fld__wire"
    }, heroKey))), rec.image && /*#__PURE__*/React.createElement("image-slot", {
      class: "rr-rec-image",
      id: "img-" + rec.id,
      placeholder: "Image field \u2014 drop the file to render it inline",
      radius: "0",
      shape: "rect"
    }), bodyPair && /*#__PURE__*/React.createElement("div", {
      className: "rr-bodytext"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-bodytext__label"
    }, labelFor(bodyPair[0]), " ", /*#__PURE__*/React.createElement("span", {
      className: "rr-fld__wire"
    }, bodyPair[0])), /*#__PURE__*/React.createElement("p", {
      className: "rr-bodytext__text"
    }, bodyPair[1])), rest.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "rr-flds"
    }, rest.map(([k, v]) => /*#__PURE__*/React.createElement(Field, {
      k: k,
      key: k,
      v: v
    }))));
  }
  Object.assign(window, {
    RRREC: {
      labelFor,
      nounFor,
      kindOf,
      displayTitle,
      Field,
      RecordBody
    }
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "recordroom/rr-record.jsx", error: String((e && e.message) || e) }); }

// recordroom/rr-sources.jsx
try { (() => {
/* RECORDROOM — Sources: the loading dock. Per-instance operational truth:
   identity, config, auth, stream manifests, health. Records are never
   viewed here — every record path hands off to Explore, the one reader. */
;
(() => {
  const {
    useState
  } = React;
  const RRX = window.RRX;
  function SourcesView({
    grants,
    onBrowse,
    onGo
  }) {
    const [sel, setSel] = useState(RRX.connections[0].id);
    const [revoking, setRevoking] = useState(false);
    const [localRevoked, setLocalRevoked] = useState([]);
    const [syncing, setSyncing] = useState(false);
    const [synced, setSynced] = useState([]);
    const con = RRX.connections.find(c => c.id === sel);
    const status = localRevoked.includes(con.id) ? "revoked" : con.status;
    const revoked = status === "revoked";

    /* which grants read each stream of this instance */
    function readBy(streamName) {
      const names = grants.filter(g => g.status !== "revoked" && g.projections && g.projections[streamName]).map(g => g.client);
      return names.length ? names.join(" · ") : "—";
    }
    function syncNow() {
      setSyncing(true);
      setTimeout(() => {
        setSyncing(false);
        setSynced(cur => [...cur, con.id]);
      }, 800);
    }
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-s"
    }, /*#__PURE__*/React.createElement("aside", {
      className: "rr-s-list"
    }, RRX.connections.map(c => {
      const st = localRevoked.includes(c.id) ? "revoked" : c.status;
      return /*#__PURE__*/React.createElement("button", {
        className: "rr-s-item" + (sel === c.id ? " is-on" : "") + (st === "revoked" ? " is-revoked" : ""),
        key: c.id,
        onClick: () => {
          setSel(c.id);
          setRevoking(false);
        },
        type: "button"
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-s-item__name"
      }, c.name), /*#__PURE__*/React.createElement("span", {
        className: "rr-s-item__kind"
      }, c.kind), /*#__PURE__*/React.createElement("span", {
        className: "rr-s-item__line"
      }, c.account), /*#__PURE__*/React.createElement("span", {
        className: "rr-s-item__flag"
      }, st === "revoked" && /*#__PURE__*/React.createElement("span", {
        className: "pdpp-endorse pdpp-endorse--revoked"
      }, "revoked"), st === "reauth" && /*#__PURE__*/React.createElement("span", {
        className: "pdpp-endorse pdpp-endorse--denied"
      }, "reauthorize"), st === "active" && /*#__PURE__*/React.createElement("span", {
        className: "rr-s-item__ok"
      }, "\u25CF")));
    }), /*#__PURE__*/React.createElement("div", {
      className: "rr-end"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      type: "button"
    }, "add a source \u2192"), /*#__PURE__*/React.createElement("span", {
      className: "rr-end__note"
    }, "a source pushes into your streams \xB7 nothing leaves"))), /*#__PURE__*/React.createElement("div", {
      className: "rr-s-detail"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__head"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "pdpp-sheet__title rr-x-sheet-title"
    }, revoked ? /*#__PURE__*/React.createElement("s", null, con.name) : con.name), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-sheet__serial"
    }, con.cin)), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__body"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-kv"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-kv__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__k"
    }, "kind"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__v"
    }, con.kind)), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-kv__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__k"
    }, "account"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__v"
    }, con.account)), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-kv__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__k"
    }, "config"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__v"
    }, con.config)), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-kv__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__k"
    }, "auth"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__v"
    }, revoked ? "revoked" : con.auth)), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-kv__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__k"
    }, "schedule"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__v"
    }, con.schedule)), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-kv__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__k"
    }, "last run"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__v"
    }, synced.includes(con.id) ? "ok · just now" : con.lastRun)), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-kv__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__k"
    }, "added"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-kv__v"
    }, con.added))), revoked && /*#__PURE__*/React.createElement("p", {
      className: "rr-x-foldnote"
    }, "Revoked ", con.id === "cc2" ? RRX.partial.revokedOn : "just now", " \u2014 this instance can no longer push. Records ingested before revocation remain on your server, in your streams.")), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__foot"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-s-actions"
    }, !revoked && /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--ghost pdpp-btn--sm",
      disabled: syncing,
      onClick: syncNow,
      type: "button"
    }, syncing ? "syncing…" : "Sync now"), status === "reauth" && /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--sm",
      type: "button"
    }, "Reauthorize"), !revoked && !revoking && /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--destructive pdpp-btn--sm",
      onClick: () => setRevoking(true),
      type: "button"
    }, "Revoke instance"), !revoked && revoking && /*#__PURE__*/React.createElement("span", {
      style: {
        display: "flex",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--ghost pdpp-btn--sm",
      onClick: () => setRevoking(false),
      type: "button"
    }, "Keep"), /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--destructive pdpp-btn--sm",
      onClick: () => {
        setLocalRevoked(cur => [...cur, con.id]);
        setRevoking(false);
      },
      type: "button"
    }, "Confirm revoke"))), /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      onClick: () => onBrowse(con.id, null),
      type: "button"
    }, "browse records \u2192"))), /*#__PURE__*/React.createElement("div", {
      className: "rr-s-manifest"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-mini-head"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "rr-mini-head__t"
    }, "Streams on this instance"), /*#__PURE__*/React.createElement("span", {
      className: "rr-x-day__n"
    }, con.streams.length)), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-table rr-s-cols"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-table__hrow"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "stream"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h u-r"
    }, "records"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "cursor"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "search"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "read by")), con.streams.map(s => /*#__PURE__*/React.createElement("button", {
      className: "rr-row-btn",
      key: s.name,
      onClick: () => onBrowse(con.id, s.name),
      type: "button"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-data-row",
      style: {
        "--cols": "inherit"
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-s-stream"
    }, s.name), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__meta"
    }, s.records), /*#__PURE__*/React.createElement("span", {
      className: "rr-s-cursor"
    }, s.cursor), /*#__PURE__*/React.createElement("span", {
      className: "rr-s-cursor"
    }, s.searchable ? "text" : "sealed"), /*#__PURE__*/React.createElement("span", {
      className: "rr-s-readby"
    }, readBy(s.name)))))), /*#__PURE__*/React.createElement("p", {
      className: "rr-s-note"
    }, "\u201c", "sealed", "\u201d", " streams hold binary or machine arguments \u2014 browsable and linked, not text-searched. Click any stream to read its records in Explore."))));
  }
  Object.assign(window, {
    RRSourcesView2: SourcesView
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "recordroom/rr-sources.jsx", error: String((e && e.message) || e) }); }

// recordroom/rr-syncs.jsx
try { (() => {
/* RECORDROOM — Syncs (merged Runs+Schedules) + de-souped ops rows for
   Connect / Exporters / Subscriptions + the Overview attention list.
   Health-first: the failure is a card with an action, not a row.
   Data: window.RR2 + a compact sync model authored here. */
;
(() => {
  const {
    useState
  } = React;
  const RR2 = window.RR2;

  /* ── Sync model: grouped by connection instance, per-stream rhythm ── */
  const SYNCS = [{
    con: "Northstar HR",
    cin: "cin_nh_e3391c",
    health: "ok",
    streams: [{
      stream: "pay_statements",
      cadence: "with payroll",
      next: "Jun 12 · 06:00Z",
      rhythm: ["ok", "ok", "ok", "ok", "ok"],
      delta: "+2 records",
      when: "today 06:00Z",
      dur: "18 s"
    }, {
      stream: "employment",
      cadence: "daily · 06:00Z",
      next: "Jun 12 · 06:00Z",
      rhythm: ["ok", "ok", "ok", "ok", "ok"],
      delta: "no change",
      when: "today 06:00Z",
      dur: "4 s",
      quiet: true
    }, {
      stream: "tax_docs",
      cadence: "yearly · Feb 01",
      next: "2027 · Feb 01",
      rhythm: ["ok"],
      delta: "no change",
      when: "Feb 01",
      dur: "2 s",
      quiet: true
    }]
  }, {
    con: "First Meridian — checking",
    cin: "cin_fm_206b11",
    health: "failing",
    fix: {
      title: "First Meridian — checking can't sync",
      body: "The bank's OFX session expired on Jun 11. New transactions aren't arriving — the cursor is held at Jun 10, so nothing already on your server is lost, but nothing new is coming in either.",
      action: "Reauthorize bank"
    },
    streams: [{
      stream: "transactions",
      cadence: "daily · 05:00Z",
      next: "held",
      rhythm: ["ok", "ok", "ok", "ok", "fail"],
      delta: "held at Jun 10",
      when: "Jun 11 05:00Z",
      dur: "2 s",
      failed: true
    }, {
      stream: "statements",
      cadence: "monthly",
      next: "held",
      rhythm: ["ok", "ok", "fail"],
      delta: "held at May",
      when: "Jun 11 05:00Z",
      dur: "—",
      failed: true
    }, {
      stream: "balances",
      cadence: "daily · 05:00Z",
      next: "held",
      rhythm: ["ok", "ok", "ok", "fail"],
      delta: "held at Jun 10",
      when: "Jun 11 05:00Z",
      dur: "—",
      failed: true
    }]
  }, {
    con: "Gmail — personal",
    cin: "cin_gm_410c2b",
    health: "ok",
    streams: [{
      stream: "messages",
      cadence: "every 15 min",
      next: "in 11 min",
      rhythm: ["ok", "ok", "ok", "ok", "ok"],
      delta: "+38 records",
      when: "31 min ago",
      dur: "6 s"
    }, {
      stream: "threads",
      cadence: "every 15 min",
      next: "in 11 min",
      rhythm: ["ok", "ok", "ok", "ok", "ok"],
      delta: "+12 records",
      when: "31 min ago",
      dur: "5 s"
    }, {
      stream: "attachments",
      cadence: "every 15 min",
      next: "in 11 min",
      rhythm: ["ok", "ok", "ok", "ok", "ok"],
      delta: "+3 records",
      when: "2 h ago",
      dur: "9 s"
    }]
  }, {
    con: "Tonal",
    cin: "cin_tn_77f024",
    health: "ok",
    streams: [{
      stream: "listening_history",
      cadence: "every 15 min",
      next: "in 3 min",
      rhythm: ["ok", "ok", "ok", "ok", "ok"],
      delta: "+4 records",
      when: "12 min ago",
      dur: "7 s"
    }]
  }];
  function Rhythm({
    runs
  }) {
    return /*#__PURE__*/React.createElement("span", {
      className: "rr-rhythm",
      title: runs.join(" · ")
    }, runs.map((r, i) => /*#__PURE__*/React.createElement("span", {
      className: "rr-rhythm__tick" + (r === "fail" ? " is-fail" : ""),
      key: i
    })));
  }

  /* ─── Syncs ─── */

  function SyncsView() {
    const [open, setOpen] = useState(null);
    const [fixed, setFixed] = useState(false);
    const groups = SYNCS;
    const streamTotal = groups.reduce((n, g) => n + g.streams.length, 0);
    const failing = fixed ? 0 : groups.filter(g => g.health === "failing").reduce((n, g) => n + g.streams.length, 0);
    const onSched = streamTotal - failing;
    const fixGroup = groups.find(g => g.fix);
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-sync"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-sync-health"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-sync-health__stat"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-sync-health__v"
    }, onSched), /*#__PURE__*/React.createElement("span", {
      className: "rr-sync-health__k"
    }, "streams on schedule")), /*#__PURE__*/React.createElement("div", {
      className: "rr-sync-health__stat" + (failing ? " is-warn" : "")
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-sync-health__v"
    }, failing), /*#__PURE__*/React.createElement("span", {
      className: "rr-sync-health__k"
    }, failing ? "need your hand" : "need attention")), /*#__PURE__*/React.createElement("div", {
      className: "rr-sync-health__stat rr-sync-health__stat--note"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-sync-health__note"
    }, "Nothing already saved is ever lost \u2014 a held connection only pauses new arrivals."))), fixGroup && !fixed && /*#__PURE__*/React.createElement("div", {
      className: "rr-fix"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-fix__body"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "rr-fix__title"
    }, fixGroup.fix.title), /*#__PURE__*/React.createElement("p", {
      className: "rr-fix__expl"
    }, fixGroup.fix.body)), /*#__PURE__*/React.createElement("div", {
      className: "rr-fix__act"
    }, /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--sm",
      onClick: () => setFixed(true),
      type: "button"
    }, fixGroup.fix.action))), groups.map(g => {
      const healthy = fixed || g.health !== "failing";
      return /*#__PURE__*/React.createElement("div", {
        className: "rr-sync-group",
        key: g.cin
      }, /*#__PURE__*/React.createElement("div", {
        className: "rr-sync-group__head"
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-sync-group__dot" + (healthy ? " is-ok" : " is-fail")
      }), /*#__PURE__*/React.createElement("span", {
        className: "rr-sync-group__name"
      }, g.con), /*#__PURE__*/React.createElement("span", {
        className: "rr-sync-group__cin"
      }, g.cin), /*#__PURE__*/React.createElement("span", {
        className: "rr-sync-group__count"
      }, g.streams.length, " ", g.streams.length === 1 ? "stream" : "streams")), /*#__PURE__*/React.createElement("div", {
        className: "pdpp-table rr-cols-sync"
      }, /*#__PURE__*/React.createElement("div", {
        className: "pdpp-table__hrow"
      }, /*#__PURE__*/React.createElement("span", {
        className: "pdpp-table__h"
      }, "stream"), /*#__PURE__*/React.createElement("span", {
        className: "pdpp-table__h"
      }, "cadence"), /*#__PURE__*/React.createElement("span", {
        className: "pdpp-table__h"
      }, "recent"), /*#__PURE__*/React.createElement("span", {
        className: "pdpp-table__h"
      }, "last result"), /*#__PURE__*/React.createElement("span", {
        className: "pdpp-table__h u-r"
      }, "next")), g.streams.map(s => {
        const failed = s.failed && !fixed;
        const isOpen = open === g.cin + s.stream;
        return /*#__PURE__*/React.createElement(React.Fragment, {
          key: s.stream
        }, /*#__PURE__*/React.createElement("button", {
          className: "rr-sync-row" + (failed ? " is-failed" : "") + (isOpen ? " is-open" : ""),
          onClick: () => setOpen(isOpen ? null : g.cin + s.stream),
          type: "button"
        }, /*#__PURE__*/React.createElement("span", {
          className: "rr-sync-row__stream"
        }, s.stream), /*#__PURE__*/React.createElement("span", {
          className: "rr-sync-row__cadence"
        }, s.cadence), /*#__PURE__*/React.createElement(Rhythm, {
          runs: fixed && s.failed ? [...s.rhythm.slice(0, -1), "ok"] : s.rhythm
        }), /*#__PURE__*/React.createElement("span", {
          className: "rr-sync-row__delta" + (s.quiet ? " is-quiet" : "") + (failed ? " is-failed" : "")
        }, failed ? "sync failed" : s.delta, /*#__PURE__*/React.createElement("span", {
          className: "rr-sync-row__when"
        }, s.when)), /*#__PURE__*/React.createElement("span", {
          className: "rr-sync-row__next"
        }, fixed && s.failed ? "resumed" : s.next)), isOpen && /*#__PURE__*/React.createElement("div", {
          className: "rr-sync-detail"
        }, /*#__PURE__*/React.createElement("div", {
          className: "rr-sync-detail__kv"
        }, /*#__PURE__*/React.createElement("span", {
          className: "rr-sync-detail__k"
        }, "last run"), /*#__PURE__*/React.createElement("span", {
          className: "rr-sync-detail__v"
        }, s.when, " \xB7 ", s.dur), /*#__PURE__*/React.createElement("span", {
          className: "rr-sync-detail__k"
        }, "delta"), /*#__PURE__*/React.createElement("span", {
          className: "rr-sync-detail__v"
        }, failed ? "0 records — cursor held" : s.delta), /*#__PURE__*/React.createElement("span", {
          className: "rr-sync-detail__k"
        }, "cadence"), /*#__PURE__*/React.createElement("span", {
          className: "rr-sync-detail__v"
        }, s.cadence)), /*#__PURE__*/React.createElement("button", {
          className: "rr-link",
          type: "button"
        }, "browse this stream \u2192")));
      })));
    }));
  }

  /* ─── Connect (de-souped) ─── */

  function ConnectView() {
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-ops"
    }, RR2.apps.map(a => {
      const pending = a.status !== "connected";
      const code = pending ? (a.detail.match(/code (\S+)/) || [])[1] : null;
      return /*#__PURE__*/React.createElement("div", {
        className: "rr-op" + (pending ? " is-action" : ""),
        key: a.name
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-op__lead"
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-op__name"
      }, a.name), /*#__PURE__*/React.createElement("span", {
        className: "rr-op__tag"
      }, a.via)), /*#__PURE__*/React.createElement("span", {
        className: "rr-op__say"
      }, pending ? "Waiting for the device code to be entered on this console." : "Reads through your grants — never more than the grant behind it."), /*#__PURE__*/React.createElement("span", {
        className: "rr-op__side"
      }, pending ? /*#__PURE__*/React.createElement("span", {
        className: "rr-op__pending"
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-op__code"
      }, code), /*#__PURE__*/React.createElement("span", {
        className: "rr-op__meta"
      }, "expires 9 min"), /*#__PURE__*/React.createElement("button", {
        className: "pdpp-btn pdpp-btn--sm",
        type: "button"
      }, "Enter code")) : /*#__PURE__*/React.createElement("span", {
        className: "rr-op__settled"
      }, /*#__PURE__*/React.createElement("span", {
        className: "pdpp-endorse pdpp-endorse--active"
      }, "connected"), /*#__PURE__*/React.createElement("span", {
        className: "rr-op__meta"
      }, "since ", a.added))));
    }), /*#__PURE__*/React.createElement("div", {
      className: "rr-end"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      type: "button"
    }, "connect an app \u2192"), /*#__PURE__*/React.createElement("span", {
      className: "rr-end__note"
    }, "apps read through grants \u2014 never more than the grant behind them")));
  }

  /* ─── Device exporters (de-souped) ─── */

  function ExportersView() {
    const [paused, setPaused] = useState({});
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-ops"
    }, RR2.exporters.map(e => {
      const isPaused = paused[e.device] != null ? paused[e.device] : e.status === "paused";
      return /*#__PURE__*/React.createElement("div", {
        className: "rr-op" + (isPaused ? " is-action" : ""),
        key: e.device
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-op__lead"
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-op__name"
      }, e.device), /*#__PURE__*/React.createElement("span", {
        className: "rr-op__tag"
      }, "device push")), /*#__PURE__*/React.createElement("span", {
        className: "rr-op__say"
      }, "Pushes straight to your server \u2014 nothing transits a third party."), /*#__PURE__*/React.createElement("span", {
        className: "rr-op__side"
      }, /*#__PURE__*/React.createElement("span", {
        className: "rr-op__settled"
      }, isPaused ? /*#__PURE__*/React.createElement("span", {
        className: "pdpp-endorse pdpp-endorse--revoked"
      }, "paused") : /*#__PURE__*/React.createElement("span", {
        className: "pdpp-endorse pdpp-endorse--active"
      }, "exporting"), /*#__PURE__*/React.createElement("span", {
        className: "rr-op__meta"
      }, isPaused ? "—" : e.records + " records")), /*#__PURE__*/React.createElement("button", {
        className: "pdpp-btn pdpp-btn--ghost pdpp-btn--sm",
        onClick: () => setPaused(p => ({
          ...p,
          [e.device]: !isPaused
        })),
        type: "button"
      }, isPaused ? "Resume" : "Pause")));
    }), /*#__PURE__*/React.createElement("div", {
      className: "rr-end"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      type: "button"
    }, "pair a device \u2192"), /*#__PURE__*/React.createElement("span", {
      className: "rr-end__note"
    }, "device flow \xB7 approve the code on this console")));
  }

  /* ─── Event subscriptions (de-souped) ─── */

  function SubscriptionsView() {
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-ops"
    }, RR2.subscriptions.map(s => /*#__PURE__*/React.createElement("div", {
      className: "rr-op",
      key: s.url
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-op__lead"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-op__name rr-op__name--mono"
    }, s.url)), /*#__PURE__*/React.createElement("span", {
      className: "rr-op__events"
    }, s.events.split(" · ").map(ev => /*#__PURE__*/React.createElement("span", {
      className: "rr-op__event",
      key: ev
    }, ev))), /*#__PURE__*/React.createElement("span", {
      className: "rr-op__side"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-op__settled"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--continuous"
    }, s.status), /*#__PURE__*/React.createElement("button", {
      className: "rr-link rr-op__test",
      type: "button"
    }, "test"))))), /*#__PURE__*/React.createElement("div", {
      className: "rr-end"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      type: "button"
    }, "add a webhook \u2192"), /*#__PURE__*/React.createElement("span", {
      className: "rr-end__note"
    }, "fires on protocol events \xB7 grant.created \xB7 grant.revoked \xB7 run.failed")));
  }

  /* ─── Overview attention list (de-souped, action-bearing) ─── */

  function AttentionList({
    onGo
  }) {
    const items = [{
      sev: "fail",
      name: "First Meridian can't sync",
      say: "OFX session expired — transactions held at the Jun 10 cursor.",
      action: "Reauthorize",
      go: "syncs"
    }, {
      sev: "warn",
      name: "TaxPrep Co grant expiring",
      say: "tax_docs.read · single use · still unused.",
      meta: "26 h left",
      go: "grants"
    }, {
      sev: "warn",
      name: "Backups not configured",
      say: "Your copy deserves a copy — set a snapshot target.",
      action: "Set up",
      go: "deployment"
    }];
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-ops"
    }, items.map(it => /*#__PURE__*/React.createElement("div", {
      className: "rr-op rr-op--attn is-" + it.sev,
      key: it.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-op__lead"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-op__sev rr-op__sev--" + it.sev
    }), /*#__PURE__*/React.createElement("span", {
      className: "rr-op__name"
    }, it.name)), /*#__PURE__*/React.createElement("span", {
      className: "rr-op__say"
    }, it.say), /*#__PURE__*/React.createElement("span", {
      className: "rr-op__side"
    }, it.action ? /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn pdpp-btn--sm",
      onClick: () => onGo(it.go),
      type: "button"
    }, it.action) : /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      onClick: () => onGo(it.go),
      type: "button"
    }, it.meta, " \u2192")))));
  }
  Object.assign(window, {
    RRSyncsView: SyncsView,
    RRConnectView2: ConnectView,
    RRExportersView2: ExportersView,
    RRSubscriptionsView2: SubscriptionsView,
    RRAttentionList: AttentionList
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "recordroom/rr-syncs.jsx", error: String((e && e.message) || e) }); }

// recordroom/rr-views2.jsx
try { (() => {
/* RECORDROOM — full-surface views: Overview, Explore, Traces, Runs,
   Schedules, Sources, Connect, Deployment, Exporters, Subscriptions,
   plus the command palette. Data from window.RR2. */
;
(() => {
  const {
    useState,
    useEffect,
    useRef
  } = React;
  const RR2 = window.RR2;
  function CopyId({
    id
  }) {
    const [done, setDone] = useState(false);
    return /*#__PURE__*/React.createElement("button", {
      className: "pdpp-sheet__serial rr-copyid",
      onClick: () => {
        navigator.clipboard && navigator.clipboard.writeText(id);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      },
      title: "Copy id",
      type: "button"
    }, done ? "copied" : id);
  }
  function MiniHead({
    title,
    action,
    onAction
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-mini-head"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "rr-mini-head__t"
    }, title), action && /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      onClick: onAction,
      type: "button"
    }, action, " \u2192"));
  }

  /* ─── Traces ─── */

  function TraceList({
    selected,
    onSelect,
    limit,
    traces
  }) {
    const rows = limit ? traces.slice(0, limit) : traces;
    return /*#__PURE__*/React.createElement("div", {
      className: "pdpp-table rr-cols-traces"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-table__hrow"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "time"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "client"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "request"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h u-r"
    }, "recs"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h u-r"
    }, "fields"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "ruling")), rows.map(tr => /*#__PURE__*/React.createElement("button", {
      className: "rr-trace-row" + (selected === tr.id ? " is-selected" : ""),
      key: tr.id,
      onClick: () => onSelect && onSelect(tr.id),
      type: "button"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-trace-row__t"
    }, tr.t.slice(5, 16)), /*#__PURE__*/React.createElement("span", {
      className: "rr-trace-row__who"
    }, tr.client), /*#__PURE__*/React.createElement("span", {
      className: "rr-trace-row__what"
    }, tr.stream, " \xB7 ", tr.op), /*#__PURE__*/React.createElement("span", {
      className: "rr-trace-row__n"
    }, tr.records), /*#__PURE__*/React.createElement("span", {
      className: "rr-trace-row__n"
    }, tr.fields), /*#__PURE__*/React.createElement("span", {
      className: "rr-decide rr-decide--" + tr.decision
    }, tr.decision))));
  }
  function TraceDetail({
    trace
  }) {
    if (!trace) return null;
    return /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet rr-inspector"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__head"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "pdpp-sheet__title",
      style: {
        whiteSpace: "nowrap"
      }
    }, trace.decision === "deny" ? "Refused" : "Served", " in ", trace.dur), /*#__PURE__*/React.createElement(CopyId, {
      id: trace.id
    })), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__body"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-steps"
    }, trace.steps.map(([k, v], i) => /*#__PURE__*/React.createElement("div", {
      className: "rr-step" + (k === "deny" ? " rr-step--deny" : ""),
      key: i
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-step__k"
    }, k), /*#__PURE__*/React.createElement("span", {
      className: "rr-step__v"
    }, v))))), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-sheet__foot"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-typed-sm",
      style: {
        color: "var(--muted-foreground)"
      }
    }, trace.decision === "deny" ? "boundary held · " + trace.reason : "every response stays inside the grant")));
  }
  function TracesView() {
    const [sel, setSel] = useState(RR2.traces[3].id);
    const trace = RR2.traces.find(t => t.id === sel);
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-content--split",
      style: {
        display: "grid"
      }
    }, /*#__PURE__*/React.createElement(TraceList, {
      onSelect: setSel,
      selected: sel,
      traces: RR2.traces
    }), /*#__PURE__*/React.createElement(TraceDetail, {
      trace: trace
    }));
  }

  /* ─── Overview ─── */

  function OverviewView({
    pending,
    onReview,
    onGo,
    grantsSummary
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-ov"
    }, pending && /*#__PURE__*/React.createElement("div", {
      className: "rr-hero pdpp-carbon"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-hero__sheet"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-hero__text"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-eyebrow"
    }, "Access request \xB7 staged \xB7 waiting on you"), /*#__PURE__*/React.createElement("h2", {
      className: "rr-hero__title"
    }, "Atlas Mortgage asks to read 3 streams"), /*#__PURE__*/React.createElement("span", {
      className: "rr-hero__meta"
    }, "req_atlas_7f2k \xB7 purpose: mortgage_preapproval \xB7 nothing crosses until you decide")), /*#__PURE__*/React.createElement("button", {
      className: "pdpp-btn",
      onClick: onReview,
      type: "button"
    }, "Review request"))), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-band"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-band__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-band__v"
    }, "10"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-band__k"
    }, "connections")), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-band__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-band__v"
    }, "34"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-band__k"
    }, "streams")), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-band__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-band__v"
    }, "48,120"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-band__k"
    }, "records")), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-band__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-band__v"
    }, grantsSummary), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-band__k"
    }, "grants in effect")), /*#__PURE__*/React.createElement("div", {
      className: "pdpp-band__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-band__v"
    }, "14"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-band__k"
    }, "reads this week"))), /*#__PURE__*/React.createElement("div", {
      className: "rr-ov__grid"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(MiniHead, {
      action: "all traces",
      onAction: () => onGo("traces"),
      title: "Latest traces"
    }), /*#__PURE__*/React.createElement(TraceList, {
      limit: 4,
      traces: RR2.traces
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(MiniHead, {
      action: "syncs",
      onAction: () => onGo("syncs"),
      title: "Needs attention"
    }), window.RRAttentionList ? /*#__PURE__*/React.createElement(window.RRAttentionList, {
      onGo: onGo
    }) : null)));
  }

  /* ─── Explore ─── */

  function ExploreView() {
    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-table rr-cols-feed"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-table__hrow"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "arrived"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "stream"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "record"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h u-r"
    }, "id")), RR2.feed.map(r => /*#__PURE__*/React.createElement("div", {
      className: "rr-feed-row",
      key: r.id
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-feed-row__t"
    }, r.t), /*#__PURE__*/React.createElement("span", {
      className: "rr-feed-row__stream"
    }, r.stream), /*#__PURE__*/React.createElement("span", {
      className: "rr-feed-row__body"
    }, r.body), /*#__PURE__*/React.createElement("span", {
      className: "rr-feed-row__id"
    }, r.id)))), /*#__PURE__*/React.createElement("p", {
      className: "pdpp-typed-sm",
      style: {
        color: "var(--muted-foreground)",
        marginTop: 12
      }
    }, "newest first \xB7 the feed is your own data arriving \u2014 nothing here has crossed to anyone"));
  }

  /* ─── Sources ─── */

  function SourcesView() {
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-attn"
    }, RR2.sources.map(s => /*#__PURE__*/React.createElement("div", {
      className: "rr-attn__row",
      key: s.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__name"
    }, s.name), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__detail"
    }, s.kind, " \xB7 ", s.streams, " \xB7 last sync ", s.last), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__side"
    }, s.authOk ? /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--active"
    }, "auth ok") : /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--denied"
    }, "reauthorize"), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__meta"
    }, s.auth)))), /*#__PURE__*/React.createElement("div", {
      className: "rr-end"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      type: "button"
    }, "add a source \u2192"), /*#__PURE__*/React.createElement("span", {
      className: "rr-end__note"
    }, "a source pushes into your streams \xB7 nothing leaves")));
  }

  /* ─── Runs ─── */

  function RunsView() {
    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-table rr-cols-runs"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-table__hrow"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "connector"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "stream \xB7 result"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "status"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h u-r"
    }, "took"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h u-r"
    }, "started")), RR2.runs.map(r => /*#__PURE__*/React.createElement("div", {
      className: "pdpp-data-row",
      key: r.id,
      style: {
        "--cols": "inherit"
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__who"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__title"
    }, r.connector), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__id"
    }, r.id)), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__detail"
    }, r.stream, " \xB7 ", r.upserts, " upserts \xB7 cursor ", r.cursor, r.note ? " · " + r.note : ""), r.status === "ok" ? /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--active"
    }, "ok") : /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--denied"
    }, "failed"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__meta"
    }, r.dur), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__meta"
    }, r.started.slice(5))))));
  }

  /* ─── Schedules ─── */

  function SchedulesView() {
    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-table rr-cols-schedules"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pdpp-table__hrow"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "stream"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "cadence"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h"
    }, "last run"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-table__h u-r"
    }, "next run")), RR2.schedules.map((s, i) => /*#__PURE__*/React.createElement("div", {
      className: "pdpp-data-row",
      key: i,
      style: {
        "--cols": "inherit"
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__who"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__title"
    }, s.stream), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__id"
    }, s.connector)), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__detail"
    }, s.cadence), s.last === "ok" ? /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--active"
    }, "last ok") : /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--denied"
    }, "last failed"), /*#__PURE__*/React.createElement("span", {
      className: "pdpp-data-row__meta"
    }, "next ", s.next)))));
  }
  function ConnectView() {
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-attn"
    }, RR2.apps.map(a => /*#__PURE__*/React.createElement("div", {
      className: "rr-attn__row",
      key: a.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__name"
    }, a.name), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__detail"
    }, a.via, " \xB7 ", a.detail), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__side"
    }, a.status === "connected" ? /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--active"
    }, "connected") : /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--expiring"
    }, "pending code"), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__meta"
    }, a.status === "connected" ? "since " + a.added : "device flow")))), /*#__PURE__*/React.createElement("div", {
      className: "rr-end"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      type: "button"
    }, "connect an app \u2192"), /*#__PURE__*/React.createElement("span", {
      className: "rr-end__note"
    }, "apps read through grants \u2014 never more than the grant behind them")));
  }

  /* ─── Deployment ─── */

  function DeploymentView() {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 32
      }
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(MiniHead, {
      title: "Readiness"
    }), /*#__PURE__*/React.createElement("div", null, RR2.checks.map(c => /*#__PURE__*/React.createElement("div", {
      className: "rr-check " + (c.ok ? "rr-check--ok" : "rr-check--warn"),
      key: c.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-check__glyph"
    }, c.ok ? "ok" : "check"), /*#__PURE__*/React.createElement("span", {
      className: "rr-check__name"
    }, c.name), /*#__PURE__*/React.createElement("span", {
      className: "rr-check__detail"
    }, c.detail))))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(MiniHead, {
      title: "Owner tokens"
    }), /*#__PURE__*/React.createElement("div", {
      className: "rr-attn"
    }, RR2.tokens.map(t => /*#__PURE__*/React.createElement("div", {
      className: "rr-attn__row",
      key: t.id
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__name"
    }, t.label), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__detail"
    }, t.id, " \xB7 created ", t.created, " \xB7 for the operator and trusted local agents only"), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__side"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--continuous"
    }, "active"), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__meta"
    }, "last used ", t.last)))), /*#__PURE__*/React.createElement("div", {
      className: "rr-end"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      type: "button"
    }, "issue a token \u2192"), /*#__PURE__*/React.createElement("span", {
      className: "rr-end__note"
    }, "owner tokens bypass grants \xB7 issue sparingly")))));
  }

  /* ─── Device exporters / Event subscriptions ─── */

  function ExportersView() {
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-attn"
    }, RR2.exporters.map(e => /*#__PURE__*/React.createElement("div", {
      className: "rr-attn__row",
      key: e.device
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__name"
    }, e.device), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__detail"
    }, "pushes to your server \u2014 nothing transits a third party \xB7 ", e.records, " records"), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__side"
    }, e.status === "ok" ? /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--active"
    }, "exporting") : /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--revoked"
    }, "paused"), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__meta"
    }, e.last)))), /*#__PURE__*/React.createElement("div", {
      className: "rr-end"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      type: "button"
    }, "pair a device \u2192"), /*#__PURE__*/React.createElement("span", {
      className: "rr-end__note"
    }, "device flow \xB7 approve the code on this console")));
  }
  function SubscriptionsView() {
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-attn"
    }, RR2.subscriptions.map(s => /*#__PURE__*/React.createElement("div", {
      className: "rr-attn__row",
      key: s.url
    }, /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__name rr-attn__name--mono"
    }, s.url), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__detail"
    }, s.events), /*#__PURE__*/React.createElement("span", {
      className: "rr-attn__side"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pdpp-endorse pdpp-endorse--continuous"
    }, s.status)))), /*#__PURE__*/React.createElement("div", {
      className: "rr-end"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rr-link",
      type: "button"
    }, "add a webhook \u2192"), /*#__PURE__*/React.createElement("span", {
      className: "rr-end__note"
    }, "fires on protocol events \xB7 grant.created \xB7 grant.revoked \xB7 run.failed")));
  }

  /* ─── Command palette ─── */

  function CommandPalette({
    open,
    onClose,
    items,
    recents = [],
    onExec
  }) {
    const [q, setQ] = useState("");
    const [hl, setHl] = useState(0);
    const inputRef = useRef(null);
    useEffect(() => {
      if (open) {
        setQ("");
        setHl(0);
        setTimeout(() => inputRef.current && inputRef.current.focus(), 30);
      }
    }, [open]);
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
      const rec = recents.map(l => items.find(i => i.label === l)).filter(Boolean).map(i => ({
        ...i,
        kind: "recent"
      }));
      const rest = items.filter(i => !recents.includes(i.label));
      filtered = [...rec, ...rest].slice(0, 9);
    } else {
      filtered = items.map(i => [score(i), i]).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).map(([, i]) => i).slice(0, 9);
    }
    function choose(it) {
      it.run();
      onExec && onExec(it.label);
      onClose();
    }
    function onKey(e) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHl(h => Math.min(h + 1, filtered.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHl(h => Math.max(h - 1, 0));
      }
      if (e.key === "Enter" && filtered[hl]) choose(filtered[hl]);
    }
    return /*#__PURE__*/React.createElement("div", {
      className: "rr-palette-overlay",
      onClick: onClose
    }, /*#__PURE__*/React.createElement("div", {
      className: "rr-palette",
      onClick: e => e.stopPropagation()
    }, /*#__PURE__*/React.createElement("input", {
      className: "rr-palette__input",
      onChange: e => {
        setQ(e.target.value);
        setHl(0);
      },
      onKeyDown: onKey,
      placeholder: "Jump to a view, grant, stream, or action\u2026",
      ref: inputRef,
      value: q
    }), /*#__PURE__*/React.createElement("div", {
      className: "rr-palette__list"
    }, filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
      className: "rr-palette__empty"
    }, "Nothing matches \u2014 the record is honest about that."), filtered.map((it, i) => /*#__PURE__*/React.createElement("button", {
      className: "rr-palette__item" + (i === hl ? " is-hl" : ""),
      key: it.kind + it.label,
      onClick: () => choose(it),
      onMouseEnter: () => setHl(i),
      type: "button"
    }, /*#__PURE__*/React.createElement("span", null, it.label), /*#__PURE__*/React.createElement("span", {
      className: "rr-palette__kind"
    }, it.kind))))));
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
    RRCommandPalette: CommandPalette
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "recordroom/rr-views2.jsx", error: String((e && e.message) || e) }); }

// recordroom/tweaks-panel.jsx
try { (() => {
// @ds-adherence-ignore -- omelette starter scaffold (raw elements/hex/px by design)

/* BEGIN USAGE */
// tweaks-panel.jsx
// Reusable Tweaks shell + form-control helpers.
// Exports (to window): useTweaks, TweaksPanel, TweakSection, TweakRow, TweakSlider,
//   TweakToggle, TweakRadio, TweakSelect, TweakText, TweakNumber, TweakColor, TweakButton.
//
// Owns the host protocol (listens for __activate_edit_mode / __deactivate_edit_mode,
// posts __edit_mode_available / __edit_mode_set_keys / __edit_mode_dismissed) so
// individual prototypes don't re-roll it. Ships a consistent set of controls so you
// don't hand-draw <input type="range">, segmented radios, steppers, etc.
//
// Usage (in an HTML file that loads React + Babel):
//
//   const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
//     "primaryColor": "#D97757",
//     "palette": ["#D97757", "#29261b", "#f6f4ef"],
//     "fontSize": 16,
//     "density": "regular",
//     "dark": false
//   }/*EDITMODE-END*/;
//
//   function App() {
//     const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
//     return (
//       <div style={{ fontSize: t.fontSize, color: t.primaryColor }}>
//         Hello
//         <TweaksPanel>
//           <TweakSection label="Typography" />
//           <TweakSlider label="Font size" value={t.fontSize} min={10} max={32} unit="px"
//                        onChange={(v) => setTweak('fontSize', v)} />
//           <TweakRadio  label="Density" value={t.density}
//                        options={['compact', 'regular', 'comfy']}
//                        onChange={(v) => setTweak('density', v)} />
//           <TweakSection label="Theme" />
//           <TweakColor  label="Primary" value={t.primaryColor}
//                        options={['#D97757', '#2A6FDB', '#1F8A5B', '#7A5AE0']}
//                        onChange={(v) => setTweak('primaryColor', v)} />
//           <TweakColor  label="Palette" value={t.palette}
//                        options={[['#D97757', '#29261b', '#f6f4ef'],
//                                  ['#475569', '#0f172a', '#f1f5f9']]}
//                        onChange={(v) => setTweak('palette', v)} />
//           <TweakToggle label="Dark mode" value={t.dark}
//                        onChange={(v) => setTweak('dark', v)} />
//         </TweaksPanel>
//       </div>
//     );
//   }
//
// TweakRadio is the segmented control for 2–3 short options (auto-falls-back to
// TweakSelect past ~16/~10 chars per label); reach for TweakSelect directly when
// options are many or long. For color tweaks always curate 3-4 options rather than
// a free picker; an option can also be a whole 2–5 color palette (the stored value
// is the array). The Tweak* controls are a floor, not a ceiling — build custom
// controls inside the panel if a tweak calls for UI they don't cover.
/* END USAGE */
// ─────────────────────────────────────────────────────────────────────────────

const __TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    transform:scale(var(--dc-inv-zoom,1));transform-origin:bottom right;
    background:rgba(250,249,247,.78);color:#29261b;
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgba(255,255,255,.6);border-radius:14px;
    box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18);
    font:11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgba(41,38,27,.55);
    width:22px;height:22px;border-radius:6px;cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:rgba(0,0,0,.06);color:#29261b}
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.15) transparent}
  .twk-body::-webkit-scrollbar{width:8px}
  .twk-body::-webkit-scrollbar-track{background:transparent;margin:2px}
  .twk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:4px;
    border:2px solid transparent;background-clip:content-box}
  .twk-body::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.25);
    border:2px solid transparent;background-clip:content-box}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgba(41,38,27,.72)}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-val{color:rgba(41,38,27,.5);font-variant-numeric:tabular-nums}

  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgba(41,38,27,.45);padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}

  .twk-field{appearance:none;box-sizing:border-box;width:100%;min-width:0;height:26px;padding:0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;
    background:rgba(255,255,255,.6);color:inherit;font:inherit;outline:none}
  .twk-field:focus{border-color:rgba(0,0,0,.25);background:rgba(255,255,255,.85)}
  select.twk-field{padding-right:22px;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(0,0,0,.5)' d='M0 0h10L5 6z'/></svg>");
    background-repeat:no-repeat;background-position:right 8px center}

  .twk-slider{appearance:none;-webkit-appearance:none;width:100%;height:4px;margin:6px 0;
    border-radius:999px;background:rgba(0,0,0,.12);outline:none}
  .twk-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
    width:14px;height:14px;border-radius:50%;background:#fff;
    border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}
  .twk-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
    background:#fff;border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}

  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:rgba(0,0,0,.06);user-select:none}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(0,0,0,.12);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:inherit;font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:default;padding:4px 6px;line-height:1.2;
    overflow-wrap:anywhere}

  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgba(0,0,0,.15);transition:background .15s;cursor:default;padding:0}
  .twk-toggle[data-on="1"]{background:#34c759}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}

  .twk-num{display:flex;align-items:center;box-sizing:border-box;min-width:0;height:26px;padding:0 0 0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;background:rgba(255,255,255,.6)}
  .twk-num-lbl{font-weight:500;color:rgba(41,38,27,.6);cursor:ew-resize;
    user-select:none;padding-right:8px}
  .twk-num input{flex:1;min-width:0;height:100%;border:0;background:transparent;
    font:inherit;font-variant-numeric:tabular-nums;text-align:right;padding:0 8px 0 0;
    outline:none;color:inherit;-moz-appearance:textfield}
  .twk-num input::-webkit-inner-spin-button,.twk-num input::-webkit-outer-spin-button{
    -webkit-appearance:none;margin:0}
  .twk-num-unit{padding-right:8px;color:rgba(41,38,27,.45)}

  .twk-btn{appearance:none;height:26px;padding:0 12px;border:0;border-radius:7px;
    background:rgba(0,0,0,.78);color:#fff;font:inherit;font-weight:500;cursor:default}
  .twk-btn:hover{background:rgba(0,0,0,.88)}
  .twk-btn.secondary{background:rgba(0,0,0,.06);color:inherit}
  .twk-btn.secondary:hover{background:rgba(0,0,0,.1)}

  .twk-swatch{appearance:none;-webkit-appearance:none;width:56px;height:22px;
    border:.5px solid rgba(0,0,0,.1);border-radius:6px;padding:0;cursor:default;
    background:transparent;flex-shrink:0}
  .twk-swatch::-webkit-color-swatch-wrapper{padding:0}
  .twk-swatch::-webkit-color-swatch{border:0;border-radius:5.5px}
  .twk-swatch::-moz-color-swatch{border:0;border-radius:5.5px}

  .twk-chips{display:flex;gap:6px}
  .twk-chip{position:relative;appearance:none;flex:1;min-width:0;height:46px;
    padding:0;border:0;border-radius:6px;overflow:hidden;cursor:default;
    box-shadow:0 0 0 .5px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.06);
    transition:transform .12s cubic-bezier(.3,.7,.4,1),box-shadow .12s}
  .twk-chip:hover{transform:translateY(-1px);
    box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 4px 10px rgba(0,0,0,.12)}
  .twk-chip[data-on="1"]{box-shadow:0 0 0 1.5px rgba(0,0,0,.85),
    0 2px 6px rgba(0,0,0,.15)}
  .twk-chip>span{position:absolute;top:0;bottom:0;right:0;width:34%;
    display:flex;flex-direction:column;box-shadow:-1px 0 0 rgba(0,0,0,.1)}
  .twk-chip>span>i{flex:1;box-shadow:0 -1px 0 rgba(0,0,0,.1)}
  .twk-chip>span>i:first-child{box-shadow:none}
  .twk-chip svg{position:absolute;top:6px;left:6px;width:13px;height:13px;
    filter:drop-shadow(0 1px 1px rgba(0,0,0,.3))}
`;

// ── useTweaks ───────────────────────────────────────────────────────────────
// Single source of truth for tweak values. setTweak persists via the host
// (__edit_mode_set_keys → host rewrites the EDITMODE block on disk).
function useTweaks(defaults) {
  const [values, setValues] = React.useState(defaults);
  // Accepts either setTweak('key', value) or setTweak({ key: value, ... }) so a
  // useState-style call doesn't write a "[object Object]" key into the persisted
  // JSON block.
  const setTweak = React.useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === 'object' && keyOrEdits !== null ? keyOrEdits : {
      [keyOrEdits]: val
    };
    setValues(prev => ({
      ...prev,
      ...edits
    }));
    window.parent.postMessage({
      type: '__edit_mode_set_keys',
      edits
    }, '*');
    // Same-window signal so in-page listeners (deck-stage rail thumbnails)
    // can react — the parent message only reaches the host, not peers.
    window.dispatchEvent(new CustomEvent('tweakchange', {
      detail: edits
    }));
  }, []);
  return [values, setTweak];
}

// ── TweaksPanel ─────────────────────────────────────────────────────────────
// Floating shell. Registers the protocol listener BEFORE announcing
// availability — if the announce ran first, the host's activate could land
// before our handler exists and the toolbar toggle would silently no-op.
// The close button posts __edit_mode_dismissed so the host's toolbar toggle
// flips off in lockstep; the host echoes __deactivate_edit_mode back which
// is what actually hides the panel.
function TweaksPanel({
  title = 'Tweaks',
  children
}) {
  const [open, setOpen] = React.useState(false);
  const dragRef = React.useRef(null);
  const offsetRef = React.useRef({
    x: 16,
    y: 16
  });
  const PAD = 16;
  const clampToViewport = React.useCallback(() => {
    const panel = dragRef.current;
    if (!panel) return;
    const w = panel.offsetWidth,
      h = panel.offsetHeight;
    const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
    const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
    offsetRef.current = {
      x: Math.min(maxRight, Math.max(PAD, offsetRef.current.x)),
      y: Math.min(maxBottom, Math.max(PAD, offsetRef.current.y))
    };
    panel.style.right = offsetRef.current.x + 'px';
    panel.style.bottom = offsetRef.current.y + 'px';
  }, []);
  React.useEffect(() => {
    if (!open) return;
    clampToViewport();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', clampToViewport);
      return () => window.removeEventListener('resize', clampToViewport);
    }
    const ro = new ResizeObserver(clampToViewport);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [open, clampToViewport]);
  React.useEffect(() => {
    const onMsg = e => {
      const t = e?.data?.type;
      if (t === '__activate_edit_mode') setOpen(true);else if (t === '__deactivate_edit_mode') setOpen(false);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({
      type: '__edit_mode_available'
    }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);
  const dismiss = () => {
    setOpen(false);
    window.parent.postMessage({
      type: '__edit_mode_dismissed'
    }, '*');
  };
  const onDragStart = e => {
    const panel = dragRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const sx = e.clientX,
      sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = ev => {
      offsetRef.current = {
        x: startRight - (ev.clientX - sx),
        y: startBottom - (ev.clientY - sy)
      };
      clampToViewport();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  if (!open) return null;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("style", null, __TWEAKS_STYLE), /*#__PURE__*/React.createElement("div", {
    ref: dragRef,
    className: "twk-panel",
    "data-omelette-chrome": "",
    style: {
      right: offsetRef.current.x,
      bottom: offsetRef.current.y
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-hd",
    onMouseDown: onDragStart
  }, /*#__PURE__*/React.createElement("b", null, title), /*#__PURE__*/React.createElement("button", {
    className: "twk-x",
    "aria-label": "Close tweaks",
    onMouseDown: e => e.stopPropagation(),
    onClick: dismiss
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    className: "twk-body"
  }, children)));
}

// ── Layout helpers ──────────────────────────────────────────────────────────

function TweakSection({
  label,
  children
}) {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "twk-sect"
  }, label), children);
}
function TweakRow({
  label,
  value,
  children,
  inline = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: inline ? 'twk-row twk-row-h' : 'twk-row'
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-lbl"
  }, /*#__PURE__*/React.createElement("span", null, label), value != null && /*#__PURE__*/React.createElement("span", {
    className: "twk-val"
  }, value)), children);
}

// ── Controls ────────────────────────────────────────────────────────────────

function TweakSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label,
    value: `${value}${unit}`
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    className: "twk-slider",
    min: min,
    max: max,
    step: step,
    value: value,
    onChange: e => onChange(Number(e.target.value))
  }));
}
function TweakToggle({
  label,
  value,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "twk-row twk-row-h"
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-lbl"
  }, /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "twk-toggle",
    "data-on": value ? '1' : '0',
    role: "switch",
    "aria-checked": !!value,
    onClick: () => onChange(!value)
  }, /*#__PURE__*/React.createElement("i", null)));
}
function TweakRadio({
  label,
  value,
  options,
  onChange
}) {
  const trackRef = React.useRef(null);
  const [dragging, setDragging] = React.useState(false);
  // The active value is read by pointer-move handlers attached for the lifetime
  // of a drag — ref it so a stale closure doesn't fire onChange for every move.
  const valueRef = React.useRef(value);
  valueRef.current = value;

  // Segments wrap mid-word once per-segment width runs out. The track is
  // ~248px (280 panel − 28 body pad − 4 seg pad), each button loses 12px
  // to its own padding, and 11.5px system-ui averages ~6.3px/char — so 2
  // options fit ~16 chars each, 3 fit ~10. Past that (or >3 options), fall
  // back to a dropdown rather than wrap.
  const labelLen = o => String(typeof o === 'object' ? o.label : o).length;
  const maxLen = options.reduce((m, o) => Math.max(m, labelLen(o)), 0);
  const fitsAsSegments = maxLen <= ({
    2: 16,
    3: 10
  }[options.length] ?? 0);
  if (!fitsAsSegments) {
    // <select> emits strings — map back to the original option value so the
    // fallback stays type-preserving (numbers, booleans) like the segment path.
    const resolve = s => {
      const m = options.find(o => String(typeof o === 'object' ? o.value : o) === s);
      return m === undefined ? s : typeof m === 'object' ? m.value : m;
    };
    return /*#__PURE__*/React.createElement(TweakSelect, {
      label: label,
      value: value,
      options: options,
      onChange: s => onChange(resolve(s))
    });
  }
  const opts = options.map(o => typeof o === 'object' ? o : {
    value: o,
    label: o
  });
  const idx = Math.max(0, opts.findIndex(o => o.value === value));
  const n = opts.length;
  const segAt = clientX => {
    const r = trackRef.current.getBoundingClientRect();
    const inner = r.width - 4;
    const i = Math.floor((clientX - r.left - 2) / inner * n);
    return opts[Math.max(0, Math.min(n - 1, i))].value;
  };
  const onPointerDown = e => {
    setDragging(true);
    const v0 = segAt(e.clientX);
    if (v0 !== valueRef.current) onChange(v0);
    const move = ev => {
      if (!trackRef.current) return;
      const v = segAt(ev.clientX);
      if (v !== valueRef.current) onChange(v);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("div", {
    ref: trackRef,
    role: "radiogroup",
    onPointerDown: onPointerDown,
    className: dragging ? 'twk-seg dragging' : 'twk-seg'
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-seg-thumb",
    style: {
      left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
      width: `calc((100% - 4px) / ${n})`
    }
  }), opts.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.value,
    type: "button",
    role: "radio",
    "aria-checked": o.value === value
  }, o.label))));
}
function TweakSelect({
  label,
  value,
  options,
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("select", {
    className: "twk-field",
    value: value,
    onChange: e => onChange(e.target.value)
  }, options.map(o => {
    const v = typeof o === 'object' ? o.value : o;
    const l = typeof o === 'object' ? o.label : o;
    return /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, l);
  })));
}
function TweakText({
  label,
  value,
  placeholder,
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("input", {
    className: "twk-field",
    type: "text",
    value: value,
    placeholder: placeholder,
    onChange: e => onChange(e.target.value)
  }));
}
function TweakNumber({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange
}) {
  const clamp = n => {
    if (min != null && n < min) return min;
    if (max != null && n > max) return max;
    return n;
  };
  const startRef = React.useRef({
    x: 0,
    val: 0
  });
  const onScrubStart = e => {
    e.preventDefault();
    startRef.current = {
      x: e.clientX,
      val: value
    };
    const decimals = (String(step).split('.')[1] || '').length;
    const move = ev => {
      const dx = ev.clientX - startRef.current.x;
      const raw = startRef.current.val + dx * step;
      const snapped = Math.round(raw / step) * step;
      onChange(clamp(Number(snapped.toFixed(decimals))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "twk-num"
  }, /*#__PURE__*/React.createElement("span", {
    className: "twk-num-lbl",
    onPointerDown: onScrubStart
  }, label), /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: value,
    min: min,
    max: max,
    step: step,
    onChange: e => onChange(clamp(Number(e.target.value)))
  }), unit && /*#__PURE__*/React.createElement("span", {
    className: "twk-num-unit"
  }, unit));
}

// Relative-luminance contrast pick — checkmarks drawn over a swatch need to
// read on both #111 and #fafafa without per-option configuration. Hex input
// only (#rgb / #rrggbb); named or rgb()/hsl() colors fall through to "light".
function __twkIsLight(hex) {
  const h = String(hex).replace('#', '');
  const x = h.length === 3 ? h.replace(/./g, c => c + c) : h.padEnd(6, '0');
  const n = parseInt(x.slice(0, 6), 16);
  if (Number.isNaN(n)) return true;
  const r = n >> 16 & 255,
    g = n >> 8 & 255,
    b = n & 255;
  return r * 299 + g * 587 + b * 114 > 148000;
}
const __TwkCheck = ({
  light
}) => /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 14 14",
  "aria-hidden": "true"
}, /*#__PURE__*/React.createElement("path", {
  d: "M3 7.2 5.8 10 11 4.2",
  fill: "none",
  strokeWidth: "2.2",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  stroke: light ? 'rgba(0,0,0,.78)' : '#fff'
}));

// TweakColor — curated color/palette picker. Each option is either a single
// hex string or an array of 1-5 hex strings; the card adapts — a lone color
// renders solid, a palette renders colors[0] as the hero (left ~2/3) with the
// rest stacked in a sharp column on the right. onChange emits the
// option in the shape it was passed (string stays string, array stays array).
// Without options it falls back to the native color input for back-compat.
function TweakColor({
  label,
  value,
  options,
  onChange
}) {
  if (!options || !options.length) {
    return /*#__PURE__*/React.createElement("div", {
      className: "twk-row twk-row-h"
    }, /*#__PURE__*/React.createElement("div", {
      className: "twk-lbl"
    }, /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("input", {
      type: "color",
      className: "twk-swatch",
      value: value,
      onChange: e => onChange(e.target.value)
    }));
  }
  // Native <input type=color> emits lowercase hex per the HTML spec, so
  // compare case-insensitively. String() guards JSON.stringify(undefined),
  // which returns the primitive undefined (no .toLowerCase).
  const key = o => String(JSON.stringify(o)).toLowerCase();
  const cur = key(value);
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-chips",
    role: "radiogroup"
  }, options.map((o, i) => {
    const colors = Array.isArray(o) ? o : [o];
    const [hero, ...rest] = colors;
    const sup = rest.slice(0, 4);
    const on = key(o) === cur;
    return /*#__PURE__*/React.createElement("button", {
      key: i,
      type: "button",
      className: "twk-chip",
      role: "radio",
      "aria-checked": on,
      "data-on": on ? '1' : '0',
      "aria-label": colors.join(', '),
      title: colors.join(' · '),
      style: {
        background: hero
      },
      onClick: () => onChange(o)
    }, sup.length > 0 && /*#__PURE__*/React.createElement("span", null, sup.map((c, j) => /*#__PURE__*/React.createElement("i", {
      key: j,
      style: {
        background: c
      }
    }))), on && /*#__PURE__*/React.createElement(__TwkCheck, {
      light: __twkIsLight(hero)
    }));
  })));
}
function TweakButton({
  label,
  onClick,
  secondary = false
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: secondary ? 'twk-btn secondary' : 'twk-btn',
    onClick: onClick
  }, label);
}
Object.assign(window, {
  useTweaks,
  TweaksPanel,
  TweakSection,
  TweakRow,
  TweakSlider,
  TweakToggle,
  TweakRadio,
  TweakSelect,
  TweakText,
  TweakNumber,
  TweakColor,
  TweakButton
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "recordroom/tweaks-panel.jsx", error: String((e && e.message) || e) }); }

// reinvention/boards-cadastral.jsx
try { (() => {
/* Direction B — PLAT — boards */
;
(() => {
  function PlatIdentity() {
    return /*#__PURE__*/React.createElement("div", {
      className: "plat"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 24
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-titleblock"
    }, /*#__PURE__*/React.createElement("h1", {
      className: "plat-titleblock__name"
    }, "PDPP"), /*#__PURE__*/React.createElement("div", {
      className: "plat-titleblock__rows"
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-titleblock__row"
    }, /*#__PURE__*/React.createElement("span", null, "Personal data"), /*#__PURE__*/React.createElement("b", null, "sheet 1 of 1")), /*#__PURE__*/React.createElement("div", {
      className: "plat-titleblock__row"
    }, /*#__PURE__*/React.createElement("span", null, "Portability protocol"), /*#__PURE__*/React.createElement("b", null, "rev 0.1.0")), /*#__PURE__*/React.createElement("div", {
      className: "plat-titleblock__row"
    }, /*#__PURE__*/React.createElement("span", null, "Office of the holder"), /*#__PURE__*/React.createElement("b", null, "rec. 2025-10-14")))), /*#__PURE__*/React.createElement("p", {
      className: "plat-note",
      style: {
        textAlign: "right"
      }
    }, "ref \u2014 county plat maps,", /*#__PURE__*/React.createElement("br", null), "Sanborn atlases, recorded", /*#__PURE__*/React.createElement("br", null), "easements, title blocks")), /*#__PURE__*/React.createElement("h2", {
      className: "plat-statement"
    }, "Every field has a ", /*#__PURE__*/React.createElement("span", {
      className: "r"
    }, "boundary"), "."), /*#__PURE__*/React.createElement("p", {
      className: "plat-body"
    }, "Grant, field, record \u2014 PDPP already speaks the language of land records. Purpose-bound access ", /*#__PURE__*/React.createElement("b", null, "is"), " an easement: a recorded right to cross someone else's property, for a stated purpose, that can be ", /*#__PURE__*/React.createElement("i", null, "vacated"), ". Scopes are parcels. Withheld parcels carry the surveyor's own mark: ", /*#__PURE__*/React.createElement("b", null, "N.A.P. \u2014 Not A Part.")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "plat-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "plat-cap__name"
    }, "The plat"), /*#__PURE__*/React.createElement("span", {
      className: "plat-cap__sub"
    }, "one grant, drawn to scale")), /*#__PURE__*/React.createElement("div", {
      className: "plat-map",
      style: {
        marginTop: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-map__parcel is-pink"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-map__lot"
    }, "1"), /*#__PURE__*/React.createElement("span", {
      className: "plat-map__bearing"
    }, "N 89\xB042\u2032 E \xB7 2Y 1MO"), /*#__PURE__*/React.createElement("span", {
      className: "plat-map__pname"
    }, "pay_statements")), /*#__PURE__*/React.createElement("div", {
      className: "plat-map__parcel is-yellow"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-map__lot"
    }, "2"), /*#__PURE__*/React.createElement("span", {
      className: "plat-map__bearing"
    }, "CUR + 5Y"), /*#__PURE__*/React.createElement("span", {
      className: "plat-map__pname"
    }, "employment")), /*#__PURE__*/React.createElement("div", {
      className: "plat-map__parcel is-nap",
      style: {
        gridColumn: "1 / -1"
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-map__nap-label"
    }, "N.A.P. \u2014 tax_docs \xB7 identity \xB7 transactions")), /*#__PURE__*/React.createElement("div", {
      className: "plat-map__easement"
    }), /*#__PURE__*/React.createElement("span", {
      className: "plat-map__easement-label"
    }, "easement of purpose \u2014 longview planning"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "plat-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "plat-cap__name"
    }, "Parcel fills"), /*#__PURE__*/React.createElement("span", {
      className: "plat-cap__sub"
    }, "after the Sanborn key")), /*#__PURE__*/React.createElement("div", {
      className: "plat-fills",
      style: {
        marginTop: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-fill"
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-fill__chip is-pink"
    }), /*#__PURE__*/React.createElement("span", {
      className: "plat-fill__name"
    }, "granted / human")), /*#__PURE__*/React.createElement("div", {
      className: "plat-fill"
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-fill__chip is-yellow"
    }), /*#__PURE__*/React.createElement("span", {
      className: "plat-fill__name"
    }, "granted / machine")), /*#__PURE__*/React.createElement("div", {
      className: "plat-fill"
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-fill__chip is-hatch"
    }), /*#__PURE__*/React.createElement("span", {
      className: "plat-fill__name"
    }, "easement / purpose")), /*#__PURE__*/React.createElement("div", {
      className: "plat-fill"
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-fill__chip is-paper"
    }), /*#__PURE__*/React.createElement("span", {
      className: "plat-fill__name"
    }, "n.a.p. / withheld")), /*#__PURE__*/React.createElement("div", {
      className: "plat-fill"
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-fill__chip is-ink"
    }), /*#__PURE__*/React.createElement("span", {
      className: "plat-fill__name"
    }, "ink")))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "plat-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "plat-cap__name"
    }, "Type"), /*#__PURE__*/React.createElement("span", {
      className: "plat-cap__sub"
    }, "Barlow Condensed \xB7 Barlow \xB7 Spline Sans Mono")), /*#__PURE__*/React.createElement("div", {
      className: "plat-ramp",
      style: {
        marginTop: 6
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-ramp__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-ramp__tag"
    }, "display / cond 600"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--plat-cond)",
        fontSize: 30,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.02em"
      }
    }, "Granular access to personal data")), /*#__PURE__*/React.createElement("div", {
      className: "plat-ramp__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-ramp__tag"
    }, "body / barlow 400"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 15
      }
    }, "The resource server enforces the boundary. Only the granted parcels come back.")), /*#__PURE__*/React.createElement("div", {
      className: "plat-ramp__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-ramp__tag"
    }, "data / mono"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--plat-mono)",
        fontSize: 13
      }
    }, "pay_statements.read \xB7 append_only \xB7 exp 2025-12-14")))));
  }
  function PlatSurfaces() {
    return /*#__PURE__*/React.createElement("div", {
      className: "plat",
      style: {
        gap: 24
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-cap",
      style: {
        borderTop: 0,
        paddingTop: 0
      }
    }, /*#__PURE__*/React.createElement("h3", {
      className: "plat-cap__name"
    }, "Consent \u2014 grant of easement"), /*#__PURE__*/React.createElement("span", {
      className: "plat-cap__sub"
    }, "the parcel schedule says exactly what crosses")), /*#__PURE__*/React.createElement("div", {
      className: "plat-inst"
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-inst__head"
    }, /*#__PURE__*/React.createElement("h4", {
      className: "plat-inst__kind"
    }, "Grant of easement"), /*#__PURE__*/React.createElement("span", {
      className: "plat-inst__no"
    }, "inst. n\xBA GRT-LONGVIEW01")), /*#__PURE__*/React.createElement("div", {
      className: "plat-inst__grantee"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-inst__grantee-k"
    }, "Grantee"), /*#__PURE__*/React.createElement("span", {
      className: "plat-inst__grantee-v"
    }, "Longview Planning"), /*#__PURE__*/React.createElement("span", {
      className: "plat-inst__purpose"
    }, "easement of purpose: long_term_financial_planning")), /*#__PURE__*/React.createElement("div", {
      className: "plat-sched"
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-srow"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__lot"
    }, "1"), /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__fill is-pink"
    }), /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__what"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__name"
    }, "pay_statements.read"), /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__desc"
    }, "employer, period, gross & net pay")), /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__terms"
    }, "APPEND ONLY \xB7 2Y 1MO")), /*#__PURE__*/React.createElement("div", {
      className: "plat-srow"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__lot"
    }, "2"), /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__fill is-yellow"
    }), /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__what"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__name"
    }, "employment.read"), /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__desc"
    }, "current and previous employers, with dates")), /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__terms"
    }, "CURRENT + 5Y")), /*#__PURE__*/React.createElement("div", {
      className: "plat-srow plat-srow--nap"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__lot"
    }, "3"), /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__fill is-nap"
    }), /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__what"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__name"
    }, "tax_docs.read"), /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__desc"
    }, "not a part of this grant")), /*#__PURE__*/React.createElement("span", {
      className: "plat-srow__terms"
    }, "N.A.P."))), /*#__PURE__*/React.createElement("div", {
      className: "plat-inst__foot"
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-stamp"
    }, /*#__PURE__*/React.createElement("span", null, "Recorded \u2014 office of the holder"), /*#__PURE__*/React.createElement("b", null, "2025 OCT 14 \xB7 09:22Z")), /*#__PURE__*/React.createElement("div", {
      className: "plat-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "plat-btn",
      type: "button"
    }, "Record grant"), /*#__PURE__*/React.createElement("button", {
      className: "plat-btn plat-btn--vacate",
      type: "button"
    }, "Vacate")))), /*#__PURE__*/React.createElement("div", {
      className: "plat-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "plat-cap__name"
    }, "Recorded grant"), /*#__PURE__*/React.createElement("span", {
      className: "plat-cap__sub"
    }, "the index card in the recorder's office")), /*#__PURE__*/React.createElement("div", {
      className: "plat-record"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-record__edge"
    }, "Recorded"), /*#__PURE__*/React.createElement("div", {
      className: "plat-record__grid"
    }, /*#__PURE__*/React.createElement("div", {
      className: "plat-record__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-record__k"
    }, "Instrument"), /*#__PURE__*/React.createElement("span", {
      className: "plat-record__v"
    }, "GRT-LONGVIEW01")), /*#__PURE__*/React.createElement("div", {
      className: "plat-record__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-record__k"
    }, "Grantee"), /*#__PURE__*/React.createElement("span", {
      className: "plat-record__v"
    }, "longview")), /*#__PURE__*/React.createElement("div", {
      className: "plat-record__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-record__k"
    }, "Mode"), /*#__PURE__*/React.createElement("span", {
      className: "plat-record__v"
    }, "continuous")), /*#__PURE__*/React.createElement("div", {
      className: "plat-record__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-record__k"
    }, "Parcels"), /*#__PURE__*/React.createElement("span", {
      className: "plat-record__v"
    }, "2 granted \xB7 1 n.a.p.")), /*#__PURE__*/React.createElement("div", {
      className: "plat-record__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-record__k"
    }, "Recorded"), /*#__PURE__*/React.createElement("span", {
      className: "plat-record__v"
    }, "2025-10-14")), /*#__PURE__*/React.createElement("div", {
      className: "plat-record__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-record__k"
    }, "Expires"), /*#__PURE__*/React.createElement("span", {
      className: "plat-record__v"
    }, "2025-12-14")))), /*#__PURE__*/React.createElement("div", {
      className: "plat-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "plat-cap__name"
    }, "Statuses & actions"), /*#__PURE__*/React.createElement("span", {
      className: "plat-cap__sub"
    }, "the recorder's language, verbatim")), /*#__PURE__*/React.createElement("div", {
      className: "plat-tags"
    }, /*#__PURE__*/React.createElement("span", {
      className: "plat-tag plat-tag--recorded"
    }, "Recorded"), /*#__PURE__*/React.createElement("span", {
      className: "plat-tag"
    }, "Expires Dec 14"), /*#__PURE__*/React.createElement("span", {
      className: "plat-tag plat-tag--expiring"
    }, "Hatched \u2014 expiring"), /*#__PURE__*/React.createElement("span", {
      className: "plat-tag plat-tag--vacated"
    }, "Vacated")), /*#__PURE__*/React.createElement("div", {
      className: "plat-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "plat-btn",
      type: "button"
    }, "Record"), /*#__PURE__*/React.createElement("button", {
      className: "plat-btn plat-btn--ghost",
      type: "button"
    }, "Survey parcels"), /*#__PURE__*/React.createElement("button", {
      className: "plat-btn plat-btn--vacate",
      type: "button"
    }, "Vacate easement")));
  }
  Object.assign(window, {
    PlatIdentity,
    PlatSurfaces
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "reinvention/boards-cadastral.jsx", error: String((e && e.message) || e) }); }

// reinvention/boards-envelope.jsx
try { (() => {
/* Direction A — SECURITY TINT — boards */
;
(() => {
  function EnvIdentity() {
    return /*#__PURE__*/React.createElement("div", {
      className: "env"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 24
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-indicia"
    }, /*#__PURE__*/React.createElement("h1", {
      className: "env-indicia__name"
    }, "PDPP"), /*#__PURE__*/React.createElement("span", {
      className: "env-indicia__line"
    }, "Consent-class mail"), /*#__PURE__*/React.createElement("span", {
      className: "env-indicia__line"
    }, "Permit N\xBA 0001")), /*#__PURE__*/React.createElement("p", {
      className: "env-note",
      style: {
        textAlign: "right"
      }
    }, "ref \u2014 security-tint envelopes,", /*#__PURE__*/React.createElement("br", null), "die-cut windows, permit indicia,", /*#__PURE__*/React.createElement("br", null), "certified-mail green cards")), /*#__PURE__*/React.createElement("h2", {
      className: "env-statement"
    }, "Your data travels ", /*#__PURE__*/React.createElement("span", {
      className: "t"
    }, "sealed"), ". The grant is the window."), /*#__PURE__*/React.createElement("p", {
      className: "env-body"
    }, "A security tint has exactly one job: keeping personal data unreadable in transit. A window envelope reveals exactly the named fields and nothing else. PDPP already works this way \u2014 the brand just admits it. ", /*#__PURE__*/React.createElement("b", null, "Granted is typed. Withheld is tinted.")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "env-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "env-cap__name"
    }, "The grammar"), /*#__PURE__*/React.createElement("span", {
      className: "env-cap__sub"
    }, "one rule, applied everywhere")), /*#__PURE__*/React.createElement("div", {
      className: "env-grammar"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-field"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-field__k"
    }, "granted field"), /*#__PURE__*/React.createElement("span", {
      className: "env-field__window"
    }, "employer: Acme Co")), /*#__PURE__*/React.createElement("div", {
      className: "env-field"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-field__k"
    }, "granted field"), /*#__PURE__*/React.createElement("span", {
      className: "env-field__window"
    }, "net_pay: $3,508.12")), /*#__PURE__*/React.createElement("div", {
      className: "env-field"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-field__k"
    }, "withheld field"), /*#__PURE__*/React.createElement("span", {
      className: "env-field__bar"
    })))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "env-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "env-cap__name"
    }, "House tints"), /*#__PURE__*/React.createElement("span", {
      className: "env-cap__sub"
    }, "privacy, printed")), /*#__PURE__*/React.createElement("div", {
      className: "env-tints",
      style: {
        marginTop: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-tint-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-tint-card__chip is-hatch"
    }), /*#__PURE__*/React.createElement("span", {
      className: "env-tint-card__name"
    }, "tint/hatch \u2014 withheld")), /*#__PURE__*/React.createElement("div", {
      className: "env-tint-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-tint-card__chip is-cross"
    }), /*#__PURE__*/React.createElement("span", {
      className: "env-tint-card__name"
    }, "tint/cross \u2014 sealed")), /*#__PURE__*/React.createElement("div", {
      className: "env-tint-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-tint-card__chip is-weave"
    }), /*#__PURE__*/React.createElement("span", {
      className: "env-tint-card__name"
    }, "tint/weave \u2014 archive")))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "env-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "env-cap__name"
    }, "Palette"), /*#__PURE__*/React.createElement("span", {
      className: "env-cap__sub"
    }, "postal, not pastel")), /*#__PURE__*/React.createElement("div", {
      className: "env-palette",
      style: {
        marginTop: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-swatch"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-swatch__chip",
      style: {
        background: "oklch(0.42 0.09 265)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "env-swatch__name"
    }, "tint blue")), /*#__PURE__*/React.createElement("div", {
      className: "env-swatch"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-swatch__chip",
      style: {
        background: "oklch(0.975 0.005 95)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "env-swatch__name"
    }, "paper")), /*#__PURE__*/React.createElement("div", {
      className: "env-swatch"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-swatch__chip",
      style: {
        background: "oklch(0.85 0.035 85)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "env-swatch__name"
    }, "kraft")), /*#__PURE__*/React.createElement("div", {
      className: "env-swatch"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-swatch__chip",
      style: {
        background: "oklch(0.55 0.09 155)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "env-swatch__name"
    }, "receipt green")), /*#__PURE__*/React.createElement("div", {
      className: "env-swatch"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-swatch__chip",
      style: {
        background: "oklch(0.52 0.17 27)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "env-swatch__name"
    }, "return red")))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "env-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "env-cap__name"
    }, "Type"), /*#__PURE__*/React.createElement("span", {
      className: "env-cap__sub"
    }, "Public Sans \xB7 Courier Prime")), /*#__PURE__*/React.createElement("div", {
      className: "env-ramp",
      style: {
        marginTop: 6
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-ramp__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-ramp__tag"
    }, "display / 700"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 28,
        fontWeight: 700,
        letterSpacing: "-0.02em"
      }
    }, "Granular access to personal data.")), /*#__PURE__*/React.createElement("div", {
      className: "env-ramp__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-ramp__tag"
    }, "label / caps"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.16em",
        textTransform: "uppercase"
      }
    }, "Detach to revoke")), /*#__PURE__*/React.createElement("div", {
      className: "env-ramp__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-ramp__tag"
    }, "data / typed"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--env-type)",
        fontSize: 15
      }
    }, "pay_statements.read \u2014 append only \u2014 2y 1mo")))));
  }
  function EnvSurfaces() {
    return /*#__PURE__*/React.createElement("div", {
      className: "env",
      style: {
        gap: 24
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-cap",
      style: {
        borderTop: 0,
        paddingTop: 0
      }
    }, /*#__PURE__*/React.createElement("h3", {
      className: "env-cap__name"
    }, "Consent \u2014 the envelope"), /*#__PURE__*/React.createElement("span", {
      className: "env-cap__sub"
    }, "windows show exactly what Longview gets")), /*#__PURE__*/React.createElement("div", {
      className: "env-envelope"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-envelope__row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-envelope__from"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-envelope__from-name"
    }, "YOUR RESOURCE SERVER"), /*#__PURE__*/React.createElement("span", {
      className: "env-envelope__from-sub"
    }, "rs.nunamak.com \xB7 holder: you")), /*#__PURE__*/React.createElement("div", {
      className: "env-envelope__indicia"
    }, "PDPP", /*#__PURE__*/React.createElement("br", null), "consent-class", /*#__PURE__*/React.createElement("br", null), "N\xBA GRT-LONGVIEW01")), /*#__PURE__*/React.createElement("div", {
      className: "env-envelope__to"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-envelope__to-label"
    }, "Deliver to"), /*#__PURE__*/React.createElement("span", {
      className: "env-envelope__to-name"
    }, "LONGVIEW PLANNING"), /*#__PURE__*/React.createElement("span", {
      className: "env-envelope__to-purpose"
    }, "purpose: long_term_financial_planning")), /*#__PURE__*/React.createElement("div", {
      className: "env-window"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-window__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-window__field"
    }, "pay_statements.read"), /*#__PURE__*/React.createElement("span", {
      className: "env-window__terms"
    }, "append only \xB7 2y 1mo")), /*#__PURE__*/React.createElement("div", {
      className: "env-window__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-window__field"
    }, "employment.read"), /*#__PURE__*/React.createElement("span", {
      className: "env-window__terms"
    }, "current + 5y")), /*#__PURE__*/React.createElement("div", {
      className: "env-window__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-window__bar"
    }), /*#__PURE__*/React.createElement("span", {
      className: "env-window__bar-tag"
    }, "tax_docs \u2014 sealed")), /*#__PURE__*/React.createElement("div", {
      className: "env-window__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-window__bar",
      style: {
        maxWidth: 220
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "env-window__bar-tag"
    }, "identity \u2014 sealed"))), /*#__PURE__*/React.createElement("div", {
      className: "env-perf"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-perf__hint"
    }, "Detach here to revoke \u2014 takes effect at the server"), /*#__PURE__*/React.createElement("span", {
      className: "env-perf__no"
    }, "GRT-LONGVIEW01"))), /*#__PURE__*/React.createElement("div", {
      className: "env-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "env-cap__name"
    }, "Grant record \u2014 the green card"), /*#__PURE__*/React.createElement("span", {
      className: "env-cap__sub"
    }, "proof of consent, kept by the holder")), /*#__PURE__*/React.createElement("div", {
      className: "env-receipt"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-receipt__head"
    }, /*#__PURE__*/React.createElement("h4", {
      className: "env-receipt__title"
    }, "Return receipt \xB7 consent recorded"), /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__no"
    }, "GRT-LONGVIEW01")), /*#__PURE__*/React.createElement("div", {
      className: "env-receipt__grid"
    }, /*#__PURE__*/React.createElement("div", {
      className: "env-receipt__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__k"
    }, "Grantee"), /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__v"
    }, "Longview Planning")), /*#__PURE__*/React.createElement("div", {
      className: "env-receipt__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__k"
    }, "Mode"), /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__v"
    }, "continuous")), /*#__PURE__*/React.createElement("div", {
      className: "env-receipt__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__k"
    }, "Issued"), /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__v"
    }, "2025-10-14 09:22Z")), /*#__PURE__*/React.createElement("div", {
      className: "env-receipt__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__k"
    }, "Expires"), /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__v"
    }, "2025-12-14 09:22Z")), /*#__PURE__*/React.createElement("div", {
      className: "env-receipt__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__k"
    }, "Scopes"), /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__v"
    }, "2 granted \xB7 2 sealed")), /*#__PURE__*/React.createElement("div", {
      className: "env-receipt__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__k"
    }, "Purpose"), /*#__PURE__*/React.createElement("span", {
      className: "env-receipt__v"
    }, "long_term_financial_planning")))), /*#__PURE__*/React.createElement("div", {
      className: "env-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "env-cap__name"
    }, "Endorsements & actions"), /*#__PURE__*/React.createElement("span", {
      className: "env-cap__sub"
    }, "statuses are stamped, not badged")), /*#__PURE__*/React.createElement("div", {
      className: "env-endorse"
    }, /*#__PURE__*/React.createElement("span", {
      className: "env-tag env-tag--receipt"
    }, "Active \xB7 first class"), /*#__PURE__*/React.createElement("span", {
      className: "env-tag"
    }, "Expires Dec 14"), /*#__PURE__*/React.createElement("span", {
      className: "env-tag env-tag--tint"
    }, "Sealed \xD7 2"), /*#__PURE__*/React.createElement("span", {
      className: "env-tag env-tag--return"
    }, "Refused \u2014 returned to sender")), /*#__PURE__*/React.createElement("div", {
      className: "env-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "env-btn",
      type: "button"
    }, "Approve & seal"), /*#__PURE__*/React.createElement("button", {
      className: "env-btn env-btn--ghost",
      type: "button"
    }, "Adjust windows"), /*#__PURE__*/React.createElement("button", {
      className: "env-btn env-btn--return",
      type: "button"
    }, "Return to sender")));
  }
  Object.assign(window, {
    EnvIdentity,
    EnvSurfaces
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "reinvention/boards-envelope.jsx", error: String((e && e.message) || e) }); }

// reinvention/boards-round2-real.jsx
try { (() => {
/* PDPP vibe studies — realistic consent screens, six skins, same flow */
;
(() => {
  const REQ = {
    client: "Longview Planning",
    purpose: "Long-term financial planning",
    scopes: [{
      name: "pay_statements.read",
      desc: "Employer, pay period, gross and net pay",
      terms: "append only · 2 yrs",
      on: true
    }, {
      name: "employment.read",
      desc: "Current and past employers, with dates",
      terms: "current + 5 yrs",
      on: true
    }, {
      name: "tax_docs.read",
      desc: "W-2s and filed returns",
      terms: "not requested by you — off",
      on: false
    }],
    expires: "Dec 14, 2026",
    id: "GRT-7F2K-0419"
  };

  /* ── 1 · Carbon Copy ── */
  function R1() {
    return /*#__PURE__*/React.createElement("div", {
      className: "scr cc"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cc-top"
    }, /*#__PURE__*/React.createElement("span", {
      className: "cc-top__brand"
    }, "recordroom", /*#__PURE__*/React.createElement("em", null, ".")), /*#__PURE__*/React.createElement("span", {
      className: "cc-top__user"
    }, "m.okafor \xB7 3 grants active")), /*#__PURE__*/React.createElement("div", {
      className: "scr-main"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
      className: "cc-req__kicker"
    }, "Access request"), /*#__PURE__*/React.createElement("h1", {
      className: "cc-req__title"
    }, "Longview Planning wants to read 2 of your records"), /*#__PURE__*/React.createElement("p", {
      className: "cc-req__sub"
    }, "For ", REQ.purpose.toLowerCase(), ". They see only the fields below \u2014 nothing else crosses.")), /*#__PURE__*/React.createElement("div", {
      className: "cc-dupe"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cc-dupe__shadow"
    }), /*#__PURE__*/React.createElement("div", {
      className: "cc-card"
    }, REQ.scopes.map(s => /*#__PURE__*/React.createElement("div", {
      className: "cc-scope-row" + (s.on ? "" : " cc-scope-row--off"),
      key: s.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "cc-check" + (s.on ? " is-on" : "")
    }, s.on ? "\u00d7" : ""), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
      className: "cc-scope-row__name"
    }, s.name), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
      className: "cc-scope-row__desc"
    }, s.desc)), /*#__PURE__*/React.createElement("span", {
      className: "cc-scope-row__terms cc-scope__terms"
    }, s.terms))), /*#__PURE__*/React.createElement("div", {
      className: "cc-card__foot"
    }, /*#__PURE__*/React.createElement("span", {
      className: "cc-copytag"
    }, "Carbon \xB7 your copy stays here")))), /*#__PURE__*/React.createElement("div", {
      className: "cc-meta"
    }, /*#__PURE__*/React.createElement("span", null, "expires ", REQ.expires), /*#__PURE__*/React.createElement("span", null, "revoke anytime"), /*#__PURE__*/React.createElement("span", null, REQ.id))), /*#__PURE__*/React.createElement("div", {
      className: "cc-foot"
    }, /*#__PURE__*/React.createElement("button", {
      className: "cc-btn cc-btn--ghost",
      type: "button"
    }, "Refuse"), /*#__PURE__*/React.createElement("button", {
      className: "cc-btn",
      type: "button"
    }, "Approve 2 scopes")));
  }

  /* ── 2 · Two-Color Ribbon ── */
  function R2() {
    return /*#__PURE__*/React.createElement("div", {
      className: "scr rb"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rb-top"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rb-top__brand"
    }, "RECORDROOM"), /*#__PURE__*/React.createElement("span", {
      className: "rb-top__user"
    }, "m.okafor")), /*#__PURE__*/React.createElement("div", {
      className: "scr-main"
    }, /*#__PURE__*/React.createElement("h1", {
      className: "rb-req__title"
    }, "Longview Planning asks to read your records. Anything refused is typed ", /*#__PURE__*/React.createElement("b", null, "in red.")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "rb-field"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rb-field__k"
    }, "requester"), /*#__PURE__*/React.createElement("span", null, REQ.client)), /*#__PURE__*/React.createElement("div", {
      className: "rb-field"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rb-field__k"
    }, "purpose"), /*#__PURE__*/React.createElement("span", null, REQ.purpose)), /*#__PURE__*/React.createElement("div", {
      className: "rb-field"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rb-field__k"
    }, "expires"), /*#__PURE__*/React.createElement("span", null, REQ.expires, " \xB7 revocable anytime"))), /*#__PURE__*/React.createElement("div", null, REQ.scopes.map(s => /*#__PURE__*/React.createElement("div", {
      className: "rb-scope-line" + (s.on ? "" : " rb-scope-line--off"),
      key: s.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "rb-scope-line__mark" + (s.on ? "" : " is-no")
    }, s.on ? "[x]" : "[–]"), /*#__PURE__*/React.createElement("span", null, s.name), /*#__PURE__*/React.createElement("span", {
      className: "rb-scope-line__terms"
    }, s.terms))))), /*#__PURE__*/React.createElement("div", {
      className: "rb-foot"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rb-btn",
      type: "button"
    }, "Record consent"), /*#__PURE__*/React.createElement("button", {
      className: "rb-btn rb-btn--red",
      type: "button"
    }, "Refuse all"), /*#__PURE__*/React.createElement("span", {
      className: "rb-foot__id"
    }, REQ.id)));
  }

  /* ── 3 · Clarendon Ledger ── */
  function R3() {
    return /*#__PURE__*/React.createElement("div", {
      className: "scr cl"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cl-top"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "cl-top__brand"
    }, "Recordroom"), /*#__PURE__*/React.createElement("span", {
      className: "cl-top__user"
    }, "M. Okafor \xB7 ledger of grants")), /*#__PURE__*/React.createElement("div", {
      className: "scr-main"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
      className: "cl-req__title"
    }, /*#__PURE__*/React.createElement("b", null, "Longview Planning"), " asks leave to read two of your records."), /*#__PURE__*/React.createElement("p", {
      className: "cl-req__sub"
    }, "Purpose: ", REQ.purpose.toLowerCase(), ". Until ", REQ.expires, ", unless you strike it sooner.")), /*#__PURE__*/React.createElement("div", {
      className: "cl-sched"
    }, REQ.scopes.map((s, i) => /*#__PURE__*/React.createElement("div", {
      className: "cl-sched-row" + (s.on ? "" : " cl-sched-row--off"),
      key: s.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "cl-sched-row__no"
    }, String(i + 1).padStart(2, "0")), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
      className: "cl-sched-row__name"
    }, s.name), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
      className: "cl-sched-row__desc"
    }, s.desc)), /*#__PURE__*/React.createElement("span", {
      className: "cl-sched-row__terms"
    }, s.terms), /*#__PURE__*/React.createElement("span", {
      className: "cl-sched-row__mark"
    }, s.on ? "granted" : "—"))))), /*#__PURE__*/React.createElement("div", {
      className: "cl-foot"
    }, /*#__PURE__*/React.createElement("button", {
      className: "cl-btn",
      type: "button"
    }, "Enter in the ledger"), /*#__PURE__*/React.createElement("button", {
      className: "cl-btn cl-btn--ghost",
      type: "button"
    }, "Decline"), /*#__PURE__*/React.createElement("span", {
      className: "cl-foot__note"
    }, "No. ", REQ.id, /*#__PURE__*/React.createElement("br", null), "revocable at any time")));
  }

  /* ── 4 · Punch Column ── */
  function R4() {
    return /*#__PURE__*/React.createElement("div", {
      className: "scr pc"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pc-top"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pc-top__brand"
    }, "RECORDROOM"), /*#__PURE__*/React.createElement("span", {
      className: "pc-top__user"
    }, "M.OKAFOR \xB7 03 ACTIVE")), /*#__PURE__*/React.createElement("div", {
      className: "scr-main"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
      className: "pc-req__kicker"
    }, "Access request"), /*#__PURE__*/React.createElement("h1", {
      className: "pc-req__title"
    }, "Longview Planning wants two fields punched"), /*#__PURE__*/React.createElement("p", {
      className: "pc-req__sub"
    }, "For ", REQ.purpose.toLowerCase(), ". A field crosses only where the card is punched.")), /*#__PURE__*/React.createElement("div", {
      className: "pc-card"
    }, REQ.scopes.map(s => /*#__PURE__*/React.createElement("div", {
      className: "pc-scope",
      key: s.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "pc-slot" + (s.on ? " pc-slot--punched" : "")
    }), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
      className: "pc-scope__name"
    }, s.name), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11.5,
        color: "oklch(0.45 0.02 75)"
      }
    }, s.desc)), /*#__PURE__*/React.createElement("span", {
      className: "pc-scope__terms"
    }, s.terms))), /*#__PURE__*/React.createElement("div", {
      className: "pc-index"
    }, /*#__PURE__*/React.createElement("span", null, "0 1 2 3 4 5 6 7 8 9"), /*#__PURE__*/React.createElement("span", null, REQ.id))), /*#__PURE__*/React.createElement("div", {
      className: "pc-meta"
    }, /*#__PURE__*/React.createElement("span", null, "EXPIRES ", REQ.expires.toUpperCase()), /*#__PURE__*/React.createElement("span", null, "REVOKE ANYTIME"))), /*#__PURE__*/React.createElement("div", {
      className: "pc-foot"
    }, /*#__PURE__*/React.createElement("button", {
      className: "pc-btn pc-btn--ghost",
      type: "button"
    }, "Leave blank"), /*#__PURE__*/React.createElement("button", {
      className: "pc-btn",
      type: "button"
    }, "Punch 2 fields")));
  }

  /* ── 5 · Civic Bold ── */
  function R5() {
    return /*#__PURE__*/React.createElement("div", {
      className: "scr cb"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cb-top"
    }, /*#__PURE__*/React.createElement("span", {
      className: "cb-top__brand"
    }, "Recordroom"), /*#__PURE__*/React.createElement("span", {
      className: "cb-top__user"
    }, "m.okafor")), /*#__PURE__*/React.createElement("div", {
      className: "scr-main"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
      className: "cb-req__title"
    }, "Longview Planning wants to read ", /*#__PURE__*/React.createElement("b", null, "2 records.")), /*#__PURE__*/React.createElement("p", {
      className: "cb-req__sub"
    }, "Purpose: ", REQ.purpose.toLowerCase(), ". Only the fields below cross. Revoke whenever you want.")), /*#__PURE__*/React.createElement("div", null, REQ.scopes.map(s => /*#__PURE__*/React.createElement("div", {
      className: "cb-scope-row",
      key: s.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "cb-scope-row__name"
    }, s.name), /*#__PURE__*/React.createElement("span", {
      className: "cb-scope-row__terms"
    }, s.terms), /*#__PURE__*/React.createElement("span", {
      className: "cb-yn " + (s.on ? "cb-yn--yes" : "cb-yn--no")
    }, s.on ? "Yes" : "No")))), /*#__PURE__*/React.createElement("div", {
      className: "cb-meta"
    }, /*#__PURE__*/React.createElement("span", null, "expires ", REQ.expires), /*#__PURE__*/React.createElement("span", null, REQ.id))), /*#__PURE__*/React.createElement("div", {
      className: "cb-foot"
    }, /*#__PURE__*/React.createElement("button", {
      className: "cb-btn",
      type: "button"
    }, "Approve"), /*#__PURE__*/React.createElement("button", {
      className: "cb-btn cb-btn--ghost",
      type: "button"
    }, "Refuse")));
  }

  /* ── 6 · Greenbar ── */
  function R6() {
    return /*#__PURE__*/React.createElement("div", {
      className: "scr gb",
      style: {
        position: "relative"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "gb-sprockets gb-sprockets--l"
    }), /*#__PURE__*/React.createElement("div", {
      className: "gb-sprockets gb-sprockets--r"
    }), /*#__PURE__*/React.createElement("div", {
      className: "gb-top"
    }, /*#__PURE__*/React.createElement("span", {
      className: "gb-top__brand"
    }, "RECORDROOM"), /*#__PURE__*/React.createElement("span", {
      className: "gb-top__user"
    }, "m.okafor \xB7 cycle 2026-06")), /*#__PURE__*/React.createElement("div", {
      className: "scr-main",
      style: {
        paddingLeft: 34,
        paddingRight: 34
      }
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
      className: "gb-req__title"
    }, /*#__PURE__*/React.createElement("b", null, "Longview Planning"), " requests read access"), /*#__PURE__*/React.createElement("p", {
      className: "gb-req__sub"
    }, "Purpose: ", REQ.purpose.toLowerCase(), ". Every read is printed to your log \u2014 you can audit the full history anytime.")), /*#__PURE__*/React.createElement("div", {
      className: "gb-list"
    }, REQ.scopes.map(s => /*#__PURE__*/React.createElement("div", {
      className: "gb-row" + (s.on ? "" : " gb-row--off"),
      key: s.name
    }, /*#__PURE__*/React.createElement("span", null, s.name), /*#__PURE__*/React.createElement("span", {
      className: "gb-row__terms"
    }, s.terms))), /*#__PURE__*/React.createElement("div", {
      className: "gb-row"
    }, /*#__PURE__*/React.createElement("span", null, "expires"), /*#__PURE__*/React.createElement("span", {
      className: "gb-row__terms"
    }, REQ.expires, " \xB7 revocable anytime")))), /*#__PURE__*/React.createElement("div", {
      className: "gb-foot"
    }, /*#__PURE__*/React.createElement("button", {
      className: "gb-btn",
      type: "button"
    }, "Approve"), /*#__PURE__*/React.createElement("button", {
      className: "gb-btn gb-btn--ghost",
      type: "button"
    }, "Refuse"), /*#__PURE__*/React.createElement("span", {
      className: "gb-foot__id"
    }, REQ.id)));
  }
  Object.assign(window, {
    R1,
    R2,
    R3,
    R4,
    R5,
    R6
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "reinvention/boards-round2-real.jsx", error: String((e && e.message) || e) }); }

// reinvention/boards-round2.jsx
try { (() => {
/* PDPP — Vibe studies round 2: six personalities, same content */
;
(() => {
  const SCOPES = [{
    name: "pay_statements.read",
    terms: "append only · 2y 1mo"
  }, {
    name: "employment.read",
    terms: "current + 5y"
  }];
  function Chips({
    items,
    labelStyle
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: "vs-chips"
    }, items.map(([c, n]) => /*#__PURE__*/React.createElement("div", {
      className: "vs-chip",
      key: n,
      style: {
        background: c,
        boxShadow: "inset 0 0 0 1px rgb(0 0 0 / 0.12)"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: labelStyle
    }, n))));
  }

  /* ── 1 · CARBON COPY ── */
  function VCarbon() {
    return /*#__PURE__*/React.createElement("div", {
      className: "vs cc"
    }, /*#__PURE__*/React.createElement("div", {
      className: "vs-row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cc-lockup"
    }, /*#__PURE__*/React.createElement("h1", {
      className: "cc-lockup__name"
    }, "PD", /*#__PURE__*/React.createElement("em", null, "PP")), /*#__PURE__*/React.createElement("span", {
      className: "cc-lockup__sub"
    }, "File copy \u2014 holder")), /*#__PURE__*/React.createElement("span", {
      className: "cc-mono",
      style: {
        fontSize: 9.5,
        color: "oklch(0.55 0.01 270)",
        textAlign: "right"
      }
    }, "ref \u2014 carbon paper,", /*#__PURE__*/React.createElement("br", null), "the duplicate you keep")), /*#__PURE__*/React.createElement("h2", {
      className: "cc-statement"
    }, "Every grant writes ", /*#__PURE__*/React.createElement("em", null, "two copies"), ". Yours is the original."), /*#__PURE__*/React.createElement("div", {
      className: "cc-dupe"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cc-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cc-card__head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "cc-card__client"
    }, "Longview Planning"), /*#__PURE__*/React.createElement("span", {
      className: "cc-card__purpose"
    }, "long_term_financial_planning")), SCOPES.map(s => /*#__PURE__*/React.createElement("div", {
      className: "cc-scope",
      key: s.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "cc-scope__name"
    }, s.name), /*#__PURE__*/React.createElement("span", {
      className: "cc-scope__terms"
    }, s.terms))), /*#__PURE__*/React.createElement("div", {
      className: "cc-card__foot"
    }, /*#__PURE__*/React.createElement("span", {
      className: "cc-copytag"
    }, "Carbon \xB7 grt-longview01"), /*#__PURE__*/React.createElement("div", {
      className: "vs-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "cc-btn",
      type: "button"
    }, "Approve"), /*#__PURE__*/React.createElement("button", {
      className: "cc-btn cc-btn--ghost",
      type: "button"
    }, "Refuse"))))), /*#__PURE__*/React.createElement("div", {
      className: "vs-tags"
    }, /*#__PURE__*/React.createElement("span", {
      className: "cc-tag cc-tag--vio"
    }, "Recorded"), /*#__PURE__*/React.createElement("span", {
      className: "cc-tag"
    }, "Expires Dec 14"), /*#__PURE__*/React.createElement("span", {
      className: "cc-tag",
      style: {
        textDecoration: "line-through"
      }
    }, "Revoked")), /*#__PURE__*/React.createElement(Chips, {
      items: [["oklch(0.99 0.003 250)", "paper"], ["oklch(0.21 0.012 270)", "ink"], ["oklch(0.46 0.15 295)", "carbon"], ["oklch(0.46 0.15 295 / 0.12)", "impression"]],
      labelStyle: {
        fontFamily: '"Fragment Mono", monospace',
        color: "oklch(0.5 0.01 270)"
      }
    }));
  }

  /* ── 2 · TWO-COLOR RIBBON ── */
  function VRibbon() {
    return /*#__PURE__*/React.createElement("div", {
      className: "vs rb"
    }, /*#__PURE__*/React.createElement("div", {
      className: "vs-row"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
      className: "rb-lockup__name"
    }, "PDPP"), /*#__PURE__*/React.createElement("span", {
      className: "rb-lockup__sub"
    }, "black for the record \xB7 red for refusal")), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 9.5,
        color: "oklch(0.55 0.02 75)",
        textAlign: "right"
      }
    }, "ref \u2014 two-color", /*#__PURE__*/React.createElement("br", null), "typewriter ribbon")), /*#__PURE__*/React.createElement("h2", {
      className: "rb-statement"
    }, "The record is typed in black. ", /*#__PURE__*/React.createElement("b", null, "No is typed in red.")), /*#__PURE__*/React.createElement("div", {
      className: "rb-h"
    }, "Consent"), /*#__PURE__*/React.createElement("div", {
      className: "rb-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "rb-line"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rb-line__k"
    }, "grantee"), /*#__PURE__*/React.createElement("span", null, "Longview Planning")), /*#__PURE__*/React.createElement("div", {
      className: "rb-line"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rb-line__k"
    }, "purpose"), /*#__PURE__*/React.createElement("span", null, "long_term_financial_planning")), SCOPES.map(s => /*#__PURE__*/React.createElement("div", {
      className: "rb-line rb-line--scope",
      key: s.name
    }, /*#__PURE__*/React.createElement("span", null, s.name), /*#__PURE__*/React.createElement("span", {
      className: "rb-line__k"
    }, s.terms))), /*#__PURE__*/React.createElement("div", {
      className: "rb-line rb-line--scope"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rb-revoked"
    }, "browsing.read"), /*#__PURE__*/React.createElement("span", {
      className: "rb-tag--red rb-tag"
    }, "refused"))), /*#__PURE__*/React.createElement("div", {
      className: "vs-tags"
    }, /*#__PURE__*/React.createElement("span", {
      className: "rb-tag"
    }, "[RECORDED]"), /*#__PURE__*/React.createElement("span", {
      className: "rb-tag"
    }, "[EXPIRES 12-14]"), /*#__PURE__*/React.createElement("span", {
      className: "rb-tag rb-tag--red"
    }, "[REVOKED]")), /*#__PURE__*/React.createElement("div", {
      className: "vs-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "rb-btn",
      type: "button"
    }, "Record"), /*#__PURE__*/React.createElement("button", {
      className: "rb-btn rb-btn--red",
      type: "button"
    }, "Refuse")), /*#__PURE__*/React.createElement(Chips, {
      items: [["oklch(0.962 0.01 92)", "paper"], ["oklch(0.25 0.015 75)", "ink"], ["oklch(0.54 0.19 27)", "ribbon red"]],
      labelStyle: {
        color: "oklch(0.55 0.02 75)"
      }
    }));
  }

  /* ── 3 · CLARENDON LEDGER ── */
  function VClarendon() {
    return /*#__PURE__*/React.createElement("div", {
      className: "vs cl"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cl-frame"
    }, /*#__PURE__*/React.createElement("div", {
      className: "vs-row",
      style: {
        alignItems: "baseline"
      }
    }, /*#__PURE__*/React.createElement("h1", {
      className: "cl-lockup__name"
    }, "PDPP"), /*#__PURE__*/React.createElement("span", {
      className: "cl-lockup__sub"
    }, "est. rev 0.1.0"))), /*#__PURE__*/React.createElement("h2", {
      className: "cl-statement"
    }, "Consent, ", /*#__PURE__*/React.createElement("b", null, "recorded"), " \u2014 with the gravity of a ledger and none of the dust."), /*#__PURE__*/React.createElement("div", {
      className: "cl-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cl-card__head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "cl-card__client"
    }, "Longview Planning"), /*#__PURE__*/React.createElement("span", {
      className: "cl-card__no"
    }, "grt-longview01")), SCOPES.map((s, i) => /*#__PURE__*/React.createElement("div", {
      className: "cl-scope",
      key: s.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "cl-scope__no"
    }, String(i + 1).padStart(2, "0")), /*#__PURE__*/React.createElement("span", {
      className: "cl-scope__name"
    }, s.name), /*#__PURE__*/React.createElement("span", {
      className: "cl-scope__terms"
    }, s.terms))), /*#__PURE__*/React.createElement("div", {
      className: "vs-actions",
      style: {
        marginTop: 4
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "cl-btn",
      type: "button"
    }, "Record grant"), /*#__PURE__*/React.createElement("button", {
      className: "cl-btn cl-btn--ghost",
      type: "button"
    }, "Decline"))), /*#__PURE__*/React.createElement("div", {
      className: "vs-tags"
    }, /*#__PURE__*/React.createElement("span", {
      className: "cl-tag cl-tag--green"
    }, "Recorded"), /*#__PURE__*/React.createElement("span", {
      className: "cl-tag"
    }, "Expires Dec 14"), /*#__PURE__*/React.createElement("span", {
      className: "cl-tag"
    }, "Vacated")), /*#__PURE__*/React.createElement(Chips, {
      items: [["oklch(0.972 0.009 85)", "paper"], ["oklch(0.24 0.02 60)", "ink"], ["oklch(0.43 0.07 165)", "banknote"]],
      labelStyle: {
        fontFamily: '"Spline Sans Mono", monospace',
        color: "oklch(0.55 0.02 60)"
      }
    }));
  }

  /* ── 4 · PUNCH COLUMN ── */
  function VPunch() {
    return /*#__PURE__*/React.createElement("div", {
      className: "vs pc"
    }, /*#__PURE__*/React.createElement("div", {
      className: "vs-row"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
      className: "pc-lockup__name"
    }, "PDPP"), /*#__PURE__*/React.createElement("span", {
      className: "pc-lockup__sub"
    }, "col 01\u201380 \xB7 personal data")), /*#__PURE__*/React.createElement("span", {
      className: "pc-mono",
      style: {
        fontSize: 8.5,
        color: "oklch(0.5 0.04 75)",
        textAlign: "right"
      }
    }, "ref \u2014 tabulating cards,", /*#__PURE__*/React.createElement("br", null), "a hole is a grant")), /*#__PURE__*/React.createElement("h2", {
      className: "pc-statement"
    }, "A field is granted the way a card is punched: precisely, or not at all."), /*#__PURE__*/React.createElement("div", {
      className: "pc-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pc-card__head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pc-card__client"
    }, "Longview Planning"), /*#__PURE__*/React.createElement("span", {
      className: "pc-card__purpose"
    }, "long_term_financial_planning")), SCOPES.map(s => /*#__PURE__*/React.createElement("div", {
      className: "pc-scope",
      key: s.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "pc-slot pc-slot--punched"
    }), /*#__PURE__*/React.createElement("span", {
      className: "pc-scope__name"
    }, s.name), /*#__PURE__*/React.createElement("span", {
      className: "pc-scope__terms"
    }, s.terms))), /*#__PURE__*/React.createElement("div", {
      className: "pc-scope"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pc-slot"
    }), /*#__PURE__*/React.createElement("span", {
      className: "pc-scope__name",
      style: {
        color: "oklch(0.55 0.04 75)",
        fontWeight: 400
      }
    }, "tax_docs.read"), /*#__PURE__*/React.createElement("span", {
      className: "pc-scope__terms"
    }, "not punched")), /*#__PURE__*/React.createElement("div", {
      className: "pc-index"
    }, /*#__PURE__*/React.createElement("span", null, "0 1 2 3 4 5 6 7 8 9"), /*#__PURE__*/React.createElement("span", null, "col 12\u201318"))), /*#__PURE__*/React.createElement("div", {
      className: "vs-tags"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pc-tag pc-tag--punched"
    }, "Punched"), /*#__PURE__*/React.createElement("span", {
      className: "pc-tag"
    }, "Expires Dec 14"), /*#__PURE__*/React.createElement("span", {
      className: "pc-tag"
    }, "Void")), /*#__PURE__*/React.createElement("div", {
      className: "vs-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "pc-btn",
      type: "button"
    }, "Punch grant"), /*#__PURE__*/React.createElement("button", {
      className: "pc-btn pc-btn--ghost",
      type: "button"
    }, "Leave blank")), /*#__PURE__*/React.createElement(Chips, {
      items: [["oklch(0.93 0.028 92)", "card buff"], ["oklch(0.27 0.02 75)", "ink"], ["oklch(0.6 0.1 40)", "column rule"]],
      labelStyle: {
        fontFamily: '"Martian Mono", monospace',
        fontSize: 8,
        color: "oklch(0.5 0.04 75)"
      }
    }));
  }

  /* ── 5 · CIVIC BOLD ── */
  function VCivic() {
    return /*#__PURE__*/React.createElement("div", {
      className: "vs cb"
    }, /*#__PURE__*/React.createElement("div", {
      className: "vs-row"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
      className: "cb-lockup__name"
    }, "PDPP"), /*#__PURE__*/React.createElement("span", {
      className: "cb-lockup__sub"
    }, "protocol, in public")), /*#__PURE__*/React.createElement("span", {
      className: "cb-mono",
      style: {
        fontSize: 9.5,
        color: "oklch(0.45 0 0)",
        textAlign: "right"
      }
    }, "ref \u2014 civic signage,", /*#__PURE__*/React.createElement("br", null), "public notices")), /*#__PURE__*/React.createElement("h2", {
      className: "cb-statement"
    }, "Your data. ", /*#__PURE__*/React.createElement("b", null, "Your terms."), " In writing."), /*#__PURE__*/React.createElement("div", {
      className: "cb-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cb-card__head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "cb-card__client"
    }, "Longview Planning"), /*#__PURE__*/React.createElement("span", {
      className: "cb-card__purpose"
    }, "long_term_financial_planning")), SCOPES.map(s => /*#__PURE__*/React.createElement("div", {
      className: "cb-scope",
      key: s.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "cb-scope__name"
    }, s.name), /*#__PURE__*/React.createElement("span", {
      className: "cb-scope__terms"
    }, s.terms))), /*#__PURE__*/React.createElement("div", {
      className: "vs-actions",
      style: {
        marginTop: 4
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "cb-btn",
      type: "button"
    }, "Approve"), /*#__PURE__*/React.createElement("button", {
      className: "cb-btn cb-btn--ghost",
      type: "button"
    }, "Refuse"))), /*#__PURE__*/React.createElement("div", {
      className: "vs-tags"
    }, /*#__PURE__*/React.createElement("span", {
      className: "cb-tag cb-tag--blue"
    }, "Recorded"), /*#__PURE__*/React.createElement("span", {
      className: "cb-tag cb-tag--ghost"
    }, "Expires Dec 14"), /*#__PURE__*/React.createElement("span", {
      className: "cb-tag"
    }, "Revoked")), /*#__PURE__*/React.createElement(Chips, {
      items: [["oklch(0.985 0.002 95)", "paper"], ["oklch(0.16 0 0)", "ink"], ["oklch(0.45 0.12 262)", "stamp blue"]],
      labelStyle: {
        fontFamily: '"Fragment Mono", monospace',
        color: "oklch(0.45 0 0)"
      }
    }));
  }

  /* ── 6 · GREENBAR ── */
  function VGreenbar() {
    return /*#__PURE__*/React.createElement("div", {
      className: "vs gb",
      style: {
        paddingLeft: 30,
        paddingRight: 30,
        position: "relative"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "gb-sprockets gb-sprockets--l"
    }), /*#__PURE__*/React.createElement("div", {
      className: "gb-sprockets gb-sprockets--r"
    }), /*#__PURE__*/React.createElement("div", {
      className: "vs-row"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
      className: "gb-lockup__name"
    }, "PDPP"), /*#__PURE__*/React.createElement("span", {
      className: "gb-lockup__sub"
    }, "continuous form \xB7 holder's printout")), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 9,
        color: "oklch(0.5 0.02 250)",
        textAlign: "right"
      }
    }, "ref \u2014 greenbar paper,", /*#__PURE__*/React.createElement("br", null), "tractor-feed printouts")), /*#__PURE__*/React.createElement("h2", {
      className: "gb-statement"
    }, "The server prints what crossed. ", /*#__PURE__*/React.createElement("b", null, "Every band, accounted for.")), /*#__PURE__*/React.createElement("div", {
      className: "gb-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "gb-card__head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "gb-card__client"
    }, "Longview Planning"), /*#__PURE__*/React.createElement("span", {
      className: "gb-card__purpose"
    }, "long_term_financial_planning")), SCOPES.map(s => /*#__PURE__*/React.createElement("div", {
      className: "gb-row",
      key: s.name
    }, /*#__PURE__*/React.createElement("span", null, s.name), /*#__PURE__*/React.createElement("span", {
      className: "gb-row__terms"
    }, s.terms))), /*#__PURE__*/React.createElement("div", {
      className: "gb-row"
    }, /*#__PURE__*/React.createElement("span", null, "queries this cycle"), /*#__PURE__*/React.createElement("span", {
      className: "gb-row__terms"
    }, "14 \xB7 all inside grant")), /*#__PURE__*/React.createElement("div", {
      className: "gb-row"
    }, /*#__PURE__*/React.createElement("span", null, "last sync"), /*#__PURE__*/React.createElement("span", {
      className: "gb-row__terms"
    }, "2025-11-04 11:05Z"))), /*#__PURE__*/React.createElement("div", {
      className: "vs-tags"
    }, /*#__PURE__*/React.createElement("span", {
      className: "gb-tag gb-tag--solid"
    }, "Recorded"), /*#__PURE__*/React.createElement("span", {
      className: "gb-tag"
    }, "Expires Dec 14"), /*#__PURE__*/React.createElement("span", {
      className: "gb-tag gb-tag--red"
    }, "Revoked")), /*#__PURE__*/React.createElement("div", {
      className: "vs-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "gb-btn",
      type: "button"
    }, "Approve"), /*#__PURE__*/React.createElement("button", {
      className: "gb-btn gb-btn--ghost",
      type: "button"
    }, "Refuse")), /*#__PURE__*/React.createElement(Chips, {
      items: [["oklch(0.99 0.004 140)", "paper"], ["oklch(0.945 0.028 162)", "band"], ["oklch(0.24 0.012 250)", "ink"], ["oklch(0.42 0.06 165)", "print green"]],
      labelStyle: {
        color: "oklch(0.5 0.02 250)"
      }
    }));
  }
  Object.assign(window, {
    VCarbon,
    VRibbon,
    VClarendon,
    VPunch,
    VCivic,
    VGreenbar
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "reinvention/boards-round2.jsx", error: String((e && e.message) || e) }); }

// reinvention/boards-round3.jsx
try { (() => {
/* PDPP round 3 — console + consent, written once, themed three ways */
;
(() => {
  /* ─── Hosted consent page (light) ─── */
  function Consent({
    t
  }) {
    const isT1 = t === "t1",
      isT2 = t === "t2",
      isT3 = t === "t3";
    const endorse = isT2 ? s => `[${s.toUpperCase()}]` : isT3 ? s => s === "active" ? "● " + s : s : s => s;
    return /*#__PURE__*/React.createElement("div", {
      className: `s3 lite ${t} hc`
    }, /*#__PURE__*/React.createElement("div", {
      className: "hc-head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "hc-mark"
    }), /*#__PURE__*/React.createElement("span", {
      className: "hc-word"
    }, "PDPP"), /*#__PURE__*/React.createElement("span", {
      className: "hc-prov"
    }, "Northstar HR \xB7 provider")), /*#__PURE__*/React.createElement("div", {
      className: "hc-main"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
      className: "hc-eyebrow"
    }, isT2 ? "access request · staged via PAR" : "Access request"), /*#__PURE__*/React.createElement("h1", {
      className: "hc-title"
    }, "Longview Planning asks to read 2 streams"), /*#__PURE__*/React.createElement("p", {
      className: "hc-lede"
    }, "Purpose: ", /*#__PURE__*/React.createElement("b", null, "long-term financial planning"), ". Only the fields below cross. Every response is projected to this grant \u2014 nothing else leaves Northstar HR.")), /*#__PURE__*/React.createElement("div", {
      className: "hc-sheetwrap"
    }, (isT1 || isT2) && /*#__PURE__*/React.createElement("div", {
      className: "hc-carbon"
    }), /*#__PURE__*/React.createElement("div", {
      className: "hc-sheet"
    }, /*#__PURE__*/React.createElement("div", {
      className: "hc-sheet__head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "hc-sheet__client"
    }, "Longview Planning"), /*#__PURE__*/React.createElement("span", {
      className: "hc-sheet__serial"
    }, "grant grt_lngvw_01 \xB7 client longview_planning_v1")), /*#__PURE__*/React.createElement("div", {
      className: "hc-scope"
    }, /*#__PURE__*/React.createElement("span", {
      className: "hc-scope__name"
    }, "pay_statements.read"), /*#__PURE__*/React.createElement("span", {
      className: "hc-scope__terms"
    }, "append only \xB7 2 yrs"), /*#__PURE__*/React.createElement("span", {
      className: "hc-scope__desc"
    }, "Employer, pay period, gross and net pay \u2014 5 of 8 fields")), /*#__PURE__*/React.createElement("div", {
      className: "hc-scope"
    }, /*#__PURE__*/React.createElement("span", {
      className: "hc-scope__name"
    }, "employment.read"), /*#__PURE__*/React.createElement("span", {
      className: "hc-scope__terms"
    }, "current + 5 yrs"), /*#__PURE__*/React.createElement("span", {
      className: "hc-scope__desc"
    }, "Employers and dates. No salary history.")), /*#__PURE__*/React.createElement("div", {
      className: "hc-sheet__foot"
    }, /*#__PURE__*/React.createElement("span", {
      className: "hc-copyline"
    }, isT1 && "Carbon — your copy stays here", isT2 && "DUPLICATE — OWNER'S FILE", isT3 && "A copy stays on your server"), /*#__PURE__*/React.createElement("span", {
      className: "hc-meta"
    }, /*#__PURE__*/React.createElement("span", null, "expires 2026-12-14"))))), /*#__PURE__*/React.createElement("div", {
      className: "hc-meta"
    }, /*#__PURE__*/React.createElement("span", null, "revocable at any time"), /*#__PURE__*/React.createElement("span", null, "takes effect at the server, not the app"))), /*#__PURE__*/React.createElement("div", {
      className: "hc-foot"
    }, /*#__PURE__*/React.createElement("button", {
      className: "hc-btn hc-btn--go",
      type: "button"
    }, "Approve 2 streams"), /*#__PURE__*/React.createElement("button", {
      className: "hc-btn hc-btn--ghost",
      type: "button"
    }, "Deny"), /*#__PURE__*/React.createElement("span", {
      className: "hc-revnote"
    }, "You can revoke from your dashboard.")));
  }

  /* ─── Operator console overview (dark) ─── */
  const NAV = [["Overview", "", true], ["Explore", ""], ["Sources", "7"], ["Traces", ""], ["Grants", "4"], ["Runs", "12"], ["Schedules", "2"], ["Connect AI apps", ""], ["Deployment", ""]];
  const GRANTS = [{
    client: "Longview Planning",
    id: "grt_lngvw_01",
    scopes: "pay_statements.read · employment.read",
    exp: "exp 2026-12-14",
    st: ["st-ok", "active"],
    dupe: true
  }, {
    client: "Concert Recommendations",
    id: "grt_cncrt_02",
    scopes: "listening_history.read",
    exp: "continuous",
    st: ["st-pro", "continuous"]
  }, {
    client: "pdpp CLI — owner export",
    id: "dev_cli_07",
    scopes: "* (owner device flow)",
    exp: "exp 2026-06-11",
    st: ["st-warn", "expiring 26h"]
  }, {
    client: "Crosswise Ads",
    id: "grt_xwise_09",
    scopes: "browsing.read",
    exp: "2026-05-02",
    st: ["st-off", "revoked"],
    revoked: true
  }];
  function Console({
    t
  }) {
    const isT2 = t === "t2",
      isT3 = t === "t3";
    const fmt = s => isT2 ? `[${s.toUpperCase()}]` : isT3 && s === "active" ? "● active" : isT3 && s === "revoked" ? "⊘ revoked" : isT3 && s.startsWith("expiring") ? "◐ " + s : isT3 ? "○ " + s : s;
    return /*#__PURE__*/React.createElement("div", {
      className: `s3 dark ${t} oc`
    }, /*#__PURE__*/React.createElement("div", {
      className: "oc-side"
    }, /*#__PURE__*/React.createElement("div", {
      className: "oc-side__brand"
    }, /*#__PURE__*/React.createElement("span", {
      className: "hc-mark",
      style: {
        background: "var(--fg)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "oc-side__word"
    }, "PDPP")), /*#__PURE__*/React.createElement("nav", {
      className: "oc-nav"
    }, NAV.map(([label, count, on]) => /*#__PURE__*/React.createElement("span", {
      className: "oc-nav__item" + (on ? " is-on" : ""),
      key: label
    }, /*#__PURE__*/React.createElement("span", null, label), count ? /*#__PURE__*/React.createElement("span", {
      className: "oc-nav__count"
    }, count) : null))), /*#__PURE__*/React.createElement("div", {
      className: "oc-side__foot"
    }, "AS :7662 \xB7 RS :7663", /*#__PURE__*/React.createElement("br", null), "composed @ localhost:3002", /*#__PURE__*/React.createElement("br", null), "rev 668ecf811d47")), /*#__PURE__*/React.createElement("div", {
      className: "oc-main"
    }, /*#__PURE__*/React.createElement("div", {
      className: "oc-top"
    }, /*#__PURE__*/React.createElement("h1", {
      className: "oc-h1"
    }, "Overview"), /*#__PURE__*/React.createElement("span", {
      className: "oc-kbd"
    }, "\u2318K \u2014 jump to grant, trace, run")), /*#__PURE__*/React.createElement("div", {
      className: "oc-band"
    }, /*#__PURE__*/React.createElement("div", {
      className: "oc-cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "oc-cell__v"
    }, "2"), /*#__PURE__*/React.createElement("span", {
      className: "oc-cell__k"
    }, "connectors")), /*#__PURE__*/React.createElement("div", {
      className: "oc-cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "oc-cell__v"
    }, "7"), /*#__PURE__*/React.createElement("span", {
      className: "oc-cell__k"
    }, "streams")), /*#__PURE__*/React.createElement("div", {
      className: "oc-cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "oc-cell__v"
    }, "48,112"), /*#__PURE__*/React.createElement("span", {
      className: "oc-cell__k"
    }, "records")), /*#__PURE__*/React.createElement("div", {
      className: "oc-cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "oc-cell__v"
    }, "1.21 GB"), /*#__PURE__*/React.createElement("span", {
      className: "oc-cell__k"
    }, "retained"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "oc-listhead"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "oc-h2"
    }, isT2 ? "Grants on file" : "Grants"), /*#__PURE__*/React.createElement("span", {
      className: "oc-link"
    }, "View all 4 \u2192")), /*#__PURE__*/React.createElement("div", {
      className: "oc-list"
    }, GRANTS.map(g => /*#__PURE__*/React.createElement("div", {
      className: "oc-row" + (g.dupe && t === "t1" ? " oc-row--dupe" : "") + (g.revoked ? " oc-row--revoked" : ""),
      key: g.id
    }, /*#__PURE__*/React.createElement("span", {
      className: "oc-row__who"
    }, /*#__PURE__*/React.createElement("span", {
      className: "oc-row__client"
    }, g.client), /*#__PURE__*/React.createElement("span", {
      className: "oc-row__id"
    }, g.id)), /*#__PURE__*/React.createElement("span", {
      className: "oc-row__scopes"
    }, g.scopes), /*#__PURE__*/React.createElement("span", {
      className: "st " + g.st[0]
    }, fmt(g.st[1])), /*#__PURE__*/React.createElement("span", {
      className: "oc-row__exp"
    }, g.exp)))))));
  }
  Object.assign(window, {
    R3Consent: Consent,
    R3Console: Console
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "reinvention/boards-round3.jsx", error: String((e && e.message) || e) }); }

// reinvention/boards-strips.jsx
try { (() => {
/* Direction C — STRIP BAY — boards */
;
(() => {
  function StrIdentity() {
    return /*#__PURE__*/React.createElement("div", {
      className: "str"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 24
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "str-lockup"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-lockup__band"
    }), /*#__PURE__*/React.createElement("div", {
      className: "str-lockup__body"
    }, /*#__PURE__*/React.createElement("h1", {
      className: "str-lockup__name"
    }, "PDPP"), /*#__PURE__*/React.createElement("span", {
      className: "str-lockup__sub"
    }, "sector \u2014 personal data"))), /*#__PURE__*/React.createElement("p", {
      className: "str-note",
      style: {
        textAlign: "right"
      }
    }, "ref \u2014 flight progress strips,", /*#__PURE__*/React.createElement("br", null), "strip bays, cocked strips \xB7", /*#__PURE__*/React.createElement("br", null), "type: B612 (Airbus cockpit)")), /*#__PURE__*/React.createElement("h2", {
      className: "str-statement"
    }, "One strip per grant. ", /*#__PURE__*/React.createElement("span", {
      className: "a"
    }, "Pull it"), " to revoke."), /*#__PURE__*/React.createElement("p", {
      className: "str-body"
    }, "Flight progress strips are the most battle-tested paper UI ever designed: one strip per flight, fixed columns, nothing decorative. A strip cocked sideways demands attention. A pulled strip is ", /*#__PURE__*/React.createElement("b", null, "gone"), " \u2014 revocation you can feel. Live data deserves an operations room, not a dashboard."), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "str-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "str-cap__name"
    }, "Strip anatomy"), /*#__PURE__*/React.createElement("span", {
      className: "str-cap__sub"
    }, "fixed columns, every surface")), /*#__PURE__*/React.createElement("div", {
      className: "str-anatomy",
      style: {
        marginTop: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "str-anatomy__labels"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-anatomy__label"
    }), /*#__PURE__*/React.createElement("span", {
      className: "str-anatomy__label"
    }, "designator"), /*#__PURE__*/React.createElement("span", {
      className: "str-anatomy__label"
    }, "payload"), /*#__PURE__*/React.createElement("span", {
      className: "str-anatomy__label"
    }, "terms"), /*#__PURE__*/React.createElement("span", {
      className: "str-anatomy__label"
    }, "time")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__band is-amber"
    }), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__designator"
    }, "LNGVW01"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__type"
    }, "grant \xB7 cont")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__main"
    }, "Longview Planning"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__sub"
    }, "pay_statements + employment")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__terms"
    }, /*#__PURE__*/React.createElement("span", null, "APPEND ONLY"), /*#__PURE__*/React.createElement("span", null, "2Y 1MO")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell str-strip__cell--time"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__clock"
    }, "09:22Z"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__date"
    }, "EXP DEC 14"))))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "str-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "str-cap__name"
    }, "Palette"), /*#__PURE__*/React.createElement("span", {
      className: "str-cap__sub"
    }, "paper on the rack \u2014 amber is the holder, blue is the machine")), /*#__PURE__*/React.createElement("div", {
      className: "str-palette",
      style: {
        marginTop: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "str-swatch"
    }, /*#__PURE__*/React.createElement("div", {
      className: "str-swatch__chip",
      style: {
        background: "var(--str-rack)",
        boxShadow: "inset 0 0 0 1px var(--str-rail)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "str-swatch__name"
    }, "rack")), /*#__PURE__*/React.createElement("div", {
      className: "str-swatch"
    }, /*#__PURE__*/React.createElement("div", {
      className: "str-swatch__chip",
      style: {
        background: "var(--str-strip)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "str-swatch__name"
    }, "strip buff")), /*#__PURE__*/React.createElement("div", {
      className: "str-swatch"
    }, /*#__PURE__*/React.createElement("div", {
      className: "str-swatch__chip",
      style: {
        background: "var(--str-amber)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "str-swatch__name"
    }, "amber / holder")), /*#__PURE__*/React.createElement("div", {
      className: "str-swatch"
    }, /*#__PURE__*/React.createElement("div", {
      className: "str-swatch__chip",
      style: {
        background: "var(--str-blue)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "str-swatch__name"
    }, "blue / machine")), /*#__PURE__*/React.createElement("div", {
      className: "str-swatch"
    }, /*#__PURE__*/React.createElement("div", {
      className: "str-swatch__chip",
      style: {
        background: "var(--str-red)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "str-swatch__name"
    }, "red / time-critical")))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "str-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "str-cap__name"
    }, "Type"), /*#__PURE__*/React.createElement("span", {
      className: "str-cap__sub"
    }, "B612 \xB7 B612 Mono \u2014 commissioned for cockpit legibility")), /*#__PURE__*/React.createElement("div", {
      className: "str-ramp",
      style: {
        marginTop: 6
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "str-ramp__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-ramp__tag"
    }, "display / 700"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 26,
        fontWeight: 700
      }
    }, "Granular access to personal data.")), /*#__PURE__*/React.createElement("div", {
      className: "str-ramp__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-ramp__tag"
    }, "body / 400"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 14,
        color: "var(--str-light)"
      }
    }, "The resource server enforces the boundary. Only granted fields come back.")), /*#__PURE__*/React.createElement("div", {
      className: "str-ramp__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-ramp__tag"
    }, "data / mono 700"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--str-mono)",
        fontSize: 14,
        fontWeight: 700
      }
    }, "LNGVW01 \xB7 PAY_STMT \xB7 EXP 1214")))));
  }
  function StrSurfaces() {
    return /*#__PURE__*/React.createElement("div", {
      className: "str",
      style: {
        gap: 24
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "str-cap",
      style: {
        borderTop: 0,
        paddingTop: 0
      }
    }, /*#__PURE__*/React.createElement("h3", {
      className: "str-cap__name"
    }, "The bay \u2014 active grants"), /*#__PURE__*/React.createElement("span", {
      className: "str-cap__sub"
    }, "consent as an operations room")), /*#__PURE__*/React.createElement("div", {
      className: "str-bay"
    }, /*#__PURE__*/React.createElement("div", {
      className: "str-bay__rail"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-bay__sector"
    }, "Bay 1 \u2014 grants in effect"), /*#__PURE__*/React.createElement("span", {
      className: "str-bay__count"
    }, "3 strips \xB7 1 pulled")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__band is-amber"
    }), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__designator"
    }, "LNGVW01"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__type"
    }, "grant \xB7 cont")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__main"
    }, "Longview Planning"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__sub"
    }, "pay_statements.read + employment.read")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__terms"
    }, /*#__PURE__*/React.createElement("span", null, "APPEND ONLY"), /*#__PURE__*/React.createElement("span", null, "2Y 1MO")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell str-strip__cell--time"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__clock"
    }, "09:22Z"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__date"
    }, "EXP DEC 14"))), /*#__PURE__*/React.createElement("div", {
      className: "str-strip str-strip--blue"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__band"
    }), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__designator"
    }, "CHASE03"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__type"
    }, "stream \xB7 sync")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__main"
    }, "transactions.read"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__sub"
    }, "last sync 41 records \xB7 cursor ok")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__terms"
    }, /*#__PURE__*/React.createElement("span", null, "READ ONLY"), /*#__PURE__*/React.createElement("span", null, "90D WINDOW")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell str-strip__cell--time"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__clock"
    }, "11:05Z"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__date"
    }, "CONTINUOUS"))), /*#__PURE__*/React.createElement("div", {
      className: "str-strip str-strip--cocked"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__band is-red"
    }), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__designator"
    }, "TAXPR02"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__type"
    }, "grant \xB7 single")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__main"
    }, "TaxPrep Co"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__sub"
    }, "tax_docs.read \u2014 single use")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__terms"
    }, /*#__PURE__*/React.createElement("span", null, "ONE QUERY"), /*#__PURE__*/React.createElement("span", null, "THEN CLOSES")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell str-strip__cell--time"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__clock is-red"
    }, "-26H"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__date"
    }, "EXPIRING"))), /*#__PURE__*/React.createElement("div", {
      className: "str-bay__gap"
    }), /*#__PURE__*/React.createElement("div", {
      className: "str-pulled"
    }, /*#__PURE__*/React.createElement("div", {
      className: "str-strip"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__band"
    }), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__designator"
    }, "ADTECH09"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__type"
    }, "grant \xB7 cont")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__main"
    }, "Crosswise Ads"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__sub"
    }, "browsing.read \u2014 denied renewal")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__terms"
    }, /*#__PURE__*/React.createElement("span", null, "\u2014")), /*#__PURE__*/React.createElement("div", {
      className: "str-strip__cell str-strip__cell--time"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-strip__clock"
    }, "14:40Z"), /*#__PURE__*/React.createElement("span", {
      className: "str-strip__date"
    }, "PULLED NOV 02"))), /*#__PURE__*/React.createElement("span", {
      className: "str-pulled__caption"
    }, "pulled \u2014 revocation is authoritative at the issuer"))), /*#__PURE__*/React.createElement("div", {
      className: "str-cap"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "str-cap__name"
    }, "Statuses & actions"), /*#__PURE__*/React.createElement("span", {
      className: "str-cap__sub"
    }, "a strip out of line is the alert")), /*#__PURE__*/React.createElement("div", {
      className: "str-tags"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-tag str-tag--active"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-tag__dot"
    }), "Active"), /*#__PURE__*/React.createElement("span", {
      className: "str-tag str-tag--cont"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-tag__dot"
    }), "Continuous"), /*#__PURE__*/React.createElement("span", {
      className: "str-tag str-tag--exp"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-tag__dot"
    }), "Expiring -26h"), /*#__PURE__*/React.createElement("span", {
      className: "str-tag str-tag--pulled"
    }, /*#__PURE__*/React.createElement("span", {
      className: "str-tag__dot"
    }), "Pulled")), /*#__PURE__*/React.createElement("div", {
      className: "str-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "str-btn",
      type: "button"
    }, "File strip"), /*#__PURE__*/React.createElement("button", {
      className: "str-btn str-btn--ghost",
      type: "button"
    }, "Cock for review"), /*#__PURE__*/React.createElement("button", {
      className: "str-btn str-btn--pull",
      type: "button"
    }, "Pull strip")));
  }
  Object.assign(window, {
    StrIdentity,
    StrSurfaces
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "reinvention/boards-strips.jsx", error: String((e && e.message) || e) }); }

// reinvention/design-canvas.jsx
try { (() => {
// @ds-adherence-ignore -- omelette starter scaffold (raw elements/hex/px by design)

/* BEGIN USAGE */
// DesignCanvas.jsx — Figma-ish design canvas wrapper
// Warm gray grid bg + Sections + Artboards + PostIt notes.
// Exports (to window): DesignCanvas, DCSection, DCArtboard, DCPostIt.
// Artboards are reorderable (grip-drag), deletable, labels/titles are
// inline-editable, and any artboard can be opened in a fullscreen focus
// overlay (←/→/Esc). State persists to a .design-canvas.state.json sidecar
// via the host bridge. No assets, no deps.
//
// Usage:
//   <DesignCanvas>
//     <DCSection id="onboarding" title="Onboarding" subtitle="First-run variants">
//       <DCArtboard id="a" label="A · Dusk" width={260} height={480}>…</DCArtboard>
//       <DCArtboard id="b" label="B · Minimal" width={260} height={480}>…</DCArtboard>
//     </DCSection>
//   </DesignCanvas>
//
// Artboards are static design frames, not scroll regions — never use
// height: 100% + overflow: auto/scroll on inner elements; size each artboard
// to fit its content (explicit pixel height, or let it grow).
/* END USAGE */

const DC = {
  bg: '#f0eee9',
  grid: 'rgba(0,0,0,0.06)',
  label: 'rgba(60,50,40,0.7)',
  title: 'rgba(40,30,20,0.85)',
  subtitle: 'rgba(60,50,40,0.6)',
  postitBg: '#fef4a8',
  postitText: '#5a4a2a',
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
};

// One-time CSS injection (classes are dc-prefixed so they don't collide with
// the hosted design's own styles).
if (typeof document !== 'undefined' && !document.getElementById('dc-styles')) {
  const s = document.createElement('style');
  s.id = 'dc-styles';
  s.textContent = ['.dc-editable{cursor:text;outline:none;white-space:nowrap;border-radius:3px;padding:0 2px;margin:0 -2px}', '.dc-editable:focus{background:#fff;box-shadow:0 0 0 1.5px #c96442}', '[data-dc-slot]{transition:transform .18s cubic-bezier(.2,.7,.3,1)}', '[data-dc-slot].dc-dragging{transition:none;z-index:10;pointer-events:none}', '[data-dc-slot].dc-dragging .dc-card{box-shadow:0 12px 40px rgba(0,0,0,.25),0 0 0 2px #c96442;transform:scale(1.02)}',
  // isolation:isolate contains artboard content's z-indexes so a
  // z-indexed child (sticky navbar etc.) can't paint over .dc-header or
  // the .dc-menu popover that drops into the top of the card.
  '.dc-card{isolation:isolate;transition:box-shadow .15s,transform .15s}', '.dc-card *{scrollbar-width:none}', '.dc-card *::-webkit-scrollbar{display:none}',
  // Per-artboard header: grip + label on the left, delete/expand on the
  // right. Single flex row; when the artboard's on-screen width is too
  // narrow for both the label yields (ellipsis, then hidden entirely below
  // ~4ch via the container query) and the buttons stay on the row.
  '.dc-header{position:absolute;bottom:100%;left:-4px;margin-bottom:calc(4px * var(--dc-inv-zoom,1));z-index:2;', '  display:flex;align-items:center;container-type:inline-size}', '.dc-labelrow{display:flex;align-items:center;gap:4px;height:24px;flex:1 1 auto;min-width:0}', '.dc-grip{flex:0 0 auto;cursor:grab;display:flex;align-items:center;padding:5px 4px;border-radius:4px;transition:background .12s,opacity .12s}', '.dc-grip:hover{background:rgba(0,0,0,.08)}', '.dc-grip:active{cursor:grabbing}', '.dc-labeltext{flex:1 1 auto;min-width:0;cursor:pointer;border-radius:4px;padding:3px 6px;', '  display:flex;align-items:center;transition:background .12s;overflow:hidden}',
  // Below ~4ch of label room: hide the label entirely, and drop the grip to
  // hover-only (same reveal rule as .dc-btns) so a narrow header is clean
  // until the card is moused.
  '@container (max-width: 110px){', '  .dc-labeltext{display:none}', '  .dc-grip{opacity:0}', '  [data-dc-slot]:hover .dc-grip{opacity:1}', '}', '.dc-labeltext:hover{background:rgba(0,0,0,.05)}', '.dc-labeltext .dc-editable{overflow:hidden;text-overflow:ellipsis;max-width:100%}', '.dc-labeltext .dc-editable:focus{overflow:visible;text-overflow:clip}', '.dc-btns{flex:0 0 auto;margin-left:auto;display:flex;gap:2px;opacity:0;transition:opacity .12s}', '[data-dc-slot]:hover .dc-btns,.dc-btns:has(.dc-menu){opacity:1}', '.dc-expand,.dc-kebab{width:22px;height:22px;border-radius:5px;border:none;cursor:pointer;padding:0;', '  background:transparent;color:rgba(60,50,40,.7);display:flex;align-items:center;justify-content:center;', '  font:inherit;transition:background .12s,color .12s}', '.dc-expand:hover,.dc-kebab:hover{background:rgba(0,0,0,.06);color:#2a251f}',
  // Slot hosting an open menu floats above later siblings (which otherwise
  // paint on top — same z-index:auto, later DOM order) so the popup isn't
  // clipped by the next card.
  '[data-dc-slot]:has(.dc-menu){z-index:10}', '.dc-menu{position:absolute;top:100%;right:0;margin-top:4px;background:#fff;border-radius:8px;', '  box-shadow:0 8px 28px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.05);padding:4px;min-width:160px;z-index:10}', '.dc-menu button{display:block;width:100%;padding:7px 10px;border:0;background:transparent;', '  border-radius:5px;font-family:inherit;font-size:13px;font-weight:500;line-height:1.2;', '  color:#29261b;cursor:pointer;text-align:left;transition:background .12s;white-space:nowrap}', '.dc-menu button:hover{background:rgba(0,0,0,.05)}', '.dc-menu hr{border:0;border-top:1px solid rgba(0,0,0,.08);margin:4px 2px}', '.dc-menu .dc-danger{color:#c96442}', '.dc-menu .dc-danger:hover{background:rgba(201,100,66,.1)}',
  // Chrome (titles / labels / buttons) counter-scales against the viewport
  // zoom so it stays a constant on-screen size. --dc-inv-zoom is set by
  // DCViewport on every transform update and inherits to all descendants —
  // any overlay inside the world (e.g. a TweaksPanel on an artboard) can use
  // it the same way.
  //
  // The header uses transform:scale (out-of-flow, so layout impact doesn't
  // matter) with its world-space width set to card-width / inv-zoom so that
  // after counter-scaling its on-screen width exactly matches the card's —
  // that's what lets the container query + text-overflow behave against the
  // card's visible edge at every zoom level.
  //
  // The section head uses CSS zoom instead of transform so its layout box
  // grows with the counter-scale, pushing the card row down — otherwise the
  // constant-screen-size title would overflow into the (shrinking) world-
  // space gap and overlap the artboard headers at low zoom.
  '.dc-header{width:calc((100% + 4px) / var(--dc-inv-zoom,1));', '  transform:scale(var(--dc-inv-zoom,1));transform-origin:bottom left}', '.dc-sectionhead{zoom:var(--dc-inv-zoom,1)}'].join('\n');
  document.head.appendChild(s);
}
const DCCtx = React.createContext(null);

// Recursively unwrap React.Fragment so <>…</> grouping doesn't hide
// DCSection/DCArtboard children from the type-based walks below.
function dcFlatten(children) {
  const out = [];
  React.Children.forEach(children, c => {
    if (c && c.type === React.Fragment) out.push(...dcFlatten(c.props.children));else out.push(c);
  });
  return out;
}

// ─────────────────────────────────────────────────────────────
// DesignCanvas — stateful wrapper around the pan/zoom viewport.
// Owns runtime state (per-section order, renamed titles/labels, hidden
// artboards, focused artboard). Order/titles/labels/hidden persist to a
// .design-canvas.state.json
// sidecar next to the HTML. Reads go via plain fetch() so the saved
// arrangement is visible anywhere the HTML + sidecar are served together
// (omelette preview, direct link, downloaded zip). Writes go through the
// host's window.omelette bridge — editing requires the omelette runtime.
// Focus is ephemeral.
// ─────────────────────────────────────────────────────────────
const DC_STATE_FILE = '.design-canvas.state.json';
function DesignCanvas({
  children,
  minScale,
  maxScale,
  style
}) {
  const [state, setState] = React.useState({
    sections: {},
    focus: null
  });
  // Hold rendering until the sidecar read settles so the saved order/titles
  // appear on first paint (no source-order flash). didRead gates writes until
  // the read settles so the empty initial state can't clobber a slow read;
  // skipNextWrite suppresses the one echo-write that would otherwise follow
  // hydration.
  const [ready, setReady] = React.useState(false);
  const didRead = React.useRef(false);
  const skipNextWrite = React.useRef(false);
  React.useEffect(() => {
    let off = false;
    fetch('./' + DC_STATE_FILE).then(r => r.ok ? r.json() : null).then(saved => {
      if (off || !saved || !saved.sections) return;
      skipNextWrite.current = true;
      setState(s => ({
        ...s,
        sections: saved.sections
      }));
    }).catch(() => {}).finally(() => {
      didRead.current = true;
      if (!off) setReady(true);
    });
    const t = setTimeout(() => {
      if (!off) setReady(true);
    }, 150);
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, []);
  React.useEffect(() => {
    if (!didRead.current) return;
    if (skipNextWrite.current) {
      skipNextWrite.current = false;
      return;
    }
    const t = setTimeout(() => {
      window.omelette?.writeFile(DC_STATE_FILE, JSON.stringify({
        sections: state.sections
      })).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [state.sections]);

  // Build registries synchronously from children so FocusOverlay can read
  // them in the same render. Fragments are flattened; wrapping in other
  // elements still opts out of focus/reorder.
  const registry = {}; // slotId -> { sectionId, artboard }
  const sectionMeta = {}; // sectionId -> { title, subtitle, slotIds[] }
  const sectionOrder = [];
  dcFlatten(children).forEach(sec => {
    if (!sec || sec.type !== DCSection) return;
    const sid = sec.props.id ?? sec.props.title;
    if (!sid) return;
    sectionOrder.push(sid);
    const persisted = state.sections[sid] || {};
    const abs = [];
    dcFlatten(sec.props.children).forEach(ab => {
      if (!ab || ab.type !== DCArtboard) return;
      const aid = ab.props.id ?? ab.props.label;
      if (aid) abs.push([aid, ab]);
    });
    // hidden is scoped to one source revision — when the agent regenerates
    // (artboard-ID set changes), prior deletes don't apply to new content.
    const srcKey = abs.map(([k]) => k).join('\x1f');
    const hidden = persisted.srcKey === srcKey ? persisted.hidden || [] : [];
    const srcIds = [];
    abs.forEach(([aid, ab]) => {
      if (hidden.includes(aid)) return;
      registry[`${sid}/${aid}`] = {
        sectionId: sid,
        artboard: ab
      };
      srcIds.push(aid);
    });
    const kept = (persisted.order || []).filter(k => srcIds.includes(k));
    sectionMeta[sid] = {
      title: persisted.title ?? sec.props.title,
      subtitle: sec.props.subtitle,
      slotIds: [...kept, ...srcIds.filter(k => !kept.includes(k))]
    };
  });
  const api = React.useMemo(() => ({
    state,
    section: id => state.sections[id] || {},
    patchSection: (id, p) => setState(s => ({
      ...s,
      sections: {
        ...s.sections,
        [id]: {
          ...s.sections[id],
          ...(typeof p === 'function' ? p(s.sections[id] || {}) : p)
        }
      }
    })),
    setFocus: slotId => setState(s => ({
      ...s,
      focus: slotId
    }))
  }), [state]);

  // Esc exits focus; any outside pointerdown commits an in-progress rename.
  React.useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') api.setFocus(null);
    };
    const onPd = e => {
      const ae = document.activeElement;
      if (ae && ae.isContentEditable && !ae.contains(e.target)) ae.blur();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPd, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPd, true);
    };
  }, [api]);
  return /*#__PURE__*/React.createElement(DCCtx.Provider, {
    value: api
  }, /*#__PURE__*/React.createElement(DCViewport, {
    minScale: minScale,
    maxScale: maxScale,
    style: style
  }, ready && children), state.focus && registry[state.focus] && /*#__PURE__*/React.createElement(DCFocusOverlay, {
    entry: registry[state.focus],
    sectionMeta: sectionMeta,
    sectionOrder: sectionOrder
  }));
}

// ─────────────────────────────────────────────────────────────
// DCViewport — transform-based pan/zoom (internal)
//
// Input mapping (Figma-style):
//   • trackpad pinch  → zoom   (ctrlKey wheel; Safari gesture* events)
//   • trackpad scroll → pan    (two-finger)
//   • mouse wheel     → zoom   (notched; distinguished from trackpad scroll)
//   • middle-drag / primary-drag-on-bg → pan
//
// Transform state lives in a ref and is written straight to the DOM
// (translate3d + will-change) so wheel ticks don't go through React —
// keeps pans at 60fps on dense canvases.
// ─────────────────────────────────────────────────────────────
function DCViewport({
  children,
  minScale = 0.1,
  maxScale = 8,
  style = {}
}) {
  const vpRef = React.useRef(null);
  const worldRef = React.useRef(null);
  const tf = React.useRef({
    x: 0,
    y: 0,
    scale: 1
  });
  // Persist viewport across reloads so the user lands back where they were
  // after an agent edit or browser refresh. The sandbox origin is already
  // per-project; pathname keeps multiple canvas files in one project apart.
  const tfKey = 'dc-viewport:' + location.pathname;
  const saveT = React.useRef(0);
  const lastPostedScale = React.useRef();
  const apply = React.useCallback(() => {
    const {
      x,
      y,
      scale
    } = tf.current;
    const el = worldRef.current;
    if (!el) return;
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    // Exposed for zoom-invariant chrome (labels, buttons, TweaksPanel).
    el.style.setProperty('--dc-inv-zoom', String(1 / scale));
    // Keep the host toolbar's % readout in sync with the canvas scale. Pan
    // ticks leave scale unchanged — skip the cross-frame post for those.
    if (lastPostedScale.current !== scale) {
      lastPostedScale.current = scale;
      window.parent.postMessage({
        type: '__dc_zoom',
        scale
      }, '*');
    }
    clearTimeout(saveT.current);
    saveT.current = setTimeout(() => {
      try {
        localStorage.setItem(tfKey, JSON.stringify(tf.current));
      } catch {}
    }, 200);
  }, [tfKey]);
  React.useLayoutEffect(() => {
    const flush = () => {
      clearTimeout(saveT.current);
      try {
        localStorage.setItem(tfKey, JSON.stringify(tf.current));
      } catch {}
    };
    try {
      const s = JSON.parse(localStorage.getItem(tfKey) || 'null');
      if (s && Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.scale)) {
        tf.current = {
          x: s.x,
          y: s.y,
          scale: Math.min(maxScale, Math.max(minScale, s.scale))
        };
        apply();
      }
    } catch {}
    // Flush on pagehide and unmount so a reload within the 200ms debounce
    // window doesn't drop the last pan/zoom.
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);
  React.useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const zoomAt = (cx, cy, factor) => {
      const r = vp.getBoundingClientRect();
      const px = cx - r.left,
        py = cy - r.top;
      const t = tf.current;
      const next = Math.min(maxScale, Math.max(minScale, t.scale * factor));
      const k = next / t.scale;
      // --dc-inv-zoom consumers (.dc-sectionhead's CSS zoom, each section's
      // marginBottom) reflow on every scale change, vertically shifting the
      // world layout — so a world point mathematically pinned under the cursor
      // drifts as you zoom (content creeps up on zoom-in, down on zoom-out).
      // Anchor the DOM element under the cursor instead: record its screen Y,
      // apply the transform + --dc-inv-zoom, then cancel whatever vertical
      // drift the reflow introduced so it stays put on screen.
      let marker = null,
        markerY0 = 0;
      if (k !== 1) {
        const hit = document.elementFromPoint(cx, cy);
        marker = hit && hit.closest ? hit.closest('[data-dc-slot],[data-dc-section]') : null;
        if (marker) markerY0 = marker.getBoundingClientRect().top;
      }
      // keep the world point under the cursor fixed
      t.x = px - (px - t.x) * k;
      t.y = py - (py - t.y) * k;
      t.scale = next;
      apply();
      if (marker) {
        // A pure zoom around (cx, cy) maps screen Y → cy + (Y - cy) * k. Any
        // departure after the --dc-inv-zoom reflow is the layout drift.
        const drift = marker.getBoundingClientRect().top - (cy + (markerY0 - cy) * k);
        if (Math.abs(drift) > 0.1) {
          t.y -= drift;
          apply();
        }
      }
    };

    // Mouse-wheel vs trackpad-scroll heuristic. A physical wheel sends
    // line-mode deltas (Firefox) or large integer pixel deltas with no X
    // component (Chrome/Safari, typically multiples of 100/120). Trackpad
    // two-finger scroll sends small/fractional pixel deltas, often with
    // non-zero deltaX. ctrlKey is set by the browser for trackpad pinch.
    const isMouseWheel = e => e.deltaMode !== 0 || e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40;
    const onWheel = e => {
      e.preventDefault();
      if (isGesturing) return; // Safari: gesture* owns the pinch — discard concurrent wheels
      if ((e.ctrlKey || e.metaKey) && !isMouseWheel(e)) {
        // trackpad pinch, or ctrl/cmd + smooth-scroll mouse. Notched
        // wheels fall through to the fixed-step branch below.
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else if (isMouseWheel(e)) {
        // notched mouse wheel — fixed-ratio step per click
        zoomAt(e.clientX, e.clientY, Math.exp(-Math.sign(e.deltaY) * 0.18));
      } else {
        // trackpad two-finger scroll — pan
        tf.current.x -= e.deltaX;
        tf.current.y -= e.deltaY;
        apply();
      }
    };

    // Safari sends native gesture* events for trackpad pinch with a smooth
    // e.scale; preferring these over the ctrl+wheel fallback gives a much
    // better feel there. No-ops on other browsers. Safari also fires
    // ctrlKey wheel events during the same pinch — isGesturing makes
    // onWheel drop those entirely so they neither zoom nor pan.
    let gsBase = 1;
    let isGesturing = false;
    const onGestureStart = e => {
      e.preventDefault();
      isGesturing = true;
      gsBase = tf.current.scale;
    };
    const onGestureChange = e => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, gsBase * e.scale / tf.current.scale);
    };
    const onGestureEnd = e => {
      e.preventDefault();
      isGesturing = false;
    };

    // Drag-pan: middle button anywhere, or primary button on canvas
    // background (anything that isn't an artboard or an inline editor).
    let drag = null;
    const onPointerDown = e => {
      const onBg = !e.target.closest('[data-dc-slot], .dc-editable');
      if (!(e.button === 1 || e.button === 0 && onBg)) return;
      e.preventDefault();
      vp.setPointerCapture(e.pointerId);
      drag = {
        id: e.pointerId,
        lx: e.clientX,
        ly: e.clientY
      };
      vp.style.cursor = 'grabbing';
    };
    const onPointerMove = e => {
      if (!drag || e.pointerId !== drag.id) return;
      tf.current.x += e.clientX - drag.lx;
      tf.current.y += e.clientY - drag.ly;
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      apply();
    };
    const onPointerUp = e => {
      if (!drag || e.pointerId !== drag.id) return;
      vp.releasePointerCapture(e.pointerId);
      drag = null;
      vp.style.cursor = '';
    };

    // Host-driven zoom (toolbar % menu). Zooms around viewport centre so the
    // visible midpoint stays fixed — matching the host's iframe-zoom feel.
    const onHostMsg = e => {
      const d = e.data;
      if (d && d.type === '__dc_set_zoom' && typeof d.scale === 'number') {
        const r = vp.getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, d.scale / tf.current.scale);
      } else if (d && d.type === '__dc_probe') {
        // Host's [readyGen] reset asks whether a canvas is present; it
        // fires on the iframe's native 'load', which for canvases with
        // images/fonts is after our mount-time announce, so re-announce.
        // Clear the pan-tick guard so apply() re-posts the current scale
        // even if it's unchanged — the host just reset dcScale to 1.
        window.parent.postMessage({
          type: '__dc_present'
        }, '*');
        lastPostedScale.current = undefined;
        apply();
      }
    };
    window.addEventListener('message', onHostMsg);
    // Announce canvas mode so the host toolbar proxies its % control here
    // instead of scaling the iframe element (which would just shrink the
    // viewport window of an infinite canvas). The apply() that follows emits
    // the initial __dc_zoom so the toolbar % is correct before first pinch.
    // lastPostedScale reset mirrors the __dc_probe handler: the layout
    // effect's restore-path apply() may already have posted the restored
    // scale (before __dc_present), so clear the guard to re-post it in order.
    window.parent.postMessage({
      type: '__dc_present'
    }, '*');
    lastPostedScale.current = undefined;
    apply();
    vp.addEventListener('wheel', onWheel, {
      passive: false
    });
    vp.addEventListener('gesturestart', onGestureStart, {
      passive: false
    });
    vp.addEventListener('gesturechange', onGestureChange, {
      passive: false
    });
    vp.addEventListener('gestureend', onGestureEnd, {
      passive: false
    });
    vp.addEventListener('pointerdown', onPointerDown);
    vp.addEventListener('pointermove', onPointerMove);
    vp.addEventListener('pointerup', onPointerUp);
    vp.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('message', onHostMsg);
      vp.removeEventListener('wheel', onWheel);
      vp.removeEventListener('gesturestart', onGestureStart);
      vp.removeEventListener('gesturechange', onGestureChange);
      vp.removeEventListener('gestureend', onGestureEnd);
      vp.removeEventListener('pointerdown', onPointerDown);
      vp.removeEventListener('pointermove', onPointerMove);
      vp.removeEventListener('pointerup', onPointerUp);
      vp.removeEventListener('pointercancel', onPointerUp);
    };
  }, [apply, minScale, maxScale]);
  const gridSvg = `url("data:image/svg+xml,%3Csvg width='120' height='120' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M120 0H0v120' fill='none' stroke='${encodeURIComponent(DC.grid)}' stroke-width='1'/%3E%3C/svg%3E")`;
  return /*#__PURE__*/React.createElement("div", {
    ref: vpRef,
    className: "design-canvas",
    style: {
      height: '100vh',
      width: '100vw',
      background: DC.bg,
      overflow: 'hidden',
      overscrollBehavior: 'none',
      touchAction: 'none',
      position: 'relative',
      fontFamily: DC.font,
      boxSizing: 'border-box',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    ref: worldRef,
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      transformOrigin: '0 0',
      willChange: 'transform',
      width: 'max-content',
      minWidth: '100%',
      minHeight: '100%',
      padding: '60px 0 80px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: -6000,
      backgroundImage: gridSvg,
      backgroundSize: '120px 120px',
      pointerEvents: 'none',
      zIndex: -1
    }
  }), children));
}

// ─────────────────────────────────────────────────────────────
// DCSection — editable title + h-row of artboards in persisted order
// ─────────────────────────────────────────────────────────────
function DCSection({
  id,
  title,
  subtitle,
  children,
  gap = 48
}) {
  const ctx = React.useContext(DCCtx);
  const sid = id ?? title;
  const all = React.Children.toArray(dcFlatten(children));
  const artboards = all.filter(c => c && c.type === DCArtboard);
  const rest = all.filter(c => !(c && c.type === DCArtboard));
  const sec = ctx && sid && ctx.section(sid) || {};
  // Must match DesignCanvas's srcKey computation exactly (it filters falsy
  // IDs), or onDelete persists a srcKey that DesignCanvas never recognizes.
  const allIds = artboards.map(a => a.props.id ?? a.props.label).filter(Boolean);
  const srcKey = allIds.join('\x1f');
  const hidden = sec.srcKey === srcKey ? sec.hidden || [] : [];
  const srcOrder = allIds.filter(k => !hidden.includes(k));
  const order = React.useMemo(() => {
    const kept = (sec.order || []).filter(k => srcOrder.includes(k));
    return [...kept, ...srcOrder.filter(k => !kept.includes(k))];
  }, [sec.order, srcOrder.join('|')]);
  const byId = Object.fromEntries(artboards.map(a => [a.props.id ?? a.props.label, a]));

  // marginBottom counter-scales so the on-screen gap between sections stays
  // constant — otherwise at low zoom the (world-space) gap collapses while
  // the screen-constant sectionhead below it doesn't, and the title reads as
  // belonging to the section above. paddingBottom below is just enough for
  // the 24px artboard-header (abs-positioned above each card) plus ~8px, so
  // the title sits tight against its own row at every zoom.
  return /*#__PURE__*/React.createElement("div", {
    "data-dc-section": sid,
    style: {
      marginBottom: 'calc(80px * var(--dc-inv-zoom, 1))',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 60px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dc-sectionhead",
    style: {
      paddingBottom: 36
    }
  }, /*#__PURE__*/React.createElement(DCEditable, {
    tag: "div",
    value: sec.title ?? title,
    onChange: v => ctx && sid && ctx.patchSection(sid, {
      title: v
    }),
    style: {
      fontSize: 28,
      fontWeight: 600,
      color: DC.title,
      letterSpacing: -0.4,
      marginBottom: 6,
      display: 'inline-block'
    }
  }), subtitle && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      color: DC.subtitle
    }
  }, subtitle))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap,
      padding: '0 60px',
      alignItems: 'flex-start',
      width: 'max-content'
    }
  }, order.map(k => /*#__PURE__*/React.createElement(DCArtboardFrame, {
    key: k,
    sectionId: sid,
    artboard: byId[k],
    order: order,
    label: (sec.labels || {})[k] ?? byId[k].props.label,
    onRename: v => ctx && ctx.patchSection(sid, x => ({
      labels: {
        ...x.labels,
        [k]: v
      }
    })),
    onReorder: next => ctx && ctx.patchSection(sid, {
      order: next
    }),
    onDelete: () => ctx && ctx.patchSection(sid, x => ({
      hidden: [...(x.srcKey === srcKey ? x.hidden || [] : []), k],
      srcKey
    })),
    onFocus: () => ctx && ctx.setFocus(`${sid}/${k}`)
  }))), rest);
}

// DCArtboard — marker; rendered by DCArtboardFrame via DCSection.
function DCArtboard() {
  return null;
}

// Per-artboard export (kind: 'png' | 'html'). Both paths share the same
// self-contained clone: computed styles baked in, @font-face / <img> /
// inline-style background-image urls inlined as data URIs. PNG wraps the
// clone in foreignObject→canvas at 3× the artboard's natural width×height
// (same pipeline the host uses for page captures); HTML wraps it in a
// minimal standalone document. Both are independent of viewport zoom.
async function dcExport(node, w, h, name, kind) {
  try {
    await document.fonts.ready;
  } catch {}
  const toDataURL = url => fetch(url).then(r => r.blob()).then(b => new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => res(url);
    fr.readAsDataURL(b);
  })).catch(() => url);

  // Collect @font-face rules. ss.cssRules throws SecurityError on
  // cross-origin sheets (e.g. fonts.googleapis.com) — in that case fetch
  // the CSS text directly (those endpoints send ACAO:*) and regex-extract
  // the blocks. @import and @media/@supports are walked so nested
  // @font-face rules aren't missed.
  const fontRules = [],
    pending = [],
    seen = new Set();
  const scrapeCss = href => {
    if (seen.has(href)) return;
    seen.add(href);
    pending.push(fetch(href).then(r => r.text()).then(css => {
      for (const m of css.match(/@font-face\s*{[^}]*}/g) || []) fontRules.push({
        css: m,
        base: href
      });
      for (const m of css.matchAll(/@import\s+(?:url\()?['"]?([^'")\s;]+)/g)) scrapeCss(new URL(m[1], href).href);
    }).catch(() => {}));
  };
  const walk = (rules, base) => {
    for (const r of rules) {
      if (r.type === CSSRule.FONT_FACE_RULE) fontRules.push({
        css: r.cssText,
        base
      });else if (r.type === CSSRule.IMPORT_RULE && r.styleSheet) {
        const ibase = r.styleSheet.href || base;
        try {
          walk(r.styleSheet.cssRules, ibase);
        } catch {
          scrapeCss(ibase);
        }
      } else if (r.cssRules) walk(r.cssRules, base);
    }
  };
  for (const ss of document.styleSheets) {
    const base = ss.href || location.href;
    try {
      walk(ss.cssRules, base);
    } catch {
      if (ss.href) scrapeCss(ss.href);
    }
  }
  while (pending.length) await pending.shift();
  const fontCss = (await Promise.all(fontRules.map(async rule => {
    let out = rule.css,
      m;
    const re = /url\((['"]?)([^'")]+)\1\)/g;
    while (m = re.exec(rule.css)) {
      if (m[2].indexOf('data:') === 0) continue;
      let abs;
      try {
        abs = new URL(m[2], rule.base).href;
      } catch {
        continue;
      }
      out = out.split(m[0]).join('url("' + (await toDataURL(abs)) + '")');
    }
    return out;
  }))).join('\n');
  const cloneStyled = src => {
    if (src.nodeType === 8 || src.nodeType === 1 && src.tagName === 'SCRIPT') return document.createTextNode('');
    const dst = src.cloneNode(false);
    if (src.nodeType === 1) {
      const cs = getComputedStyle(src);
      let txt = '';
      for (let i = 0; i < cs.length; i++) txt += cs[i] + ':' + cs.getPropertyValue(cs[i]) + ';';
      dst.setAttribute('style', txt + 'animation:none;transition:none;');
      if (src.tagName === 'CANVAS') try {
        const im = document.createElement('img');
        im.src = src.toDataURL();
        im.setAttribute('style', txt);
        return im;
      } catch {}
    }
    for (let c = src.firstChild; c; c = c.nextSibling) dst.appendChild(cloneStyled(c));
    return dst;
  };
  const clone = cloneStyled(node);
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  // Drop the card's own shadow/radius so the export is a flush w×h rect;
  // the artboard's own background (if any) is already in the computed style.
  clone.style.boxShadow = 'none';
  clone.style.borderRadius = '0';
  const jobs = [];
  clone.querySelectorAll('img').forEach(el => {
    const s = el.getAttribute('src');
    if (s && s.indexOf('data:') !== 0) jobs.push(toDataURL(el.src).then(d => el.setAttribute('src', d)));
  });
  [clone, ...clone.querySelectorAll('*')].forEach(el => {
    const bg = el.style.backgroundImage;
    if (!bg) return;
    let m;
    const re = /url\(["']?([^"')]+)["']?\)/g;
    while (m = re.exec(bg)) {
      const tok = m[0],
        url = m[1];
      if (url.indexOf('data:') === 0) continue;
      jobs.push(toDataURL(url).then(d => {
        el.style.backgroundImage = el.style.backgroundImage.split(tok).join('url("' + d + '")');
      }));
    }
  });
  await Promise.all(jobs);
  const xml = new XMLSerializer().serializeToString(clone);
  const save = (blob, ext) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name + '.' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  if (kind === 'html') {
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + name + '</title>' + (fontCss ? '<style>' + fontCss + '</style>' : '') + '</head><body style="margin:0">' + xml + '</body></html>';
    return save(new Blob([html], {
      type: 'text/html'
    }), 'html');
  }

  // PNG: the SVG's own width/height must be the output resolution — an
  // <img>-loaded SVG rasterizes at its intrinsic size, so sizing it at 1×
  // and ctx.scale()-ing up would just upscale a 1× bitmap. viewBox maps the
  // w×h foreignObject onto the px·w × px·h SVG canvas so the browser renders
  // the HTML at full resolution.
  const px = 3;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w * px + '" height="' + h * px + '" viewBox="0 0 ' + w + ' ' + h + '"><foreignObject width="' + w + '" height="' + h + '">' + (fontCss ? '<style><![CDATA[' + fontCss + ']]></style>' : '') + xml + '</foreignObject></svg>';
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('svg load failed'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const cv = document.createElement('canvas');
  cv.width = w * px;
  cv.height = h * px;
  cv.getContext('2d').drawImage(img, 0, 0);
  cv.toBlob(blob => save(blob, 'png'), 'image/png');
}
function DCArtboardFrame({
  sectionId,
  artboard,
  label,
  order,
  onRename,
  onReorder,
  onFocus,
  onDelete
}) {
  const {
    id: rawId,
    label: rawLabel,
    width = 260,
    height = 480,
    children,
    style = {}
  } = artboard.props;
  const id = rawId ?? rawLabel;
  const ref = React.useRef(null);
  const cardRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  // ⋯ menu: close on any outside pointerdown. Two-click delete lives inside
  // the menu — first click arms the row, second commits; closing disarms.
  React.useEffect(() => {
    if (!menuOpen) {
      setConfirming(false);
      return;
    }
    const off = e => {
      if (!menuRef.current || !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', off, true);
    return () => document.removeEventListener('pointerdown', off, true);
  }, [menuOpen]);
  const doExport = kind => {
    setMenuOpen(false);
    if (!cardRef.current) return;
    const name = String(label || id || 'artboard').replace(/[^\w\s.-]+/g, '_');
    dcExport(cardRef.current, width, height, name, kind).catch(e => console.error('[design-canvas] export failed:', e));
  };

  // Live drag-reorder: dragged card sticks to cursor; siblings slide into
  // their would-be slots in real time via transforms. DOM order only
  // changes on drop.
  const onGripDown = e => {
    e.preventDefault();
    e.stopPropagation();
    const me = ref.current;
    // translateX is applied in local (pre-scale) space but pointer deltas and
    // getBoundingClientRect().left are screen-space — divide by the viewport's
    // current scale so the dragged card tracks the cursor at any zoom level.
    const scale = me.getBoundingClientRect().width / me.offsetWidth || 1;
    const peers = Array.from(document.querySelectorAll(`[data-dc-section="${sectionId}"] [data-dc-slot]`));
    const homes = peers.map(el => ({
      el,
      id: el.dataset.dcSlot,
      x: el.getBoundingClientRect().left
    }));
    const slotXs = homes.map(h => h.x);
    const startIdx = order.indexOf(id);
    const startX = e.clientX;
    let liveOrder = order.slice();
    me.classList.add('dc-dragging');
    const layout = () => {
      for (const h of homes) {
        if (h.id === id) continue;
        const slot = liveOrder.indexOf(h.id);
        h.el.style.transform = `translateX(${(slotXs[slot] - h.x) / scale}px)`;
      }
    };
    const move = ev => {
      const dx = ev.clientX - startX;
      me.style.transform = `translateX(${dx / scale}px)`;
      const cur = homes[startIdx].x + dx;
      let nearest = 0,
        best = Infinity;
      for (let i = 0; i < slotXs.length; i++) {
        const d = Math.abs(slotXs[i] - cur);
        if (d < best) {
          best = d;
          nearest = i;
        }
      }
      if (liveOrder.indexOf(id) !== nearest) {
        liveOrder = order.filter(k => k !== id);
        liveOrder.splice(nearest, 0, id);
        layout();
      }
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      const finalSlot = liveOrder.indexOf(id);
      me.classList.remove('dc-dragging');
      me.style.transform = `translateX(${(slotXs[finalSlot] - homes[startIdx].x) / scale}px)`;
      // After the settle transition, kill transitions + clear transforms +
      // commit the reorder in the same frame so there's no visual snap-back.
      setTimeout(() => {
        for (const h of homes) {
          h.el.style.transition = 'none';
          h.el.style.transform = '';
        }
        if (liveOrder.join('|') !== order.join('|')) onReorder(liveOrder);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          for (const h of homes) h.el.style.transition = '';
        }));
      }, 180);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement("div", {
    ref: ref,
    "data-dc-slot": id,
    style: {
      position: 'relative',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dc-header",
    "data-omelette-chrome": "",
    style: {
      color: DC.label
    },
    onPointerDown: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "dc-labelrow"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dc-grip",
    onPointerDown: onGripDown,
    title: "Drag to reorder"
  }, /*#__PURE__*/React.createElement("svg", {
    width: "9",
    height: "13",
    viewBox: "0 0 9 13",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "2",
    cy: "2",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "7",
    cy: "2",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "2",
    cy: "6.5",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "7",
    cy: "6.5",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "2",
    cy: "11",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "7",
    cy: "11",
    r: "1.1"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "dc-labeltext",
    onClick: onFocus,
    title: "Click to focus"
  }, /*#__PURE__*/React.createElement(DCEditable, {
    value: label,
    onChange: onRename,
    onClick: e => e.stopPropagation(),
    style: {
      fontSize: 15,
      fontWeight: 500,
      color: DC.label,
      lineHeight: 1
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "dc-btns"
  }, /*#__PURE__*/React.createElement("div", {
    ref: menuRef,
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "dc-kebab",
    title: "More",
    onClick: () => setMenuOpen(o => !o)
  }, /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 12 12",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "2.5",
    cy: "6",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "6",
    cy: "6",
    r: "1.1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "9.5",
    cy: "6",
    r: "1.1"
  }))), menuOpen && /*#__PURE__*/React.createElement("div", {
    className: "dc-menu",
    onPointerDown: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => doExport('png')
  }, "Download PNG"), /*#__PURE__*/React.createElement("button", {
    onClick: () => doExport('html')
  }, "Download HTML"), /*#__PURE__*/React.createElement("hr", null), /*#__PURE__*/React.createElement("button", {
    className: "dc-danger",
    onClick: () => {
      if (confirming) {
        setMenuOpen(false);
        onDelete();
      } else setConfirming(true);
    }
  }, confirming ? 'Click again to delete' : 'Delete'))), /*#__PURE__*/React.createElement("button", {
    className: "dc-expand",
    onClick: onFocus,
    title: "Focus"
  }, /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 12 12",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M7 1h4v4M5 11H1V7M11 1L7.5 4.5M1 11l3.5-3.5"
  }))))), /*#__PURE__*/React.createElement("div", {
    ref: cardRef,
    className: "dc-card",
    style: {
      borderRadius: 2,
      boxShadow: '0 1px 3px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.06)',
      overflow: 'hidden',
      width,
      height,
      background: '#fff',
      ...style
    }
  }, children || /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#bbb',
      fontSize: 13,
      fontFamily: DC.font
    }
  }, id)));
}

// Inline rename — commits on blur or Enter.
function DCEditable({
  value,
  onChange,
  style,
  tag = 'span',
  onClick
}) {
  const T = tag;
  return /*#__PURE__*/React.createElement(T, {
    className: "dc-editable",
    contentEditable: true,
    suppressContentEditableWarning: true,
    onClick: onClick,
    onPointerDown: e => e.stopPropagation(),
    onBlur: e => onChange && onChange(e.currentTarget.textContent),
    onKeyDown: e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
    style: style
  }, value);
}

// ─────────────────────────────────────────────────────────────
// Focus mode — overlay one artboard; ←/→ within section, ↑/↓ across
// sections, Esc or backdrop click to exit.
// ─────────────────────────────────────────────────────────────
function DCFocusOverlay({
  entry,
  sectionMeta,
  sectionOrder
}) {
  const ctx = React.useContext(DCCtx);
  const {
    sectionId,
    artboard
  } = entry;
  const sec = ctx.section(sectionId);
  const meta = sectionMeta[sectionId];
  const peers = meta.slotIds;
  const aid = artboard.props.id ?? artboard.props.label;
  const idx = peers.indexOf(aid);
  const secIdx = sectionOrder.indexOf(sectionId);
  const go = d => {
    const n = peers[(idx + d + peers.length) % peers.length];
    if (n) ctx.setFocus(`${sectionId}/${n}`);
  };
  const goSection = d => {
    // Sections whose artboards are all deleted have slotIds:[] — step past
    // them to the next non-empty section so ↑/↓ doesn't dead-end.
    const n = sectionOrder.length;
    for (let i = 1; i < n; i++) {
      const ns = sectionOrder[((secIdx + d * i) % n + n) % n];
      const first = sectionMeta[ns] && sectionMeta[ns].slotIds[0];
      if (first) {
        ctx.setFocus(`${ns}/${first}`);
        return;
      }
    }
  };
  React.useEffect(() => {
    const k = e => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(1);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        goSection(-1);
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        goSection(1);
      }
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  });
  const {
    width = 260,
    height = 480,
    children
  } = artboard.props;
  const [vp, setVp] = React.useState({
    w: window.innerWidth,
    h: window.innerHeight
  });
  React.useEffect(() => {
    const r = () => setVp({
      w: window.innerWidth,
      h: window.innerHeight
    });
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);
  const scale = Math.max(0.1, Math.min((vp.w - 200) / width, (vp.h - 260) / height, 2));
  const [ddOpen, setDd] = React.useState(false);
  const Arrow = ({
    dir,
    onClick
  }) => /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      onClick();
    },
    style: {
      position: 'absolute',
      top: '50%',
      [dir]: 28,
      transform: 'translateY(-50%)',
      border: 'none',
      background: 'rgba(255,255,255,.08)',
      color: 'rgba(255,255,255,.9)',
      width: 44,
      height: 44,
      borderRadius: 22,
      fontSize: 18,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background .15s'
    },
    onMouseEnter: e => e.currentTarget.style.background = 'rgba(255,255,255,.18)',
    onMouseLeave: e => e.currentTarget.style.background = 'rgba(255,255,255,.08)'
  }, /*#__PURE__*/React.createElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 18 18",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: dir === 'left' ? 'M11 3L5 9l6 6' : 'M7 3l6 6-6 6'
  })));

  // Portal to body so position:fixed is the real viewport regardless of any
  // transform on DesignCanvas's ancestors (including the canvas zoom itself).
  return ReactDOM.createPortal(/*#__PURE__*/React.createElement("div", {
    onClick: () => ctx.setFocus(null),
    onWheel: e => e.preventDefault(),
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 100,
      background: 'rgba(24,20,16,.6)',
      backdropFilter: 'blur(14px)',
      fontFamily: DC.font,
      color: '#fff'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 72,
      display: 'flex',
      alignItems: 'flex-start',
      padding: '16px 20px 0',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setDd(o => !o),
    style: {
      border: 'none',
      background: 'transparent',
      color: '#fff',
      cursor: 'pointer',
      padding: '6px 8px',
      borderRadius: 6,
      textAlign: 'left',
      fontFamily: 'inherit'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 18,
      fontWeight: 600,
      letterSpacing: -0.3
    }
  }, meta.title), /*#__PURE__*/React.createElement("svg", {
    width: "11",
    height: "11",
    viewBox: "0 0 11 11",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    style: {
      opacity: .7
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M2 4l3.5 3.5L9 4"
  }))), meta.subtitle && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 13,
      opacity: .6,
      fontWeight: 400,
      marginTop: 2
    }
  }, meta.subtitle)), ddOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      left: 0,
      marginTop: 4,
      background: '#2a251f',
      borderRadius: 8,
      boxShadow: '0 8px 32px rgba(0,0,0,.4)',
      padding: 4,
      minWidth: 200,
      zIndex: 10
    }
  }, sectionOrder.filter(sid => sectionMeta[sid].slotIds.length).map(sid => /*#__PURE__*/React.createElement("button", {
    key: sid,
    onClick: () => {
      setDd(false);
      const f = sectionMeta[sid].slotIds[0];
      if (f) ctx.setFocus(`${sid}/${f}`);
    },
    style: {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      border: 'none',
      cursor: 'pointer',
      background: sid === sectionId ? 'rgba(255,255,255,.1)' : 'transparent',
      color: '#fff',
      padding: '8px 12px',
      borderRadius: 5,
      fontSize: 14,
      fontWeight: sid === sectionId ? 600 : 400,
      fontFamily: 'inherit'
    }
  }, sectionMeta[sid].title)))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => ctx.setFocus(null),
    onMouseEnter: e => e.currentTarget.style.background = 'rgba(255,255,255,.12)',
    onMouseLeave: e => e.currentTarget.style.background = 'transparent',
    style: {
      border: 'none',
      background: 'transparent',
      color: 'rgba(255,255,255,.7)',
      width: 32,
      height: 32,
      borderRadius: 16,
      fontSize: 20,
      cursor: 'pointer',
      lineHeight: 1,
      transition: 'background .12s'
    }
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 64,
      bottom: 56,
      left: 100,
      right: 100,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      width: width * scale,
      height: height * scale,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width,
      height,
      transform: `scale(${scale})`,
      transformOrigin: 'top left',
      background: '#fff',
      borderRadius: 2,
      overflow: 'hidden',
      boxShadow: '0 20px 80px rgba(0,0,0,.4)'
    }
  }, children || /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#bbb'
    }
  }, aid))), /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      fontSize: 14,
      fontWeight: 500,
      opacity: .85,
      textAlign: 'center'
    }
  }, (sec.labels || {})[aid] ?? artboard.props.label, /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: .5,
      marginLeft: 10,
      fontVariantNumeric: 'tabular-nums'
    }
  }, idx + 1, " / ", peers.length))), /*#__PURE__*/React.createElement(Arrow, {
    dir: "left",
    onClick: () => go(-1)
  }), /*#__PURE__*/React.createElement(Arrow, {
    dir: "right",
    onClick: () => go(1)
  }), /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      position: 'absolute',
      bottom: 20,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: 8
    }
  }, peers.map((p, i) => /*#__PURE__*/React.createElement("button", {
    key: p,
    onClick: () => ctx.setFocus(`${sectionId}/${p}`),
    style: {
      border: 'none',
      padding: 0,
      cursor: 'pointer',
      width: 6,
      height: 6,
      borderRadius: 3,
      background: i === idx ? '#fff' : 'rgba(255,255,255,.3)'
    }
  })))), document.body);
}

// ─────────────────────────────────────────────────────────────
// Post-it — absolute-positioned sticky note
// ─────────────────────────────────────────────────────────────
function DCPostIt({
  children,
  top,
  left,
  right,
  bottom,
  rotate = -2,
  width = 180
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top,
      left,
      right,
      bottom,
      width,
      background: DC.postitBg,
      padding: '14px 16px',
      fontFamily: '"Comic Sans MS", "Marker Felt", "Segoe Print", cursive',
      fontSize: 14,
      lineHeight: 1.4,
      color: DC.postitText,
      boxShadow: '0 2px 8px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)',
      transform: `rotate(${rotate}deg)`,
      zIndex: 5
    }
  }, children);
}
Object.assign(window, {
  DesignCanvas,
  DCSection,
  DCArtboard,
  DCPostIt
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "reinvention/design-canvas.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/ConsentCard.jsx
try { (() => {
// ConsentCard — the user-facing grant-approval surface. Human-temperature.

const DEFAULT_SCOPES = [{
  id: 'pay',
  title: 'Pay statements',
  sub: 'Employer, pay period, gross & net pay.',
  scope: 'pay_statements.read',
  tag: 'append only',
  retention: '2y 1mo',
  on: true
}, {
  id: 'emp',
  title: 'Employment',
  sub: 'Current and previous employers with dates.',
  scope: 'employment.read',
  tag: 'mutable state',
  retention: 'current + 5y',
  on: true
}, {
  id: 'tax',
  title: 'Tax documents',
  sub: 'W-2 and 1099 forms issued to you.',
  scope: 'tax_docs.read',
  tag: 'append only',
  retention: '3y history',
  on: false
}];
const ConsentCard = () => {
  const [scopes, setScopes] = React.useState(DEFAULT_SCOPES);
  const toggle = id => setScopes(s => s.map(x => x.id === id ? {
    ...x,
    on: !x.on
  } : x));
  const anyOn = scopes.some(s => s.on);
  return /*#__PURE__*/React.createElement("div", {
    className: "pdpp-surface-human",
    style: {
      overflow: 'hidden',
      maxWidth: 640
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '22px 24px 18px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "pdpp-eyebrow",
    style: {
      color: 'var(--human)'
    }
  }, "CONSENT \xB7 SECTION 3"), /*#__PURE__*/React.createElement("div", {
    className: "pdpp-heading",
    style: {
      marginTop: 10,
      fontSize: 22,
      lineHeight: 1.25
    }
  }, "Longview Planning wants access to your data"), /*#__PURE__*/React.createElement("p", {
    className: "pdpp-body",
    style: {
      margin: '10px 0 0',
      color: 'var(--muted-foreground)'
    }
  }, "They\u2019ll use it for ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--edu-fg)',
      fontFamily: 'var(--font-mono)',
      fontSize: 13
    }
  }, "long-term financial planning"), ". You can revoke at any time.")), /*#__PURE__*/React.createElement("hr", {
    className: "pdpp-rule"
  }), /*#__PURE__*/React.createElement("div", null, scopes.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: s.id,
    onClick: () => toggle(s.id),
    style: {
      display: 'grid',
      gridTemplateColumns: '24px 1fr auto',
      gap: 12,
      padding: '14px 24px',
      borderTop: i > 0 ? '1px solid var(--border)' : 'none',
      cursor: 'pointer',
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 18,
      height: 18,
      borderRadius: 4,
      marginTop: 2,
      background: s.on ? 'var(--foreground)' : 'var(--card)',
      border: s.on ? '1px solid var(--foreground)' : '1px solid var(--input)',
      position: 'relative'
    }
  }, s.on && /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 18 18",
    style: {
      position: 'absolute',
      inset: 0
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M4 9.5 L7.5 13 L14 5.5",
    stroke: "var(--background)",
    strokeWidth: "2",
    fill: "none",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "pdpp-title"
  }, s.title), /*#__PURE__*/React.createElement("div", {
    className: "pdpp-caption",
    style: {
      color: 'var(--muted-foreground)',
      marginTop: 2
    }
  }, s.sub), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      marginTop: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "pdpp-badge pdpp-badge-outline"
  }, s.tag), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 11.5,
      color: 'var(--muted-foreground)'
    }
  }, s.scope))), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 11.5,
      color: 'var(--muted-foreground)',
      whiteSpace: 'nowrap'
    }
  }, s.retention)))), /*#__PURE__*/React.createElement("hr", {
    className: "pdpp-rule"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 24px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "pdpp-caption",
    style: {
      color: 'var(--muted-foreground)'
    }
  }, "These are their commitments, not enforced by your server."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "pdpp-btn pdpp-btn-ghost",
    style: {
      height: 34,
      fontSize: 13
    }
  }, "Deny"), /*#__PURE__*/React.createElement("button", {
    className: "pdpp-btn pdpp-btn-primary",
    style: {
      height: 34,
      fontSize: 13,
      opacity: anyOn ? 1 : 0.5
    },
    disabled: !anyOn
  }, "Grant access"))));
};
window.ConsentCard = ConsentCard;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/ConsentCard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/GrantInspector.jsx
try { (() => {
// GrantInspector — the protocol-temperature companion to ConsentCard.
// Shows a grant "as issued" in machine terms.

const GrantInspector = ({
  grantId = 'grt_longview01'
}) => /*#__PURE__*/React.createElement("div", {
  className: "pdpp-surface-protocol",
  style: {
    overflow: 'hidden',
    maxWidth: 640
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '20px 24px 14px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start'
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "pdpp-eyebrow",
  style: {
    color: 'var(--primary)'
  }
}, "GRANT \xB7 ISSUED"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 18,
    fontWeight: 500,
    marginTop: 6,
    letterSpacing: '-0.005em'
  }
}, grantId)), /*#__PURE__*/React.createElement("span", {
  className: "pdpp-badge pdpp-badge-success"
}, /*#__PURE__*/React.createElement("span", {
  className: "pdpp-dot"
}), "active"))), /*#__PURE__*/React.createElement("hr", {
  className: "pdpp-rule"
}), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: '120px 1fr',
    gap: 0
  }
}, [['purpose', /*#__PURE__*/React.createElement("span", {
  style: {
    color: 'var(--edu-fg)'
  }
}, "long_term_financial_planning")], ['mode', 'continuous'], ['scopes', /*#__PURE__*/React.createElement("span", null, "pay_statements.read \xB7 employment.read")], ['fields', 'employer, pay_period, gross_pay, net_pay'], ['time_range', 'last 2y 1mo'], ['issued', '2025-10-14T09:22:07Z'], ['expires', '2025-12-14T09:22:07Z']].map(([k, v], i) => /*#__PURE__*/React.createElement(React.Fragment, {
  key: k
}, /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '9px 24px',
    borderTop: '1px solid var(--border)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--muted-foreground)'
  }
}, k), /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '9px 24px 9px 0',
    borderTop: '1px solid var(--border)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12.5,
    color: 'var(--foreground)'
  }
}, v)))), /*#__PURE__*/React.createElement("hr", {
  className: "pdpp-rule"
}), /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '12px 24px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  }
}, /*#__PURE__*/React.createElement("span", {
  className: "pdpp-caption",
  style: {
    color: 'var(--muted-foreground)'
  }
}, "The grant is the artifact. Collection is a companion mechanism."), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 6
  }
}, /*#__PURE__*/React.createElement("button", {
  className: "pdpp-btn pdpp-btn-ghost",
  style: {
    height: 30,
    fontSize: 12
  }
}, "Copy JSON"), /*#__PURE__*/React.createElement("button", {
  className: "pdpp-btn pdpp-btn-outline",
  style: {
    height: 30,
    fontSize: 12
  }
}, "Revoke \u21BA"))));
window.GrantInspector = GrantInspector;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/GrantInspector.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/GrantsList.jsx
try { (() => {
// GrantsList — the owner's dashboard of active grants.

const GRANTS = [{
  id: 'grt_longview01',
  client: 'Longview Planning',
  monogram: 'LV',
  purpose: 'long_term_financial_planning',
  status: 'active',
  scopes: ['pay_statements.read', 'employment.read'],
  issued: 'Oct 14, 2025',
  expires: 'Dec 14, 2025'
}, {
  id: 'grt_acme_kyc_02',
  client: 'Acme KYC',
  monogram: 'AK',
  purpose: 'identity_verification',
  status: 'active',
  scopes: ['identity.read'],
  issued: 'Nov 02, 2025',
  expires: 'Nov 03, 2025'
}, {
  id: 'grt_forecast_17',
  client: 'Forecast Mortgage',
  monogram: 'FM',
  purpose: 'underwriting_review',
  status: 'expiring',
  scopes: ['pay_statements.read', 'tax_docs.read', 'employment.read'],
  issued: 'Sep 28, 2025',
  expires: 'in 2 days'
}, {
  id: 'grt_oldmedical',
  client: 'Old Medical LLC',
  monogram: 'OM',
  purpose: 'insurance_claim',
  status: 'revoked',
  scopes: ['identity.read'],
  issued: 'Aug 05, 2025',
  expires: '—'
}];
const STATUS_CLASS = {
  active: 'pdpp-badge-success',
  expiring: 'pdpp-badge-warning',
  revoked: 'pdpp-badge-destructive'
};
const GrantsList = ({
  onOpen
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end'
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "pdpp-heading"
}, "Your grants"), /*#__PURE__*/React.createElement("div", {
  className: "pdpp-caption",
  style: {
    color: 'var(--muted-foreground)'
  }
}, "4 grants \xB7 2 active \xB7 1 expiring \xB7 1 revoked")), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 6
  }
}, /*#__PURE__*/React.createElement("button", {
  className: "pdpp-btn pdpp-btn-ghost",
  style: {
    height: 30,
    fontSize: 12
  }
}, "Filter"), /*#__PURE__*/React.createElement("button", {
  className: "pdpp-btn pdpp-btn-outline",
  style: {
    height: 30,
    fontSize: 12
  }
}, "Export"))), GRANTS.map(g => /*#__PURE__*/React.createElement("div", {
  key: g.id,
  onClick: () => onOpen && onOpen(g),
  className: g.status === 'revoked' ? 'pdpp-surface-neutral' : 'pdpp-surface-protocol',
  style: {
    padding: '14px 16px',
    cursor: 'pointer',
    opacity: g.status === 'revoked' ? 0.65 : 1
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    minWidth: 0
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: 32,
    height: 32,
    borderRadius: 6,
    background: g.status === 'revoked' ? 'var(--muted)' : 'oklch(0.52 0.09 45 / 0.14)',
    color: g.status === 'revoked' ? 'var(--muted-foreground)' : 'var(--human)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    fontWeight: 600,
    flexShrink: 0
  }
}, g.monogram), /*#__PURE__*/React.createElement("div", {
  style: {
    minWidth: 0
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "pdpp-title"
}, g.client), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11.5,
    color: 'var(--edu-fg)'
  }
}, "// ", g.purpose))), /*#__PURE__*/React.createElement("span", {
  className: `pdpp-badge ${STATUS_CLASS[g.status]}`
}, /*#__PURE__*/React.createElement("span", {
  className: "pdpp-dot"
}), g.status)), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 6,
    marginTop: 10,
    flexWrap: 'wrap'
  }
}, g.scopes.map(sc => /*#__PURE__*/React.createElement("span", {
  key: sc,
  className: "pdpp-chip",
  style: {
    fontSize: 11,
    padding: '1px 8px'
  }
}, sc))), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 18,
    marginTop: 10,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--muted-foreground)'
  }
}, /*#__PURE__*/React.createElement("span", null, g.id), /*#__PURE__*/React.createElement("span", null, "issued ", g.issued), /*#__PURE__*/React.createElement("span", null, "expires ", g.expires)))));
window.GrantsList = GrantsList;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/GrantsList.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/Hero.jsx
try { (() => {
// Hero — the cross-quadrant layout from apps/web. Copper left rule on content column.

const Hero = () => /*#__PURE__*/React.createElement("section", {
  style: {
    padding: '80px 48px 96px',
    maxWidth: 'var(--content-wide-width)',
    margin: '0 auto'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: 'var(--pdpp-sidebar-width) 1fr',
    gap: 48
  }
}, /*#__PURE__*/React.createElement("div", null), " ", /*#__PURE__*/React.createElement("div", {
  style: {
    borderLeft: '2px solid var(--human)',
    paddingLeft: 32
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "pdpp-eyebrow",
  style: {
    marginBottom: 14
  }
}, "PDPP \xB7 v0.1.0 draft"), /*#__PURE__*/React.createElement("h1", {
  className: "pdpp-display-lg",
  style: {
    margin: 0,
    maxWidth: 880
  }
}, "Granular access to ", /*#__PURE__*/React.createElement("span", {
  style: {
    color: 'var(--primary)'
  }
}, "personal data.")), /*#__PURE__*/React.createElement("p", {
  className: "pdpp-body-lg",
  style: {
    margin: '20px 0 32px',
    maxWidth: 640,
    color: 'var(--muted-foreground)'
  }
}, "An open specification for how personal user data flows through the digital economy. Clients request named records and fields. Every response stays inside the grant."), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 10,
    alignItems: 'center'
  }
}, /*#__PURE__*/React.createElement("button", {
  className: "pdpp-btn pdpp-btn-primary",
  style: {
    height: 40,
    padding: '0 18px',
    fontSize: 14
  }
}, "Read the spec"), /*#__PURE__*/React.createElement("button", {
  className: "pdpp-btn pdpp-btn-outline",
  style: {
    height: 40,
    padding: '0 16px',
    fontSize: 14
  }
}, "View on GitHub \u203A"), /*#__PURE__*/React.createElement("span", {
  style: {
    marginLeft: 12,
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--muted-foreground)'
  }
}, "RFC status \xB7 draft 3")), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 56,
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 32,
    borderTop: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)'
  }
}, [{
  k: 'GRANT',
  t: 'The portable artifact',
  b: 'A grant names resources, fields, purpose, duration, and mode.'
}, {
  k: 'STREAM',
  t: 'Named data shapes',
  b: 'Pay statements, employment, tax docs — declared, typed, versioned.'
}, {
  k: 'ENFORCE',
  t: 'Server-side boundary',
  b: 'Only the granted fields come back. Purpose is declared, not enforced.'
}].map((c, i) => /*#__PURE__*/React.createElement("div", {
  key: i,
  style: {
    padding: '24px 0',
    borderRight: i < 2 ? '1px solid var(--border)' : 'none',
    paddingRight: i < 2 ? 32 : 0,
    minWidth: 0
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "pdpp-eyebrow",
  style: {
    color: 'var(--primary)'
  }
}, c.k), /*#__PURE__*/React.createElement("div", {
  className: "pdpp-heading",
  style: {
    marginTop: 6
  }
}, c.t), /*#__PURE__*/React.createElement("p", {
  className: "pdpp-body",
  style: {
    margin: '6px 0 0',
    color: 'var(--muted-foreground)'
  }
}, c.b)))))));
window.Hero = Hero;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/Hero.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/SiteHeader.jsx
try { (() => {
// Site header — nav with logo, docs/spec/palette links, GitHub CTA
const SiteHeader = ({
  active = 'home',
  onNav
}) => /*#__PURE__*/React.createElement("header", {
  style: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    backdropFilter: 'blur(8px)',
    background: 'oklch(0.99 0.002 95 / 0.85)',
    borderBottom: '1px solid var(--border)',
    height: '56px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 'var(--content-wide-width)',
    margin: '0 auto',
    height: '100%',
    padding: '0 48px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 24
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 10
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: 22,
    height: 22,
    borderRadius: 4,
    background: 'var(--primary)',
    color: 'var(--primary-foreground)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: 11
  }
}, "P"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontWeight: 600,
    fontSize: 15,
    letterSpacing: '-0.02em'
  }
}, "PDPP"), /*#__PURE__*/React.createElement("span", {
  className: "pdpp-chip",
  style: {
    marginLeft: 4,
    fontSize: 11,
    padding: '0 6px'
  }
}, "v0.1.0")), /*#__PURE__*/React.createElement("nav", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 4
  }
}, ['home', 'spec', 'design', 'palette', 'docs'].map(k => /*#__PURE__*/React.createElement("button", {
  key: k,
  onClick: () => onNav && onNav(k),
  className: "pdpp-btn pdpp-btn-ghost",
  style: {
    height: 32,
    padding: '0 10px',
    fontSize: 13,
    color: active === k ? 'var(--foreground)' : 'var(--muted-foreground)',
    fontWeight: active === k ? 500 : 400
  }
}, k)), /*#__PURE__*/React.createElement("div", {
  style: {
    width: 1,
    height: 18,
    background: 'var(--border)',
    margin: '0 8px'
  }
}), /*#__PURE__*/React.createElement("button", {
  className: "pdpp-btn pdpp-btn-outline",
  style: {
    height: 30,
    fontSize: 12.5
  }
}, /*#__PURE__*/React.createElement("svg", {
  width: "14",
  height: "14",
  viewBox: "0 0 24 24",
  fill: "currentColor"
}, /*#__PURE__*/React.createElement("path", {
  d: "M12 0C5.37 0 0 5.5 0 12.3c0 5.44 3.44 10.05 8.21 11.68.6.12.82-.27.82-.6v-2.1c-3.34.74-4.04-1.64-4.04-1.64-.55-1.42-1.34-1.8-1.34-1.8-1.09-.76.08-.75.08-.75 1.21.09 1.85 1.27 1.85 1.27 1.08 1.89 2.82 1.34 3.5 1.03.11-.8.42-1.34.76-1.65-2.66-.31-5.46-1.36-5.46-6.07 0-1.34.47-2.44 1.24-3.3-.12-.31-.54-1.56.12-3.26 0 0 1.01-.33 3.31 1.26.96-.27 2-.41 3.03-.42 1.02.01 2.07.15 3.04.42 2.3-1.59 3.3-1.26 3.3-1.26.67 1.7.25 2.95.12 3.26.77.86 1.23 1.96 1.23 3.3 0 4.72-2.81 5.76-5.48 6.06.43.38.82 1.12.82 2.25v3.33c0 .33.22.72.83.6C20.57 22.34 24 17.73 24 12.3 24 5.5 18.63 0 12 0z"
})), "GitHub"))));
window.SiteHeader = SiteHeader;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/SiteHeader.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/StreamInventory.jsx
try { (() => {
// StreamInventory — a list of declared streams with their shapes and access mode.

const STREAMS = [{
  id: 'pay_statements',
  title: 'Pay statements',
  mode: 'append only',
  fields: 6,
  recent: '2 days ago',
  granted: 3
}, {
  id: 'employment',
  title: 'Employment',
  mode: 'mutable state',
  fields: 4,
  recent: '1 month ago',
  granted: 2
}, {
  id: 'tax_docs',
  title: 'Tax documents',
  mode: 'append only',
  fields: 5,
  recent: '3 months ago',
  granted: 1
}, {
  id: 'identity',
  title: 'Identity',
  mode: 'mutable state',
  fields: 3,
  recent: 'never',
  granted: 0
}, {
  id: 'transactions',
  title: 'Transactions',
  mode: 'append only',
  fields: 8,
  recent: 'today',
  granted: 4
}];
const StreamInventory = () => /*#__PURE__*/React.createElement("div", {
  className: "pdpp-surface-neutral",
  style: {
    overflow: 'hidden'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '16px 20px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "pdpp-title"
}, "Streams"), /*#__PURE__*/React.createElement("div", {
  className: "pdpp-caption",
  style: {
    color: 'var(--muted-foreground)'
  }
}, "5 declared \xB7 3 sharing with at least one grant")), /*#__PURE__*/React.createElement("button", {
  className: "pdpp-btn pdpp-btn-outline",
  style: {
    height: 30,
    fontSize: 12
  }
}, "+ Declare stream")), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: '1.6fr 1fr 0.7fr 1fr 0.6fr',
    padding: '8px 20px',
    borderTop: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--muted-foreground)',
    letterSpacing: '0.05em',
    textTransform: 'uppercase'
  }
}, /*#__PURE__*/React.createElement("span", null, "stream"), /*#__PURE__*/React.createElement("span", null, "mode"), /*#__PURE__*/React.createElement("span", null, "fields"), /*#__PURE__*/React.createElement("span", null, "last record"), /*#__PURE__*/React.createElement("span", {
  style: {
    textAlign: 'right'
  }
}, "grants")), STREAMS.map((s, i) => /*#__PURE__*/React.createElement("div", {
  key: s.id,
  style: {
    display: 'grid',
    gridTemplateColumns: '1.6fr 1fr 0.7fr 1fr 0.6fr',
    padding: '12px 20px',
    alignItems: 'center',
    borderTop: i > 0 ? '1px solid var(--border)' : 'none'
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 13.5,
    fontWeight: 500
  }
}, s.title), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11.5,
    color: 'var(--muted-foreground)'
  }
}, s.id)), /*#__PURE__*/React.createElement("span", {
  className: `pdpp-badge ${s.mode === 'append only' ? 'pdpp-badge-protocol' : 'pdpp-badge-neutral'}`
}, s.mode), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12.5
  }
}, s.fields), /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--muted-foreground)'
  }
}, s.recent), /*#__PURE__*/React.createElement("span", {
  style: {
    textAlign: 'right',
    fontFamily: 'var(--font-mono)',
    fontSize: 12.5,
    color: s.granted ? 'var(--foreground)' : 'var(--muted-foreground)'
  }
}, s.granted || '—'))));
window.StreamInventory = StreamInventory;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/StreamInventory.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/Teaching.jsx
try { (() => {
// CodeBlock + FlowDiagram — teaching units used throughout the site/docs.

const CodeBlock = ({
  children,
  caption
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8
  }
}, /*#__PURE__*/React.createElement("pre", {
  style: {
    margin: 0,
    padding: '14px 16px',
    background: 'oklch(0.14 0 0)',
    color: 'oklch(0.85 0.005 95)',
    borderRadius: 8,
    fontFamily: 'var(--font-mono)',
    fontSize: 12.5,
    lineHeight: 1.65,
    overflow: 'auto',
    whiteSpace: 'pre'
  }
}, children), caption && /*#__PURE__*/React.createElement("div", {
  className: "pdpp-caption",
  style: {
    color: 'var(--muted-foreground)'
  }
}, caption));
const Node = ({
  kind,
  eyebrow,
  title,
  sub
}) => /*#__PURE__*/React.createElement("div", {
  className: kind === 'human' ? 'pdpp-surface-human' : kind === 'protocol' ? 'pdpp-surface-protocol' : 'pdpp-surface-neutral',
  style: {
    padding: '12px 14px',
    minWidth: 160
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "pdpp-eyebrow",
  style: {
    fontSize: 10.5,
    color: kind === 'human' ? 'var(--human)' : kind === 'protocol' ? 'var(--primary)' : 'var(--muted-foreground)'
  }
}, eyebrow), /*#__PURE__*/React.createElement("div", {
  className: "pdpp-title",
  style: {
    marginTop: 3
  }
}, title), /*#__PURE__*/React.createElement("div", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--muted-foreground)',
    marginTop: 2
  }
}, sub));
const Arrow = ({
  label
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    minWidth: 60
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    color: 'var(--primary)'
  }
}, label), /*#__PURE__*/React.createElement("div", {
  style: {
    width: '100%',
    height: 1,
    background: 'var(--border)',
    position: 'relative',
    marginTop: 4
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    position: 'absolute',
    right: -1,
    top: -4,
    borderRight: '1px solid var(--muted-foreground)',
    borderBottom: '1px solid var(--muted-foreground)',
    width: 7,
    height: 7,
    transform: 'rotate(-45deg)'
  }
})));
const FlowDiagram = () => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 10
  }
}, /*#__PURE__*/React.createElement(Node, {
  kind: "human",
  eyebrow: "HOLDER",
  title: "Personal vault",
  sub: "user records"
}), /*#__PURE__*/React.createElement(Arrow, {
  label: "grant"
}), /*#__PURE__*/React.createElement(Node, {
  kind: "protocol",
  eyebrow: "PROTOCOL",
  title: "Grant + stream",
  sub: "pay_statements.read"
}), /*#__PURE__*/React.createElement(Arrow, {
  label: "records"
}), /*#__PURE__*/React.createElement(Node, {
  kind: "neutral",
  eyebrow: "CLIENT",
  title: "Longview Planning",
  sub: "purpose: planning"
}));
window.CodeBlock = CodeBlock;
window.FlowDiagram = FlowDiagram;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/Teaching.jsx", error: String((e && e.message) || e) }); }

})();
