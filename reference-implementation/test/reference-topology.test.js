import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REFERENCE_BROWSER_ORIGIN,
  REFERENCE_MODE_COMPOSED,
  REFERENCE_MODE_DIRECT,
  resolveReferenceBrowserOrigin,
  resolveReferenceMode,
  resolveReferenceTopology,
} from '../server/reference-topology.ts';

test('reference topology defaults to direct mode when no composed-origin signals are present', () => {
  assert.equal(
    resolveReferenceMode({
      env: {},
    }),
    REFERENCE_MODE_DIRECT,
  );
});

test('reference topology switches to composed mode from explicit mode or browser-origin signals', () => {
  assert.equal(
    resolveReferenceMode({
      explicitMode: 'composed',
      env: {},
    }),
    REFERENCE_MODE_COMPOSED,
  );
  assert.equal(
    resolveReferenceMode({
      env: { PDPP_REFERENCE_ORIGIN: 'http://localhost:3200' },
    }),
    REFERENCE_MODE_COMPOSED,
  );
  assert.equal(
    resolveReferenceMode({
      env: { AS_PUBLIC_URL: 'http://localhost:3200' },
    }),
    REFERENCE_MODE_COMPOSED,
  );
});

test('reference topology ignoreAmbient keeps ephemeral servers honest', () => {
  assert.equal(
    resolveReferenceMode({
      ignoreAmbient: true,
      env: {
        PDPP_REFERENCE_MODE: 'composed',
        PDPP_REFERENCE_ORIGIN: 'http://localhost:3200',
        AS_PUBLIC_URL: 'http://localhost:3200',
        RS_PUBLIC_URL: 'http://localhost:3200',
      },
    }),
    REFERENCE_MODE_DIRECT,
  );
});

test('reference topology resolves composed public urls from the browser origin', () => {
  const topology = resolveReferenceTopology({
    explicitMode: 'composed',
    referenceOrigin: 'http://localhost:3200/',
    env: {},
  });

  assert.equal(topology.mode, REFERENCE_MODE_COMPOSED);
  assert.equal(topology.browserOrigin, 'http://localhost:3200');
  assert.equal(topology.asPublicUrl, 'http://localhost:3200');
  assert.equal(topology.rsPublicUrl, 'http://localhost:3200');
});

test('reference browser origin falls back to the default local web origin', () => {
  assert.equal(
    resolveReferenceBrowserOrigin({ env: {} }),
    DEFAULT_REFERENCE_BROWSER_ORIGIN,
  );
});
