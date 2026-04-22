/**
 * Fixture capture for connector runs.
 *
 * Gated on PDPP_CAPTURE_FIXTURES=1. When active, writes under
 * `packages/polyfill-connectors/fixtures/<connector>/raw/<runId>/` three
 * kinds of capture:
 *
 *   records/<stream>.jsonl     one JSON per emitted RECORD.data (generic,
 *                               free to any connector that uses a shared
 *                               runtime — emit() is wrapped to append)
 *   dom/<label>.html           Playwright page.content() snapshots at
 *                               connector-chosen checkpoints
 *   http/<nnnn>-<label>.json   HTTP response bodies for API connectors
 *
 * The "raw" side is gitignored. A companion scrubber (bin/scrub-fixtures.mjs)
 * consumes a run's raw/ and writes sanitized files to scrubbed/ for commit.
 *
 * runId is an ISO-timestamp folder so repeated runs accumulate rather than
 * overwriting — useful when diffing runs or when the first run fails partway.
 *
 * All capture is best-effort: if the filesystem is unavailable, we warn to
 * stderr and return null so the real run proceeds unimpeded. Capture must
 * never make a connector fail.
 */

import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const safeLabel = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);

export function createCaptureSession(connectorName) {
  if (process.env.PDPP_CAPTURE_FIXTURES !== '1') return null;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const baseDir = join(PACKAGE_ROOT, 'fixtures', connectorName, 'raw', runId);
  try {
    mkdirSync(join(baseDir, 'records'), { recursive: true });
    mkdirSync(join(baseDir, 'dom'), { recursive: true });
    mkdirSync(join(baseDir, 'http'), { recursive: true });
  } catch (err) {
    process.stderr.write(`[capture] mkdir failed: ${err.message}\n`);
    return null;
  }

  let httpSeq = 0;

  return {
    runId,
    baseDir,
    recordRecord(msg) {
      try {
        const file = join(baseDir, 'records', `${safeLabel(msg.stream)}.jsonl`);
        appendFileSync(file, JSON.stringify(msg.data) + '\n');
      } catch (err) {
        process.stderr.write(`[capture] record write failed: ${err.message}\n`);
      }
    },
    async captureDom(page, label) {
      try {
        const html = await page.content();
        writeFileSync(join(baseDir, 'dom', `${safeLabel(label)}.html`), html);
      } catch (err) {
        process.stderr.write(`[capture] dom write failed for ${label}: ${err.message}\n`);
      }
    },
    captureHttp(label, body, meta = {}) {
      try {
        const idx = String(++httpSeq).padStart(4, '0');
        const file = join(baseDir, 'http', `${idx}-${safeLabel(label)}.json`);
        const payload = { label, meta, body: typeof body === 'string' ? body : body };
        writeFileSync(file, JSON.stringify(payload, null, 2));
      } catch (err) {
        process.stderr.write(`[capture] http write failed for ${label}: ${err.message}\n`);
      }
    },
  };
}
