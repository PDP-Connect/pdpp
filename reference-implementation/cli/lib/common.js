import { readFileSync } from 'node:fs';

import { PdppUsageError } from './errors.js';

export function resolveAsUrl(flags) {
  return flags['as-url'] || process.env.PDPP_AS_URL || process.env.AS_URL || 'http://localhost:7662';
}

export function resolveRsUrl(flags) {
  return flags['rs-url'] || process.env.PDPP_RS_URL || process.env.RS_URL || 'http://localhost:7663';
}

export function resolveOwnerToken(flags) {
  return flags.token || process.env.PDPP_OWNER_TOKEN || process.env.VANA_PS_TOKEN || null;
}

export function resolveClientToken(flags) {
  return flags.token || process.env.PDPP_CLIENT_TOKEN || null;
}

export function resolveInitialAccessToken(flags) {
  return flags['initial-access-token'] || process.env.PDPP_INITIAL_ACCESS_TOKEN || null;
}

export function readJsonInput(pathOrDash) {
  const raw = pathOrDash === '-' ? readFileSync(0, 'utf8') : readFileSync(pathOrDash, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new PdppUsageError(`Invalid JSON input: ${error.message}`);
  }
}

export function appendQuery(url, params) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    next.searchParams.set(key, String(value));
  }
  return next.toString();
}
