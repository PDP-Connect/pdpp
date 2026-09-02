import assert from "node:assert/strict";
import test from "node:test";

import { defaultInteractionHandler } from "../runtime/index.ts";

/**
 * The default interaction handler prompts on stdin. That is right for the CLI
 * and wrong everywhere else: a server-hosted run has no terminal, so the prompt
 * can never be answered and the interaction sits until its timeout expires.
 *
 * The observed shape of that failure is a run whose lifetime equals the handoff
 * window almost exactly (1812s against a 1800s timeout, 2026-08-26) with no
 * notification of any kind. Read from the logs it looks like the owner was
 * asked and ignored it. In fact nobody could have seen it — there was no
 * surface to see it on.
 *
 * These tests pin the refusal, not the prompt. The prompting path needs a real
 * TTY and is exercised by using the CLI.
 */

const UNATTENDED_PREFIX_RE = /^interaction_handler_unattended:/;
const KIND_RE = /kind=manual_action/;
const REMEDY_RE = /must supply its own onInteraction handler/;
const THROWN_UNATTENDED_RE = /^Error: interaction_handler_unattended:/;

function withStdinTty<T>(isTTY: boolean | undefined, body: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: isTTY });
  const restore = (): void => {
    if (descriptor) {
      Object.defineProperty(process.stdin, "isTTY", descriptor);
      return;
    }
    Reflect.deleteProperty(process.stdin as unknown as Record<string, unknown>, "isTTY");
  };
  return body().finally(restore);
}

test("defaultInteractionHandler: refuses immediately when there is no terminal to prompt", async () => {
  await withStdinTty(undefined, async () => {
    await assert.rejects(
      defaultInteractionHandler({ kind: "manual_action", message: "approve this" } as never),
      (error: Error) => {
        assert.match(
          error.message,
          UNATTENDED_PREFIX_RE,
          "the refusal must name itself — an unnamed throw here is indistinguishable from a connector crash"
        );
        assert.match(
          error.message,
          KIND_RE,
          "the kind belongs in the message; it is what tells the reader WHICH request went unanswered"
        );
        assert.match(
          error.message,
          REMEDY_RE,
          "say what to do about it — this fires precisely when the wiring is missing"
        );
        return true;
      }
    );
  });
});

test("defaultInteractionHandler: refusal is keyed on stdin, not on stderr being writable", async () => {
  // A server-hosted run holds a perfectly good stderr for its logs while having
  // no readable stdin at all. Keying the guard on the output side would pass
  // exactly where the prompt is unanswerable, which is the whole failure.
  await withStdinTty(false, async () => {
    await assert.rejects(
      defaultInteractionHandler({ kind: "otp", message: "enter the code" } as never),
      THROWN_UNATTENDED_RE,
      "isTTY false is as unattended as isTTY undefined"
    );
  });
});
