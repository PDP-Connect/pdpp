import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

function readManifest(name: string): {
  capabilities?: {
    public_listing?: { listed?: unknown; status?: unknown };
    refresh_policy?: { background_safe?: unknown; recommended_mode?: unknown };
  };
} {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, `${name}.json`), "utf8")) as {
    capabilities?: {
      public_listing?: { listed?: unknown; status?: unknown };
      refresh_policy?: { background_safe?: unknown; recommended_mode?: unknown };
    };
  };
}

test("Spotify is not advertised as public or background-safe until proven", () => {
  const spotify = readManifest("spotify");
  assert.equal(spotify.capabilities?.public_listing?.listed, false);
  assert.equal(spotify.capabilities?.public_listing?.status, "unproven");
  assert.equal(spotify.capabilities?.refresh_policy?.recommended_mode, "manual");
  assert.equal(spotify.capabilities?.refresh_policy?.background_safe, false);
});

test("iMessage is local-device only and not background-safe in provider Docker", () => {
  const imessage = readManifest("imessage") as ReturnType<typeof readManifest> & {
    runtime_requirements?: {
      bindings?: { local_device?: { required?: unknown } };
    };
  };

  assert.equal(imessage.runtime_requirements?.bindings?.local_device?.required, true);
  assert.equal(imessage.capabilities?.refresh_policy?.recommended_mode, "manual");
  assert.equal(imessage.capabilities?.refresh_policy?.background_safe, false);
});
