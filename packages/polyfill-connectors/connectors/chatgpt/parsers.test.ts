import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildConversationRecord,
  buildCustomInstructionsRecord,
  buildGizmoRecord,
  buildMemoryRecord,
  buildSharedConversationRecord,
  countBranchMessages,
  extractContent,
  extractMessage,
  extractToolCalls,
  flattenTreeCurrentBranch,
  maxUpdateTimeIso,
  resolveGizmoIsPublic,
  tsToIso,
  unwrapGizmo,
} from "./parsers.ts";
import type { ChatGptNode, ConversationListItem, RawGizmo } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "__fixtures__");

interface ConversationFixture {
  current_node: string;
  mapping: Record<string, ChatGptNode>;
}

function readFixtureJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, rel), "utf8")) as T;
}

// ─── tsToIso ────────────────────────────────────────────────────────────

test("tsToIso: unix seconds number → ISO", () => {
  assert.equal(tsToIso(1_700_000_000), new Date(1_700_000_000 * 1000).toISOString());
});

test("tsToIso: ISO string passes through", () => {
  assert.equal(tsToIso("2024-01-02T03:04:05Z"), "2024-01-02T03:04:05.000Z");
});

test("tsToIso: null / nonsense / NaN → null", () => {
  assert.equal(tsToIso(null), null);
  assert.equal(tsToIso(undefined), null);
  assert.equal(tsToIso("not a date"), null);
  assert.equal(tsToIso(Number.NaN), null);
  // Non-string, non-number falls through to null.
  assert.equal(tsToIso({} as unknown), null);
});

// ─── flattenTreeCurrentBranch + countBranchMessages ────────────────────

test("flattenTreeCurrentBranch: walks root → tip for current branch only", () => {
  const { mapping, current_node: currentNode } = readFixtureJson<ConversationFixture>("conversation-mapping.json");
  const branch = flattenTreeCurrentBranch(mapping, currentNode).map((x) => x.nodeId);
  assert.deepEqual(branch, ["root", "u1", "a1"]);
});

test("flattenTreeCurrentBranch: missing current → empty list", () => {
  assert.deepEqual(flattenTreeCurrentBranch({}, null), []);
  assert.deepEqual(flattenTreeCurrentBranch({}, "does-not-exist"), []);
});

test("countBranchMessages: only counts nodes with a message + role; null for missing mapping", () => {
  const { mapping, current_node: currentNode } = readFixtureJson<ConversationFixture>("conversation-mapping.json");
  // root has no message → 2 (u1 + a1).
  assert.equal(countBranchMessages(mapping, currentNode), 2);
  assert.equal(countBranchMessages(null, currentNode), null);
  assert.equal(countBranchMessages(mapping, null), null);
});

// ─── extractContent per-content_type dispatch ─────────────────────────

test("extractContent: undefined / empty object → null", () => {
  assert.equal(extractContent(undefined), null);
  assert.equal(extractContent({}), null);
});

test("extractContent: text joins parts with \\n and asset-pointers render as [asset:...]", () => {
  const out = extractContent({
    content_type: "text",
    parts: ["hello", { asset_pointer: "file-1" }, { text: "world" }],
  });
  assert.equal(out, "hello\n[asset:file-1]\nworld");
});

test("extractContent: empty text parts → null", () => {
  assert.equal(extractContent({ content_type: "text", parts: [] }), null);
  assert.equal(extractContent({ content_type: "text", parts: ["", "   "] }), null);
});

test("extractContent: code with language → fenced block", () => {
  const out = extractContent({ content_type: "code", language: "python", text: "print(1)" });
  assert.equal(out, "```python\nprint(1)\n```");
});

test("extractContent: code without language → raw body", () => {
  const out = extractContent({ content_type: "code", text: "echo hi" });
  assert.equal(out, "echo hi");
});

test("extractContent: code empty body + empty language → null", () => {
  assert.equal(extractContent({ content_type: "code" }), null);
});

