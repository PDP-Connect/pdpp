// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* PDPP Explorer v2 — root app
 *
 * Single-canvas, query-driven. The query is the URL is the navigation.
 *   <topbar: brand · query · views · grant>
 *   <facet line>
 *   <main canvas: feed | dispatched view>     <peek slide-in>
 */

(() => {
  // biome-ignore lint/correctness/noUndeclaredVariables: this standalone design artifact deliberately uses dynamic preview behavior.
  // biome-ignore lint/correctness/noUnusedVariables: this standalone design artifact deliberately uses dynamic preview behavior.
  const { useState, useEffect, useMemo, useCallback } = React;
  const { runQuery, computeFacets } = window.PDPP_QUERY;
  const { detect, pickInitial, VIEW_ORDER } = window.PDPP_DISPATCH;
  // biome-ignore lint/correctness/noUnusedVariables: this standalone design artifact deliberately uses dynamic preview behavior.
  const { fmtRelative, CAP_GLYPH, CAP_LABEL, NOW } = window.PDPPPrim;

  const APP_DEFAULTS = /*EDITMODE-BEGIN*/ {
    projectionDefault: false,
    defaultMode: "lex",
  } /*EDITMODE-END*/;

  function App() {
    // biome-ignore lint/correctness/noUnusedVariables: this standalone design artifact deliberately uses dynamic preview behavior.
    const { grant, connections, streams } = window.PDPP_DATA;
    const { TweaksPanel, useTweaks, TweakSection, TweakToggle, TweakRadio } = window;
    const [tweaks, setTweak] = useTweaks(APP_DEFAULTS);

    const [query, setQuery] = useState({ chips: [], text: "" });
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
        if (e.key === "Escape" && selected) {
          setSelected(null);
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
      for (const h of hits) {
        s.set(`${h.stream.connection_id}::${h.stream.name}`, h.stream);
      }
      return [...s.values()];
    }, [hits]);

    const singleStream = uniqueStreams.length === 1 ? uniqueStreams[0] : null;

    // Capability dispatch for the single-stream case
    const dispatchResult = useMemo(() => (singleStream ? detect(singleStream) : null), [singleStream]);
    const initialView = useMemo(() => (singleStream ? pickInitial(singleStream) : "feed"), [singleStream]);

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
      setSelected({ stream, record });
    }
    function clearQuery() {
      setQuery({ chips: [], text: "" });
    }
    function addChip(chip) {
      setQuery((q) => {
        // de-dup
        const chips = q.chips.filter(
          (c) => !(c.field === chip.field && JSON.stringify(c.value) === JSON.stringify(chip.value))
        );
        return { ...q, chips: [...chips, chip] };
      });
    }

    function bodyForView() {
      if (activeView === "feed") {
        const isEmpty = query.chips.length === 0 && !query.text.trim();
        return (
          <window.FeedView
            hits={hits}
            // biome-ignore lint/performance/noJsxPropsBind: this standalone design artifact deliberately uses dynamic preview behavior.
            onAddChip={addChip}
            // biome-ignore lint/performance/noJsxPropsBind: this standalone design artifact deliberately uses dynamic preview behavior.
            onSelect={openRecord}
            selectedId={selected?.record?.id}
            showDiscover={isEmpty}
            streams={streams}
          />
        );
      }
      // Single-stream: filter the underlying stream records to those in our hits
      // (the query result), then mount the capability view over that subset.
      const hitIds = new Set(hits.map((h) => h.record.id));
      const filteredStream = {
        ...singleStream,
        records: singleStream.records.filter((r) => hitIds.has(r.id)),
      };
      const viewProps = {
        stream: filteredStream,
        selectedId: selected?.record?.id,
        onSelect: (r) => openRecord(filteredStream, r),
        projection,
      };
      switch (activeView) {
        case "table":
          return <window.TableView {...viewProps} />;
        case "timeline":
          return <window.TimelineView {...viewProps} />;
        case "conversation":
          return <window.ConversationView {...viewProps} />;
        case "ledger":
          return <window.LedgerView {...viewProps} />;
        case "gallery":
          return <window.GalleryView {...viewProps} />;
        case "map":
          return <window.MapView {...viewProps} />;
        case "calendar":
          return <window.CalendarView {...viewProps} />;
        case "chart":
          return <window.ChartView {...viewProps} />;
        case "reader":
          return <window.ReaderView {...viewProps} />;
        default:
          // biome-ignore lint/performance/noJsxPropsBind: this standalone design artifact deliberately uses dynamic preview behavior.
          return <window.FeedView hits={hits} onSelect={openRecord} selectedId={selected?.record?.id} />;
      }
    }

    return (
      <>
        <div className="exp-app" data-peek={selected ? "open" : "closed"}>
          {/* ── Top bar ── */}
          <header className="exp-topbar">
            {/* biome-ignore lint/a11y/useSemanticElements: this standalone design artifact deliberately uses dynamic preview behavior. */}{" "}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: this standalone design artifact deliberately uses dynamic preview behavior. */}{" "}
            {/* biome-ignore lint/a11y/useFocusableInteractive: this standalone design artifact deliberately uses dynamic preview behavior. */}{" "}
            {/* biome-ignore lint/performance/noJsxPropsBind: this standalone design artifact deliberately uses dynamic preview behavior. */}
            <div className="exp-topbar__brand" onClick={clearQuery} role="button" style={{ cursor: "pointer" }}>
              {/* biome-ignore lint/correctness/useImageSize: this standalone design artifact deliberately uses dynamic preview behavior. */}
              <img alt="pdpp" src="explorer/assets/logo-mark.svg" />
              <span className="exp-topbar__brand-name">pdpp</span>
            </div>
            <div className="exp-topbar__center">
              <window.QueryBar
                focused={queryFocused}
                mode={mode}
                onChange={setQuery}
                onFocusedChange={setQueryFocused}
                onModeChange={setMode}
                query={query}
                streams={streams}
              />
            </div>
            <div className="exp-topbar__right">
              <ViewSwitcher
                available={availableViews}
                isFeed={!singleStream}
                onChange={setForcedView}
                // biome-ignore lint/performance/noJsxPropsBind: this standalone design artifact deliberately uses dynamic preview behavior.
                onWhy={() => setWhyOpen((x) => !x)}
                value={activeView}
                whyOpen={whyOpen}
              />
              <GrantChip
                grant={grant}
                // biome-ignore lint/performance/noJsxPropsBind: this standalone preview callback closes over render-local state and has no memoized child contract requiring stable identity.
                onToggleProjection={() => setProjection((x) => !x)}
                projection={projection}
              />
            </div>
          </header>
          {/* ── Facets ── */}
          <FacetLine
            facets={facets}
            hits={hits}
            // biome-ignore lint/performance/noJsxPropsBind: this standalone preview callback closes over render-local state and has no memoized child contract requiring stable identity.
            onAddChip={addChip}
            query={query}
          />
          {/* ── Main canvas ── */}
          <main className="exp-main">
            <div className="exp-main__scroll">{bodyForView()}</div>
          </main>
          {/* ── Peek ── */}
          {selected ? (
            <window.Peek
              // biome-ignore lint/performance/noJsxPropsBind: this standalone preview callback closes over render-local state and has no memoized child contract requiring stable identity.
              onClose={() => setSelected(null)}
              projection={projection}
              record={selected.record}
              stream={selected.stream}
            />
          ) : null}
          {/* ── Why-this-view popover ── */}
          {whyOpen && dispatchResult ? (
            <div className="exp-why">
              <div className="exp-why__title">Why these views?</div>
              <div className="exp-why__sub">
                Lit up from the stream's typed schema fields. Connector identity is irrelevant.
              </div>
              {VIEW_ORDER.map((cap) => (
                <div className="exp-why__row" data-active={dispatchResult.capabilities.includes(cap)} key={cap}>
                  <span className="exp-why__row-cap">
                    {dispatchResult.capabilities.includes(cap) ? "✓ " : "  "}
                    {CAP_LABEL[cap]}
                  </span>
                  <span className="exp-why__row-fields">
                    {dispatchResult.capabilities.includes(cap)
                      ? (dispatchResult.signals[cap] ?? []).join(" · ") || "—"
                      : "no signal"}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <TweaksPanel title="Tweaks">
          <TweakSection title="Search">
            <TweakRadio
              label="Default search mode"
              // biome-ignore lint/performance/noJsxPropsBind: this standalone preview callback closes over render-local state and has no memoized child contract requiring stable identity.
              onChange={(v) => {
                setTweak("defaultMode", v);
                setMode(v);
              }}
              options={[
                { value: "lex", label: "Lexical" },
                { value: "sem", label: "Semantic" },
                { value: "hyb", label: "Hybrid" },
              ]}
              value={tweaks.defaultMode}
            />
          </TweakSection>
          <TweakSection title="Grant">
            <TweakToggle
              label="Project to granted fields by default"
              // biome-ignore lint/performance/noJsxPropsBind: this standalone preview callback closes over render-local state and has no memoized child contract requiring stable identity.
              onChange={(v) => {
                setTweak("projectionDefault", v);
                setProjection(v);
              }}
              value={tweaks.projectionDefault}
            />
          </TweakSection>
        </TweaksPanel>
      </>
    );
  }

  /* ─── ViewSwitcher ─────────────────────────────────────────────────── */
  function ViewSwitcher({ available, value, onChange, isFeed, onWhy, whyOpen }) {
    // When the result set spans multiple streams, the only option is "feed"
    // — there's nothing useful to switch to, so hide the chrome entirely.
    // The switcher only appears once the user has narrowed to one stream
    // and the stream's capability views can light up.
    if (isFeed) {
      return null;
    }
    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", position: "relative" }}>
        <div className="exp-views">
          {window.PDPP_DISPATCH.VIEW_ORDER.map((cap) => {
            if (!available.includes(cap)) {
              return null;
            }
            return (
              <button
                className="exp-views__btn"
                data-active={value === cap}
                key={cap}
                // biome-ignore lint/performance/noJsxPropsBind: this standalone preview callback closes over render-local state and has no memoized child contract requiring stable identity.
                onClick={() => onChange(cap)}
                title={CAP_LABEL[cap]}
                type="button"
              >
                <span className="exp-views__glyph">{CAP_GLYPH[cap]}</span>
                <span>{CAP_LABEL[cap].toLowerCase()}</span>
              </button>
            );
          })}
        </div>
        <button
          onClick={onWhy}
          style={{
            border: "1px solid var(--border)",
            background: whyOpen ? "var(--muted)" : "var(--card)",
            borderRadius: 999,
            padding: "0.2rem 0.55rem",
            fontFamily: "var(--font-mono)",
            fontSize: "0.66rem",
            color: "var(--muted-foreground)",
            cursor: "pointer",
          }}
          title="Explain which views activated"
          type="button"
        >
          why?
        </button>
      </div>
    );
  }

  /* ─── GrantChip (top bar) ─────────────────────────────────────────── */

  function GrantChip({ grant, projection, onToggleProjection }) {
    const days = Math.ceil((new Date(grant.expires_at).getTime() - NOW) / 86_400_000);
    return (
      <button
        className="exp-grant-chip"
        data-proj-on={projection}
        onClick={onToggleProjection}
        title={`Grant ${grant.grant_id} · ${grant.client_display} · ${grant.granted_field_count}/${grant.total_field_count} fields. Click to toggle field projection.`}
        type="button"
      >
        <span className="exp-grant-chip__bug">LV</span>
        <span>{grant.client_display}</span>
        <span className="exp-grant-chip__expires">
          · {days}d · {projection ? "projected" : "all fields"}
        </span>
      </button>
    );
  }

  /* ─── FacetLine ───────────────────────────────────────────────────── */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this standalone design artifact deliberately uses dynamic preview behavior.
  function FacetLine({ hits, facets, query, onAddChip }) {
    const totalCount = hits.length;
    const streamCount = facets.streams.length;
    const ppl = facets.people.length;
    const months = facets.months.length;

    let resultCountLabel = `${totalCount.toLocaleString()} records`;
    if (totalCount === 0) {
      resultCountLabel = "no results";
    } else if (totalCount === 1) {
      resultCountLabel = "1 record";
    }

    return (
      <div className="exp-facets">
        <span className="exp-facets__count">{resultCountLabel}</span>
        {totalCount > 0 ? (
          <>
            <span className="exp-facets__sep">·</span>
            <span className="exp-facets__group">spans {months === 1 ? "1 month" : `${months} months`}</span>
            {streamCount > 0 ? (
              <>
                <span className="exp-facets__sep">·</span>
                <span className="exp-facets__group">
                  {facets.streams.slice(0, 4).map(([s, c], i) => (
                    <button
                      className="exp-facet"
                      key={i}
                      // biome-ignore lint/performance/noJsxPropsBind: this standalone preview callback closes over render-local state and has no memoized child contract requiring stable identity.
                      onClick={() => onAddChip({ field: "stream", op: "in", value: [s.connector_id] })}
                      type="button"
                    >
                      {s.connector_id}
                      <span className="exp-facet__count">{c}</span>
                    </button>
                  ))}
                  {streamCount > 4 ? <span style={{ marginLeft: "0.3rem" }}>+{streamCount - 4} more</span> : null}
                </span>
              </>
            ) : null}
            {ppl > 0 ? (
              <>
                <span className="exp-facets__sep">·</span>
                <span className="exp-facets__group">
                  {facets.people.slice(0, 4).map(([p, c]) => {
                    const first = window.PDPP_QUERY.firstNameToken(p);
                    if (!first) {
                      return null;
                    }
                    return (
                      <button
                        className="exp-facet"
                        key={p}
                        // biome-ignore lint/performance/noJsxPropsBind: this standalone preview callback closes over render-local state and has no memoized child contract requiring stable identity.
                        onClick={() => onAddChip({ field: "from", op: "is", value: first })}
                        title={`Filter to ${p}`}
                        type="button"
                      >
                        {first}
                        <span className="exp-facet__count">{c}</span>
                      </button>
                    );
                  })}
                </span>
              </>
            ) : null}
            {facets.categories.length > 0 ? (
              <>
                <span className="exp-facets__sep">·</span>
                <span className="exp-facets__group">
                  {facets.categories.slice(0, 3).map(([cat, c]) => (
                    <button
                      className="exp-facet"
                      key={cat}
                      // biome-ignore lint/performance/noJsxPropsBind: this standalone preview callback closes over render-local state and has no memoized child contract requiring stable identity.
                      onClick={() => onAddChip({ field: "category", op: "is", value: cat })}
                      type="button"
                    >
                      {cat.toLowerCase().split(" ").join("·")}
                      <span className="exp-facet__count">{c}</span>
                    </button>
                  ))}
                </span>
              </>
            ) : null}
          </>
        ) : null}
        <span style={{ flex: 1 }} />
        {query.chips.length > 0 || query.text ? (
          <span className="exp-facets__group" style={{ marginRight: "0.4rem" }}>
            <button
              className="exp-facet"
              // biome-ignore lint/performance/noJsxPropsBind: this standalone preview callback closes over render-local state and has no memoized child contract requiring stable identity.
              onClick={() => {
                const url = new URL(window.location.href);
                url.hash = `#${encodeURIComponent(JSON.stringify(query))}`;
                navigator.clipboard?.writeText(url.toString());
              }}
              title="Copy this view as a URL"
              type="button"
            >
              share view
            </button>
          </span>
        ) : null}
      </div>
    );
  }
  const root = window.ReactDOM.createRoot(document.getElementById("app"));
  root.render(<App />);
})();
