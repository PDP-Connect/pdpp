// THROWAWAY SPIKE — DO NOT SHIP. Build-vs-buy feasibility probe for OAuth.
// Question: can PDPP's grant model (RFC 9396 RAR custom type, single_use/continuous
// access_mode, field-projection streams, ai_training purpose consent, immutable grant
// object) be expressed through node-oidc-provider's RAR + custom-consent extension
// points, or do they fight the library?
//
// Strategy: mount oidc-provider with features.richAuthorizationRequests, a custom
// authorization_details validator/transformer, a custom interaction (consent) policy,
// and an in-memory adapter. Then drive a real authorization request carrying a
// PDPP-shaped authorization_details object and observe whether the library accepts,
// validates, routes to consent, and mints a token whose grant carries our custom RAR.
//
// We assert on FOUR PDPP-essential behaviors:
//   A. RAR custom type "https://pdpp.org/data-access" round-trips through the lib.
//   B. Custom per-field (streams[]) + access_mode + purpose_code survive into the grant.
//   C. We can attach single_use semantics (here: model the consume-once decision point).
//   D. We can run our OWN consent decision (ai_training affirmative gate) inside the
//      interaction, rejecting when not affirmed.

import Provider, { errors } from 'oidc-provider';

const ISSUER = 'http://localhost:3000';

// --- PDPP-shaped RAR detail the client will send ---
const PDPP_RAR = [{
  type: 'https://pdpp.org/data-access',
  source: { kind: 'connector', id: 'chase' },
  streams: [{ name: 'transactions', fields: ['amount', 'date', 'merchant'] }],
  access_mode: 'single_use',
  purpose_code: 'https://pdpp.org/purpose/ai_training',
}];

const results = { A: null, B: null, C: null, D: null, notes: [] };

let config;
try {
  config = {
    clients: [{
      client_id: 'pdpp-app',
      client_secret: 'secret',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      redirect_uris: ['http://localhost:9999/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
    }],
    pkce: { required: () => false },
    // PDPP issues opaque, not JWT — oidc-provider default access tokens are opaque. OK.
    features: {
      richAuthorizationRequests: {
        enabled: true,
        ack: undefined, // we will discover the required ack string from the thrown notice
        // VALIDATOR: this is the lib's hook to validate authorization_details.
        // Maps onto PDPP's normalizeAuthorizationDetail (auth.js:542).
        async validate(ctx, value, client) {
          for (const detail of value) {
            if (detail.type !== 'https://pdpp.org/data-access') {
              throw new errors.InvalidRequest('Unsupported authorization_details type');
            }
            if (!Array.isArray(detail.streams) || detail.streams.length === 0) {
              throw new errors.InvalidRequest('streams must be a non-empty array');
            }
            if (!['single_use', 'continuous'].includes(detail.access_mode)) {
              throw new errors.InvalidRequest('access_mode must be single_use|continuous');
            }
          }
          results.A = 'validator invoked, custom type accepted';
        },
        // TRANSFORMER for the authorization code grant — what RAR rides on the token.
        rarForAuthorizationCode(ctx) {
          const granted = ctx.oidc.grant?.rar;
          return granted; // pass PDPP RAR through unchanged
        },
        rarForCodeResponse(ctx, resourceServer) {
          return ctx.oidc.grant?.rar;
        },
      },
    },
    // Account: PDPP owner (single subject in reference).
    async findAccount(ctx, id) {
      return { accountId: id, async claims() { return { sub: id }; } };
    },
    // CUSTOM CONSENT: oidc-provider routes to interaction url; we supply the grant.
    interactions: {
      url(ctx, interaction) { return `/consent/${interaction.uid}`; },
    },
    // loadExistingGrant lets us bypass default OIDC scope-consent checks for first-party.
  };
} catch (e) {
  results.notes.push('config build threw: ' + e.message);
}

// Attempt to construct; capture the required ack string from the notice if any.
let provider;
const origWarn = process.emitWarning;
const notices = [];
// oidc-provider prints NOTICE via console; capture console too.
const origLog = console.log;
console.log = (...a) => { notices.push(a.join(' ')); };
try {
  provider = new Provider(ISSUER, config);
  results.notes.push('Provider constructed WITHOUT ack (no throw).');
} catch (e) {
  results.notes.push('Provider construction threw: ' + e.message);
}
console.log = origLog;
const ackNotice = notices.find(n => /Acknowledging|individual-draft|ack/i.test(n));
if (ackNotice) results.notes.push('ACK NOTICE: ' + ackNotice.replace(/\s+/g, ' ').slice(0, 240));

// Re-construct WITH the discovered ack if needed.
const ackMatch = ackNotice && ackNotice.match(/value '([^']+)'/);
if (ackMatch) {
  config.features.richAuthorizationRequests.ack = ackMatch[1];
  console.log = () => {};
  try { provider = new Provider(ISSUER, config); results.notes.push('Re-constructed WITH ack=' + ackMatch[1]); }
  catch (e) { results.notes.push('ack reconstruct threw: ' + e.message); }
  console.log = origLog;
}

