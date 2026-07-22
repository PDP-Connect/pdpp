// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* IIFE-WRAPPED */
(() => {
  /* PDPP Explorer — Peek panel (record detail)
   *
   * Right pane that slides in when a record is selected. Surfaces:
   * - Title + meta
   * - Each schema field, with granted/redacted state explicit
   * - The actual /v1/streams/.../records/<id> URL the explorer is reading
   */

  const { fmtRelative, fmtDate, fmtCurrency, fmtDuration, fmtDistance, Avatar: PeekAvatar } = window.PDPPPrim;

  function Peek({ stream, record, onClose, projection }) {
    if (!(stream && record)) {
      return null;
    }
    const fields = stream.schema.fields;
    const granted = fields.filter((f) => f.granted);
    const redacted = fields.filter((f) => !f.granted);
    const visibleFields = projection ? granted : fields;
    const title = record.subject ?? record.title ?? record.merchant ?? record.text ?? record.caption ?? record.id;
    const timeField = fields.find((f) => f.type === "timestamp")?.name;

    function renderValue(field) {
      const v = record[field.name];
      if (v == null) {
        return <span style={{ color: "var(--muted-foreground)" }}>—</span>;
      }
      if (field.type === "timestamp") {
        return (
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {new Date(v).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
          </span>
        );
      }
      if (field.type === "currency") {
        return (
          <span style={{ color: v > 0 ? "var(--success)" : "var(--foreground)", fontFamily: "var(--font-mono)" }}>
            {fmtCurrency(v)}
          </span>
        );
      }
      if (field.type === "number") {
        if (field.unit === "meters") {
          return (
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {fmtDistance(v)} <small style={{ color: "var(--muted-foreground)" }}>({v.toLocaleString()} m)</small>
            </span>
          );
        }
        if (field.unit === "seconds") {
          return <span style={{ fontFamily: "var(--font-mono)" }}>{fmtDuration(v)}</span>;
        }
        return (
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {v.toLocaleString()}
            {field.unit ? <small style={{ color: "var(--muted-foreground)" }}> {field.unit}</small> : null}
          </span>
        );
      }
      if (field.type === "id") {
        return <code style={{ color: "var(--muted-foreground)", fontSize: "0.72rem" }}>{v}</code>;
      }
      if (field.type === "url") {
        return (
          <a href={v} rel="noreferrer" style={{ color: "var(--primary)", textDecoration: "underline" }} target="_blank">
            {v}
          </a>
        );
      }
      if (field.type === "blob") {
        if ((field.media_type ?? "").startsWith("image/")) {
          return <img alt="" src={v} style={{ borderRadius: 4, marginTop: 4, maxWidth: "100%" }} />;
        }
        return <code style={{ fontSize: "0.72rem" }}>blob: {v}</code>;
      }
      if (field.type === "person") {
        return (
          <span>
            {String(v)
              .replace(/<[^>]+>/g, "")
              .trim()}
          </span>
        );
      }
      if (Array.isArray(v)) {
        if (v.length === 0) {
          return <span style={{ color: "var(--muted-foreground)" }}>[]</span>;
        }
        if (typeof v[0] === "object") {
          return (
            <pre style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", whiteSpace: "pre-wrap" }}>
              {JSON.stringify(v, null, 2)}
            </pre>
          );
        }
        return <span>{v.join(", ")}</span>;
      }
      return <span className={`exp-peek__field-value ${String(v).length > 80 ? "long" : ""}`}>{String(v)}</span>;
    }

    return (
      <aside className="exp-peek">
        <button className="exp-peek__close" onClick={onClose} title="Close">
          ×
        </button>
        <div className="exp-peek__head">
          <div className="exp-peek__eyebrow">
            {stream.connector_id} / {stream.name}
          </div>
          <h2 className="exp-peek__title">{title}</h2>
          <div className="exp-peek__meta">
            <span>{record.id}</span>
            {timeField ? (
              <>
                <span>·</span>
                <span>{fmtRelative(record[timeField])}</span>
              </>
            ) : null}
            <span>·</span>
            <span>connection {stream.connection_display}</span>
          </div>
        </div>
        <div className="exp-peek__body">
          {visibleFields.map((f) => {
            const isRedacted = !f.granted;
            if (isRedacted && projection) {
              return null;
            }
            return (
              <div className="exp-peek__field" data-redacted={isRedacted} key={f.name}>
                <span className="exp-peek__field-name">{f.name}</span>
                <div className="exp-peek__field-value">
                  {isRedacted ? <span>redacted — {f.redacted_reason ?? "out of scope"}</span> : renderValue(f)}
                </div>
              </div>
            );
          })}
          {projection && redacted.length ? (
            <div
              style={{
                color: "var(--muted-foreground)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.7rem",
                marginTop: "0.9rem",
              }}
            >
              +{redacted.length} field{redacted.length === 1 ? "" : "s"} hidden by projection
            </div>
          ) : null}
          <div className="exp-peek__source">
            <b>GET</b> /v1/streams/<b>{stream.name}</b>/records/<b>{record.id}</b>
            {"\n"}
            <span style={{ opacity: 0.7 }}>?connection_id={stream.connection_id}</span>
          </div>
        </div>
      </aside>
    );
  }

  window.Peek = Peek;
})();
