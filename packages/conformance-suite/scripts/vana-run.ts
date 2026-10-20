// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderMarkdown } from "../src/report/markdown.ts";
import { buildRequirementsReport, readSpecText } from "../src/report/requirements.ts";
import { exitCodeFor } from "../src/report/result.ts";
import { ALL_CASES, runSuite } from "../src/suite.ts";
import { VanaPsAdapter, type VanaPsConfig } from "../src/targets/vana-ps-adapter.ts";

const state = process.env.PDPP_VANA_STATE_DIR;
if (!state) {
  throw new Error("PDPP_VANA_STATE_DIR is required");
}
const readinessLine = readFileSync(join(state, "server.log"), "utf8")
  .split("\n")
  .find((line) => line.startsWith('{"ready":true'));
if (!readinessLine) {
  throw new Error("Server readiness missing");
}
const ready = JSON.parse(readinessLine);
const baseUrl: string = ready.baseUrl;
const sourceId = "https://registry.pdpp.dev/connectors/spotify";
const instances = ["conn_00000001-0000-4000-8000-000000000001", "conn_00000002-0000-4000-8000-000000000002"] as const;
const methodId = "conformance";
async function json(path: string, token: string, body?: unknown, method = "POST") {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  }
  return result;
}
const owner = (await json("/pdpp/v1/owner/token", ready.devToken, { source_id: sourceId })).access_token;
for (const [i, instance] of instances.entries()) {
  // biome-ignore lint/performance/noAwaitInLoops: fixture provisioning is ordered.
  await json(
    `/pdpp/connections/${instance}`,
    owner,
    { source_id: sourceId, method_id: methodId, label: `Fixture connection ${i + 1}` },
    "PUT"
  );
}
// Boot may migrate an empty legacy default connection from the scope inventory.
// Remove that disposable default through the same authenticated registry route.
const inventory = await json(`/pdpp/connections?source_id=${encodeURIComponent(sourceId)}`, owner, undefined, "GET");
for (const connection of inventory.connections as { connection_id: string }[]) {
  if (!(instances as readonly string[]).includes(connection.connection_id)) {
    // biome-ignore lint/performance/noAwaitInLoops: delete only explicitly listed disposable defaults.
    await json(`/pdpp/connections/${encodeURIComponent(connection.connection_id)}`, owner, undefined, "DELETE");
  }
}
const fixtureRows: Record<string, unknown[]> = {};
async function ingest(
  stream: string,
  instance: string,
  records: { key: string | string[]; data: Record<string, unknown>; emitted_at?: string }[]
) {
  const envelopes = records.map((r) => ({ instance, emitted_at: r.emitted_at ?? "2026-01-01T00:00:00Z", ...r }));
  const result = await json(
    `/v1/streams/${stream}/records/ingest?method=${methodId}&binding_generation=1`,
    owner,
    envelopes
  );
  if (result.accepted !== records.length) {
    throw new Error(`Seed rejected: ${JSON.stringify(result)}`);
  }
  fixtureRows[`${instance}/${stream}`] = envelopes;
}
const ts = "2026-01-01T00:00:00Z";
for (const [index, instance] of instances.entries()) {
  // biome-ignore lint/performance/noAwaitInLoops: fixture write order is part of the oracle.
  await ingest(
    "top_artists",
    instance,
    Array.from({ length: 5 }, (_, n) => ({
      key: `art_${n + 1}`,
      emitted_at: `2026-01-0${n + 1}T00:00:00Z`,
      data: {
        id: `art_${n + 1}`,
        name: `Artist ${n + 1}${index ? " other connection" : ""}`,
        genres: ["indie", "rock"],
        source_updated_at: `2026-01-0${n + 1}T00:00:00Z`,
      },
    }))
  );
}
const multiRecords: { id: string; instanceId: string; cursor: string | null }[] = [];
for (const [index, instance] of instances.entries()) {
  const records = Array.from({ length: 70 }, (_, n) => {
    const id = `multi_${index}_${String(n).padStart(3, "0")}`;
    const cursor = n > 65 ? null : new Date(Date.UTC(2026, 0, 1, 0, n, index)).toISOString();
    multiRecords.push({ id, instanceId: instance, cursor });
    return { key: id, data: { id, name: `Multi ${index}/${n}`, ...(cursor ? { source_updated_at: cursor } : {}) } };
  });
  // biome-ignore lint/performance/noAwaitInLoops: fixture write order is part of the oracle.
  await ingest("multi_records", instance, records);
}
await ingest(
  "saved_tracks",
  instances[0],
  Array.from({ length: 3 }, (_, n) => ({
    key: `trk_${n + 1}`,
    data: { id: `trk_${n + 1}`, title: `Track ${n + 1}`, artist: `Artist ${n + 1}`, source_updated_at: ts },
  }))
);
await ingest(
  "playlists",
  instances[0],
  Array.from({ length: 3 }, (_, n) => ({
    key: ["owner_1", `pl_${n + 1}`],
    data: { owner_id: "owner_1", playlist_id: `pl_${n + 1}`, title: `Playlist ${n + 1}` },
  }))
);
await ingest(
  "events",
  instances[0],
  Array.from({ length: 3 }, (_, n) => ({
    key: `evt_${n + 1}`,
    data: { id: `evt_${n + 1}`, name: `Event ${n + 1}`, genres: ["event"], source_updated_at: ts },
  }))
);
async function upload(content: string, instance = instances[0]) {
  const bytes = Buffer.from(content);
  const response = await fetch(
    `${baseUrl}/v1/blobs/ingest?instance=${instance}&method=${methodId}&binding_generation=1`,
    { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "image/jpeg" }, body: bytes }
  );
  const result = await response.json();
  if (!response.ok) {
    throw new Error(`Blob seed: ${response.status} ${JSON.stringify(result)}`);
  }
  return {
    blobId: result.blob_id as string,
    mimeType: "image/jpeg",
    digest: { sha256: createHash("sha256").update(bytes).digest("hex"), length: bytes.length },
  };
}
const blob = await upload("conformance-blob-in-grant");
await upload("conformance-blob-in-grant", instances[1]);
const outside = await upload("conformance-blob-out-of-grant");
// The forbidden connection references the shared blob FIRST. A first-reference-only
// authorization implementation must fail the shared-blob oracle.
await ingest("media", instances[1], [
  {
    key: "med_forbidden",
    data: {
      id: "med_forbidden",
      caption: "Forbidden reference",
      blob_ref: { blob_id: blob.blobId, mime_type: blob.mimeType },
      source_updated_at: ts,
    },
  },
]);
await ingest("media", instances[0], [
  {
    key: "med_1",
    data: {
      id: "med_1",
      caption: "Seeded media record",
      blob_ref: { blob_id: blob.blobId, mime_type: blob.mimeType },
      source_updated_at: ts,
    },
  },
]);
const rawConfig = JSON.parse(readFileSync("targets/vana-personal-server.json", "utf8"));
const config: VanaPsConfig = {
  ...rawConfig,
  baseUrl,
  ownerBootstrapToken: ready.devToken,
  operatorToken: "conformance-operator-loopback-only",
  targetVersion: `personal-server-ts@${process.env.PDPP_VANA_REF}`,
  instanceId: instances[0],
  methodId,
  blobFixture: {
    ...rawConfig.blobFixture,
    blobId: blob.blobId,
    outOfGrantBlobId: outside.blobId,
    sha256: blob.digest.sha256,
    sizeBytes: blob.digest.length,
    sharedBlob: blob,
  },
  multiInstanceFixture: {
    stream: "multi_records",
    cursorField: "source_updated_at",
    instanceIds: instances,
    records: multiRecords,
  },
};
const adapter = new VanaPsAdapter(config);
const output = process.env.PDPP_VANA_REPORT_DIR ?? join(state, "reports");
mkdirSync(output, { recursive: true });
writeFileSync(
  join(output, "fixture-truth.json"),
  `${JSON.stringify({ sourceId, instances, rows: fixtureRows, blob, forbiddenBlob: outside }, null, 2)}\n`
);
writeFileSync(
  join(output, "target.json"),
  `${JSON.stringify({ ...config, ownerBootstrapToken: "[redacted]", operatorToken: "[redacted]" }, null, 2)}\n`
);
// Expected connection values come from the generator above, independent of reads.
const isolationResults: { id: string; outcome: string; detail: string; response?: unknown }[] = [];
for (const [index, instance] of instances.entries()) {
  // biome-ignore lint/performance/noAwaitInLoops: each consent journey must complete before its read.
  const grant = await adapter.issueGrant({
    streams: [{ name: "top_artists", fields: ["id", "name"], instanceIds: [instance] }],
  });
  if (!grant) {
    isolationResults.push({
      id: `connection-${index + 1}/equal-key-isolation`,
      outcome: "skip",
      detail: "Explicit connection grant was not issued",
    });
    continue;
  }
  const response = await fetch(`${baseUrl}/v1/streams/top_artists/records`, {
    headers: { authorization: `Bearer ${grant.accessToken}` },
  });
  const body = await response.json();
  const expected = fixtureRows[`${instance}/top_artists`] as { data: { id: string; name: string } }[];
  const rows = body.data as { data?: { id?: string; name?: string } }[] | undefined;
  const exact =
    response.status === 200 &&
    rows?.length === expected.length &&
    expected.every((record) =>
      rows.some((row) => row.data?.id === record.data.id && row.data?.name === record.data.name)
    );
  isolationResults.push({
    id: `connection-${index + 1}/equal-key-isolation`,
    outcome: exact ? "pass" : "fail",
    detail: "Explicit grant selects only the chosen connection with equal record keys",
    response: { status: response.status, body },
  });
}
const challenge = createHash("sha256")
  .update("pdpp-conformance-verifier-0000000000000000000000000000")
  .digest("base64url");
