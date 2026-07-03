import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "./next.config.mjs";

const redirects = await nextConfig.redirects();

function matchRule(rule, pathname) {
  const { source, destination } = rule;

  if (source.endsWith("/:rest*")) {
    const prefix = source.slice(0, -"/:rest*".length);
    if (pathname === prefix) {
      return destination.replace("/:rest*", "").replace(":rest*", "") || "/";
    }
    if (pathname.startsWith(`${prefix}/`)) {
      const rest = pathname.slice(prefix.length + 1);
      return destination.replace(":rest*", rest).replace(/\/$/, "") || "/";
    }
    return null;
  }

  return pathname === source ? destination : null;
}

function resolve(pathname) {
  for (const rule of redirects) {
    const destination = matchRule(rule, pathname);
    if (destination !== null) {
      return { destination, permanent: rule.permanent === true };
    }
  }
  return null;
}

const REMOVED_DASHBOARD_PATHS = [
  "/dashboard",
  "/dashboard/records",
  "/dashboard/records/gmail",
  "/dashboard/runs",
  "/dashboard/runs/run_42",
  "/dashboard/runs/run_42/stream",
  "/dashboard/traces",
  "/dashboard/explore",
  "/dashboard/grants",
  "/dashboard/connect",
  "/dashboard/deployment/tokens",
  "/dashboard/timeline",
];

test("legacy /dashboard routes are not preserved as redirects", () => {
  for (const path of REMOVED_DASHBOARD_PATHS) {
    assert.equal(resolve(path), null, `${path} must not redirect to a replacement route`);
  }
});

test("redirect table does not recognize the removed /dashboard prefix", () => {
  for (const rule of redirects) {
    assert.ok(!rule.source.startsWith("/dashboard"), `removed legacy source remains: ${rule.source}`);
    assert.ok(!rule.destination.startsWith("/dashboard"), `removed legacy target remains: ${rule.destination}`);
  }
});

test("non-dashboard redirects still work", () => {
  assert.equal(resolve("/favicon.ico")?.destination, "/brand/pdpp-favicon.svg");
});