test("extractContent: thoughts combines summary + content per entry, separates entries with blank line", () => {
  const out = extractContent({
    content_type: "thoughts",
    thoughts: [{ summary: "s1", content: "c1" }, { summary: "s2" }, { content: "c3" }],
  });
  assert.equal(out, "s1\nc1\n\ns2\n\nc3");
});

test("extractContent: reasoning_recap prefers `content` then falls back to `text`", () => {
  assert.equal(extractContent({ content_type: "reasoning_recap", content: "A" }), "A");
  assert.equal(extractContent({ content_type: "reasoning_recap", text: "B" }), "B");
  assert.equal(extractContent({ content_type: "reasoning_recap" }), null);
});

test("extractContent: multimodal_text renders {content_type: image_asset_pointer} tag", () => {
  const out = extractContent({
    content_type: "multimodal_text",
    parts: [{ content_type: "image_asset_pointer", asset_pointer: "img-1" }, "caption"],
  });
  // asset_pointer wins over content_type when both present.
  assert.equal(out, "[asset:img-1]\ncaption");
});

test("extractContent: tether_browsing_display joins summary + result with blank line", () => {
  const out = extractContent({
    content_type: "tether_browsing_display",
    summary: "quick summary",
    result: "full text",
  });
  assert.equal(out, "quick summary\n\nfull text");
});

test("extractContent: tether_quote stacks title + url + text newline-joined", () => {
  const out = extractContent({
    content_type: "tether_quote",
    title: "T",
    url: "https://example/q",
    text: "quoted",
  });
  assert.equal(out, "T\nhttps://example/q\nquoted");
});

test("extractContent: execution_output returns text or null", () => {
  assert.equal(extractContent({ content_type: "execution_output", text: "stdout" }), "stdout");
  assert.equal(extractContent({ content_type: "execution_output" }), null);
});

test("extractContent: model_editable_context includes repository line when set", () => {
  const out = extractContent({
    content_type: "model_editable_context",
    model_set_context: "bio",
    repository: "org/repo",
    repo_summary: "it's a repo",
  });
  assert.equal(out, "bio\n\nrepository: org/repo\n\nit's a repo");
});

test("extractContent: unrecognized shape falls back to JSON-stringified payload", () => {
  const out = extractContent({ content_type: "unknown_future_shape", mystery: true });
  assert.ok(typeof out === "string" && out.includes("unknown_future_shape"));
});

test("extractContent: empty / null-shaped content falls back to null", () => {
  assert.equal(extractContent({}), null);
});

test("extractContent: content with U+0000 (NUL) returns null, not shape-check-failing string", () => {
  assert.equal(extractContent({ content_type: "text", parts: ["hello\x00world"] }), null);
});

test("extractContent: content with other forbidden control char (VT U+000B) returns null", () => {
  assert.equal(extractContent({ content_type: "text", parts: ["line1\x0Bline2"] }), null);
});

test("extractContent: content with only allowed whitespace (\\t \\n \\r) is preserved", () => {
  assert.equal(extractContent({ content_type: "text", parts: ["a\tb\nc\rd"] }), "a\tb\nc\rd");
});

test("extractContent: safe full message content is not preview-truncated", () => {
  const content = "x".repeat(5001);
  assert.equal(extractContent({ content_type: "text", parts: [content] }), content);
});

// ─── extractToolCalls ──────────────────────────────────────────────────

test("extractToolCalls: explicit metadata.tool_calls passes through when non-empty", () => {
  const calls = [{ name: "python", args: {} }];
  const out = extractToolCalls({ author: { role: "assistant" }, metadata: { tool_calls: calls } });
  assert.deepEqual(out, calls);
});

test("extractToolCalls: assistant addressed to a tool synthesizes a call", () => {
  const out = extractToolCalls({
    author: { role: "assistant" },
    recipient: "python",
    content: { content_type: "code", language: "python", text: "1+1" },
    metadata: { invoked_plugin: { plugin_id: "p1" } },
  });
  assert.equal(out.length, 1);
  const c = out[0] as {
    content_type?: string;
    invoked_plugin?: unknown;
    language?: string;
    recipient?: string;
    text?: string;
  };
  assert.equal(c.recipient, "python");
  assert.equal(c.content_type, "code");
  assert.equal(c.language, "python");
  assert.equal(c.text, "1+1");
  assert.deepEqual(c.invoked_plugin, { plugin_id: "p1" });
});

