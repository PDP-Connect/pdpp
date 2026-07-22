// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* PDPP Explorer — Query bar
 *
 * One bar. Chips + free text input + lex/sem/hybrid mode pill.
 * Backspace at empty input removes the last chip. Suggestions appear
 * below as the user types and can be added via ↓+Enter or by clicking.
 */

(() => {
  const { useState, useEffect, useRef, useMemo } = React;
  const { suggestChips } = window.PDPP_QUERY;

  function chipLabel(c) {
    if (c.field === "stream") {
      const v = Array.isArray(c.value) ? c.value.join(", ") : c.value;
      return { field: "stream", op: "in", value: v };
    }
    if (c.field === "amount") {
      return { field: "amount", op: c.op, value: `$${c.value}` };
    }
    if (c.field === "month") {
      return { field: "month", op: "", value: monthLabel(c.value) };
    }
    if (c.field === "year") {
      return { field: "year", op: "", value: String(c.value) };
    }
    if (c.field === "has") {
      return { field: "has", op: "", value: c.value };
    }
    if (c.field === "category") {
      return { field: "category", op: "", value: c.value };
    }
    return { field: c.field, op: "", value: String(c.value) };
  }
  function monthLabel(s) {
    if (!s) {
      return "";
    }
    const d = new Date(s + "-15");
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" }).toLowerCase();
  }

  function QueryBar({ query, onChange, streams, mode, onModeChange, focused, onFocusedChange }) {
    const [text, setText] = useState(query.text ?? "");
    const [suggestionIdx, setSuggestionIdx] = useState(0);
    const inputRef = useRef(null);

    useEffect(() => {
      setText(query.text ?? "");
    }, [query.text]);

    const suggestions = useMemo(() => {
      if (!text.trim()) {
        return [];
      }
      return suggestChips(text, streams);
    }, [text, streams]);

    useEffect(() => {
      setSuggestionIdx(0);
    }, [suggestions.length]);

    function commitText(newText) {
      onChange({ ...query, text: newText });
    }
    function addChip(chip) {
      // Replace existing chip with same field+op (avoid dup `from:` etc), except for `stream:` which we accumulate.
      let chips = [...query.chips];
      if (chip.field === "stream") {
        const existing = chips.find((c) => c.field === "stream");
        if (existing) {
          const merged = Array.isArray(existing.value) ? existing.value : [existing.value];
          const newV = Array.isArray(chip.value) ? chip.value : [chip.value];
          existing.value = Array.from(new Set([...merged, ...newV]));
        } else {
          chips.push(chip);
        }
      } else {
        chips = chips.filter((c) => !(c.field === chip.field && c.op === chip.op));
        chips.push(chip);
      }
      onChange({ chips, text: "" });
      setText("");
      inputRef.current?.focus();
    }
    function removeChipAt(i) {
      const chips = [...query.chips];
      chips.splice(i, 1);
      onChange({ ...query, chips });
      inputRef.current?.focus();
    }

    function onKeyDown(e) {
      if (e.key === "Backspace" && text === "" && query.chips.length > 0) {
        removeChipAt(query.chips.length - 1);
        return;
      }
      if (suggestions.length === 0) {
        if (e.key === "Enter") {
          commitText(text);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggestionIdx((i) => Math.min(i + 1, suggestions.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggestionIdx((i) => Math.max(i - 1, 0));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const sel = suggestions[suggestionIdx];
        if (sel) {
          addChip(sel.chip);
        } else {
          commitText(text);
        }
      }
      if (e.key === "Escape") {
        setText("");
        commitText("");
      }
    }

    // Debounce text changes into the query
    useEffect(() => {
      const t = setTimeout(() => {
        if (text !== query.text) {
          commitText(text);
        }
      }, 180);
      return () => clearTimeout(t);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [text]);

    const showSuggest = focused && suggestions.length > 0;

    return (
      <div style={{ position: "relative" }}>
        <div className="exp-query" data-focused={focused} onClick={() => inputRef.current?.focus()}>
          {query.chips.map((c, i) => {
            const lab = chipLabel(c);
            return (
              <button
                className="exp-chip"
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  removeChipAt(i);
                }}
                title={`${lab.field}${lab.op ? " " + lab.op : ""}: ${lab.value}`}
                type="button"
              >
                <span className="exp-chip__field">{lab.field}</span>
                {lab.op ? <span className="exp-chip__op">{lab.op}</span> : <span className="exp-chip__op">:</span>}
                <span className="exp-chip__value">{lab.value}</span>
                <span className="exp-chip__remove">×</span>
              </button>
            );
          })}
          <input
            className="exp-query__text"
            onBlur={() => setTimeout(() => onFocusedChange(false), 120)}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => onFocusedChange(true)}
            onKeyDown={onKeyDown}
            placeholder={query.chips.length ? "narrow…" : "Search everything"}
            ref={inputRef}
            spellCheck="false"
            type="text"
            value={text}
          />
          <span className="exp-query__hint">
            <kbd className="exp-kbd">/</kbd>
          </span>
          <span className="exp-query__mode">
            {["lex", "sem", "hyb"].map((m) => (
              <button
                className="exp-query__mode-btn"
                data-on={mode === m}
                key={m}
                onClick={(e) => {
                  e.stopPropagation();
                  onModeChange(m);
                }}
                title={{ hyb: "Hybrid", lex: "Lexical search", sem: "Semantic search" }[m]}
                type="button"
              >
                {m}
              </button>
            ))}
          </span>
        </div>
        {showSuggest ? (
          <div className="exp-suggest">
            <div className="exp-suggest__label">add filter</div>
            {suggestions.map((s, i) => (
              <div
                className="exp-suggest__row"
                data-selected={i === suggestionIdx}
                key={i}
                onMouseDown={(e) => {
                  e.preventDefault();
                  addChip(s.chip);
                }}
                onMouseEnter={() => setSuggestionIdx(i)}
              >
                <span className="exp-suggest__row-kind">{s.chip.field}</span>
                <span className="exp-suggest__row-label">{s.label.replace(/^[^:]+:\s*/, "")}</span>
                <span className="exp-suggest__row-hint">{s.hint}</span>
              </div>
            ))}
            <div className="exp-suggest__divider" />
            <div
              className="exp-suggest__row"
              onMouseDown={(e) => {
                e.preventDefault();
                commitText(text);
              }}
              style={{ paddingBottom: "0.5rem", paddingTop: "0.5rem" }}
            >
              <span className="exp-suggest__row-kind">text</span>
              <span className="exp-suggest__row-label">search for “{text}”</span>
              <span className="exp-suggest__row-hint">
                <kbd className="exp-kbd">↵</kbd>
              </span>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  window.QueryBar = QueryBar;
  window.queryChipLabel = chipLabel;
})();
