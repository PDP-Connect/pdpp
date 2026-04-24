/**
 * Per-stream one-line summary heuristics for the cross-stream timeline
 * and search views. Keeping this table explicit (rather than deriving it
 * from manifest schemas) gives the timeline a hand-picked "identifying
 * line" per stream — the same field(s) a human would cite when skimming.
 *
 * A summary function returns a short plain-text line (already truncated
 * where appropriate). Keys match `${connectorId}::${stream}`; a fallback
 * generic function runs if no specific mapping exists.
 */
import { truncate } from './rs-client';

export type RecordData = Record<string, unknown>;
type SummaryFn = (data: RecordData) => string;

function s(v: unknown, max = 80): string {
  if (v === null || v === undefined) return '';
  const str = typeof v === 'string' ? v : JSON.stringify(v);
  return truncate(str.replace(/\s+/g, ' ').trim(), max);
}

// Looks like a bare UUID/ULID/hex id — skip these when picking a
// "human-identifying" field for a summary line.
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_FIELD = /(^|_)(id|uuid|guid|token|hash|sha)$/i;

function firstString(data: RecordData, skipKeys: string[] = ['id']): string {
  for (const [k, v] of Object.entries(data)) {
    if (skipKeys.includes(k) || ID_FIELD.test(k)) continue;
    if (typeof v !== 'string' || !v.trim()) continue;
    if (UUID_LIKE.test(v.trim())) continue;
    return s(v);
  }
  return '';
}

function connectorShortName(connectorId: string): string {
  const m = connectorId.match(/\/connectors\/([^/]+)$/);
  return m?.[1] ?? connectorId;
}

// Stream-specific summaries. Keyed by the short connector name (e.g.
// "chatgpt", "github") so we don't have to keep the full URL form in sync.
const SUMMARIES: Record<string, SummaryFn> = {
  // Messaging / chat
  'chatgpt::messages': (d) => {
    const author = s(d.author_role ?? d.role ?? d.author, 20);
    const content = s(d.content ?? d.text ?? d.message, 100);
    return [author, content].filter(Boolean).join(': ');
  },
  'chatgpt::conversations': (d) => s(d.title ?? d.name, 100),
  'chatgpt::memories': (d) => s(d.content ?? d.text ?? d.memory, 100),

  'claude-code::messages': (d) => {
    const role = s(d.role ?? d.author_role, 20);
    const text = s(d.content ?? d.text ?? d.message, 100);
    return [role, text].filter(Boolean).join(': ');
  },
  'claude-code::sessions': (d) => {
    const cwd = s(d.cwd ?? d.working_directory, 40);
    const msg = s(d.first_user_message ?? d.summary ?? d.title, 80);
    return [cwd, msg].filter(Boolean).join(' — ');
  },

  'codex::messages': (d) => {
    const role = s(d.role ?? d.author_role, 20);
    const text = s(d.content ?? d.text ?? d.message, 100);
    return [role, text].filter(Boolean).join(': ');
  },
  'codex::sessions': (d) => {
    const cwd = s(d.cwd ?? d.working_directory, 40);
    const msg = s(d.first_user_message ?? d.summary ?? d.title, 80);
    return [cwd, msg].filter(Boolean).join(' — ');
  },

  'slack::messages': (d) => {
    const who = s(d.user_id ?? d.username ?? d.user, 24);
    const text = s(d.text ?? d.content, 100);
    return [who, text].filter(Boolean).join(': ');
  },
  'slack::channels': (d) => {
    const name = s(d.name, 40);
    const purpose = s(d.purpose ?? d.topic, 80);
    return [name, purpose].filter(Boolean).join(' — ');
  },

  'gmail::messages': (d) => {
    const from = s(d.from ?? d.sender, 40);
    const subj = s(d.subject ?? d.snippet, 80);
    return [from, subj].filter(Boolean).join(' — ');
  },
  'gmail::threads': (d) => s(d.subject ?? d.snippet, 120),

  // Finance
  'ynab::transactions': (d) => {
    const amt = typeof d.amount === 'number' ? formatAmount(d.amount) : s(d.amount, 16);
    const payee = s(d.payee_name ?? d.payee, 40);
    const memo = s(d.memo ?? d.category_name, 60);
    return [amt, payee, memo].filter(Boolean).join(' — ');
  },
  'usaa::transactions': (d) => {
    const amt = typeof d.amount === 'number' ? formatAmount(d.amount) : s(d.amount, 16);
    const desc = s(d.description ?? d.memo ?? d.merchant, 80);
    return [amt, desc].filter(Boolean).join(' — ');
  },
  'ynab::months': (d) => {
    const month = s(d.month, 16);
    const income = typeof d.income === 'number' ? formatAmount(d.income) : null;
    const budgeted = typeof d.budgeted === 'number' ? formatAmount(d.budgeted) : null;
    const parts = [month];
    if (income) parts.push(`income ${income}`);
    if (budgeted) parts.push(`budgeted ${budgeted}`);
    return parts.join(' — ');
  },
  'ynab::month_categories': (d) => {
    const cat = s(d.category_name, 40);
    const group = s(d.category_group_name, 30);
    const budgeted = typeof d.budgeted === 'number' ? formatAmount(d.budgeted) : null;
    const activity = typeof d.activity === 'number' ? formatAmount(d.activity) : null;
    const name = group && cat ? `${group} / ${cat}` : cat || group;
    const amts = [budgeted && `budgeted ${budgeted}`, activity && `spent ${activity}`]
      .filter(Boolean)
      .join(', ');
    return [name, amts].filter(Boolean).join(' — ');
  },

  // Code forges
  'github::issues': (d) => {
    const repo = s(d.repository ?? d.repo ?? d.repository_full_name, 32);
    const title = s(d.title, 80);
    return [repo, title].filter(Boolean).join(' — ');
  },
  'github::pull_requests': (d) => {
    const repo = s(d.repository ?? d.repo ?? d.repository_full_name, 32);
    const title = s(d.title, 80);
    return [repo, title].filter(Boolean).join(' — ');
  },
  'github::starred': (d) => s(d.full_name ?? d.name ?? d.repository, 80),
  'github::repositories': (d) => s(d.full_name ?? d.name, 80),
  'github::gists': (d) => s(d.description ?? d.filename, 100),
};

