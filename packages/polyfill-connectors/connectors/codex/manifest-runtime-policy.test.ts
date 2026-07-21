import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CODEX_GATED_INVENTORY_STREAMS, CODEX_KNOWN_LOCAL_STORES } from "./index.ts";

/**
 * Binds the Codex connector's runtime inventory/defer classification
 * (`CODEX_KNOWN_LOCAL_STORES`, `CODEX_GATED_INVENTORY_STREAMS`) to the
 * manifest's accepted-absence policy. The 2026-07-10 live audit found
 * `history` emitted/classified `inventory_only` at runtime while its
 * manifest stream stayed `required` with no `coverage_policy`, so a
 * settled connection with only that stream unmeasured still failed
 * Healthy (`accepted_absence_on_required`). Runtime classification is the
 * source of truth here — the manifest must declare a matching non-required
 * accepted-absence policy for every gated inventory/defer stream, and must
 * NOT weaken a content-bearing `collect` stream to non-required.
 */

const MANIFEST_PATH = join(import.meta.dirname, "../../manifests/codex.json");

const RUNTIME_CLASSIFICATION_TO_MANIFEST_POLICY: Record<string, string> = {
  defer: "deferred",
  inventory_only: "inventory_only",
};

interface ManifestStream {
  coverage_policy?: string;
  name: string;
  required?: boolean;
}

function readManifestStreams(): Map<string, ManifestStream> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { streams: ManifestStream[] };
  return new Map(manifest.streams.map((s) => [s.name, s]));
}

test("codex manifest: every runtime inventory_only/defer stream is a non-required accepted-absence policy", () => {
  const manifestStreams = readManifestStreams();
  const runtimeByStream = new Map(CODEX_KNOWN_LOCAL_STORES.filter((s) => s.stream).map((s) => [s.stream as string, s]));

  const violations: string[] = [];
  for (const streamName of CODEX_GATED_INVENTORY_STREAMS) {
    const runtimeStore = runtimeByStream.get(streamName);
    assert(
      runtimeStore,
      `CODEX_GATED_INVENTORY_STREAMS names "${streamName}" but no CODEX_KNOWN_LOCAL_STORES entry maps to it`
    );

    const expectedPolicy = RUNTIME_CLASSIFICATION_TO_MANIFEST_POLICY[runtimeStore.classification];
    assert(
      expectedPolicy,
      `runtime classification "${runtimeStore.classification}" for stream "${streamName}" has no accepted manifest coverage_policy mapping`
    );

    const manifestStream = manifestStreams.get(streamName);
    if (!manifestStream) {
      violations.push(`${streamName}: runtime emits it but manifest declares no such stream`);
      continue;
    }
    if (manifestStream.required !== false) {
      violations.push(
        `${streamName}: runtime classification is "${runtimeStore.classification}" (accepted absence) but manifest ` +
          `required=${manifestStream.required ?? true} — a settled connection resting unmeasured on this stream ` +
          "fails Healthy as accepted_absence_on_required instead of resolving as accepted absence"
      );
    }
    if (manifestStream.coverage_policy !== expectedPolicy) {
      violations.push(
        `${streamName}: runtime classification "${runtimeStore.classification}" expects manifest ` +
          `coverage_policy="${expectedPolicy}" but found "${manifestStream.coverage_policy ?? "<none>"}"`
      );
    }
  }

  assert.deepEqual(violations, [], `Codex manifest/runtime policy drift:\n${violations.join("\n")}`);
});

test("codex manifest: content-bearing collect streams stay required", () => {
  const manifestStreams = readManifestStreams();
  const gated = new Set<string>(CODEX_GATED_INVENTORY_STREAMS);

  const contentBearingCollectStreams = CODEX_KNOWN_LOCAL_STORES.filter(
    (s) => s.stream && s.classification === "collect" && !gated.has(s.stream)
  ).map((s) => s.stream as string);

  assert(
    contentBearingCollectStreams.length > 0,
    "expected at least one content-bearing collect stream to assert against"
  );

  const violations: string[] = [];
  for (const streamName of contentBearingCollectStreams) {
    const manifestStream = manifestStreams.get(streamName);
    assert(manifestStream, `runtime declares collect stream "${streamName}" but manifest has no such stream`);
    if (manifestStream.required === false) {
      violations.push(`${streamName}: content-bearing collect stream must not be manifest required=false`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Codex manifest wrongly weakened a content-bearing stream:\n${violations.join("\n")}`
  );
});