test("extractToolCalls: assistant with recipient='all' does NOT synthesize a call", () => {
  const out = extractToolCalls({ author: { role: "assistant" }, recipient: "all" });
  assert.deepEqual(out, []);
});

test("extractToolCalls: plugin invocation without explicit tool_calls → single element", () => {
  const out = extractToolCalls({
    author: { role: "assistant" },
    metadata: { invoked_plugin: { plugin_id: "wolfram" } },
  });
  assert.deepEqual(out, [{ invoked_plugin: { plugin_id: "wolfram" } }]);
});

test("extractToolCalls: user message → empty list", () => {
  assert.deepEqual(extractToolCalls({ author: { role: "user" } }), []);
});

// ─── extractMessage ────────────────────────────────────────────────────

test("extractMessage: returns null for synthetic root (no message)", () => {
  assert.equal(extractMessage("root", { parent: null, children: ["x"] }, "conv1", false), null);
});

test("extractMessage: builds a RECORD with content + children + current-branch flag", () => {
  const { mapping } = readFixtureJson<ConversationFixture>("conversation-mapping.json");
  const a1 = mapping.a1;
  assert.ok(a1, "fixture must expose a1");
  const rec = extractMessage("a1", a1, "conv1", true);
  assert.ok(rec);
  assert.equal(rec?.id, "a1");
  assert.equal(rec?.conversation_id, "conv1");
  assert.equal(rec?.role, "assistant");
  assert.equal(rec?.content, "hi there");
  assert.equal(rec?.content_type, "text");
  assert.equal(rec?.model_slug, "gpt-4o");
  assert.equal(rec?.finish_reason, "stop");
  assert.equal(rec?.on_current_branch, true);
});

// ─── Memory + gizmo + custom instructions + shared + conversation ─────

test("buildMemoryRecord: returns null when id is missing", () => {
  assert.equal(buildMemoryRecord({}), null);
});

test("buildMemoryRecord: falls back from content to name", () => {
  const rec = buildMemoryRecord({ id: "m1", name: "remember this", updated_at: "2024-01-01T00:00:00Z" });
  assert.equal(rec?.content, "remember this");
  assert.equal(rec?.updated_at, "2024-01-01T00:00:00Z");
});

test("unwrapGizmo: handles {resource:{gizmo:{}}}, {resource:{}}, {gizmo:{}} and flat", () => {
  assert.equal(unwrapGizmo(null), null);
  assert.equal(unwrapGizmo("not obj"), null);
  assert.deepEqual((unwrapGizmo({ resource: { gizmo: { id: "a" } } }) as RawGizmo).id, "a");
  assert.deepEqual((unwrapGizmo({ resource: { id: "b" } }) as RawGizmo).id, "b");
  assert.deepEqual((unwrapGizmo({ gizmo: { id: "c" } }) as RawGizmo).id, "c");
  assert.deepEqual((unwrapGizmo({ id: "d" }) as RawGizmo).id, "d");
});

test("resolveGizmoIsPublic: boolean wins over sharing string, else sharing==='public'", () => {
  assert.equal(resolveGizmoIsPublic({ is_public: true }), true);
  assert.equal(resolveGizmoIsPublic({ is_public: false, sharing: "public" }), false);
  assert.equal(resolveGizmoIsPublic({ sharing: "public" }), true);
  assert.equal(resolveGizmoIsPublic({ sharing: "private" }), false);
  assert.equal(resolveGizmoIsPublic({}), null);
});

