/**
 * File Import Tool (Experiment)
 *
 * Imports pre-collected data files (platform export archives, JSON, CSV)
 * into a PDPP resource server via the ingest endpoint.
 *
 * Like the webhook adapter, this does NOT use the Collection Profile's
 * START/RECORD/STATE/DONE protocol. It reads a file, validates records
 * against the stream schema, and ingests via POST /v1/ingest/{stream}
 * with an owner token.
 *
 * The experiment tests whether batch data import can be handled as a
 * runtime tool without needing a Batch Import Profile.
 *
 * Status: Experimental (reference architecture, non-normative)
 *
 * Key question: does the RS ingest endpoint + owner token + RECORD format
 * provide a sufficient contract for file import, or does import need its
 * own validation/lifecycle spec?
 */

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

/**
 * Import a JSONL file of PDPP records into the RS.
 *
 * Expected file format: one JSON object per line, each with:
 * { stream, key, data, emitted_at? }
 *
 * @param {object} opts
 * @param {string} opts.filePath - Path to JSONL file
 * @param {string} opts.ownerToken - Owner bearer token
 * @param {string} opts.rsUrl - Resource server base URL
 * @param {string} opts.connectorId - Connector ID for attribution
 * @param {number} opts.batchSize - Records per ingest request (default 100)
 * @param {function} opts.onProgress - (stats) => void
 * @returns {Promise<{ total: number, ingested: number, errors: number, skipped: number }>}
 */
export async function importFile(opts) {
  const {
    filePath,
    ownerToken,
    rsUrl = process.env.RS_URL || 'http://localhost:7663',
    connectorId,
    batchSize = 100,
    onProgress = () => {},
  } = opts;

  const stats = { total: 0, ingested: 0, errors: 0, skipped: 0 };

  // Read file line by line
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  // Buffer for batching
  const batchByStream = new Map(); // stream name → record[]

  for await (const line of rl) {
    if (!line.trim()) continue;
    stats.total++;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      stats.errors++;
      continue;
    }

    // Validate minimal RECORD shape
    if (!record.stream || !record.key || !record.data) {
      stats.skipped++;
      continue;
    }

    // Ensure emitted_at
    if (!record.emitted_at) {
      record.emitted_at = new Date().toISOString();
    }

    // Add to batch
    const streamName = record.stream;
    if (!batchByStream.has(streamName)) {
      batchByStream.set(streamName, []);
    }
    batchByStream.get(streamName).push(record);

    // Flush if batch is full
    for (const [stream, records] of batchByStream) {
      if (records.length >= batchSize) {
        const result = await ingestBatch(rsUrl, ownerToken, stream, records);
        if (result.ok) {
          stats.ingested += records.length;
        } else {
          stats.errors += records.length;
        }
        batchByStream.set(stream, []);
        onProgress({ ...stats });
      }
    }
  }

  // Flush remaining
  for (const [stream, records] of batchByStream) {
    if (records.length > 0) {
      const result = await ingestBatch(rsUrl, ownerToken, stream, records);
      if (result.ok) {
        stats.ingested += records.length;
      } else {
        stats.errors += records.length;
      }
    }
  }

  onProgress({ ...stats, done: true });
  return stats;
}

/**
 * Import a platform export archive (e.g., Instagram data download).
 *
 * This is a higher-level function that:
 * 1. Reads the archive structure
 * 2. Maps platform-specific files to PDPP streams
 * 3. Transforms records to PDPP RECORD format
 * 4. Ingests via importFile()
 *
 * The mapping is connector-specific and lives in the connector's
 * manifest or a separate mapping file. This is NOT a spec concern —
 * each platform has its own export format.
 *
 * @param {object} opts
 * @param {string} opts.archivePath - Path to extracted archive directory
 * @param {object} opts.mapping - Maps archive file paths to { stream, transform }
 * @param {string} opts.ownerToken
 * @param {string} opts.rsUrl
 * @returns {Promise<{ total: number, ingested: number, errors: number }>}
 */
export async function importArchive(opts) {
  const {
    archivePath,
    mapping,
    ownerToken,
    rsUrl = process.env.RS_URL || 'http://localhost:7663',
  } = opts;

  const stats = { total: 0, ingested: 0, errors: 0 };

  for (const [relPath, { stream, transform }] of Object.entries(mapping)) {
    const fullPath = path.join(archivePath, relPath);
    if (!fs.existsSync(fullPath)) continue;

    const raw = fs.readFileSync(fullPath, 'utf-8');
    let items;
    try {
      items = JSON.parse(raw);
      if (!Array.isArray(items)) items = [items];
    } catch {
      stats.errors++;
      continue;
    }

    // Transform platform records to PDPP RECORD format
    const records = items.map((item, i) => ({
      stream,
      key: item.id || `${stream}_${i}`,
      data: transform ? transform(item) : item,
      emitted_at: new Date().toISOString(),
    }));

    // Ingest
    const result = await ingestBatch(rsUrl, ownerToken, stream, records);
    if (result.ok) {
      stats.ingested += records.length;
    } else {
      stats.errors += records.length;
    }
    stats.total += records.length;
  }

  return stats;
}

async function ingestBatch(rsUrl, ownerToken, stream, records) {
  try {
    const res = await fetch(`${rsUrl}/v1/ingest/${stream}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ records }),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Observations for the post-experiment memo ──────────────────────────────
//
// 1. Did this fit cleanly as runtime/reference architecture?
//    → YES. The import tool just calls POST /v1/ingest/{stream} with
//      records in RECORD format. No new wire-level contract.
//
// 2. Did it expose a real interoperability contract?
//    → The RECORD format is the contract, and it's already defined in Core §4.
//      The archive mapping (platform file → PDPP stream) is connector-specific,
//      not a protocol concern. Different platforms have different export formats.
//
// 3. Does import need a Batch Import Profile?
//    → NOT TODAY. The RS ingest endpoint + RECORD format + owner token is
//      sufficient. A profile would be justified if:
//      (a) multiple import tools needed to agree on an archive discovery format
//      (b) the RS needed to handle import-specific validation (schema version
//          compatibility, deduplication across imports)
//      Neither is a pressing need.
//
// 4. What is the smallest profile boundary if one is needed?
//    → Define: (a) archive manifest format (what streams, what files, what schema
//      version), (b) import request format (batch of records + metadata),
//      (c) import result format (success/partial/failure with per-record status).
//      But this is premature unless multiple import tools need interop.
