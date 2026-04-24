import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../lib/args.js';
import { resolveAsUrl, resolveRsUrl } from '../lib/common.js';
import { PdppCliError, PdppUsageError } from '../lib/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REF_ROOT = join(__dirname, '..', '..');
const SEED_CONNECTOR_PATH = join(REF_ROOT, 'connectors', 'seed', 'index.js');
const MANIFESTS_DIR = join(REF_ROOT, 'manifests');

// The deterministic seed connector (connectors/seed/index.js) emits fixtures for
// these three worlds; no external credentials required.
const DEFAULT_CONNECTORS = ['spotify', 'github', 'reddit'];
const OWNER_BOOTSTRAP_CLIENT = 'pdpp-polyfill-owner-bootstrap';

export async function runSeed(argv) {
  const { flags, positionals } = parseArgs(argv);
  if (positionals.length > 0) {
    throw new PdppUsageError('pdpp seed does not take positional arguments; use --connector <name>');
  }

  const asUrl = resolveAsUrl(flags);
  const rsUrl = resolveRsUrl(flags);
  const subjectId = flags.subject || process.env.PDPP_SUBJECT_ID || 'owner_local';

  const requested = flags.connector;
  const connectors = (() => {
    if (!requested || requested === true) return DEFAULT_CONNECTORS;
    return String(requested)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  })();

  for (const name of connectors) {
    if (!DEFAULT_CONNECTORS.includes(name)) {
      throw new PdppUsageError(
        `Unknown seed connector: ${name}. Supported: ${DEFAULT_CONNECTORS.join(', ')}`,
      );
    }
  }

  await ensureReachable(asUrl);

  const { runConnector } = await import(join(REF_ROOT, 'runtime', 'index.js'));

  process.stdout.write(`Seeding ${connectors.length} connector(s) against ${asUrl}\n`);

  const ownerToken = await issueOwnerToken(asUrl, subjectId).catch((err) => {
    const message = err?.message || String(err);
    if (/owner_session_required|owner placeholder auth|401/i.test(message)) {
      throw new PdppCliError(
        `Seed requires open local-dev owner auth. The reference server has placeholder owner\n` +
          `auth enabled (PDPP_OWNER_PASSWORD is set). Sign in at /owner/login and approve the\n` +
          `device flow there, or restart the server without PDPP_OWNER_PASSWORD so \`pdpp seed\`\n` +
          `can mint owner tokens directly.`,
      );
    }
    throw new PdppCliError(`Failed to mint owner token: ${message}`);
  });

  const results = [];
  for (const name of connectors) {
    process.stdout.write(`  · ${name} … `);
    try {
      const manifestPath = join(MANIFESTS_DIR, `${name}.json`);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

      await registerManifest(asUrl, manifest);

      const result = await runConnector({
        connectorPath: SEED_CONNECTOR_PATH,
        connectorId: manifest.connector_id,
        ownerToken,
        manifest,
        state: null,
        collectionMode: 'full_refresh',
        rsUrl,
      });

      results.push({ name, connectorId: manifest.connector_id, result, ok: true });
      const recordCount = typeof result?.records === 'number' ? result.records : null;
      process.stdout.write(
        recordCount !== null ? `ok · ${recordCount.toLocaleString()} records\n` : 'ok\n',
      );
    } catch (err) {
      const message = err?.message || String(err);
      process.stdout.write(`failed: ${message}\n`);
      results.push({ name, ok: false, error: message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length === results.length) {
    throw new PdppCliError(`All ${failed.length} seed connector(s) failed. See errors above.`);
  }

  // Dataset summary — so the operator sees exactly what the dashboard will see.
  let summary = null;
  try {
    const res = await fetch(`${asUrl}/_ref/dataset/summary`);
    if (res.ok) summary = await res.json();
  } catch {
    // non-fatal — server may not expose /_ref yet
  }

  process.stdout.write('\nDataset summary\n');
  if (summary) {
    process.stdout.write(
      `  connectors: ${summary.connector_count}\n` +
        `  streams:    ${summary.stream_count}\n` +
        `  records:    ${summary.record_count.toLocaleString()}\n` +
        `  retained:   ${formatBytes(summary.total_retained_bytes)}\n`,
    );
    if (summary.earliest_record_time) {
      const start = summary.earliest_record_time.slice(0, 10);
      const end = (summary.latest_record_time ?? '').slice(0, 10);
      process.stdout.write(`  timespan:   ${start} → ${end}\n`);
    }
  } else {
    process.stdout.write('  (summary unavailable)\n');
  }

  if (failed.length > 0) {
    process.stdout.write(
      `\n${failed.length} connector(s) failed. Succeeded: ${results
        .filter((r) => r.ok)
        .map((r) => r.name)
        .join(', ')}.\n`,
    );
    process.exitCode = 1;
  }
}

async function ensureReachable(asUrl) {
  try {
    const res = await fetch(`${asUrl}/.well-known/pdpp-provider`);
    if (!res.ok && res.status !== 404) {
      throw new PdppCliError(
        `Reference server at ${asUrl} responded ${res.status}. Is the right server running?`,
      );
    }
  } catch (err) {
    if (err instanceof PdppCliError) throw err;
    throw new PdppCliError(
      `Reference server unreachable at ${asUrl}. Start it with:\n` +
        `  PDPP_DB_PATH=packages/polyfill-connectors/.pdpp-data/pdpp.sqlite \\\n` +
        `    node reference-implementation/server/index.js`,
    );
  }
}

async function registerManifest(asUrl, manifest) {
  const res = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  const text = await res.text();
  // 409 on re-register is fine — manifest version unchanged.
  if (res.status !== 201 && res.status !== 200 && res.status !== 409) {
    throw new Error(`register manifest failed ${res.status}: ${text}`);
  }
}

async function issueOwnerToken(asUrl, subjectId) {
  const clientId = OWNER_BOOTSTRAP_CLIENT;

  const deviceRes = await fetch(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  if (!deviceRes.ok) {
    throw new Error(`device_authorization failed ${deviceRes.status}: ${await deviceRes.text()}`);
  }
  const device = await deviceRes.json();

  const approveRes = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      user_code: device.user_code,
      subject_id: subjectId,
    }).toString(),
  });
  if (!approveRes.ok) {
    throw new Error(`device/approve failed ${approveRes.status}: ${await approveRes.text()}`);
  }

  const tokenRes = await fetch(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  if (!tokenRes.ok) {
    throw new Error(`/oauth/token failed ${tokenRes.status}: ${await tokenRes.text()}`);
  }
  const tokenBody = await tokenRes.json();
  return tokenBody.access_token;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${rounded} ${units[unitIndex]}`;
}
