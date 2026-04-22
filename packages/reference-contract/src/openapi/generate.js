#!/usr/bin/env node
// OpenAPI 3.1 artifact generator driven from route manifests.
//
// Emits:
//   - reference-public.openapi.json  (public routes only)
//   - reference-full.openapi.json    (public + /_ref routes)

import { publicManifests } from '../public/index.js';
import { referenceManifests } from '../reference/index.js';

function pathToOpenApi(path) {
  // our manifests already use {param} style braces
  return path;
}

function operationFromManifest(manifest) {
  const op = {
    operationId: manifest.id,
    tags: manifest.tags || [],
    summary: manifest.summary,
    parameters: [],
    responses: {},
  };

  const req = manifest.request || {};

  if (req.params?.properties) {
    for (const [name, schema] of Object.entries(req.params.properties)) {
      op.parameters.push({
        in: 'path',
        name,
        required: (req.params.required || []).includes(name),
        schema,
      });
    }
  }
  if (req.query?.properties) {
    for (const [name, schema] of Object.entries(req.query.properties)) {
      op.parameters.push({
        in: 'query',
        name,
        required: (req.query.required || []).includes(name),
        schema,
      });
    }
  }
  if (req.body) {
    op.requestBody = {
      required: true,
      content: {
        [req.body.contentType || 'application/json']: {
          schema: req.body.schema || {},
        },
      },
    };
  }

  for (const [code, spec] of Object.entries(manifest.responses || {})) {
    const response = {
      description: spec.description || '',
    };
    if (spec.schema) {
      response.content = {
        [spec.contentType || 'application/json']: { schema: spec.schema },
      };
    } else if (spec.contentType) {
      response.content = { [spec.contentType]: {} };
    }
    op.responses[String(code)] = response;
  }

  return op;
}

export function generateOpenApi({ includeReference = false } = {}) {
  const manifests = includeReference
    ? [...publicManifests, ...referenceManifests]
    : [...publicManifests];
  const document = {
    openapi: '3.1.0',
    info: {
      title: includeReference
        ? 'PDPP Reference Implementation (full, includes /_ref)'
        : 'PDPP Reference Implementation (public)',
      version: '0.1.0',
      description: includeReference
        ? 'Public PDPP JSON APIs plus reference-designated /_ref operator/control surfaces.'
        : 'Public PDPP JSON APIs.',
    },
    tags: [
      { name: 'metadata', description: 'Authorization-server and protected-resource metadata' },
      { name: 'oauth', description: 'OAuth-adjacent public flows used by the reference implementation' },
      { name: 'grants', description: 'Grant initiation, approval, revocation, and introspection' },
      { name: 'records', description: 'Record-query / read surface' },
      ...(includeReference
        ? [
            { name: 'reference', description: 'Reference-only operator/control APIs (/_ref)' },
            { name: 'connectors', description: 'Connector inventory and run control' },
            { name: 'runs', description: 'Run and schedule control' },
          ]
        : []),
    ],
    paths: {},
    components: { schemas: {} },
  };
  for (const manifest of manifests) {
    const path = pathToOpenApi(manifest.path);
    const pathItem = document.paths[path] || (document.paths[path] = {});
    pathItem[manifest.method.toLowerCase()] = operationFromManifest(manifest);
  }
  return document;
}

async function main() {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname, join, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(here, '../../../../reference-implementation/openapi');
  await mkdir(outDir, { recursive: true });
  const pub = generateOpenApi({ includeReference: false });
  const full = generateOpenApi({ includeReference: true });
  await writeFile(join(outDir, 'reference-public.openapi.json'), `${JSON.stringify(pub, null, 2)}\n`);
  await writeFile(join(outDir, 'reference-full.openapi.json'), `${JSON.stringify(full, null, 2)}\n`);
  process.stdout.write(`wrote ${outDir}/reference-public.openapi.json\n`);
  process.stdout.write(`wrote ${outDir}/reference-full.openapi.json\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