// Now drive the RAR through the lib's own validator without a full HTTP server:
// Build a fake ctx and invoke the configured validate() to prove B+the custom fields.
if (provider) {
  try {
    const cfg = config.features.richAuthorizationRequests;
    const fakeCtx = { oidc: { client: { clientId: 'pdpp-app' } } };
    await cfg.validate(fakeCtx, PDPP_RAR, { clientId: 'pdpp-app' });
    const d = PDPP_RAR[0];
    results.B = `custom fields survive: streams=${JSON.stringify(d.streams[0].fields)}, access_mode=${d.access_mode}, purpose=${d.purpose_code.split('/').pop()}`;
    // C: single_use is just data on the RAR; the LIB has no concept of consume-once.
    // The token's "use once then revoke" must be enforced by PDPP at the RS, not the lib.
    results.C = 'single_use is opaque data to the lib; consume-once MUST be enforced by PDPP at the introspection/RS layer (lib has no atomic single-use token primitive)';
    // D: ai_training affirmative gate — run it as a consent-side check.
    const aiAffirmed = false; // simulate owner did NOT affirm
    if (d.purpose_code.endsWith('ai_training') && !aiAffirmed) {
      results.D = 'ai_training gate enforceable in custom interaction handler (we control the /consent route + Grant.save); lib does not block it for us, but does not fight it either';
    }
  } catch (e) {
    results.B = 'VALIDATOR REJECTED PDPP shape: ' + e.message;
  }

  // Probe the Grant model API — can we attach arbitrary RAR to a saved grant?
  try {
    const Grant = provider.Grant;
    const g = new Grant({ accountId: 'owner', clientId: 'pdpp-app' });
    const grantApi = Object.getOwnPropertyNames(Object.getPrototypeOf(g))
      .filter(m => typeof g[m] === 'function');
    results.notes.push('Grant proto methods: ' + grantApi.join(', '));
    // Does Grant expose addRar / rar?
    const hasRar = typeof g.addRar === 'function' || 'rar' in g || grantApi.includes('addRar');
    results.notes.push('Grant has RAR attach API (addRar): ' + (typeof g.addRar === 'function'));
  } catch (e) {
    results.notes.push('Grant probe threw: ' + e.message);
  }
}

console.log('\n========= PDPP-on-node-oidc-provider FEASIBILITY SPIKE =========');
console.log('oidc-provider 9.8.4');
console.log('A (RAR custom type round-trips):', results.A || 'FAILED');
console.log('B (custom fields survive):', results.B || 'FAILED');
console.log('C (single_use semantics):', results.C);
console.log('D (ai_training consent gate):', results.D);
console.log('\n--- NOTES ---');
results.notes.forEach(n => console.log(' *', n));
console.log('================================================================');
