#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// OpenAPI 3.1 artifact generator driven from route manifests.
//
// Emits:
//   - reference-public.openapi.json  (public routes only)
//   - reference-full.openapi.json    (public + /_ref routes)

import type { JsonSchema, RouteManifest } from "../common/index.ts";
import { publicManifests as publicManifestsRaw } from "../public/index.ts";
import { referenceManifests as referenceManifestsRaw } from "../reference/index.ts";

// The literal manifest tuples are structurally assignable to RouteManifest[];
// mirror the cast used in ../validate.ts so this module reads them typed.
const publicManifests = publicManifestsRaw as readonly RouteManifest[];
const referenceManifests = referenceManifestsRaw as readonly RouteManifest[];

interface OpenApiParameter {
  in: "path" | "query";
  name: string;
  required: boolean;
  schema: JsonSchema;
}

interface OpenApiMediaType {
  schema?: JsonSchema;
}

interface OpenApiRequestBody {
  content: Record<string, OpenApiMediaType>;
  required: boolean;
}

interface OpenApiResponse {
  content?: Record<string, OpenApiMediaType>;
  description: string;
}

interface OpenApiOperation {
  operationId: string;
  parameters: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
  summary: string | undefined;
  tags: readonly string[];
}

interface OpenApiTag {
  description: string;
  name: string;
}

interface OpenApiDocument {
  components: { schemas: Record<string, JsonSchema> };
  info: { title: string; version: string; description: string };
  openapi: string;
  paths: Record<string, Record<string, OpenApiOperation>>;
  tags: OpenApiTag[];
}

function pathToOpenApi(path: string): string {
  // our manifests already use {param} style braces
  return path;
}

function parametersFromRequest(req: NonNullable<RouteManifest["request"]>): OpenApiParameter[] {
  const parameters: OpenApiParameter[] = [];
  if (req.params?.properties) {
    for (const [name, schema] of Object.entries(req.params.properties)) {
      parameters.push({ in: "path", name, required: (req.params.required || []).includes(name), schema });
    }
  }
  if (req.query?.properties) {
    for (const [name, schema] of Object.entries(req.query.properties)) {
      parameters.push({ in: "query", name, required: (req.query.required || []).includes(name), schema });
    }
  }
  return parameters;
}

function responseFromSpec(spec: NonNullable<RouteManifest["responses"]>[string]): OpenApiResponse {
  const response: OpenApiResponse = { description: spec.description || "" };
  if (spec.schema) {
    response.content = { [spec.contentType || "application/json"]: { schema: spec.schema } };
  } else if (spec.contentType) {
    response.content = { [spec.contentType]: {} };
  }
  return response;
}

function operationFromManifest(manifest: RouteManifest): OpenApiOperation {
  const req = manifest.request || {};
  const op: OpenApiOperation = {
    operationId: manifest.id,
    tags: manifest.tags || [],
    summary: manifest.summary,
    parameters: parametersFromRequest(req),
    responses: {},
  };

  if (req.body) {
    op.requestBody = {
      required: req.body.required !== false,
      content: {
        [req.body.contentType || "application/json"]: {
          schema: req.body.schema || {},
        },
      },
    };
  }

  for (const [code, spec] of Object.entries(manifest.responses || {})) {
    op.responses[String(code)] = responseFromSpec(spec);
  }

  return op;
}

// Client event-subscription routes are a late-added RI extension that the
// published artifacts group at the end of the document, after the core public
// and /_ref surfaces. Partition them out of the natural surface order so the
// emitted path order keeps that grouping: core public, core /_ref, then the
// event-subscription routes (public first, then /_ref).
function isEventSubscriptionManifest(manifest: RouteManifest): boolean {
  return (manifest.tags || []).includes("event-subscriptions");
}

export function generateOpenApi({ includeReference = false }: { includeReference?: boolean } = {}): OpenApiDocument {
  const publicCore = publicManifests.filter((m) => !isEventSubscriptionManifest(m));
  const publicEventSubs = publicManifests.filter(isEventSubscriptionManifest);
  const referenceCore = referenceManifests.filter((m) => !isEventSubscriptionManifest(m));
  const referenceEventSubs = referenceManifests.filter(isEventSubscriptionManifest);
  const manifests = includeReference
    ? [...publicCore, ...referenceCore, ...publicEventSubs, ...referenceEventSubs]
    : [...publicCore, ...publicEventSubs];
  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: includeReference
        ? "PDPP Reference Implementation (full, includes /_ref)"
        : "PDPP Reference Implementation (public)",
      version: "0.1.0",
      description: includeReference
        ? "Public PDPP JSON APIs plus reference-designated /_ref operator/control surfaces."
        : "Public PDPP JSON APIs.",
    },
    tags: [
      { name: "metadata", description: "Authorization-server and protected-resource metadata" },
      { name: "oauth", description: "OAuth-adjacent public flows used by the reference implementation" },
      { name: "grants", description: "Grant initiation, approval, revocation, and introspection" },
      { name: "records", description: "Record-query / read surface" },
      ...(includeReference
        ? [
            { name: "reference", description: "Reference-only operator/control APIs (/_ref)" },
            { name: "connectors", description: "Connector inventory and run control" },
            { name: "runs", description: "Run and schedule control" },
          ]
        : []),
      {
        name: "event-subscriptions",
        description:
          "Client event-subscription management (RI extension; CloudEvents 1.0 + Standard Webhooks delivery)",
      },
    ],
    paths: {},
    components: { schemas: {} },
  };
  // The reference splits some surfaces across two listening servers (AS and
  // RS) but advertises a single OpenAPI document. When two manifests share
  // (method, path), keep the first registered manifest in the document. The
  // contract registry still holds both ids for runtime route validation;
  // duplicating an OpenAPI path entry would produce an invalid document
  // because OpenAPI 3.1 requires path+method to be unique per document.
  for (const manifest of manifests) {
    const path = pathToOpenApi(manifest.path);
    const method = manifest.method.toLowerCase();
    if (!document.paths[path]) {
      document.paths[path] = {};
    }
    const pathItem = document.paths[path];
    if (pathItem[method]) {
      continue;
    }
    pathItem[method] = operationFromManifest(manifest);
  }
  return document;
}

async function main(): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(here, "../../../../reference-implementation/openapi");
  await mkdir(outDir, { recursive: true });
  const pub = generateOpenApi({ includeReference: false });
  const full = generateOpenApi({ includeReference: true });
  await writeFile(join(outDir, "reference-public.openapi.json"), `${JSON.stringify(pub, null, 2)}\n`);
  await writeFile(join(outDir, "reference-full.openapi.json"), `${JSON.stringify(full, null, 2)}\n`);
  process.stdout.write(`wrote ${outDir}/reference-public.openapi.json\n`);
  process.stdout.write(`wrote ${outDir}/reference-full.openapi.json\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    const e = err as { stack?: string; message?: string };
    process.stderr.write(`${e.stack || e.message}\n`);
    process.exit(1);
  });
}
