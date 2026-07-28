// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* RECORDROOM — the record type system. One sheet chrome, kind-aware bodies.
   Wire keys never leak alone: every field shows a human label AND its
   wire key (what a client literally receives). Long text gets a reading
   region; money gets tabular figures; derived titles get one grammar. */
const RR_RECORD_REF_WORD = /\bref\b/;

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
    tax_year: "Tax year",
  };

  function prettify(k) {
    let normalized = k.replaceAll("_", " ");
    normalized = normalized.replace(RR_RECORD_REF_WORD, "").trim();
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
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
    user: "record",
  };
  function nounFor(stream) {
    return STREAM_NOUN[stream] || "record";
  }

  function fieldMap(rec) {
    return Object.fromEntries((rec.fields || []).map((f) => [f[0], f[1]]));
  }

  /* ── Kind dispatch — by field signature, not stream name (a "messages"
      stream is email from Gmail but an agent turn from Codex). ── */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ordered field-signature dispatch is the explicit fixture contract for record kinds.
  function kindOf(rec) {
    const k = new Set((rec.fields || []).map((f) => f[0]));
    if (rec.image || k.has("filename") || k.has("content_type")) {
      return "attachment";
    }
    if (k.has("amount") || k.has("gross_pay") || k.has("net_pay")) {
      return "money";
    }
    if (k.has("track") || k.has("artist")) {
      return "media";
    }
    if (k.has("charset") && k.has("text")) {
      return "body";
    }
    if (k.has("role")) {
      return "agent";
    }
    if (k.has("from") || k.has("subject") || k.has("participants")) {
      return "email";
    }
    if (k.has("repo") || k.has("commits")) {
      return "code";
    }
    return "generic";
  }

  function isMoneyVal(v) {
    return typeof v === "string" && (v.startsWith("$") || v.startsWith("-$") || v.startsWith("−$"));
  }
  function isLongVal(key, v) {
    return (key === "text" || key === "content") && typeof v === "string" && v.length > 56;
  }

  /* ── One derived-title grammar. Never "no X" — a quiet kicker + a fact. ── */
  function displayTitle(rec) {
    if (!rec.degraded) {
      return { primary: rec.title, kicker: null };
    }
    const f = fieldMap(rec);
    const noun = nounFor(rec.stream);
    let hint = "";
    if (f.from) {
      hint = `from ${f.from}`;
    } else if (f.role) {
      hint = `${f.role} turn`;
    } else if (f.bytes || f.charset) {
      hint = [f.charset, f.bytes ? `${Math.round(String(f.bytes).replace(/[^\d]/g, "") / 1024)} KB` : ""]
        .filter(Boolean)
        .join(" · ");
    } else if (f.date) {
      hint = f.date;
    }
    return { primary: hint || noun, kicker: `untitled ${noun}` };
  }

  /* ── Dual-key field row ── */
  function Field({ k, v }) {
    return (
      <div className="rr-fld">
        <span className="rr-fld__id">
          <span className="rr-fld__label">{labelFor(k)}</span>
          <span className="rr-fld__wire">{k}</span>
        </span>
        <span className={`rr-fld__val${isMoneyVal(v) ? "is-num" : ""}`}>{v}</span>
      </div>
    );
  }

  /* ── Kind-aware body: hero + image + reading region + dual-key fields ── */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: kind-aware record rendering intentionally keeps ordered field selection and presentation together.
  function RecordBody({ rec, pairs }) {
    const kind = kindOf(rec);
    const present = (key) => pairs.find(([k]) => k === key);
    const heroKey = kind === "money" ? ["net_pay", "amount", "gross_pay"].find((k) => present(k)) : null;
    const bodyPair = pairs.find(([k, v]) => isLongVal(k, v));
    const heroVal = heroKey ? present(heroKey)[1] : null;
    const negative = heroVal && (heroVal.startsWith("-") || heroVal.startsWith("−"));

    const captionParts = [];
    if (kind === "money") {
      for (const k of ["merchant", "employer", "category", "period_end", "date"]) {
        const p = present(k);
        if (p) {
          captionParts.push(p[1]);
        }
      }
    }

    const skip = new Set();
    if (heroKey) {
      skip.add(heroKey);
    }
    if (bodyPair) {
      skip.add(bodyPair[0]);
    }
    const rest = pairs.filter(([k]) => !skip.has(k));

    return (
      <>
        {heroKey && (
          <div className="rr-hero rr-hero--money">
            <span className={`rr-hero__amount${negative ? "is-neg" : ""}`}>{heroVal}</span>
            {captionParts.length > 0 && <span className="rr-hero__cap">{captionParts.slice(0, 2).join(" · ")}</span>}
            <span className="rr-hero__wire">
              {labelFor(heroKey)} · <span className="rr-fld__wire">{heroKey}</span>
            </span>
          </div>
        )}
        {rec.image && (
          <image-slot
            class="rr-rec-image"
            id={`img-${rec.id}`}
            placeholder="Image field — drop the file to render it inline"
            radius="0"
            shape="rect"
          />
        )}
        {bodyPair && (
          <div className="rr-bodytext">
            <span className="rr-bodytext__label">
              {labelFor(bodyPair[0])} <span className="rr-fld__wire">{bodyPair[0]}</span>
            </span>
            <p className="rr-bodytext__text">{bodyPair[1]}</p>
          </div>
        )}
        {rest.length > 0 && (
          <div className="rr-flds">
            {rest.map(([k, v]) => (
              <Field k={k} key={k} v={v} />
            ))}
          </div>
        )}
      </>
    );
  }

  Object.assign(window, {
    RRREC: { labelFor, nounFor, kindOf, displayTitle, Field, RecordBody },
  });
})();
