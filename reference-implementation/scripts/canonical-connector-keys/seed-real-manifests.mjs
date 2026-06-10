#!/usr/bin/env node
/**
 * canonical-connector-keys / seed-real-manifests.mjs
 *
 * Companion to backup-restore-seed.sql. The SQL fixture seeds THIN connector
 * manifest bodies — enough for the storage-layer migration verifier. The
 * live HTTP read path (verify-http-surfaces.mjs) additionally needs a VALID
 * operational manifest body to resolve a connector's streams, so this script
 * overwrites the seeded `connectors.manifest` JSONB with the real first-party
 * manifests from packages/polyfill-connectors/manifests/.
 *
 * It runs on the SEED database, before the backup dump, so the realistic
 * manifests travel through the dump → restore → migrate cycle exactly like an
 * operator's real connector catalog would. The manifests are single-sourced
 * from the shipped manifest files (no duplication into the fixture).
 *
 * Each row is keyed by its PRE-migration connector_id (URL-shaped / legacy
 * alias / canonical) so the migration still exercises the PK rewrite; the
 * writer copies the manifest JSONB verbatim when it repoints the parent row,
 * so the real manifest body survives the migration under the canonical key.
 *
 * Usage:
 *   PDPP_DATABASE_URL=postgres://... node seed-real-manifests.mjs
 *
 * Never prints the connection string.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = join(__dirname, '..', '..', '..', 'packages', 'polyfill-connectors', 'manifests');

// pre-migration connector_id (the seed's PK) -> manifest filename.
const SEED_MANIFESTS = [
  { pk: 'https://registry.pdpp.org/connectors/gmail', file: 'gmail.json' },
  { pk: 'claude_code', file: 'claude_code.json' },
  { pk: 'codex', file: 'codex.json' },
  { pk: 'spotify', file: 'spotify.json' },
];

async function main() {
  const url = process.env.PDPP_DATABASE_URL;
  if (!url) throw new Error('PDPP_DATABASE_URL is required');

  const pg = await import('pg');
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({ connectionString: url });

  try {
    for (const { pk, file } of SEED_MANIFESTS) {
      const manifest = readFileSync(join(MANIFESTS_DIR, file), 'utf8');
      // Validate it parses before writing.
      JSON.parse(manifest);
      const res = await pool.query(
        `UPDATE connectors SET manifest = $1::jsonb WHERE connector_id = $2`,
        [manifest, pk],
      );
      if ((res.rowCount ?? 0) !== 1) {
        throw new Error(
          `expected to patch exactly 1 connectors row for ${JSON.stringify(pk)}, patched ${res.rowCount}`,
        );
      }
      process.stdout.write(`patched manifest for ${pk} <- ${file}\n`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  const safe = String(err?.message ?? err).replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgres://<redacted>');
  process.stderr.write(`seed-real-manifests error: ${safe}\n`);
  process.exit(1);
});
