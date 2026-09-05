// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { type PublicSupporter, publicSupportersUrl, readPublicSupporters } from "./public-supporters.ts";

const SUPPORTER: PublicSupporter = {
  country: "United States",
  principlesVersion: "1.0",
  publicName: "Public P.",
  signedOn: "2026-09-05",
  type: "Individual",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function bundled(): Promise<readonly PublicSupporter[]> {
  return Promise.resolve([{ ...SUPPORTER, publicName: "Bundled B." }]);
}

test("readPublicSupporters uses a valid runtime register", async () => {
  let request: { init: RequestInit & { next?: { revalidate: number } }; url: string } | undefined;
  const supporters = await readPublicSupporters({
    fetch: (url, init) => {
      request = { init: init ?? {}, url };
      return Promise.resolve(response([SUPPORTER]));
    },
    now: new Date("2026-09-05T12:34:00.000Z"),
    readBundled: bundled,
  });

  assert.deepEqual(supporters, [SUPPORTER]);
  assert.equal(request?.init.next?.revalidate, 60);
  assert.equal(new URL(request?.url).searchParams.get("minute"), "29810194");
});

test("readPublicSupporters falls back when the runtime register has a non-public field", async () => {
  const supporters = await readPublicSupporters({
    fetch: async () => response([{ ...SUPPORTER, email: "private@example.test" }]),
    readBundled: bundled,
  });

  assert.deepEqual(supporters, await bundled());
});

test("readPublicSupporters falls back when the runtime request throws", async () => {
  const supporters = await readPublicSupporters({
    fetch: () => Promise.reject(new Error("network unavailable")),
    readBundled: bundled,
  });

  assert.deepEqual(supporters, await bundled());
});

test("readPublicSupporters falls back when the runtime register is not found", async () => {
  const supporters = await readPublicSupporters({
    fetch: async () => response({ message: "not found" }, 404),
    readBundled: bundled,
  });

  assert.deepEqual(supporters, await bundled());
});

test("publicSupportersUrl changes its cache-busting key each minute", () => {
  const first = new URL(publicSupportersUrl(new Date("2026-09-05T12:34:00.000Z")));
  const sameMinute = new URL(publicSupportersUrl(new Date("2026-09-05T12:34:59.999Z")));
  const nextMinute = new URL(publicSupportersUrl(new Date("2026-09-05T12:35:00.000Z")));

  assert.equal(first.searchParams.get("minute"), sameMinute.searchParams.get("minute"));
  assert.notEqual(first.searchParams.get("minute"), nextMinute.searchParams.get("minute"));
});
