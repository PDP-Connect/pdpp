import { getAsInternalUrl, ReferenceServerUnreachableError, withOwnerSessionCookie } from "./owner-token.ts";

const DURATION_RE = /^(\d+)(s|m|h|d)?$/i;

function asJson(body: unknown) {
  return JSON.stringify(body);
}

function readBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

function describeError(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const maybeError = body as {
      error?: string | { message?: string };
      error_description?: string;
    };
    if (typeof maybeError.error_description === "string" && maybeError.error_description) {
      return maybeError.error_description;
    }
    if (typeof maybeError.error === "string" && maybeError.error) {
      return maybeError.error;
    }
    if (
      maybeError.error &&
      typeof maybeError.error === "object" &&
      typeof maybeError.error.message === "string" &&
      maybeError.error.message
    ) {
      return maybeError.error.message;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }
  return fallback;
}

async function fetchAs(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(
      `${getAsInternalUrl()}${path}`,
      await withOwnerSessionCookie({
        cache: "no-store",
        ...init,
      })
    );
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach authorization server at ${getAsInternalUrl()}`, err);
  }
}

function parseDurationInput(value: string, label: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(DURATION_RE);
  if (!match) {
    throw new Error(`Invalid ${label} value '${trimmed}'. Use values like 30m, 60s, 2h, or 1d.`);
  }

  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = (match[2] || "s").toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
  };
  const multiplier = multipliers[unit] ?? 1;
  return amount * multiplier;
}

export async function runConnectorNow(connectorId: string) {
  const response = await fetchAs(`/_ref/connectors/${encodeURIComponent(connectorId)}/run`, {
    method: "POST",
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `run-now failed (${response.status})`));
  }
  return body;
}

export async function saveConnectorSchedule(
  connectorId: string,
  input: {
    every: string;
    jitter?: string;
    enabled: boolean;
  }
) {
  const body = {
    interval_seconds: parseDurationInput(input.every, "schedule interval"),
    enabled: input.enabled,
    ...(input.jitter?.trim() ? { jitter_seconds: parseDurationInput(input.jitter, "schedule jitter") } : {}),
  };

  const response = await fetchAs(`/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: asJson(body),
  });
  const responseBody = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(responseBody, `schedule update failed (${response.status})`));
  }
  return responseBody;
}

export async function pauseConnectorSchedule(connectorId: string) {
  const response = await fetchAs(`/_ref/connectors/${encodeURIComponent(connectorId)}/schedule/pause`, {
    method: "POST",
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `schedule pause failed (${response.status})`));
  }
  return body;
}

export async function resumeConnectorSchedule(connectorId: string) {
  const response = await fetchAs(`/_ref/connectors/${encodeURIComponent(connectorId)}/schedule/resume`, {
    method: "POST",
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `schedule resume failed (${response.status})`));
  }
  return body;
}

export async function deleteConnectorSchedule(connectorId: string) {
  const response = await fetchAs(`/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 204) {
    const body = await readBody(response);
    throw new Error(describeError(body, `schedule delete failed (${response.status})`));
  }
}