test("buildGizmoRecord: normalizes wrapped fixture (+ tool tag extraction)", () => {
  const raw = readFixtureJson<unknown>("gizmo-wrapped.json");
  const rec = buildGizmoRecord(raw);
  assert.ok(rec);
  assert.equal(rec?.id, "g-abc");
  assert.equal(rec?.display_name, "Rubber Duck");
  assert.equal(rec?.display_description, "Talks back");
  assert.equal(rec?.author_id, "U42");
  assert.equal(rec?.author_name, "Alice");
  assert.equal(rec?.is_public, true);
  assert.deepEqual(rec?.tools, ["code_interpreter", "browser", "dalle"]);
  assert.deepEqual(rec?.tags, ["debug"]);
});

test("buildGizmoRecord: missing id → null", () => {
  assert.equal(buildGizmoRecord({ resource: { gizmo: {} } }), null);
});

test("buildCustomInstructionsRecord: prefers _message fields; preserves enabled boolean", () => {
  const rec = buildCustomInstructionsRecord({
    about_user_message: "I'm a dev",
    about_model_message: "Be concise",
    enabled: true,
    updated_at: 1_700_000_000,
  });
  assert.equal(rec.id, "user_custom_instructions");
  assert.equal(rec.about_user, "I'm a dev");
  assert.equal(rec.response_style, "Be concise");
  assert.equal(rec.enabled, true);
  assert.equal(rec.updated_at, new Date(1_700_000_000 * 1000).toISOString());
});

test("buildCustomInstructionsRecord: falls back to fallback keys + null enabled when absent", () => {
  const rec = buildCustomInstructionsRecord({ about_user: "legacy-a", response_style: "legacy-b" });
  assert.equal(rec.about_user, "legacy-a");
  assert.equal(rec.response_style, "legacy-b");
  assert.equal(rec.enabled, null);
});

test("buildSharedConversationRecord: null when no id / share_id", () => {
  assert.equal(buildSharedConversationRecord({}), null);
});

test("buildSharedConversationRecord: synthesizes share_url and resolves anonymous fallback", () => {
  const rec = buildSharedConversationRecord({
    share_id: "s-1",
    conversation_id: "c-1",
    title: "t",
    create_time: 1_700_000_000,
    anonymous: true,
  });
  assert.equal(rec?.id, "s-1");
  assert.equal(rec?.share_url, "https://chatgpt.com/share/s-1");
  assert.equal(rec?.anonymous, true);
});

test("buildConversationRecord: detail fields overlay list; branchCount uses mapping", () => {
  const { mapping, current_node: currentNode } = readFixtureJson<ConversationFixture>("conversation-mapping.json");
  const list: ConversationListItem = {
    id: "conv1",
    title: "list-title",
    update_time: 1_700_000_000,
    current_node: null,
  };
  const rec = buildConversationRecord(list, {
    title: "detail-title",
    update_time: 1_710_000_000,
    is_archived: true,
    workspace_id: "w-1",
    gizmo_id: "g-1",
    current_node: currentNode,
    mapping,
  });
  assert.equal(rec.title, "detail-title");
  assert.equal(rec.is_archived, true);
  assert.equal(rec.workspace_id, "w-1");
  assert.equal(rec.gizmo_id, "g-1");
  assert.equal(rec.current_node, currentNode);
  assert.equal(rec.message_count_on_current_branch, 2);
});

test("buildConversationRecord: null detail falls back to list fields", () => {
  const rec = buildConversationRecord({ id: "conv1", title: "t", update_time: 1_700_000_000 }, null);
  assert.equal(rec.title, "t");
  assert.equal(rec.is_archived, null);
  assert.equal(rec.workspace_id, null);
  assert.equal(rec.message_count_on_current_branch, null);
});

test("maxUpdateTimeIso: picks largest ISO across the list", () => {
  const convos: ConversationListItem[] = [
    { id: "a", update_time: 1_700_000_000 },
    { id: "b", update_time: 1_710_000_000 },
    { id: "c" },
  ];
  const out = maxUpdateTimeIso(convos);
  assert.equal(out, new Date(1_710_000_000 * 1000).toISOString());
});

test("maxUpdateTimeIso: empty list → null", () => {
  assert.equal(maxUpdateTimeIso([]), null);
});
