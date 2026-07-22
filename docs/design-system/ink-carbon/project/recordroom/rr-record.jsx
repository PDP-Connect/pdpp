// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* RECORDROOM — the record type system. One sheet chrome, kind-aware bodies.
   Wire keys never leak alone: every field shows a human label AND its
   wire key (what a client literally receives). Long text gets a reading
   region; money gets tabular figures; derived titles get one grammar. */
(() => {
  /* ── Lexicon: wire key → human label. Fallback prettifies snake_case. ── */
  const FIELD_LABELS = {
    account_ref: "Account",
    amount: "Amount",
    artist: "Artist",
    bank_routing: "Deposited to",
    benefits_detail: "Benefits",
    breakdown: "Breakdown",
    bytes: "Size",
    calls: "Calls",
    category: "Category",
    chars: "Length",
    charset: "Encoding",
    commits: "Commits",
    content: "Message",
    content_type: "Type",
    date: "Date",
    device: "Device",
    doc_type: "Document",
    employer: "Employer",
    filename: "File",
    from: "From",
    gross_pay: "Gross pay",
    label: "Label",
    memo: "Memo",
    merchant: "Merchant",
    message_ref: "Message",
    messages: "Messages",
    model: "Model",
    net_pay: "Net pay",
    open_prs: "Open PRs",
    participants: "Participants",
    period_end: "Period end",
    period_start: "Period start",
    pings: "Pings",
    played_at: "Played",
    playlist_ref: "Playlist",
    prompt: "Prompt",
    prs_opened: "PRs opened",
    pushed: "Last push",
    received: "Received",
    repo: "Repository",
    reviews: "Reviews",
    role: "Role",
    session: "Session",
    size: "Size",
    span: "Over",
    started: "Started",
    subject: "Subject",
    tax_year: "Tax year",
    taxes_withheld: "Taxes withheld",
    text: "Body",
    title: "Title",
    track: "Track",
    turns: "Turns",
    visibility: "Visibility",
  };

  function prettify(k) {
    return k
      .replace(/_/g, " ")
      .replace(/\bref\b/, "")
      .trim()
      .replace(/^\w/, (c) => c.toUpperCase());
  }
  function labelFor(k) {
    return FIELD_LABELS[k] || prettify(k);
  }

  const STREAM_NOUN = {
    attachments: "attachment",
    balances: "balance",
    conversations: "conversation",
    employment: "record",
    function_calls: "tool calls",
    listening_history: "play",
    message_bodies: "message body",
    messages: "message",
    pay_statements: "pay statement",
    repositories: "repository",
    sessions: "session",
    skills: "skill",
    statements: "statement",
    tax_docs: "document",
    threads: "thread",
    transactions: "transaction",
    user: "record",
    user_stats: "stats snapshot",
  };
  function nounFor(stream) {
    return STREAM_NOUN[stream] || "record";
  }

  function fieldMap(rec) {
    return Object.fromEntries((rec.fields || []).map((f) => [f[0], f[1]]));
  }

  /* ── Kind dispatch — by field signature, not stream name (a "messages"
      stream is email from Gmail but an agent turn from Codex). ── */
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

  const MONEY_RE = /^[−-]?\$|^\$/;
  function isMoneyVal(v) {
    return typeof v === "string" && MONEY_RE.test(v);
  }
  function isLongVal(key, v) {
    return (key === "text" || key === "content") && typeof v === "string" && v.length > 56;
  }

  /* ── One derived-title grammar. Never "no X" — a quiet kicker + a fact. ── */
  function displayTitle(rec) {
    if (!rec.degraded) {
      return { kicker: null, primary: rec.title };
    }
    const f = fieldMap(rec);
    const noun = nounFor(rec.stream);
    let hint = "";
    if (f.from) {
      hint = "from " + f.from;
    } else if (f.role) {
      hint = f.role + " turn";
    } else if (f.bytes || f.charset) {
      hint = [f.charset, f.bytes ? Math.round(String(f.bytes).replace(/[^\d]/g, "") / 1024) + " KB" : ""]
        .filter(Boolean)
        .join(" · ");
    } else if (f.date) {
      hint = f.date;
    }
    return { kicker: "untitled " + noun, primary: hint || noun };
  }

  /* ── Dual-key field row ── */
  function Field({ k, v }) {
    return (
      <div className="rr-fld">
        <span className="rr-fld__id">
          <span className="rr-fld__label">{labelFor(k)}</span>
          <span className="rr-fld__wire">{k}</span>
        </span>
        <span className={"rr-fld__val" + (isMoneyVal(v) ? "is-num" : "")}>{v}</span>
      </div>
    );
  }

  /* ── Kind-aware body: hero + image + reading region + dual-key fields ── */
  function RecordBody({ rec, pairs }) {
    const kind = kindOf(rec);
    const present = (key) => pairs.find(([k]) => k === key);
    const heroKey = kind === "money" ? ["net_pay", "amount", "gross_pay"].find((k) => present(k)) : null;
    const bodyPair = pairs.find(([k, v]) => isLongVal(k, v));
    const heroVal = heroKey ? present(heroKey)[1] : null;
    const negative = heroVal && /^[−-]/.test(heroVal);

    const captionParts = [];
    if (kind === "money") {
      ["merchant", "employer", "category", "period_end", "date"].forEach((k) => {
        const p = present(k);
        if (p) {
          captionParts.push(p[1]);
        }
      });
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
      <React.Fragment>
        {heroKey && (
          <div className="rr-hero rr-hero--money">
            <span className={"rr-hero__amount" + (negative ? "is-neg" : "")}>{heroVal}</span>
            {captionParts.length > 0 && <span className="rr-hero__cap">{captionParts.slice(0, 2).join(" · ")}</span>}
            <span className="rr-hero__wire">
              {labelFor(heroKey)} · <span className="rr-fld__wire">{heroKey}</span>
            </span>
          </div>
        )}
        {rec.image && (
          <image-slot
            class="rr-rec-image"
            id={"img-" + rec.id}
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
      </React.Fragment>
    );
  }

  Object.assign(window, {
    RRREC: { displayTitle, Field, kindOf, labelFor, nounFor, RecordBody },
  });
})();
