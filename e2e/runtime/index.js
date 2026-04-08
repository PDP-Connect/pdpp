/**
 * PDPP Connector Runtime
 *
 * Spawns connector processes, manages the JSONL protocol,
 * handles INTERACTION, and ingests RECORDs to the RS via owner token.
 */
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { createReadStream } from 'fs';

const AS_URL = process.env.AS_URL || 'http://localhost:7662';
const RS_URL = process.env.RS_URL || 'http://localhost:7663';

/**
 * Run a connector to completion.
 *
 * @param {object} opts
 * @param {string} opts.connectorPath - Path to connector executable
 * @param {string} opts.connectorId - Connector ID (for ingest URL)
 * @param {string} opts.ownerToken - Owner bearer token
 * @param {object} opts.manifest - Full connector manifest
 * @param {object} opts.state - Current StreamState (null on first run)
 * @param {string} opts.collectionMode - 'full_refresh' | 'incremental'
 * @param {function} opts.onInteraction - async (interaction) => response
 * @param {function} opts.onProgress - (msg) => void
 * @returns {Promise<{status, records_emitted, state}>}
 */
export async function runConnector(opts) {
  const {
    connectorPath,
    connectorId,
    ownerToken,
    manifest,
    state = null,
    collectionMode = 'incremental',
    onInteraction = defaultInteractionHandler,
    onProgress = (msg) => process.stderr.write(`[runtime] ${JSON.stringify(msg)}\n`),
  } = opts;

  // Check binding requirements
  const requiredBindings = manifest.runtime_requirements?.bindings || {};
  const availableBindings = { network: {} }; // this runtime always has network

  for (const [binding, req] of Object.entries(requiredBindings)) {
    if (req.required && !(binding in availableBindings)) {
      throw new Error(`Runtime cannot satisfy required binding: ${binding}`);
    }
  }

  // Spawn connector process
  const proc = spawn(process.execPath, [connectorPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const rl = createInterface({ input: proc.stdout, terminal: false });
  const stderrChunks = [];
  proc.stderr.on('data', d => stderrChunks.push(d));

  // Send START
  const startMsg = {
    type: 'START',
    run_id: `run_${Date.now()}`,
    collection_mode: collectionMode,
    state,
    bindings: availableBindings,
    config: { connector_id: connectorId },
  };
  proc.stdin.write(JSON.stringify(startMsg) + '\n');

  // Collect new STATE checkpoints
  const newState = {};
  let totalEmitted = 0;
  let finalStatus = 'failed';
  let pendingInteraction = null;

  // Batch records for ingest
  const recordBatch = {};
  const BATCH_SIZE = 50;

  async function flushBatch(stream) {
    const batch = recordBatch[stream];
    if (!batch || !batch.length) return;
    const ndjson = batch.map(r => JSON.stringify(r)).join('\n');
    const url = `${RS_URL}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ownerToken}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: ndjson,
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Ingest failed for ${stream}: ${resp.status} ${body}`);
    }
    const result = await resp.json();
    onProgress({ type: 'ingest', stream, accepted: result.records_accepted, rejected: result.records_rejected });
    recordBatch[stream] = [];
  }

  async function flushAll() {
    for (const stream of Object.keys(recordBatch)) {
      await flushBatch(stream);
    }
  }

  // Process a STATE message: persist to RS
  async function persistState(stream, cursor) {
    newState[stream] = cursor;
    const url = `${RS_URL}/v1/state/${encodeURIComponent(connectorId)}`;
    await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state: { [stream]: cursor } }),
    });
  }

  return new Promise((resolve, reject) => {
    const msgQueue = [];
    let processing = false;

    async function processNext() {
      if (processing || !msgQueue.length) return;
      processing = true;

      const msg = msgQueue.shift();

      try {
        await handleMsg(msg);
      } catch (err) {
        reject(err);
        proc.kill();
        return;
      }

      processing = false;
      processNext();
    }

    async function handleMsg(msg) {
      switch (msg.type) {
        case 'RECORD': {
          const { stream, key, data, emitted_at, op } = msg;
          if (!recordBatch[stream]) recordBatch[stream] = [];
          recordBatch[stream].push({ key, data, emitted_at, op });
          totalEmitted++;

          if (recordBatch[stream].length >= BATCH_SIZE) {
            await flushBatch(stream);
          }
          break;
        }

        case 'STATE': {
          // Flush records for this stream before persisting state
          await flushBatch(msg.stream);
          await persistState(msg.stream, msg.cursor);
          break;
        }

        case 'INTERACTION': {
          if (pendingInteraction) {
            // Protocol violation
            proc.kill();
            throw new Error('Connector emitted INTERACTION while already waiting');
          }
          pendingInteraction = msg;

          let response;
          try {
            response = await onInteraction(msg);
          } catch (err) {
            response = { type: 'INTERACTION_RESPONSE', request_id: msg.request_id, status: 'cancelled' };
          }

          pendingInteraction = null;
          proc.stdin.write(JSON.stringify(response) + '\n');
          break;
        }

        case 'SKIP_RESULT':
          onProgress(msg);
          break;

        case 'PROGRESS':
          onProgress(msg);
          break;

        case 'DONE': {
          finalStatus = msg.status;

          if (msg.status === 'succeeded') {
            // Flush any remaining records
            await flushAll();
          }

          onProgress({ type: 'done', status: msg.status, records_emitted: msg.records_emitted });
          break;
        }

        default:
          onProgress({ type: 'unknown', msg });
      }
    }

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        msgQueue.push(msg);
        processNext().catch(reject);
      } catch (err) {
        onProgress({ type: 'parse_error', line, error: err.message });
      }
    });

    proc.on('close', async (code) => {
      const stderr = Buffer.concat(stderrChunks).toString();
      if (stderr) onProgress({ type: 'stderr', text: stderr });

      // Wait for queue to drain
      const waitForQueue = () => new Promise(res => {
        const check = () => {
          if (!msgQueue.length && !processing) return res();
          setTimeout(check, 10);
        };
        check();
      });

      try {
        await waitForQueue();
        resolve({
          status: finalStatus,
          records_emitted: totalEmitted,
          state: newState,
          exit_code: code,
        });
      } catch (err) {
        reject(err);
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Default interaction handler — prompts via stdin/stdout of the runtime process itself
 */
async function defaultInteractionHandler(interaction) {
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });

  process.stderr.write(`\n[INTERACTION] ${interaction.message}\n`);
  process.stderr.write(`Kind: ${interaction.kind}\n`);

  const data = {};
  const schema = interaction.schema?.properties || {};

  for (const [field, def] of Object.entries(schema)) {
    const answer = await new Promise(resolve => {
      const prompt = def.format === 'password' ? `${field} (hidden): ` : `${field}: `;
      rl.question(prompt, resolve);
    });
    data[field] = answer;
  }

  rl.close();

  return {
    type: 'INTERACTION_RESPONSE',
    request_id: interaction.request_id,
    status: 'success',
    data,
  };
}

/**
 * Load sync state from the RS for a connector
 */
export async function loadSyncState(connectorId, ownerToken) {
  const url = `${RS_URL}/v1/state/${encodeURIComponent(connectorId)}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${ownerToken}` },
  });
  if (!resp.ok) return null;
  const body = await resp.json();
  return body.state || null;
}
