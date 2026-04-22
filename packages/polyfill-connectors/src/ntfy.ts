/**
 * ntfy adapter — fire-and-forget push notifications to the self-hosted
 * ntfy.vivid.fish topic configured in .env.local.
 *
 * Non-blocking: failures are logged to stderr but don't throw. The operator
 * should still see inbox items locally if ntfy is down.
 */

const TRAILING_SLASH = /\/$/;

function basicAuth(
  user: string | undefined,
  pass: string | undefined
): string | undefined {
  if (!(user && pass)) {
    return;
  }
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

export interface NtfyAction {
  action: string;
  clear?: boolean;
  label: string;
  url: string;
}

export interface NtfyOptions {
  actions?: readonly NtfyAction[];
  clickUrl?: string;
  message: string;
  priority?: "default" | "low" | "high" | "urgent";
  tags?: readonly string[];
  title?: string;
}

export interface NtfyResult {
  error?: string;
  id?: string;
  ok?: boolean;
  skipped?: boolean;
  status?: number;
}

interface NtfyServerResponse {
  id?: string;
}

export async function notify(opts: NtfyOptions): Promise<NtfyResult> {
  const serverUrl = process.env.NTFY_SERVER_URL || "https://ntfy.sh";
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.error("[ntfy] NTFY_TOPIC not set; skipping notification");
    return { skipped: true };
  }

  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (opts.title) {
    headers.Title = opts.title;
  }
  if (opts.tags?.length) {
    headers.Tags = opts.tags.join(",");
  }
  if (opts.priority) {
    headers.Priority = opts.priority;
  }
  if (opts.clickUrl) {
    headers.Click = opts.clickUrl;
  }
  if (opts.actions?.length) {
    headers.Actions = opts.actions
      .map(
        (a) =>
          `${a.action}, ${a.label}, ${a.url}${a.clear ? ", clear=true" : ""}`
      )
      .join("; ");
  }
  const auth = basicAuth(process.env.NTFY_USERNAME, process.env.NTFY_PASSWORD);
  if (auth) {
    headers.Authorization = auth;
  }

  try {
    const res = await fetch(
      `${serverUrl.replace(TRAILING_SLASH, "")}/${encodeURIComponent(topic)}`,
      {
        method: "POST",
        headers,
        body: opts.message || "",
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[ntfy] ${res.status} ${body.slice(0, 120)}`);
      return { ok: false, status: res.status };
    }
    const body = (await res.json().catch(() => ({}))) as NtfyServerResponse;
    return body.id ? { ok: true, id: body.id } : { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ntfy] send failed: ${message}`);
    return { ok: false, error: message };
  }
}

export interface InboxItemNotice {
  connector_id: string;
  kind: string;
  message?: string;
}

export function notifyInboxItem(item: InboxItemNotice): Promise<NtfyResult> {
  const title = `PDPP needs you: ${item.kind}`;
  const msg =
    item.message ||
    `A connector (${item.connector_id}) is parked waiting for ${item.kind}.`;
  return notify({
    title,
    message: msg,
    tags:
      item.kind === "credentials" || item.kind === "otp"
        ? ["key"]
        : ["construction"],
    priority: "high",
  });
}

export interface OvernightSummary {
  counts?: Record<string, string | number>;
  failures?: readonly string[];
  ok: boolean;
}

export function notifyOvernightSummary({
  ok,
  counts,
  failures,
}: OvernightSummary): Promise<NtfyResult> {
  const lines: string[] = [];
  lines.push(`status: ${ok ? "green" : "attention needed"}`);
  if (counts) {
    for (const [k, v] of Object.entries(counts)) {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  if (failures?.length) {
    lines.push("");
    lines.push("Failures:");
    for (const f of failures) {
      lines.push(`  • ${f}`);
    }
  }
  return notify({
    title: ok ? "PDPP overnight: all green" : "PDPP overnight: check the logs",
    message: lines.join("\n"),
    tags: ok ? ["white_check_mark"] : ["warning"],
    priority: ok ? "default" : "high",
  });
}
