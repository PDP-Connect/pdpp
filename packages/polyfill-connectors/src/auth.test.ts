import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resolveAuth } from "./auth.ts";
import type { InteractionRequest, InteractionResponse } from "./connector-runtime.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test("env auth alias arrays return the primary credential name", async () => {
  delete process.env.YNAB_PERSONAL_ACCESS_TOKEN;
  process.env.YNAB_PAT = "pat-from-docs";

  const credentials = await resolveAuth(
    { kind: "env", required: [["YNAB_PERSONAL_ACCESS_TOKEN", "YNAB_PAT"]] },
    {
      connectorName: "ynab",
      sendInteraction: (_req: InteractionRequest): Promise<InteractionResponse> =>
        Promise.reject(new Error("unexpected interaction")),
    }
  );

  assert.deepEqual(credentials, { YNAB_PERSONAL_ACCESS_TOKEN: "pat-from-docs" });
});
