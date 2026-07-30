// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { PAGE_TARGETS, pageTargets, validatePageResponse } from "./bench.ts";

const ERROR_SHELL_PATTERN = /error shell/;
const HTML_PATTERN = /HTML/;
const HTTP_200_PATTERN = /HTTP 200/;
const MARKER_PATTERN = /marker/;

test("page targets use the current clean owner routes", () => {
  assert.deepEqual(
    PAGE_TARGETS.map((target) => target.route),
    ["/", "/sources", "/sources/add", "/explore", "/syncs", "/grants", "/connect", "/search"]
  );
  assert.equal(
    PAGE_TARGETS.some((target) => target.route.startsWith("/dashboard")),
    false
  );
  assert.deepEqual(
    pageTargets("owner-session=benchmark").map((target) => target.headers),
    Array.from({ length: PAGE_TARGETS.length }, () => ({ Cookie: "owner-session=benchmark" }))
  );
});

test("page validation accepts only the intended HTML page", () => {
  for (const target of PAGE_TARGETS) {
    assert.equal(
      validatePageResponse(target, {
        body: `<main>${target.marker}</main>`,
        contentType: "text/html; charset=utf-8",
        status: 200,
      }),
      null,
      `${target.route} must have a route-specific success assertion`
    );
  }

  const target = PAGE_TARGETS.find(({ route }) => route === "/explore");
  assert.ok(target);
  assert.match(validatePageResponse(target, { body: "", contentType: "text/html", status: 307 }), HTTP_200_PATTERN);
  assert.match(
    validatePageResponse(target, { body: "<h1>Something went wrong</h1>", contentType: "text/html", status: 200 }),
    ERROR_SHELL_PATTERN
  );
  assert.match(
    validatePageResponse(target, {
      body: '<h1 class="pdpp-heading break-words text-foreground">Jump to artifact</h1><h2>Reference server unreachable</h2>',
      contentType: "text/html",
      status: 200,
    }),
    ERROR_SHELL_PATTERN
  );
  assert.match(
    validatePageResponse(target, {
      body: "<h1>This page could not be found</h1>",
      contentType: "text/html",
      status: 200,
    }),
    ERROR_SHELL_PATTERN
  );
  assert.equal(
    validatePageResponse(target, {
      body: `<main>${target.marker}</main><script>throw new Error("This page could not be found")</script>`,
      contentType: "text/html",
      status: 200,
    }),
    null,
    "a route's bundled client error copy is not a rendered not-found shell"
  );
  assert.match(
    validatePageResponse(target, { body: "<main>other page</main>", contentType: "text/html", status: 200 }),
    MARKER_PATTERN
  );
  assert.match(
    validatePageResponse(target, { body: target.marker, contentType: "application/json", status: 200 }),
    HTML_PATTERN
  );
});