const ambiguous = await json("/pdpp/v1/authorize", owner, {
  client_id: config.clientId,
  redirect_uri: config.redirectUri,
  code_challenge: challenge,
  code_challenge_method: "S256",
  authorization_details: [
    {
      type: "https://pdpp.dev/data-access",
      source: { id: sourceId },
      purpose_code: config.purposeCode,
      access_mode: "continuous",
      streams: [{ name: "top_artists", fields: ["id", "name"] }],
    },
  ],
});
const ambiguousRead = await fetch(`${baseUrl}/pdpp/v1/authorize/${ambiguous.session_id}/review`, {
  headers: { authorization: `Bearer ${owner}` },
});
const ambiguousBody = await ambiguousRead.json();
isolationResults.push({
  id: "connections/no-implicit-fan-in",
  outcome:
    ambiguousRead.status === 200 &&
    Array.isArray(ambiguousBody.instance_choice_required) &&
    ambiguousBody.instance_choice_required.some(
      (choice: { stream?: string; candidates?: string[] }) =>
        choice.stream === "top_artists" && instances.every((instance) => choice.candidates?.includes(instance))
    ) &&
    !ambiguousBody.review
      ? "pass"
      : "fail",
  detail: "An unselected two-connection request must require explicit owner choice",
  response: { status: ambiguousRead.status, body: ambiguousBody },
});
writeFileSync(
  join(output, "fixture-probes.json"),
  `${JSON.stringify({ targetVersion: config.targetVersion, results: isolationResults }, null, 2)}\n`
);
const report = await runSuite(adapter, ALL_CASES);
writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(output, "report.md"), renderMarkdown(report));
writeFileSync(
  join(output, "requirements.json"),
  `${JSON.stringify(buildRequirementsReport(report, readSpecText()), null, 2)}\n`
);
// Separate implementation probes: the pinned suite has no experimental v0.2
// case inventory. These observations do not count toward its Core results.
const v02Results: { id: string; outcome: string; detail: string; response?: unknown }[] = [];
const narrowed = await adapter.issueGrant({
  specVersion: "0.2",
  streams: [{ name: "saved_tracks", fields: ["id", "title", "artist"], minimum: { fields: ["id"] } }],
  ownerChoices: { fields: { saved_tracks: ["id", "artist"] } },
});
if (narrowed) {
  const response = await fetch(`${baseUrl}/v1/streams/saved_tracks/records`, {
    headers: { authorization: `Bearer ${narrowed.accessToken}` },
  });
  const body = await response.json();
  const rows = body.data as { data?: Record<string, unknown> }[] | undefined;
  const exact =
    response.status === 200 &&
    rows?.length === 3 &&
    rows.every((row) => row.data?.id && row.data.artist && !Object.hasOwn(row.data, "title"));
  v02Results.push({
    id: "experimental-v0.2/narrowed-record-read",
    outcome: exact ? "pass" : "fail",
    detail:
      "Owner narrows schema-required title out of experimental v0.2 grant; expect three id/artist rows without title.",
    response: { status: response.status, body },
  });
} else {
  v02Results.push({
    id: "experimental-v0.2/narrowed-record-read",
    outcome: "skip",
    detail: "Target did not issue the narrowed experimental grant; no conformance verdict.",
  });
}
const badMinimum = await adapter.submitSelection({
  specVersion: "0.1",
  streams: [{ name: "saved_tracks", fields: ["id"], minimum: { fields: ["id"] } }],
});
v02Results.push({
  id: "experimental-v0.2/minimum-on-v0.1-refused",
  outcome: badMinimum?.status === 400 ? "pass" : "fail",
  detail: "A v0.2 minimum supplied on a v0.1 request must be refused.",
  response: badMinimum,
});
const experimental = {
  profile: "experimental-v0.2",
  targetVersion: config.targetVersion,
  suiteCoreSpecVersion: "0.1.0",
  scope: "Target-specific probes; the pinned suite has no v0.2 requirement inventory. Not a conformance assessment.",
  results: v02Results,
};
writeFileSync(join(output, "experimental-v0.2.json"), `${JSON.stringify(experimental, null, 2)}\n`);
writeFileSync(
  join(output, "experimental-v0.2.md"),
  `# Experimental v0.2 observations\n\n${experimental.scope}\n\n${v02Results.map((result) => `- ${result.outcome}: ${result.id} — ${result.detail}`).join("\n")}\n`
);
console.log(JSON.stringify({ output, exitCode: exitCodeFor(report) }));
process.exitCode = exitCodeFor(report);
