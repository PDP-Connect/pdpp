import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const ROOT_PROXY_ROUTES = ["consent", "device", "owner"] as const;

test("console exposes bare hosted-UI proxy routes", () => {
  for (const route of ROOT_PROXY_ROUTES) {
    assert.equal(
      existsSync(`apps/console/src/app/${route}/route.ts`),
      true,
      `apps/console must expose /${route}; catch-all routes do not match the bare path`
    );
  }
});

test("web exposes the same bare hosted-UI proxy routes", () => {
  for (const route of ROOT_PROXY_ROUTES) {
    assert.equal(
      existsSync(`apps/web/src/app/${route}/route.ts`),
      true,
      `apps/web must expose /${route}; keep hosted-UI root routes in sync`
    );
  }
});
