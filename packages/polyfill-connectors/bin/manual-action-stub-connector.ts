#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-scaffold: drive the streaming-target registration code path directly,
 * without the ChatGPT/Cloudflare delay or any real connector flow.
 *
 * This invokes `acquireBrowserForConnector` with a stubbed
 * StreamingTargetRegistrationHooks that records register/unregister calls
 * and reports back via stderr. Use to bisect bug B (companion_start_failed):
 *   - Did the launcher add `--remote-debugging-port=0`?
 *   - Did `DevToolsActivePort` appear?
 *   - Did `/json` return a `page` target with a `webSocketDebuggerUrl`?
 *
 * Run with the env vars Mode-A would normally pass (PDPP_RUN_ID,
 * PDPP_REFERENCE_BASE_URL, PDPP_STREAMING_REGISTRATION_TOKEN) to also
 * exercise `resolveStreamingRegistrationFromEnv`. Or pass --stub-only to
 * skip env resolution and just inject the stub directly.
 */

import { acquireBrowserForConnector } from "../src/browser-launch.ts";
import {
  type RegisterArgs,
  resolveStreamingRegistrationFromEnv,
  type StreamingTargetRegistrationHooks,
  type UnregisterArgs,
} from "../src/streaming-target-registration.ts";

async function main(): Promise<void> {
  const stubOnly = process.argv.includes("--stub-only");
  const headless = process.argv.includes("--headless");

  process.stderr.write(`[stub] starting (stubOnly=${String(stubOnly)}, headless=${String(headless)})\n`);
  process.stderr.write(`[stub] env PDPP_RUN_ID=${process.env.PDPP_RUN_ID ?? ""}\n`);
  process.stderr.write(`[stub] env PDPP_REFERENCE_BASE_URL=${process.env.PDPP_REFERENCE_BASE_URL ?? ""}\n`);
  process.stderr.write(
    `[stub] env PDPP_STREAMING_REGISTRATION_TOKEN.len=${String((process.env.PDPP_STREAMING_REGISTRATION_TOKEN || "").length)}\n`
  );

  let registration: StreamingTargetRegistrationHooks;
  if (stubOnly) {
    registration = {
      runId: `stub_run_${String(Date.now())}`,
      register: (args: RegisterArgs): Promise<boolean> => {
        process.stderr.write(
          `[stub] register called: runId=${args.runId} interactionId=${args.interactionId} wsUrl=${args.wsUrl}\n`
        );
        return Promise.resolve(true);
      },
      unregister: (args: UnregisterArgs): Promise<boolean> => {
        process.stderr.write(`[stub] unregister called: runId=${args.runId} interactionId=${args.interactionId}\n`);
        return Promise.resolve(true);
      },
    };
  } else {
    const real = await resolveStreamingRegistrationFromEnv();
    if (!real) {
      process.stderr.write("[stub] resolveStreamingRegistrationFromEnv returned undefined; aborting.\n");
      process.exit(2);
    }
    // Wrap to log what real client returned, but still attempt the real POST.
    const innerRegister = real.register;
    const innerUnregister = real.unregister;
    registration = {
      runId: real.runId,
      register: async (args: RegisterArgs): Promise<boolean> => {
        process.stderr.write(
          `[stub] register attempting: runId=${args.runId} interactionId=${args.interactionId} wsUrl=${args.wsUrl}\n`
        );
        const ok = await innerRegister(args);
        process.stderr.write(`[stub] register result: ok=${String(ok)}\n`);
        return ok;
      },
      unregister: async (args: UnregisterArgs): Promise<boolean> => {
        process.stderr.write(`[stub] unregister attempting: runId=${args.runId} interactionId=${args.interactionId}\n`);
        const ok = await innerUnregister(args);
        process.stderr.write(`[stub] unregister result: ok=${String(ok)}\n`);
        return ok;
      },
    };
  }

  process.stderr.write("[stub] calling acquireBrowserForConnector ...\n");
  const noStreaming = process.argv.includes("--no-streaming");
  const acquired = await acquireBrowserForConnector({
    profileName: "manual-action-stub",
    headless,
    ...(noStreaming ? {} : { streamingRegistration: registration }),
  });
  process.stderr.write("[stub] browser acquired, sleeping 3s for steady state\n");
  await new Promise((r) => setTimeout(r, 3000));
  process.stderr.write("[stub] releasing\n");
  await acquired.release();
  process.stderr.write("[stub] done\n");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`[stub] FATAL: ${message}\n`);
  process.exit(1);
});
