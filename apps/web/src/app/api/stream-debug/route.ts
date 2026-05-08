import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_EVENTS = 50;
const MAX_ARRAY_ITEMS = 25;
const MAX_OBJECT_KEYS = 40;
const MAX_STRING_LENGTH = 512;
const MAX_DEPTH = 8;

function originMatchesHost(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }
  const host = request.headers.get("host");
  if (!host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return "[depth-limit]";
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.includes("token") || normalizedKey.includes("password") || normalizedKey.includes("secret")) {
        result[key] = "[redacted]";
        continue;
      }
      result[key] = sanitizeValue(entry, depth + 1);
    }
    return result;
  }
  return String(value);
}

export async function POST(request: Request) {
  if (!originMatchesHost(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const events = Array.isArray((payload as { events?: unknown })?.events)
    ? ((payload as { events: unknown[] }).events.slice(0, MAX_EVENTS) as unknown[])
    : [];
  if (events.length === 0) {
    return NextResponse.json({ ok: true, accepted: 0 });
  }

  const sanitized = sanitizeValue({
    events,
    receivedAt: new Date().toISOString(),
  });
  console.info("pdpp_stream_debug", JSON.stringify(sanitized));
  return NextResponse.json({ ok: true, accepted: events.length });
}
