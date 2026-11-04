// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { appDirectoryEnabled } from "@/lib/site-config.ts";
import Page from "./page.tsx";

const FLAG = "NEXT_PUBLIC_PDPP_APP_DIRECTORY";

function withFlag<T>(value: string | undefined, run: () => T): T {
  const previous = process.env[FLAG];
  if (value === undefined) {
    delete process.env[FLAG];
  } else {
    process.env[FLAG] = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = previous;
    }
  }
}

test("only the value true turns the app directory on", () => {
  assert.equal(
    withFlag(undefined, () => appDirectoryEnabled()),
    false
  );
  for (const value of ["", "false", "1", "yes", "on"]) {
    assert.equal(
      withFlag(value, () => appDirectoryEnabled()),
      false,
      value
    );
  }
  for (const value of ["true", " TRUE "]) {
    assert.equal(
      withFlag(value, () => appDirectoryEnabled()),
      true,
      value
    );
  }
});

test("the page is not found when the flag is off", async () => {
  const previous = process.env[FLAG];
  delete process.env[FLAG];
  try {
    await assert.rejects(Page(), (error: unknown) => {
      const digest = (error as { digest?: string }).digest ?? "";
      return digest.includes("404") || digest.includes("NEXT_NOT_FOUND");
    });
  } finally {
    if (previous !== undefined) {
      process.env[FLAG] = previous;
    }
  }
});
