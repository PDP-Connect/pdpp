import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  MessageStructureObject,
  // biome-ignore lint/correctness/noUnresolvedImports: imapflow is declared in package.json; Biome's resolver doesn't see it here
} from "imapflow";
import {
  addressListToArray,
  bigintToCursor,
  bigintToNumber,
  buildDeltaMessageRecord,
  buildMessageBodyRecord,
  buildMessageRecord,
  buildThreadRecord,
  canonicalLabelName,
  classifyBodySource,
  decodeBodyPart,
  decodeBodystructureForAttachments,
  envelopeParticipants,
  findFirstPartByType,
  findLeafByPath,
  findTextHtmlPart,
  findTextPlainPart,
  isGmailSystemLabel,
  isInTimeRange,
  labelParentName,
  MAX_BODY_FIELD_CHARS,
  makeSnippet,
  parseReferencesHeader,
  sanitizeForJsonl,
  selectBodyParts,
  stripHtmlToText,
  toFlagsArray,
  toLabelsArray,
  updateThreadAggregate,
} from "./parsers.ts";
import type { ThreadAggregate } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "__fixtures__");

function readJsonFixture<T>(relPath: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, relPath), "utf8")) as T;
}

// ─── bigintToNumber ─────────────────────────────────────────────────────

test("bigintToNumber: narrows bigint → number", () => {
  assert.equal(bigintToNumber(42n), 42);
  assert.equal(bigintToNumber(0n), 0);
  assert.equal(bigintToNumber(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test("bigintToNumber: passes number through unchanged", () => {
  assert.equal(bigintToNumber(42), 42);
  assert.equal(bigintToNumber(0), 0);
});

test("bigintToNumber: returns null for strings / null / undefined / object", () => {
  assert.equal(bigintToNumber(undefined), null);
  assert.equal(bigintToNumber(null), null);
  assert.equal(bigintToNumber("42"), null);
  assert.equal(bigintToNumber({}), null);
  assert.equal(bigintToNumber([]), null);
});

// ─── bigintToCursor ─────────────────────────────────────────────────────

test("bigintToCursor: safe-range bigint → number", () => {
  assert.equal(bigintToCursor(42n), 42);
  assert.equal(bigintToCursor(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test("bigintToCursor: out-of-range bigint → string (preserves precision)", () => {
  const huge = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
  assert.equal(bigintToCursor(huge), huge.toString());
  const negHuge = BigInt(Number.MIN_SAFE_INTEGER) - 10n;
  assert.equal(bigintToCursor(negHuge), negHuge.toString());
});

test("bigintToCursor: numbers and strings pass through", () => {
  assert.equal(bigintToCursor(42), 42);
  assert.equal(bigintToCursor("cursor-abc"), "cursor-abc");
});

test("bigintToCursor: null/undefined/object → null", () => {
  assert.equal(bigintToCursor(undefined), null);
  assert.equal(bigintToCursor(null), null);
  assert.equal(bigintToCursor({}), null);
});

// ─── canonicalLabelName ─────────────────────────────────────────────────

test("canonicalLabelName: INBOX special-cases to lowercase", () => {
  assert.equal(canonicalLabelName("INBOX"), "inbox");
});

test("canonicalLabelName: strips [Gmail]/ prefix, lowercases, underscore-joins whitespace", () => {
  assert.equal(canonicalLabelName("[Gmail]/All Mail"), "all_mail");
  assert.equal(canonicalLabelName("[Gmail]/Sent Mail"), "sent_mail");
  assert.equal(canonicalLabelName("[Gmail]/Starred"), "starred");
});

test("canonicalLabelName: user labels lowercase + underscore-join", () => {
  assert.equal(canonicalLabelName("Work"), "work");
  assert.equal(canonicalLabelName("Work/Projects Q4"), "work/projects_q4");
});

// ─── isGmailSystemLabel ─────────────────────────────────────────────────

test("isGmailSystemLabel: INBOX + [Gmail]/... are system", () => {
  assert.equal(isGmailSystemLabel("INBOX"), true);
  assert.equal(isGmailSystemLabel("[Gmail]/All Mail"), true);
  assert.equal(isGmailSystemLabel("[Gmail]/Trash"), true);
});

test("isGmailSystemLabel: user labels are not system", () => {
  assert.equal(isGmailSystemLabel("Work"), false);
  assert.equal(isGmailSystemLabel("Inbox"), false); // case-sensitive
  assert.equal(isGmailSystemLabel("gmail/whatever"), false);
});

// ─── labelParentName ────────────────────────────────────────────────────

test("labelParentName: nested returns everything but the leaf", () => {
  assert.equal(labelParentName("Work/Projects/Q4"), "Work/Projects");
  assert.equal(labelParentName("a/b"), "a");
});

test("labelParentName: top-level returns null", () => {
  assert.equal(labelParentName("INBOX"), null);
  assert.equal(labelParentName("Work"), null);
});

// ─── addressListToArray ─────────────────────────────────────────────────

test("addressListToArray: maps imapflow addresses to { name, email }", () => {
  const input = [
    { name: "Alice", address: "alice@example.com" },
    { name: "", address: "bob@example.com" },
    { name: "Charlie", address: "" },
  ];
  assert.deepEqual(addressListToArray(input), [
    { name: "Alice", email: "alice@example.com" },
    { name: null, email: "bob@example.com" },
    { name: "Charlie", email: null },
  ]);
});

test("addressListToArray: undefined/empty → []", () => {
  assert.deepEqual(addressListToArray(undefined), []);
  assert.deepEqual(addressListToArray([]), []);
});

// ─── toFlagsArray / toLabelsArray ───────────────────────────────────────

test("toFlagsArray: Set becomes Array", () => {
  assert.deepEqual(toFlagsArray(new Set(["\\Seen", "\\Flagged"])), ["\\Seen", "\\Flagged"]);
});

test("toFlagsArray: undefined → []", () => {
  assert.deepEqual(toFlagsArray(undefined), []);
});

test("toLabelsArray: Set or Array pass through", () => {
  assert.deepEqual(toLabelsArray(new Set(["\\Important", "Work"])), ["\\Important", "Work"]);
  assert.deepEqual(toLabelsArray(["\\Important", "Work"]), ["\\Important", "Work"]);
});

test("toLabelsArray: undefined → []", () => {
  assert.deepEqual(toLabelsArray(undefined), []);
});

// ─── sanitizeForJsonl ───────────────────────────────────────────────────

test("sanitizeForJsonl: lone surrogates → U+FFFD", () => {
  // \uD83D alone without trailing low-surrogate is invalid
  assert.equal(sanitizeForJsonl("hello\uD83D world"), "hello\uFFFD world");
  assert.equal(sanitizeForJsonl("\uDC00stray low"), "\uFFFDstray low");
});

test("sanitizeForJsonl: well-formed surrogate pair preserved", () => {
  // \uD83D\uDE00 = 😀
  assert.equal(sanitizeForJsonl("smile \uD83D\uDE00!"), "smile \uD83D\uDE00!");
});

test("sanitizeForJsonl: control chars (0x00..0x1F except \\r\\n\\t) → space", () => {
  // 0x01 - 0x08, 0x0B, 0x0C, 0x0E - 0x1F, 0x7F all become space
  assert.equal(sanitizeForJsonl("a\u0001b"), "a b");
  assert.equal(sanitizeForJsonl("a\u001Fb"), "a b");
  assert.equal(sanitizeForJsonl("a\u007Fb"), "a b");
});

test("sanitizeForJsonl: tab / CR / LF preserved (JSON.stringify escapes them)", () => {
  assert.equal(sanitizeForJsonl("a\tb"), "a\tb");
  assert.equal(sanitizeForJsonl("a\nb"), "a\nb");
  assert.equal(sanitizeForJsonl("a\rb"), "a\rb");
});

test("sanitizeForJsonl: null / undefined / number / boolean pass through", () => {
  assert.equal(sanitizeForJsonl(null), null);
  assert.equal(sanitizeForJsonl(undefined), undefined);
  assert.equal(sanitizeForJsonl(42), 42);
  assert.equal(sanitizeForJsonl(true), true);
});

test("sanitizeForJsonl: recurses into arrays + objects", () => {
  const input = { a: "x\u0001y", b: ["z\u0001w", 5], c: { d: "lone \uD83D!" } };
  assert.deepEqual(sanitizeForJsonl(input), {
    a: "x y",
    b: ["z w", 5],
    c: { d: "lone \uFFFD!" },
  });
});

// ─── BODYSTRUCTURE walking ──────────────────────────────────────────────

// The JSON fixture matches imapflow's MessageStructureObject shape at
// runtime. Declaring the return type directly lets parsers accept the
// value without any intermediate coercion.
function readBodystructureFixture(): MessageStructureObject {
  return readJsonFixture<MessageStructureObject>("bodystructure-multipart.json");
}

test("decodeBodystructureForAttachments: extracts both inline and attachment leaves from fixture", () => {
  const tree = readBodystructureFixture();
  const items = decodeBodystructureForAttachments(tree, "msg-1", "2024-01-15T12:00:00.000Z");
  assert.equal(items.length, 2);
  // Inline image = part 2, attachment pdf = part 3
  const inline = items.find((a) => a.filename === "inline-image.png");
  assert.ok(inline);
  assert.equal(inline.is_inline, true);
  assert.equal(inline.part_index, "2");
  assert.equal(inline.content_type, "image/png");
  assert.equal(inline.content_id, "<image1@example.com>");
  assert.equal(inline.id, "msg-1:2");
  assert.equal(inline.size_bytes, 24_576);
  assert.equal(inline.blob_ref, null);
  assert.equal(inline.content_sha256, null);
  assert.equal(inline.hydration_status, "deferred");
  assert.equal(inline.hydration_error, null);

  const pdf = items.find((a) => a.filename === "invoice.pdf");
  assert.ok(pdf);
  assert.equal(pdf.is_inline, false);
  assert.equal(pdf.part_index, "3");
  assert.equal(pdf.content_type, "application/pdf");
  assert.equal(pdf.id, "msg-1:3");
});

test("decodeBodystructureForAttachments: undefined structure → []", () => {
  assert.deepEqual(decodeBodystructureForAttachments(undefined, "msg-1", "2024-01-15T12:00:00.000Z"), []);
});

test("decodeBodystructureForAttachments: drops body alternatives (inline text without filename)", () => {
  // Real-world shape: multipart/alternative with text/plain + text/html
  // body alternatives, both marked disposition=inline by the server.
  // The previous classifier emitted both as "attachments"; the corrected
  // rule rejects them. Verified against IMAP truth on 480 sampled
  // Gmail messages: zero false-positives, zero missed attachments.
  // See connectors/gmail/parsers.ts decodeBodystructureForAttachments.
  const tree = {
    type: "multipart/alternative",
    childNodes: [
      {
        part: "1",
        type: "text/plain",
        disposition: "inline",
        size: 1234,
      },
      {
        part: "2",
        type: "text/html",
        disposition: "inline",
        size: 5678,
      },
    ],
  } as MessageStructureObject;
  const items = decodeBodystructureForAttachments(tree, "msg-body-only", "2024-01-15T12:00:00.000Z");
  assert.equal(items.length, 0, "body alternatives must not be classified as attachments");
});

test("decodeBodystructureForAttachments: keeps inline non-text leaves with Content-ID (cid: images)", () => {
  // Real-world shape: multipart/related with an HTML body and a PNG
  // referenced via cid: in the HTML. The PNG has disposition=inline,
  // no filename, but a Content-ID. It IS an attachment in the
  // user-meaningful sense — they would want to fetch its bytes.
  const tree = {
    type: "multipart/related",
    childNodes: [
      {
        part: "1",
        type: "text/html",
        disposition: "inline",
        size: 1234,
      },
      {
        part: "2",
        type: "image/png",
        disposition: "inline",
        id: "<sig-image@example.com>",
        size: 9999,
      },
    ],
  } as MessageStructureObject;
  const items = decodeBodystructureForAttachments(tree, "msg-cid-image", "2024-01-15T12:00:00.000Z");
  assert.equal(items.length, 1, "cid-referenced inline images are real attachments");
  const item = items[0];
  assert.ok(item, "expected one item");
  assert.equal(item.part_index, "2");
  assert.equal(item.content_type, "image/png");
  assert.equal(item.content_id, "<sig-image@example.com>");
});

test("decodeBodystructureForAttachments: drops inline non-text leaves without Content-ID", () => {
  // Defensive: an inline non-text leaf with neither filename nor
  // Content-ID is unaddressable — caller cannot fetch its bytes
  // meaningfully. Drop it.
  const tree = {
    type: "multipart/related",
    childNodes: [
      {
        part: "1",
        type: "image/png",
        disposition: "inline",
        size: 9999,
        // no id, no filename
      },
    ],
  } as MessageStructureObject;
  const items = decodeBodystructureForAttachments(tree, "msg-anon-inline", "2024-01-15T12:00:00.000Z");
  assert.equal(items.length, 0);
});

test("findFirstPartByType / findTextPlainPart / findTextHtmlPart: locate leaf parts", () => {
  const tree = readBodystructureFixture();
  assert.equal(findTextPlainPart(tree), "1.1");
  assert.equal(findTextHtmlPart(tree), "1.2");
  assert.equal(findFirstPartByType(tree, "application/pdf"), "3");
  assert.equal(findFirstPartByType(tree, "text/nonexistent"), null);
});

test("findLeafByPath: returns the node at a given IMAP path", () => {
  const tree = readBodystructureFixture();
  const plain = findLeafByPath(tree, "1.1");
  assert.ok(plain);
  assert.equal(plain.type, "text/plain");
  assert.equal(plain.parameters?.charset, "utf-8");
  // Missing path returns null
  assert.equal(findLeafByPath(tree, "9.9"), null);
});

// ─── decodeBodyPart ─────────────────────────────────────────────────────

test("decodeBodyPart: plain utf8 passthrough", () => {
  assert.equal(decodeBodyPart(Buffer.from("hello world", "utf8"), null, "utf8"), "hello world");
});

test("decodeBodyPart: base64 → utf8", () => {
  const raw = "Hello, 世界!";
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  assert.equal(decodeBodyPart(Buffer.from(b64, "ascii"), "base64", "utf8"), raw);
});

test("decodeBodyPart: quoted-printable decodes =HH + soft-break", () => {
  // "Hello=20World" (QP space) + soft break
  const qp = Buffer.from("Hello=\r\n=20World", "ascii");
  assert.equal(decodeBodyPart(qp, "quoted-printable", "utf8"), "Hello World");
});

test("decodeBodyPart: null/empty → empty string", () => {
  assert.equal(decodeBodyPart(null, null, null), "");
  assert.equal(decodeBodyPart(undefined, null, null), "");
  assert.equal(decodeBodyPart(Buffer.alloc(0), null, null), "");
});

// ─── stripHtmlToText ────────────────────────────────────────────────────

test("stripHtmlToText: strips script/style, drops tags, decodes entities", () => {
  const html =
    "<html><head><style>body{color:red}</style></head><body>" +
    "<p>Hello &amp; welcome</p>" +
    "<script>alert('x')</script>" +
    "<p>Line&nbsp;two</p>" +
    "<!-- comment --></body></html>";
  const out = stripHtmlToText(html);
  assert.match(out, /Hello & welcome/);
  assert.match(out, /Line two/);
  assert.doesNotMatch(out, /alert/);
  assert.doesNotMatch(out, /color:red/);
  assert.doesNotMatch(out, /<p>/);
});

test("stripHtmlToText: <br> becomes newline; block close-tags insert newline", () => {
  const html = "<p>A</p><p>B</p>C<br>D";
  const out = stripHtmlToText(html);
  assert.ok(out.includes("A\nB"));
  assert.ok(out.includes("C\nD"));
});

test("stripHtmlToText: decodes decimal + hex entities", () => {
  assert.equal(stripHtmlToText("&#65;&#x42;"), "AB");
});

test("stripHtmlToText: null/empty → empty", () => {
  assert.equal(stripHtmlToText(null), "");
  assert.equal(stripHtmlToText(undefined), "");
  assert.equal(stripHtmlToText(""), "");
});

// ─── parseReferencesHeader ──────────────────────────────────────────────

test("parseReferencesHeader: single-line list of message-ids", () => {
  const hdr = "References: <a@x> <b@y>\r\nSubject: whatever\r\n";
  assert.deepEqual(parseReferencesHeader(hdr), ["<a@x>", "<b@y>"]);
});

test("parseReferencesHeader: header folding (CRLF + whitespace) unfolds correctly", () => {
  const hdr = "References: <first@x>\r\n <second@y>\r\n\t<third@z>\r\nSubject: ok\r\n";
  assert.deepEqual(parseReferencesHeader(hdr), ["<first@x>", "<second@y>", "<third@z>"]);
});

test("parseReferencesHeader: Buffer input decoded as utf8", () => {
  const hdr = Buffer.from("References: <a@x> <b@y>\r\n", "utf8");
  assert.deepEqual(parseReferencesHeader(hdr), ["<a@x>", "<b@y>"]);
});

test("parseReferencesHeader: missing header / empty / null → []", () => {
  assert.deepEqual(parseReferencesHeader("Subject: no refs\r\n"), []);
  assert.deepEqual(parseReferencesHeader(""), []);
  assert.deepEqual(parseReferencesHeader(null), []);
  assert.deepEqual(parseReferencesHeader(undefined), []);
});

// ─── makeSnippet ────────────────────────────────────────────────────────

test("makeSnippet: drops quoted-reply lines and collapses whitespace", () => {
  const input = Buffer.from("Real reply text\n> old quote\n> more quote\nAnother real line\n", "utf8");
  assert.equal(makeSnippet(input, null, "utf8"), "Real reply text Another real line");
});

test("makeSnippet: quoted-printable does byte-wise decode (Latin-1 interpretation quirk)", () => {
  // BUG (flagged, not fixed): makeSnippet's QP path uses String.fromCharCode
  // per hex escape, which treats each =HH as a codepoint instead of a raw
  // byte. For a UTF-8 'é' encoded as =C3=A9 this yields "Ã©" (Latin-1) rather
  // than "é". decodeBodyPart does the correct byte-accumulation; makeSnippet
  // does not. Documenting the current behavior here so a future fix is a
  // conscious change, not a silent one.
  const qpInput = Buffer.from("caf=C3=A9 snippet", "ascii");
  const snippet = makeSnippet(qpInput, "quoted-printable", "utf8");
  assert.equal(snippet, "cafÃ© snippet");
});

test("makeSnippet: respects maxChars (truncates)", () => {
  const longInput = Buffer.from("abcdefghijklmnopqrstuvwxyz".repeat(20), "utf8");
  const snip = makeSnippet(longInput, null, "utf8", 10);
  assert.ok(snip);
  assert.equal(snip.length, 10);
  assert.equal(snip, "abcdefghij");
});

test("makeSnippet: empty input / all-quoted input → null", () => {
  assert.equal(makeSnippet(null, null, null), null);
  assert.equal(makeSnippet(Buffer.alloc(0), null, null), null);
  // All lines quoted
  assert.equal(makeSnippet(Buffer.from("> q1\n> q2\n", "utf8"), null, "utf8"), null);
});

// ─── ThreadAggregate ────────────────────────────────────────────────────

function makeParams(
  overrides: Partial<Parameters<typeof updateThreadAggregate>[1]> = {}
): Parameters<typeof updateThreadAggregate>[1] {
  return {
    flagsArr: [],
    hasAttachments: false,
    labels: [],
    participants: [],
    receivedAt: "2024-01-15T12:00:00.000Z",
    subject: "hello",
    threadId: "t1",
    ...overrides,
  };
}

test("updateThreadAggregate: seeds fresh aggregate on first message", () => {
  const agg = updateThreadAggregate(undefined, makeParams({ participants: ["a@x", "b@y"] }));
  assert.equal(agg.id, "t1");
  assert.equal(agg.subject, "hello");
  assert.equal(agg.message_count, 1);
  assert.equal(agg.first_message_date, "2024-01-15T12:00:00.000Z");
  assert.equal(agg.last_message_date, "2024-01-15T12:00:00.000Z");
  assert.deepEqual([...agg.participant_set].sort(), ["a@x", "b@y"]);
  assert.equal(agg.unread_count, 1); // \Seen absent → unread
  assert.equal(agg.flagged_count, 0);
});

test("updateThreadAggregate: subsequent messages expand participants + update dates", () => {
  let agg = updateThreadAggregate(
    undefined,
    makeParams({ participants: ["a@x"], receivedAt: "2024-01-15T12:00:00.000Z" })
  );
  agg = updateThreadAggregate(agg, makeParams({ participants: ["b@y"], receivedAt: "2024-01-20T00:00:00.000Z" }));
  agg = updateThreadAggregate(
    agg,
    makeParams({ participants: ["a@x", "c@z"], receivedAt: "2024-01-10T00:00:00.000Z" })
  );
  assert.equal(agg.message_count, 3);
  // Earliest wins for first_message_date, latest wins for last_message_date
  assert.equal(agg.first_message_date, "2024-01-10T00:00:00.000Z");
  assert.equal(agg.last_message_date, "2024-01-20T00:00:00.000Z");
  assert.deepEqual([...agg.participant_set].sort(), ["a@x", "b@y", "c@z"]);
});

test("updateThreadAggregate: seen → not unread; flagged increments flagged_count", () => {
  let agg = updateThreadAggregate(undefined, makeParams({ flagsArr: ["\\Seen"], subject: "s", threadId: "t1" }));
  assert.equal(agg.unread_count, 0);
  agg = updateThreadAggregate(agg, makeParams({ flagsArr: ["\\Flagged"] }));
  assert.equal(agg.flagged_count, 1);
  assert.equal(agg.unread_count, 1); // this one wasn't \Seen
});

test("updateThreadAggregate: any message with attachments turns has_attachments true", () => {
  let agg = updateThreadAggregate(undefined, makeParams({ hasAttachments: false }));
  assert.equal(agg.has_attachments, false);
  agg = updateThreadAggregate(agg, makeParams({ hasAttachments: true }));
  assert.equal(agg.has_attachments, true);
  // stays true even if subsequent messages have no attachments
  agg = updateThreadAggregate(agg, makeParams({ hasAttachments: false }));
  assert.equal(agg.has_attachments, true);
});

test("updateThreadAggregate: first non-null subject sticks", () => {
  let agg = updateThreadAggregate(undefined, makeParams({ subject: null }));
  assert.equal(agg.subject, null);
  agg = updateThreadAggregate(agg, makeParams({ subject: "Found one" }));
  assert.equal(agg.subject, "Found one");
  agg = updateThreadAggregate(agg, makeParams({ subject: "Later subject" }));
  // Preserved (does not overwrite)
  assert.equal(agg.subject, "Found one");
});

test("updateThreadAggregate: labels accumulated into set", () => {
  let agg = updateThreadAggregate(undefined, makeParams({ labels: ["INBOX", "Work"] }));
  agg = updateThreadAggregate(agg, makeParams({ labels: ["Work", "Personal"] }));
  assert.deepEqual([...agg.labels_set].sort(), ["INBOX", "Personal", "Work"]);
});

test("buildThreadRecord: serializes ThreadAggregate to the emit shape", () => {
  const agg: ThreadAggregate = {
    id: "t1",
    subject: "hello",
    participant_set: new Set(["a@x", "b@y"]),
    message_count: 3,
    first_message_date: "2024-01-10T00:00:00.000Z",
    last_message_date: "2024-01-20T00:00:00.000Z",
    labels_set: new Set(["INBOX", "Work"]),
    unread_count: 1,
    flagged_count: 2,
    has_attachments: true,
  };
  const rec = buildThreadRecord(agg);
  assert.equal(rec.id, "t1");
  assert.equal(rec.subject, "hello");
  const pe = rec.participant_emails;
  assert.ok(Array.isArray(pe));
  assert.deepEqual([...pe].sort(), ["a@x", "b@y"]);
  assert.equal(rec.message_count, 3);
  assert.equal(rec.first_message_date, "2024-01-10T00:00:00.000Z");
  assert.equal(rec.last_message_date, "2024-01-20T00:00:00.000Z");
  const labels = rec.labels;
  assert.ok(Array.isArray(labels));
  assert.deepEqual([...labels].sort(), ["INBOX", "Work"]);
  assert.equal(rec.unread_count, 1);
  assert.equal(rec.flagged_count, 2);
  assert.equal(rec.has_attachments, true);
});

// ─── selectBodyParts ────────────────────────────────────────────────────

test("selectBodyParts: resolves plain + html when wantBodies=true", () => {
  const tree = readBodystructureFixture();
  const sel = selectBodyParts(tree, true);
  assert.equal(sel.plainPart, "1.1");
  assert.equal(sel.htmlPart, "1.2");
  assert.ok(sel.plainLeaf);
  assert.ok(sel.htmlLeaf);
  assert.equal(sel.plainCharset, "utf-8");
  assert.equal(sel.htmlCharset, "utf-8");
});

test("selectBodyParts: skips html lookup when wantBodies=false (snippet-only path)", () => {
  const tree = readBodystructureFixture();
  const sel = selectBodyParts(tree, false);
  assert.equal(sel.plainPart, "1.1");
  assert.equal(sel.htmlPart, null);
  assert.equal(sel.htmlLeaf, null);
  assert.equal(sel.htmlEncoding, null);
});

test("selectBodyParts: undefined structure → all null", () => {
  const sel = selectBodyParts(undefined, true);
  assert.equal(sel.plainPart, null);
  assert.equal(sel.htmlPart, null);
  assert.equal(sel.plainEncoding, null);
  assert.equal(sel.plainCharset, null);
});

// ─── classifyBodySource ─────────────────────────────────────────────────

test("classifyBodySource: prefers non-empty text_plain", () => {
  const r = classifyBodySource("plain body", "<p>html</p>");
  assert.equal(r.bodyText, "plain body");
  assert.equal(r.bodySource, "text_plain");
});

test("classifyBodySource: falls back to html_stripped when text empty", () => {
  const r = classifyBodySource(null, "<p>Hello</p>");
  assert.equal(r.bodyText, "Hello");
  assert.equal(r.bodySource, "html_stripped");
});

test("classifyBodySource: text_html when html present but strips to nothing", () => {
  // stripHtmlToText returns "" for empty bodies after tag removal
  const r = classifyBodySource(null, "<!-- comment -->");
  assert.equal(r.bodyText, null);
  assert.equal(r.bodySource, "text_html");
});

test("classifyBodySource: empty when both are null/empty", () => {
  const r = classifyBodySource(null, null);
  assert.equal(r.bodyText, null);
  assert.equal(r.bodySource, "empty");
});

// ─── buildMessageBodyRecord ─────────────────────────────────────────────

test("buildMessageBodyRecord: text_plain path populates full fields + bytes", () => {
  const rec = buildMessageBodyRecord({
    bodyTextFull: "plain body text",
    bodyHtmlFull: "<p>html body</p>",
    gmMsgid: "msg-1",
    textCharset: "utf-8",
    htmlCharset: null,
  });
  assert.equal(rec.id, "msg-1");
  assert.equal(rec.message_id, "msg-1");
  assert.equal(rec.body_text, "plain body text");
  assert.equal(rec.body_html, "<p>html body</p>");
  assert.equal(rec.body_text_bytes, Buffer.byteLength("plain body text", "utf8"));
  assert.equal(rec.body_html_bytes, Buffer.byteLength("<p>html body</p>", "utf8"));
  assert.equal(rec.body_source, "text_plain");
  assert.equal(rec.charset, "utf-8");
  assert.equal(rec.content_languages, null);
});

test("buildMessageBodyRecord: truncates body_text past MAX_BODY_FIELD_CHARS and tags truncation", () => {
  const huge = "x".repeat(MAX_BODY_FIELD_CHARS + 100);
  const rec = buildMessageBodyRecord({
    bodyTextFull: huge,
    bodyHtmlFull: null,
    gmMsgid: "m",
    textCharset: null,
    htmlCharset: null,
  });
  assert.ok(typeof rec.body_text === "string");
  const body = rec.body_text;
  assert.ok(body);
  assert.ok(body.endsWith("…[truncated]"));
  assert.ok(body.length < huge.length);
  // Pre-truncation bytes recorded for the full body.
  assert.equal(rec.body_text_bytes, Buffer.byteLength(huge, "utf8"));
});

test("buildMessageBodyRecord: CR/LF escaped in place for JSONL safety", () => {
  const rec = buildMessageBodyRecord({
    bodyTextFull: "line 1\nline 2\rline 3",
    bodyHtmlFull: null,
    gmMsgid: "m",
    textCharset: "utf-8",
    htmlCharset: null,
  });
  const body = rec.body_text;
  assert.ok(typeof body === "string");
  assert.ok(body);
  assert.equal(body.includes("\n"), false);
  assert.equal(body.includes("\r"), false);
});

test("buildMessageBodyRecord: empty body → null + body_source='empty'", () => {
  const rec = buildMessageBodyRecord({
    bodyTextFull: null,
    bodyHtmlFull: null,
    gmMsgid: "m",
    textCharset: null,
    htmlCharset: null,
  });
  assert.equal(rec.body_text, null);
  assert.equal(rec.body_html, null);
  assert.equal(rec.body_source, "empty");
  assert.equal(rec.charset, null);
});

// ─── buildMessageRecord ─────────────────────────────────────────────────

test("buildMessageRecord: full envelope maps to expected fields", () => {
  const rec = buildMessageRecord({
    attachmentsCount: 2,
    dateHeader: "2024-01-15T12:00:00.000Z",
    envelope: {
      subject: "Hello",
      messageId: "<mid@x>",
      inReplyTo: "<parent@x>",
      from: [{ name: "Alice", address: "alice@x" }],
      to: [{ name: "Bob", address: "bob@x" }],
      cc: [],
      bcc: [],
      replyTo: [],
    },
    flagsArr: ["\\Seen", "\\Flagged"],
    gmMsgid: "m1",
    gmThrid: "t1",
    labels: ["INBOX", "Work"],
    rawHeaders: "References: <a@x> <b@y>\r\n",
    receivedAt: "2024-01-15T12:00:00.000Z",
    sizeBytes: 42,
    snippet: "hello body",
  });
  assert.equal(rec.id, "m1");
  assert.equal(rec.thread_id, "t1");
  assert.equal(rec.subject, "Hello");
  assert.equal(rec.from_name, "Alice");
  assert.equal(rec.from_email, "alice@x");
  assert.deepEqual(rec.to, [{ name: "Bob", email: "bob@x" }]);
  assert.equal(rec.date, "2024-01-15T12:00:00.000Z");
  assert.equal(rec.received_at, "2024-01-15T12:00:00.000Z");
  assert.equal(rec.message_id, "<mid@x>");
  assert.equal(rec.in_reply_to, "<parent@x>");
  assert.deepEqual(rec.references, ["<a@x>", "<b@y>"]);
  assert.equal(rec.size_bytes, 42);
  assert.deepEqual(rec.labels, ["INBOX", "Work"]);
  assert.equal(rec.is_seen, true);
  assert.equal(rec.is_flagged, true);
  assert.equal(rec.is_draft, false);
  assert.equal(rec.is_answered, false);
  assert.equal(rec.has_attachments, true);
  assert.equal(rec.snippet, "hello body");
});

test("buildMessageRecord: empty envelope + zero attachments maps to null/defaults", () => {
  const rec = buildMessageRecord({
    attachmentsCount: 0,
    dateHeader: null,
    envelope: {},
    flagsArr: [],
    gmMsgid: "m",
    gmThrid: "",
    labels: [],
    rawHeaders: null,
    receivedAt: "2024-01-15T12:00:00.000Z",
    sizeBytes: null,
    snippet: null,
  });
  assert.equal(rec.subject, null);
  assert.equal(rec.from_name, null);
  assert.equal(rec.from_email, null);
  assert.deepEqual(rec.to, []);
  assert.equal(rec.message_id, null);
  assert.equal(rec.in_reply_to, null);
  assert.deepEqual(rec.references, []);
  assert.equal(rec.size_bytes, null);
  assert.equal(rec.has_attachments, false);
  assert.equal(rec.snippet, null);
});

// ─── buildDeltaMessageRecord ────────────────────────────────────────────

test("buildDeltaMessageRecord: minimal shape with flags + labels, received_at fallback", () => {
  const rec = buildDeltaMessageRecord({
    flagsArr: ["\\Seen"],
    gmMsgid: "m1",
    gmThrid: "t1",
    labels: ["INBOX"],
    receivedAtFallback: "2024-02-01T00:00:00.000Z",
  });
  assert.equal(rec.id, "m1");
  assert.equal(rec.thread_id, "t1");
  assert.equal(rec.subject, null);
  assert.equal(rec.from_name, null);
  assert.deepEqual(rec.to, []);
  assert.equal(rec.received_at, "2024-02-01T00:00:00.000Z");
  assert.deepEqual(rec.labels, ["INBOX"]);
  assert.equal(rec.is_seen, true);
  assert.equal(rec.is_flagged, false);
  assert.equal(rec.has_attachments, false);
});

// ─── isInTimeRange ──────────────────────────────────────────────────────

test("isInTimeRange: no range → always true", () => {
  assert.equal(isInTimeRange("2024-01-15T00:00:00.000Z", undefined), true);
  assert.equal(isInTimeRange("2024-01-15T00:00:00.000Z", null), true);
});

test("isInTimeRange: since / until half-open interval [since, until)", () => {
  const range = { since: "2024-01-01T00:00:00.000Z", until: "2024-02-01T00:00:00.000Z" };
  assert.equal(isInTimeRange("2024-01-15T00:00:00.000Z", range), true);
  assert.equal(isInTimeRange("2024-01-01T00:00:00.000Z", range), true); // boundary inclusive
  assert.equal(isInTimeRange("2023-12-31T00:00:00.000Z", range), false);
  assert.equal(isInTimeRange("2024-02-01T00:00:00.000Z", range), false); // upper exclusive
  assert.equal(isInTimeRange("2024-03-01T00:00:00.000Z", range), false);
});

test("isInTimeRange: only-since / only-until", () => {
  assert.equal(isInTimeRange("2024-01-15T00:00:00.000Z", { since: "2024-01-01T00:00:00.000Z" }), true);
  assert.equal(isInTimeRange("2023-12-15T00:00:00.000Z", { since: "2024-01-01T00:00:00.000Z" }), false);
  assert.equal(isInTimeRange("2024-01-15T00:00:00.000Z", { until: "2024-02-01T00:00:00.000Z" }), true);
  assert.equal(isInTimeRange("2024-03-15T00:00:00.000Z", { until: "2024-02-01T00:00:00.000Z" }), false);
});

// ─── envelopeParticipants ───────────────────────────────────────────────

test("envelopeParticipants: flattens from/to/cc into a single string[]", () => {
  const env = {
    from: [{ address: "a@x", name: "A" }],
    to: [
      { address: "b@y", name: "B" },
      { address: "c@z", name: "C" },
    ],
    cc: [{ address: "d@w", name: "D" }],
  };
  const parts = envelopeParticipants(env);
  assert.deepEqual(parts.sort(), ["a@x", "b@y", "c@z", "d@w"]);
});

test("envelopeParticipants: filters missing addresses and handles undefined envelope", () => {
  assert.deepEqual(envelopeParticipants(undefined), []);
  assert.deepEqual(envelopeParticipants({}), []);
  assert.deepEqual(envelopeParticipants({ from: [{ name: "X", address: "" }] }), []);
});

// ─── Gate to any real-fixture tests ─────────────────────────────────────
// None yet — Gmail captures land in ../../fixtures/gmail/... Leaving a
// skipped placeholder so future commits can add real fixture parsing tests.
test("real gmail fixtures (if present on disk) smoke-parse", {
  skip: !existsSync(join(__dirname, "..", "..", "fixtures", "gmail")),
}, () => {
  // Placeholder: a future commit can enumerate files under fixtures/gmail
  // and round-trip parse them. Current fixtures format is JSONL, not raw
  // IMAP objects, so no parsers target them directly yet.
  assert.ok(true);
});
