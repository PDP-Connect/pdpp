// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { publicSiteNav } from "@/lib/public-site-nav.ts";

test("the Participate menu lists /apps after the Participate page", () => {
  const participate = publicSiteNav().find((item) => item.text === "Participate");
  assert.deepEqual(
    participate?.children?.map((child) => child.link),
    ["/participate", "/apps"]
  );
});
