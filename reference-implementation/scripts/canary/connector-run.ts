// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * canary/connector-run
 *
 * Triggers one connector run through the owner API and waits for it to reach
 * a terminal state.
 *
 * Why a triggered run is worth the trouble
 * ---------------------------------------
 * SQL counters and restart counts prove the process did not crash. They do
 * NOT prove the thing the owner actually cares about — that a connector can
 * still complete a run end to end. A Slack run was structurally impossible
 * before today's undici fix while every counter looked healthy, so a
 * liveness check that exercises the real path is the difference between
 * "nothing got worse" and "it works".
 *
 * The cost, and the gate
 * ----------------------
 * Six connectors dispatch a real one-time password to the owner's phone when
 * a run starts. Those codes are finite, rate-limited, and land on a human's
 * lock screen; one was burned today when a crash killed a run 49 seconds
 * after the code arrived. `manifest.ts` rejects those connectors at PARSE
 * time, and `triggerConnectorRun` re-checks the slug here before issuing the
 * request. The duplication is deliberate: this function is the last point
 * before a real text message is sent, and a check at the boundary of an
 * irreversible side effect should not rely on a caller having validated.
 */

import { isOtpDenylisted, OTP_DENYLISTED_CONNECTORS } from "./manifest.ts";

/** Matches `<input name="_csrf" ... value="...">` (attribute order: name first). */
const CSRF_INPUT_NAME_FIRST_PATTERN = /name=["']_csrf["'][^>]*value=["']([^"']+)["']/u;
/** Matches the same hidden input when the form emits `value` before `name`. */
const CSRF_INPUT_VALUE_FIRST_PATTERN = /value=["']([^"']+)["'][^>]*name=["']_csrf["']/u;

export interface RunOutcome {
  readonly detail: string;
  readonly runId: string | null;
  readonly status: string;
}

interface Session {
  readonly cookie: string;
  readonly csrf: string;
}

/**
 * Accumulates cookies across the login redirect chain. The owner session and
 * the CSRF token arrive in separate responses, so a single jar must span both.
 */
function mergeCookies(existing: string, response: Response): string {
  const jar = new Map<string, string>();
  for (const entry of existing.split("; ")) {
    const separator = entry.indexOf("=");
    if (separator > 0) {
      jar.set(entry.slice(0, separator), entry.slice(separator + 1));
    }
  }
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0) {
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Extracts the `_csrf` hidden input the login form requires. */
export function extractCsrf(html: string): string | null {
  const match = CSRF_INPUT_NAME_FIRST_PATTERN.exec(html) ?? CSRF_INPUT_VALUE_FIRST_PATTERN.exec(html);
  return match?.[1] ?? null;
}

async function login(origin: string, password: string): Promise<Session> {
  const loginUrl = `${origin}/owner/login`;
  const page = await fetch(loginUrl, { redirect: "manual" });
  const cookie = mergeCookies("", page);
  const csrf = extractCsrf(await page.text());
  if (!csrf) {
    throw new Error("could not scrape _csrf from the login page");
  }

  const body = new URLSearchParams({ _csrf: csrf, password });
  const response = await fetch(loginUrl, {
    body,
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    method: "POST",
    redirect: "manual",
  });
  if (response.status >= 400) {
    throw new Error(`owner login failed with status ${response.status}`);
  }
  return { cookie: mergeCookies(cookie, response), csrf };
}

/**
 * Triggers a run and polls until it terminates or `timeoutSeconds` elapses.
 *
 * A timeout is reported as its own status rather than a failure: an
 * unfinished run is an unknown, and calling an unknown a failure is the same
 * dishonesty in the other direction.
 */
export async function triggerConnectorRun(options: {
  readonly origin: string;
  readonly password: string;
  readonly connectionId: string;
  readonly connectorSlug: string;
  readonly timeoutSeconds: number;
  readonly pollIntervalMs?: number;
}): Promise<RunOutcome> {
  // Last gate before an irreversible side effect (a real OTP text message).
  if (isOtpDenylisted(options.connectorSlug)) {
    throw new Error(
      `refusing to trigger '${options.connectorSlug}': OTP-denylisted (${OTP_DENYLISTED_CONNECTORS.join(", ")}). Triggering it sends a real one-time password to the owner's phone.`
    );
  }

  const session = await login(options.origin, options.password);
  const response = await fetch(`${options.origin}/_ref/connections/${options.connectionId}/run`, {
    body: "{}",
    headers: {
      "content-type": "application/json",
      cookie: session.cookie,
      "x-csrf-token": session.csrf,
    },
    method: "POST",
  });
  if (response.status >= 400) {
    return { detail: `POST /run returned ${response.status}`, runId: null, status: "trigger_failed" };
  }

  const triggered: unknown = await response.json().catch(() => null);
  const runId =
    triggered && typeof triggered === "object"
      ? ((triggered as Record<string, unknown>).run_id ?? (triggered as Record<string, unknown>).runId)
      : null;
  if (typeof runId !== "string" || runId.length === 0) {
    return { detail: "response contained no run id", runId: null, status: "trigger_failed" };
  }

  const deadline = Date.now() + options.timeoutSeconds * 1000;
  const interval = options.pollIntervalMs ?? 10_000;
  const terminal = new Set(["succeeded", "failed", "cancelled", "abandoned", "skipped"]);
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const poll = await fetch(`${options.origin}/_ref/runs/${runId}`, {
      headers: { cookie: session.cookie },
    });
    if (poll.status >= 400) {
      continue;
    }
    const payload: unknown = await poll.json().catch(() => null);
    const status = payload && typeof payload === "object" ? (payload as Record<string, unknown>).status : null;
    if (typeof status === "string") {
      lastStatus = status;
      if (terminal.has(status)) {
        return { detail: `run ${runId} reached ${status}`, runId, status };
      }
    }
  }
  return {
    detail: `run ${runId} still ${lastStatus} after ${options.timeoutSeconds}s`,
    runId,
    status: "timeout",
  };
}
