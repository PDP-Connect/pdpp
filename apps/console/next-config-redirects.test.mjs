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

test("configured redirects resolve correctly", () => {
  assert.equal(resolve("/favicon.ico")?.destination, "/brand/pdpp-favicon.svg");
});
