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

;(() => {

const FIELD_ALIASES = {
  from:   ["from", "sender", "author", "actor", "user"],
  to:     ["to", "recipient", "recipients"],
  text:   ["subject", "snippet", "body", "text", "message", "content", "title", "caption", "merchant", "memo"],
  amount: ["amount", "value", "total"],
  cat:    ["category"],
  type:   ["type"],
};

function normPerson(p) {
  if (p == null) return "";
  if (Array.isArray(p)) return p.map(normPerson).join(" ");
  return String(p).toLowerCase();
}

/** Reduce a person field's raw text to a short, human-friendly first token.
 * Handles "Maya Chen <maya@figma.com>", "the owner@example.com", and arrays.
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
    case "stream": {
      const v = Array.isArray(chip.value) ? chip.value : [chip.value];
      return v.some((x) => stream.connector_id === x || stream.name === x || `${stream.connector_id}/${stream.name}` === x);
    }
    case "connection": {
      const v = Array.isArray(chip.value) ? chip.value : [chip.value];
      return v.includes(stream.connection_id);
    }
    case "from": {
      const target = String(chip.value).toLowerCase();
      const candidateFields = stream.schema.fields.filter((f) =>
        FIELD_ALIASES.from.some((alias) => f.name.toLowerCase().includes(alias)) ||
        f.type === "person" || f.type === "person[]"
      );
      return candidateFields.some((f) => normPerson(r[f.name]).includes(target));
    }
    case "with": case "to": {
      const target = String(chip.value).toLowerCase();
      // matches author OR recipient OR text body
      const fs = stream.schema.fields;
      return fs.some((f) =>
        (f.type === "person" || f.type === "person[]" || f.type === "text") &&
        normPerson(r[f.name]).includes(target)
      );
    }
    case "month": {
      const fs = stream.schema.fields;
      const tf = fs.find((f) => f.type === "timestamp")?.name;
      return tf ? r[tf]?.slice(0, 7) === chip.value : false;
    }
    case "year": {
      const fs = stream.schema.fields;
      const tf = fs.find((f) => f.type === "timestamp")?.name;
      return tf ? r[tf]?.slice(0, 4) === String(chip.value) : false;
    }
    case "since": {
      const fs = stream.schema.fields;
      const tf = fs.find((f) => f.type === "timestamp")?.name;
      return tf ? new Date(r[tf]).getTime() >= new Date(chip.value).getTime() : false;
    }
    case "amount": {
      const fs = stream.schema.fields;
      const af = fs.find((f) => f.type === "currency")?.name ?? fs.find((f) => /amount/i.test(f.name))?.name;
      if (!af) return false;
      const x = Math.abs(r[af] ?? 0);
      if (chip.op === ">") return x > Number(chip.value);
      if (chip.op === "<") return x < Number(chip.value);
      if (chip.op === "=") return x === Number(chip.value);
      return false;
    }
    case "category": {
      const fs = stream.schema.fields;
      const cf = fs.find((f) => /category/i.test(f.name))?.name;
      return cf ? r[cf] === chip.value : false;
    }
    case "type": {
      return r.type === chip.value;
    }
    case "channel": {
      const target = String(chip.value).toLowerCase();
      return ["channel", "channel_id"].some((k) => String(r[k] ?? "").toLowerCase().includes(target));
    }
    case "has": {
      if (chip.value === "image") {
        return stream.schema.fields.some((f) => f.type === "blob" && (f.media_type ?? "").startsWith("image/")) ||
               stream.schema.fields.some((f) => /thumb|image|photo|picture/i.test(f.name) && (f.type === "blob" || f.type === "url") && r[f.name]);
      }
      if (chip.value === "geo") {
        return ["lat","latitude"].some((n) => r[n] != null);
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
  const fields = stream.schema.fields.filter((f) =>
    ["text", "person"].includes(f.type) ||
    /title|subject|snippet|body|text|caption|merchant|memo|name/i.test(f.name)
  );
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
    const streamChips = query.chips.filter((c) => c.field === "stream" || c.field === "connection");
    if (streamChips.length && !streamChips.every((c) => recordMatchesChip(s, s.records[0] ?? {}, c))) continue;

    for (const r of s.records) {
      // Apply non-stream chips
      const passes = query.chips
        .filter((c) => c.field !== "stream" && c.field !== "connection")
        .every((c) => recordMatchesChip(s, r, c));
      if (!passes) continue;
      if (!textMatches(s, r, query.text)) continue;
      hits.push({ stream: s, record: r });
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
  const tf = s.schema.fields.find((f) => f.type === "timestamp")?.name;
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
  for (const { stream, record } of hits) {
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
    categories: [...catCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
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
        out.push({ kind: "chip", chip: { field: "stream", op: "in", value: [key] }, label: `stream: ${key}`, hint: s.title });
      }
    }
  }
  // Person suggestions (across streams)
  const seenPpl = new Set();
  for (const s of allStreams) {
    const personFields = s.schema.fields.filter((f) => f.type === "person" || f.type === "person[]");
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
          out.push({ kind: "chip", chip: { field: "from", op: "is", value: first }, label: `from: ${first}`, hint: display });
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

window.PDPP_QUERY = { runQuery, computeFacets, suggestChips, recordTime, firstNameToken };

})();