function formatAmount(milli: number): string {
  // YNAB-style milliunits convention; usaa amounts are in dollars. We
  // heuristically format both: if |n| > 10000 assume milliunits.
  const n = Math.abs(milli) > 10000 ? milli / 1000 : milli;
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function summarize(
  connectorId: string,
  stream: string,
  data: RecordData,
): string {
  const key = `${connectorShortName(connectorId)}::${stream}`;
  const fn = SUMMARIES[key];
  if (fn) {
    const out = fn(data);
    if (out) return out;
  }
  // Fallbacks by stream name alone (generic)
  const streamLower = stream.toLowerCase();
  if (streamLower.includes('message') || streamLower.includes('chat')) {
    const author = s(data.author_role ?? data.role ?? data.from ?? data.user, 24);
    const body = s(data.content ?? data.text ?? data.message ?? data.body, 100);
    if (author || body) return [author, body].filter(Boolean).join(': ');
  }
  if (streamLower.includes('transaction')) {
    const amt =
      typeof data.amount === 'number' ? formatAmount(data.amount) : s(data.amount, 16);
    const desc = s(data.description ?? data.memo ?? data.payee_name, 80);
    if (amt || desc) return [amt, desc].filter(Boolean).join(' — ');
  }
  if (typeof data.title === 'string' && data.title.trim()) return s(data.title, 120);
  if (typeof data.name === 'string' && data.name.trim()) return s(data.name, 120);
  if (typeof data.subject === 'string' && data.subject.trim()) return s(data.subject, 120);
  if (typeof data.description === 'string' && data.description.trim()) {
    return s(data.description, 120);
  }
  // Prefer any *_name field (category_name, payee_name, etc.) before
  // falling back to the first generic string.
  for (const [k, v] of Object.entries(data)) {
    if (k === 'id' || !k.endsWith('_name')) continue;
    if (typeof v === 'string' && v.trim()) return s(v, 120);
  }
  return firstString(data) || '(no summary)';
}
