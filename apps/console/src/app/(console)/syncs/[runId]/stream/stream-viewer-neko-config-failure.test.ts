import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const VIEWER_FILE = fileURLToPath(new URL("./stream-viewer.tsx", import.meta.url));

const LOADS_CONFIG_WITH_RETRY_HELPER =
  /const payload = \(await fetchNekoClientConfigResponse\(clientConfigPath\)\) as NekoClientConfigResponse;/;
const CONFIG_LOAD_CATCH_SETS_INLINE_ERROR =
  /\.catch\(\(err: unknown\) => \{\s+if \(!cancelled\) \{\s+setError\(err instanceof Error \? err\.message : "n\.eko direct stream failed"\);/;
const INLINE_ERROR_PANEL = /The n\.eko WebRTC stream did not attach\./;
const INLINE_RETRY_BUTTON = /Retry secure browser/;
const RETRY_RELOADS_CONFIG = /setConfigLoadRetryEpoch\(\(epoch\) => epoch \+ 1\)/;
const THROW_RE = /\bthrow\b/;

test("neko config fetch failures render inline trouble with retry instead of throwing to the page boundary", async () => {
  const src = await readFile(VIEWER_FILE, "utf8");
  const loadStart = src.indexOf("const connection = loadNekoClientConfig(session.clientConfigPath)");
  const loadEnd = src.indexOf("return () => {", loadStart);

  assert.notEqual(loadStart, -1, "NekoSurface should load the remote browser config in an effect");
  assert.notEqual(loadEnd, -1, "NekoSurface config-load effect should have a cleanup boundary");
  const loadEffect = src.slice(loadStart, loadEnd);

  assert.match(src, LOADS_CONFIG_WITH_RETRY_HELPER);
  assert.match(loadEffect, CONFIG_LOAD_CATCH_SETS_INLINE_ERROR);
  assert.doesNotMatch(loadEffect, THROW_RE, "config-load failure path must not throw to the route error boundary");
  assert.match(src, INLINE_ERROR_PANEL);
  assert.match(src, INLINE_RETRY_BUTTON);
  assert.match(src, RETRY_RELOADS_CONFIG);
});
