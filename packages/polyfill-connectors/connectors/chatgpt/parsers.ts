// Pure parsers for the ChatGPT connector. Kept free of Playwright / network
// I/O so they can be unit-tested in isolation (see parsers.test.ts). The
// browser-context auth, API client, and the collect() orchestrator live in
// index.ts.

import type { RecordData } from "../../src/connector-runtime.ts";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import type {
  ChatGptContent,
  ChatGptMessage,
  ChatGptNode,
  ConversationListItem,
  RawCustomInstructionsBody,
  RawGizmo,
  RawGizmoWrapper,
  RawMemoryEntry,
  RawSharedConversation,
  ToolCallSynthetic,
} from "./types.ts";

// ─── Time normalisation ────────────────────────────────────────────────

/**
 * ChatGPT times are unix seconds (number). Some responses use ISO strings.
 * Normalize both to ISO-8601; swallow malformed inputs.
 */
export function tsToIso(v: unknown): string | null {
  if (v == null) {
    return null;
  }
  try {
    if (typeof v === "number" && Number.isFinite(v)) {
      const d = new Date(v * 1000);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (typeof v === "string") {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
  } catch {
    /* swallow */
  }
  return null;
}

// ─── Conversation tree walk ────────────────────────────────────────────

export interface FlattenedNode {
  node: ChatGptNode;
  nodeId: string;
}

/**
 * Walk the conversation tree from `currentNodeId` up to the root, then
 * reverse so the returned list is ordered root→tip along the current branch.
 */
export function flattenTreeCurrentBranch(
  mapping: Record<string, ChatGptNode>,
  currentNodeId: string | null | undefined
): FlattenedNode[] {
  const orderedRootToTip: string[] = [];
  let id: string | null | undefined = currentNodeId;
  const visited = new Set<string>();
  while (id && !visited.has(id) && mapping[id]) {
    visited.add(id);
    orderedRootToTip.push(id);
    id = mapping[id]?.parent ?? null;
  }
  orderedRootToTip.reverse();
  return orderedRootToTip.map((nodeId) => {
    const node = mapping[nodeId];
    if (!node) {
      // visited.has + mapping[id] guard above guarantees presence.
      throw new Error(`flattenTreeCurrentBranch: missing node ${nodeId}`);
    }
    return { nodeId, node };
  });
}

// ─── extractContent per-content_type helpers ──────────────────────────

/**
 * Stringify one `parts[]` entry from text / multimodal_text bodies. Returns
 * "" for unknown shapes so the caller can filter them out via `.filter(Boolean)`.
 */
function stringifyContentPart(p: unknown): string {
  if (typeof p === "string") {
    return p;
  }
  if (p && typeof p === "object") {
    const po = p as {
      asset_pointer?: unknown;
      content_type?: unknown;
      text?: unknown;
    };
    if (typeof po.text === "string") {
      return po.text;
    }
    if (typeof po.asset_pointer === "string") {
      return `[asset:${po.asset_pointer}]`;
    }
    if (typeof po.content_type === "string") {
      return `[${po.content_type}]`;
    }
  }
  return "";
}

/** Canonical user/assistant text: `{ parts: ["...", {asset_pointer}...] }`. */
function extractTextContent(content: ChatGptContent): string | null {
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const s = parts.map(stringifyContentPart).join("\n").trim();
  return s || null;
}

/**
 * Multimodal variant: same part-stringifier, but filter empties before joining
 * (a `{content_type: "image_asset_pointer"}` entry without an asset_pointer or
 * text yields "" which we drop here).
 */
function extractMultimodalContent(content: ChatGptContent): string | null {
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const s = parts.map(stringifyContentPart).filter(Boolean).join("\n").trim();
  return s || null;
}

/** Assistant-authored tool call bodies: `{ content_type: "code", language, text }`. */
function extractCodeContent(content: ChatGptContent): string | null {
  const body = typeof content.text === "string" ? content.text : "";
  const lang = content.language ? String(content.language) : "";
  if (!(body || lang)) {
    return null;
  }
  return lang ? `\`\`\`${lang}\n${body}\n\`\`\`` : body;
}

/**
 * Reasoning summaries (GPT-5 thinking traces):
 * `{ content_type: "thoughts", thoughts: [{summary, content}], source_analysis_msg_id? }`.
 */
function extractThoughtsContent(content: ChatGptContent): string | null {
  const thoughts = Array.isArray(content.thoughts) ? content.thoughts : [];
  const s = thoughts.map(stringifyThought).filter(Boolean).join("\n\n").trim();
  return s || null;
}

function stringifyThought(t: unknown): string {
  if (!t || typeof t !== "object") {
    return "";
  }
  const to = t as { content?: unknown; summary?: unknown };
  const summary = typeof to.summary === "string" ? to.summary : "";
  const body = typeof to.content === "string" ? to.content : "";
  if (summary && body) {
    return `${summary}\n${body}`;
  }
  return summary || body || "";
}

/** `{ content_type: "reasoning_recap", content: "..." }` (some variants use `text`). */
function extractReasoningRecap(content: ChatGptContent): string | null {
  if (typeof content.content === "string") {
    return content.content || null;
  }
  if (typeof content.text === "string") {
    return content.text || null;
  }
  return null;
}

/** `{ content_type: "tether_browsing_display", result, summary, ... }`. */
function extractTetherBrowsingDisplay(content: ChatGptContent): string | null {
  const pieces: string[] = [];
  if (typeof content.summary === "string" && content.summary) {
    pieces.push(content.summary);
  }
  if (typeof content.result === "string" && content.result) {
    pieces.push(content.result);
  }
  const s = pieces.join("\n\n").trim();
  return s || null;
}

/** `{ content_type: "tether_quote", url, domain?, text, title }`. */
function extractTetherQuote(content: ChatGptContent): string | null {
  const pieces: string[] = [];
  if (content.title) {
    pieces.push(String(content.title));
  }
  if (content.url) {
    pieces.push(String(content.url));
  }
  if (typeof content.text === "string" && content.text) {
    pieces.push(content.text);
  }
  const s = pieces.join("\n").trim();
  return s || null;
}

/** Python / code-interpreter stdout: `{ content_type: "execution_output", text }`. */
function extractExecutionOutput(content: ChatGptContent): string | null {
  if (typeof content.text === "string") {
    return content.text || null;
  }
  return null;
}

/**
 * "Bio"/memory + custom instructions + connected-repo context:
 * `{ content_type: "model_editable_context", model_set_context, repository?, repo_summary? }`.
 */
function extractModelEditableContext(content: ChatGptContent): string | null {
  const pieces: string[] = [];
  if (typeof content.model_set_context === "string" && content.model_set_context) {
    pieces.push(content.model_set_context);
  }
  if (typeof content.repository === "string" && content.repository) {
    pieces.push(`repository: ${content.repository}`);
  }
  if (typeof content.repo_summary === "string" && content.repo_summary) {
    pieces.push(content.repo_summary);
  }
  const s = pieces.join("\n\n").trim();
  return s || null;
}

/** Observed but undocumented: system-level error shape. */
function extractSystemError(content: ChatGptContent): string | null {
  const pieces: string[] = [];
  if (content.name) {
    pieces.push(String(content.name));
  }
  if (typeof content.text === "string" && content.text) {
    pieces.push(content.text);
  }
  return pieces.join(": ").trim() || null;
}

/** User custom-instructions shape (observed on imported conversations). */
function extractUserEditableContext(content: ChatGptContent): string | null {
  const pieces: string[] = [];
  if (typeof content.user_profile === "string" && content.user_profile) {
    pieces.push(content.user_profile);
  }
  if (typeof content.user_instructions === "string" && content.user_instructions) {
    pieces.push(content.user_instructions);
  }
  return pieces.join("\n\n").trim() || null;
}

// Fallback for unrecognized shape — prefer an explicit handler. Stringify so
// *something* lands rather than null; truncate to keep rows sane.
const FALLBACK_MAX_CHARS = 5000;

function extractFallback(content: ChatGptContent): string | null {
  try {
    const s = JSON.stringify(content);
    if (!s || s === "{}" || s === "null") {
      return null;
    }
    return s.length > FALLBACK_MAX_CHARS ? `${s.slice(0, FALLBACK_MAX_CHARS)}…` : s;
  } catch {
    return null;
  }
}

// Dispatch table keeps extractContent a tiny switch-by-lookup: the many
// per-content_type branches live as named helpers above.
const CONTENT_EXTRACTORS: Readonly<Record<string, (c: ChatGptContent) => string | null>> = {
  code: extractCodeContent,
  execution_output: extractExecutionOutput,
  model_editable_context: extractModelEditableContext,
  multimodal_text: extractMultimodalContent,
  reasoning_recap: extractReasoningRecap,
  system_error: extractSystemError,
  tether_browsing_display: extractTetherBrowsingDisplay,
  tether_quote: extractTetherQuote,
  text: extractTextContent,
  thoughts: extractThoughtsContent,
  user_editable_context: extractUserEditableContext,
};

function toSafeFullContent(s: string | null): string | null {
  if (s === null) {
    return null;
  }
  return pdppSafeText.safeParse(s).success ? s : null;
}

/**
 * Extract a string from a ChatGPT message content object. ChatGPT has many
 * content_type shapes; the previous implementation only handled `text` and
 * silently returned null for everything else (67% of records). Each branch
 * returns a string; we return null only if the payload is truly empty.
 */
export function extractContent(content: ChatGptContent | undefined): string | null {
  if (!content || typeof content !== "object") {
    return null;
  }
  const type = content.content_type;
  const handler = type ? CONTENT_EXTRACTORS[type] : undefined;
  const raw = handler ? handler(content) : extractFallback(content);
  return toSafeFullContent(raw);
}

// ─── Tool calls ─────────────────────────────────────────────────────────

/**
 * Derive tool_calls for a message. ChatGPT does not emit an OpenAI-API-style
 * `tool_calls` array on assistant messages; instead, the model "addresses" a
 * tool via `message.recipient` (e.g. "python", "browser.search", "bio") and
 * the content body carries the call. Synthesize a normalized array.
 */
export function extractToolCalls(m: ChatGptMessage | undefined): unknown[] {
  // Some API shapes do include an explicit list.
  if (Array.isArray(m?.metadata?.tool_calls) && m.metadata.tool_calls.length) {
    return m.metadata.tool_calls;
  }
  const recipient = typeof m?.recipient === "string" ? m.recipient : null;
  const role = m?.author?.role;
  // Assistant messages addressed to a specific tool = a tool call.
  if (role === "assistant" && recipient && recipient !== "all") {
    const call: ToolCallSynthetic = { recipient };
    if (m?.content?.content_type) {
      call.content_type = m.content.content_type;
    }
    if (typeof m?.content?.language === "string") {
      call.language = m.content.language;
    }
    if (typeof m?.content?.text === "string") {
      call.text = m.content.text;
    }
    if (m?.metadata?.invoked_plugin) {
      call.invoked_plugin = m.metadata.invoked_plugin;
    }
    return [call];
  }
  // Plugin invocation metadata without an explicit tool_calls array.
  if (m?.metadata?.invoked_plugin) {
    return [{ invoked_plugin: m.metadata.invoked_plugin }];
  }
  return [];
}

// ─── Message record ─────────────────────────────────────────────────────

export function extractMessage(
  nodeId: string,
  node: ChatGptNode,
  conversationId: string,
  onCurrentBranch: boolean
): RecordData | null {
  const m = node.message;
  if (!m) {
    return null;
  }
  const content = extractContent(m.content);
  return {
    id: nodeId,
    conversation_id: conversationId,
    parent_id: node.parent ?? null,
    children_ids: node.children ?? [],
    role: m.author?.role ?? null,
    content: content || null,
    content_type: m.content?.content_type ?? null,
    model_slug: m.metadata?.model_slug ?? null,
    create_time: tsToIso(m.create_time),
    finish_reason: m.end_turn === false ? "tool_calls" : (m.metadata?.finish_details?.type ?? null),
    citations: m.metadata?.citations ?? [],
    tool_calls: extractToolCalls(m),
    attachment_ids: (m.metadata?.attachments ?? []).map((a) => a.id).filter(Boolean),
    on_current_branch: onCurrentBranch,
  };
}

// ─── Memories ───────────────────────────────────────────────────────────

export function buildMemoryRecord(m: RawMemoryEntry): RecordData | null {
  if (m.id == null) {
    return null;
  }
  return {
    id: m.id,
    content: m.content || m.name || "",
    created_at: m.created_at || null,
    updated_at: m.updated_at || null,
  };
}

// ─── Custom GPTs (gizmos) ───────────────────────────────────────────────

/**
 * /gizmos/mine returns one of several wrapper shapes per item:
 *   { resource: { gizmo: {...} } }   (newer)
 *   { resource: {...} }              (some tenants)
 *   { gizmo: {...} }                 (rarer)
 *   {...} flat                        (oldest)
 * Normalize all four into a bare gizmo object.
 */
export function unwrapGizmo(raw: unknown): RawGizmo | null {
  const rawObj = raw as RawGizmoWrapper | null | undefined;
  if (!rawObj || typeof rawObj !== "object") {
    return null;
  }
  const resourceGizmo = (rawObj.resource as { gizmo?: unknown } | null | undefined)?.gizmo;
  const resourceFlat = rawObj.resource as unknown;
  const direct = rawObj.gizmo;
  const picked = resourceGizmo ?? direct ?? resourceFlat ?? raw;
  if (!picked || typeof picked !== "object") {
    return null;
  }
  return picked as RawGizmo;
}

/** Pick `is_public` from the boolean flag or from the string `sharing` enum. */
export function resolveGizmoIsPublic(g: RawGizmo): boolean | null {
  if (typeof g.is_public === "boolean") {
    return g.is_public;
  }
  if (typeof g.sharing === "string") {
    return g.sharing === "public";
  }
  return null;
}

/** Normalize an entry in gizmo.config.tools to a string tag (or null to drop). */
function toolTagOf(t: unknown): string | null {
  if (typeof t === "string") {
    return t;
  }
  const to = t as { name?: unknown; type?: unknown };
  return (to?.type || to?.name || null) as string | null;
}

export function buildGizmoRecord(raw: unknown): RecordData | null {
  const g = unwrapGizmo(raw);
  if (!g?.id) {
    return null;
  }
  const display = g.display || {};
  const config = g.config || {};
  const author = g.author || g.owner || {};
  const toolsRaw = Array.isArray(config.tools) ? config.tools : [];
  const tools = toolsRaw.map(toolTagOf).filter(Boolean);
  const tagsRaw = g.tags || display.tags || [];
  return {
    id: g.id,
    short_url: g.short_url || g.shortcode || null,
    display_name: display.name || g.name || null,
    display_description: display.description || null,
    display_welcome_message: display.welcome_message || null,
    instructions: config.instructions || g.instructions || null,
    tools,
    created_at: tsToIso(g.created_at ?? g.create_time),
    updated_at: tsToIso(g.updated_at ?? g.update_time),
    author_id: author.user_id || author.id || null,
    author_name: author.display_name || author.name || null,
    is_public: resolveGizmoIsPublic(g),
    category: g.category || display.category || null,
    tags: Array.isArray(tagsRaw) ? tagsRaw : [],
  };
}

// ─── Custom instructions ────────────────────────────────────────────────

export function buildCustomInstructionsRecord(j: RawCustomInstructionsBody | null | undefined): RecordData {
  const body = j || {};
  return {
    id: "user_custom_instructions",
    about_user: body.about_user_message ?? body.about_user ?? null,
    response_style: body.about_model_message ?? body.response_style ?? null,
    enabled: typeof body.enabled === "boolean" ? body.enabled : null,
    updated_at: tsToIso(body.updated_at ?? body.update_time_detail),
  };
}

// ─── Shared conversations ──────────────────────────────────────────────

function resolveSharedAnonymous(s: RawSharedConversation): boolean | null {
  if (typeof s.is_anonymous === "boolean") {
    return s.is_anonymous;
  }
  if (typeof s.anonymous === "boolean") {
    return s.anonymous;
  }
  return null;
}

export function buildSharedConversationRecord(s: RawSharedConversation): RecordData | null {
  const shareId = s.id || s.share_id;
  if (!shareId) {
    return null;
  }
  return {
    id: shareId,
    conversation_id: s.conversation_id || null,
    share_url: s.share_url || `https://chatgpt.com/share/${shareId}`,
    title: s.title || null,
    created_at: tsToIso(s.create_time ?? s.created_at),
    anonymous: resolveSharedAnonymous(s),
    is_public: typeof s.is_public === "boolean" ? s.is_public : null,
    highlighted_text: s.highlighted_text || null,
  };
}

// ─── Conversations ──────────────────────────────────────────────────────

export interface ConversationDetail {
  create_time?: number | string | null;
  current_node?: string | null;
  gizmo_id?: string | null;
  is_archived?: boolean | null;
  is_starred?: boolean | null;
  mapping?: Record<string, ChatGptNode> | null;
  title?: string | null;
  update_time?: number | string | null;
  workspace_id?: string | null;
}

/**
 * Count the messages on the conversation's current branch (i.e. excluding
 * off-branch alternatives). Returns null when we have no detail mapping.
 */
export function countBranchMessages(
  mapping: Record<string, ChatGptNode> | null | undefined,
  currentNode: string | null | undefined
): number | null {
  if (!(mapping && currentNode)) {
    return null;
  }
  return flattenTreeCurrentBranch(mapping, currentNode).filter((x) => x.node?.message?.author?.role).length;
}

/**
 * Merge the list-endpoint and detail-endpoint views into a single conversation
 * record. Fields that only appear on detail (gizmo_id, workspace_id,
 * current_node, message_count_on_current_branch) fall back to list when
 * `detail` is null (conversations-only sync path).
 */
export function buildConversationRecord(c: ConversationListItem, detail: ConversationDetail | null): RecordData {
  const mapping = detail?.mapping || null;
  const currentNode = detail?.current_node ?? c.current_node ?? null;
  return {
    id: c.id,
    title: (detail?.title ?? c.title) || null,
    create_time: tsToIso(detail?.create_time ?? c.create_time),
    update_time: tsToIso(detail?.update_time ?? c.update_time),
    is_archived: detail?.is_archived ?? c.is_archived ?? null,
    is_starred: detail?.is_starred ?? c.is_starred ?? null,
    workspace_id: (detail?.workspace_id ?? c.workspace_id) || null,
    current_node: currentNode || null,
    message_count_on_current_branch: countBranchMessages(mapping, currentNode),
    gizmo_id: (detail?.gizmo_id ?? c.gizmo_id) || null,
  };
}

/**
 * Pick the largest ISO update_time across conversations. Used when committing
 * the conversations cursor at the end of a run.
 */
export function maxUpdateTimeIso(items: readonly ConversationListItem[]): string | null {
  return (
    items
      .map((c) => (c.update_time ? tsToIso(c.update_time) : null))
      .filter((x): x is string => Boolean(x))
      .sort()
      .pop() ?? null
  );
}
