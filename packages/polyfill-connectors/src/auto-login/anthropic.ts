// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Anthropic/Claude.ai session readiness.
 *
 * Claude.ai auth is expected to live in the connector's browser profile. When
 * it is absent, hand the browser surface to the owner and poll session evidence
 * until the profile is signed in. There is no "I've signed in" interaction:
 * readiness is proven only by connector-owned session probes.
 */

import type { Page } from "playwright";
import type { AssistanceCompletionStatus, AssistanceRequest, SessionCheckpointFn } from "../connector-runtime.ts";
import type { CaptureSession } from "../fixture-capture.ts";

export const ANTHROPIC_BROWSER_LOGIN_ASSISTANCE_MESSAGE =
  "Sign in to Claude in the secure browser. PDPP will continue automatically after Claude confirms the session.";

const ANTHROPIC_HOME_URL = "https://claude.ai/";
const BROWSER_LOGIN_POLL_INTERVAL_MS = 5000;
const BROWSER_LOGIN_DEFAULT_TIMEOUT_MS = 1_800_000;
const BROWSER_LOGIN_TIMEOUT_ENV = "PDPP_ANTHROPIC_BROWSER_LOGIN_TIMEOUT_MS";

interface EnsureAnthropicSessionArgs {
  assist: (req: AssistanceRequest) => Promise<string>;
  capture?: CaptureSession | null;
  checkpoint?: SessionCheckpointFn;
  completeAssistance: (
    assistanceRequestId: string,
    status: AssistanceCompletionStatus,
    extra?: { message?: string }
  ) => Promise<void>;
  page: Page;
  probe: () => Promise<boolean>;
  progress?: (message: string) => Promise<void>;
}

export function resolveAnthropicBrowserLoginTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[BROWSER_LOGIN_TIMEOUT_ENV]?.trim();
  if (!raw) {
    return BROWSER_LOGIN_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!(Number.isFinite(parsed) && parsed > 0)) {
    return BROWSER_LOGIN_DEFAULT_TIMEOUT_MS;
  }
  return parsed;
}

export function anthropicBrowserLoginAssistance(env: NodeJS.ProcessEnv = process.env): AssistanceRequest {
  return {
    attachments: [{ kind: "browser_surface", role: "streaming_companion" }],
    message: ANTHROPIC_BROWSER_LOGIN_ASSISTANCE_MESSAGE,
    owner_action: "operate_attachment",
    progress_posture: "blocked",
    response_contract: "none",
    sensitivity: "non_secret",
    timeout_seconds: Math.ceil(resolveAnthropicBrowserLoginTimeoutMs(env) / 1000),
  };
}

function browserLoginPollAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Math.ceil(resolveAnthropicBrowserLoginTimeoutMs(env) / BROWSER_LOGIN_POLL_INTERVAL_MS));
}

export async function waitForAnthropicSessionReadiness({
  attempts = browserLoginPollAttempts(),
  checkpoint,
  intervalMs = BROWSER_LOGIN_POLL_INTERVAL_MS,
  probe,
  wait,
}: {
  attempts?: number;
  checkpoint?: SessionCheckpointFn;
  intervalMs?: number;
  probe: () => Promise<boolean>;
  wait: (ms: number) => Promise<void>;
}): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await checkpoint?.("anthropic-browser-login-poll");
    if (await probe()) {
      return true;
    }
    await wait(intervalMs);
  }
  return false;
}

export async function ensureAnthropicSession({
  assist,
  capture,
  checkpoint,
  completeAssistance,
  page,
  probe,
  progress,
}: EnsureAnthropicSessionArgs): Promise<void> {
  await checkpoint?.("anthropic-session-probe");
  if (await probe()) {
    return;
  }

  await page
    .goto(ANTHROPIC_HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch((): undefined => undefined);
  await capture?.captureDom(page, "anthropic-login-required").catch((): undefined => undefined);
  const assistanceRequestId = await assist(anthropicBrowserLoginAssistance());
  await checkpoint?.("anthropic-browser-login-requested");
  await progress?.(ANTHROPIC_BROWSER_LOGIN_ASSISTANCE_MESSAGE);

  const ready = await waitForAnthropicSessionReadiness({
    ...(checkpoint ? { checkpoint } : {}),
    probe,
    wait: (ms) => page.waitForTimeout(ms),
  });
  if (ready) {
    await completeAssistance(assistanceRequestId, "resolved", {
      message: "Claude login completed and the connector is continuing.",
    });
    await progress?.("Claude login completed; continuing collection.");
    return;
  }

  await completeAssistance(assistanceRequestId, "escalated", {
    message: "Claude login did not complete before the connector's bounded wait expired.",
  });
  throw new Error("anthropic_session_required: Claude session was not ready before the bounded login wait expired");
}
