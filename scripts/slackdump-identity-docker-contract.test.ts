// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_VERSION = "pdpp-slackdump-identity/3.1.13 github.com/rusq/slackdump/v3@v3.1.13";
const GO_VERSION = "1.24.2-bookworm@sha256:79390b5e5af9ee6e7b1173ee3eac7fadf6751a545297672916b59bfa0ecf6f71";
const HELPER_DEST = "/opt/pdpp-tools/slackdump/slackdump-identity";
const GO_STAGE_RE = /FROM golang:\$\{GO_VERSION\} AS slackdump-identity-builder/;
const MODULE_COPY_RE =
  /COPY packages\/polyfill-connectors\/connectors\/slack\/slackdump-identity\/go\.mod packages\/polyfill-connectors\/connectors\/slack\/slackdump-identity\/go\.sum \./;
const VERIFY_MODULE_RE = /RUN go mod download[\s\S]*go mod verify/;
const MAIN_COPY_RE = /COPY packages\/polyfill-connectors\/connectors\/slack\/slackdump-identity\/main\.go/;
const BUILD_RE = /CGO_ENABLED=0 go build -trimpath -buildvcs=false/;
const EXECUTABLE_RE = /test -x \/out\/slackdump-identity/;
const REFERENCE_STAGE_RE = /FROM connector-runtime AS reference\b/;
const BROWSER_STAGE_RE = /FROM connector-runtime AS browsers\b/;
const REFERENCE_BROWSER_STAGE_RE = /FROM browsers AS reference-browser\b/;
const RAILWAY_STAGE_RE = /FROM connector-runtime AS railway-core\b/;
const COMPOSE_SLACKDUMP_FILE_MOUNT_RE =
  /PDPP_DOCKER_SLACKDUMP_DIR[^\n]+\/slackdump:\/opt\/pdpp-tools\/slackdump\/slackdump:ro/;

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

test("reference Dockerfiles build and install the pinned Slackdump identity helper", () => {
  const rootDockerfile = read("Dockerfile");
  const railwayDockerfile = read("deploy/railway/reference.Dockerfile");
  const compose = read("docker-compose.yml");

  for (const [name, dockerfile] of [
    ["Dockerfile", rootDockerfile],
    ["deploy/railway/reference.Dockerfile", railwayDockerfile],
  ] as const) {
    assert.match(dockerfile, new RegExp(`ARG GO_VERSION=${GO_VERSION.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`), name);
    assert.match(dockerfile, GO_STAGE_RE, name);
    assert.match(dockerfile, MODULE_COPY_RE, name);
    assert.match(dockerfile, VERIFY_MODULE_RE, name);
    assert.match(dockerfile, MAIN_COPY_RE, name);
    assert.match(dockerfile, BUILD_RE, name);
    assert.match(dockerfile, EXECUTABLE_RE, name);
    assert.match(
      dockerfile,
      new RegExp(
        `test "\\$\\(\\/out\\/slackdump-identity --version\\)" = "${HELPER_VERSION.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}"`
      ),
      name
    );
    assert.match(
      dockerfile,
      new RegExp(
        `COPY --from=slackdump-identity-builder /out/slackdump-identity ${HELPER_DEST.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`
      ),
      name
    );
  }

  assert.match(rootDockerfile, REFERENCE_STAGE_RE);
  assert.match(rootDockerfile, BROWSER_STAGE_RE);
  assert.match(rootDockerfile, REFERENCE_BROWSER_STAGE_RE);
  assert.match(rootDockerfile, RAILWAY_STAGE_RE);
  assert.match(compose, COMPOSE_SLACKDUMP_FILE_MOUNT_RE);
});
