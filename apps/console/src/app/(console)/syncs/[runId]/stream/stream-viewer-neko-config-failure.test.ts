import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const VIEWER_FILE = fileURLToPath(new URL("./stream-viewer.tsx", import.meta.url));

const LOADS_CONFIG_WITH_RETRY_HELPER =
  /const payload = \(await fetchNekoClientConfigResponse\(clientConfigPath, \{\s+onObservation,\s+\}\)\) as NekoClientConfigResponse;/;
const CONFIG_LOAD_OBSERVATION =
  /logDebug\("stream_neko_client_config", \{ browserSessionId: session\.browserSessionId, \.\.\.observation \}\)/;
const CONFIG_LOAD_CATCH_SETS_INLINE_ERROR =
  /\.catch\(\(err: unknown\) => \{\s+if \(!cancelled\) \{\s+setError\(err instanceof Error \? err\.message : "n\.eko direct stream failed"\);/;
const INLINE_ERROR_PANEL = /The n\.eko WebRTC stream did not attach\./;
const INLINE_RETRY_BUTTON = /Retry secure browser/;
const RETRY_RELOADS_CONFIG = /setConfigLoadRetryEpoch\(\(epoch\) => epoch \+ 1\)/;
const MOUNT_REJECTION_RETHROWS_TO_INLINE_CATCH =
  /await mountNekoViewer\([\s\S]*?catch \(error\) \{[\s\S]*?throw error;[\s\S]*?\.catch\(\(err: unknown\) => \{\s+if \(!cancelled\) \{\s+setError\(/;

test("NekoSurface config-load source contract retains inline retry handling", async () => {
  const src = await readFile(VIEWER_FILE, "utf8");
  const loadStart = src.indexOf("const connection = loadNekoClientConfig(session.clientConfigPath,");
  const loadEnd = src.indexOf("return () => {", loadStart);

  assert.notEqual(loadStart, -1, "NekoSurface should load the remote browser config in an effect");
  assert.notEqual(loadEnd, -1, "NekoSurface config-load effect should have a cleanup boundary");
  const loadEffect = src.slice(loadStart, loadEnd);

  assert.match(src, LOADS_CONFIG_WITH_RETRY_HELPER);
  assert.match(src, CONFIG_LOAD_OBSERVATION);
  assert.match(loadEffect, CONFIG_LOAD_CATCH_SETS_INLINE_ERROR);
  assert.match(
    loadEffect,
    MOUNT_REJECTION_RETHROWS_TO_INLINE_CATCH,
    "viewer readiness rejection must rethrow only to the surrounding inline-error catch"
  );
  assert.match(src, INLINE_ERROR_PANEL);
  assert.match(src, INLINE_RETRY_BUTTON);
  assert.match(src, RETRY_RELOADS_CONFIG);
});
