// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Consent + owner-device-auth conformance harness.
 *
 * Test-only helper. Defines durable obligations of the reference auth
 * substrate (pending-consent + owner-device authorization) as reusable
 * scenarios that any candidate driver can be run against.
 *
 * The driver shape is intentionally narrow and *semantic*: it speaks in
 * lifecycle operations (start / lookup / approve / deny / exchange / expire),
 * not in raw SQL, table names, query builders, or a generic repository
 * surface. It is not exported from production code and SHALL NOT be treated
 * as a production `ConsentStore` / `OwnerDeviceAuthStore` contract.
 *
 * Driver shape:
 *
 *   {
 *     async setup(): void
 *     async teardown(): void
 *
 *     // Pending consent (third-party data grant flow).
 *     // Returns { request_uri, approval_id }.
 *     async startPendingConsent(input): { request_uri, approval_id }
 *
 *     // Public consent lookup keyed by request_uri. Returns null if the
 *     // pending consent is no longer available (expired, approved, denied,
 *     // unknown). The reference's public lookup intentionally surfaces the
 *     // user_code so the consent UI can show it; secret redaction of the
 *     // device_code is the route-level concern and NOT pinned here.
 *     async lookupPendingConsentByRequestUri(request_uri): publicView | null
 *
 *     // Approval-id lookup. The harness only asserts: (a) it returns a
 *     // record for the right approval_id, (b) the record discloses the
 *     // bound subject and grant once approved. The full _ref/approvals
 *     // route projection's no-leak property is route-level and stays in
 *     // `security-device-code-exposure.test.js`.
 *     async lookupPendingConsentByApprovalId(approval_id): adminView | null
 *
 *     async approvePendingConsent(request_uri): { grant, token }
 *     async denyPendingConsent(request_uri): boolean
 *
 *     // Test-only seam: force the row's `expires_at` into the past so the
 *     // expiry transition is deterministic in tests. Drivers that cannot
 *     // simulate time MUST throw a `not_supported` error here; the
 *     // expiry-coverage scenarios are skipped on those drivers and
 *     // explicitly deferred to route-level tests.
 *     async forceExpirePendingConsent(request_uri): void
 *
 *     // Owner-device authorization (RFC 8628-shaped owner-token issuance).
 *     // Returns { device_code, user_code, interval, expires_in, approval_id }.
 *     async startOwnerDeviceAuth(input): startResult
 *
 *     // Public lookup by user_code (verification UI surface). Returns null
 *     // when not pending or expired.
 *     async lookupOwnerDeviceAuthByUserCode(user_code): publicView | null
 *
 *     // Approval-id lookup; same shape contract as pending consent.
 *     async lookupOwnerDeviceAuthByApprovalId(approval_id): adminView | null
 *
 *     async approveOwnerDeviceAuth(user_code): { access_token, ... }
 *     async denyOwnerDeviceAuth(user_code): void
 *
 *     // Polling token exchange. MUST throw a typed error with `code`:
 *     //   'authorization_pending' | 'slow_down' | 'access_denied' |
 *     //   'expired_token' | 'invalid_grant' | 'invalid_client' |
 *     //   'invalid_request'
 *     // when the grant is not redeemable.
 *     async exchangeOwnerDeviceCode(input): { access_token, ... }
 *
 *     async forceExpireOwnerDeviceAuth(device_code): void
 *
 *     // Test-only seam: rewind the row's `last_polled_at` so a
 *     // subsequent poll is treated as having waited at least one
 *     // polling interval. Drivers that cannot simulate this MUST
 *     // throw `not_supported`.
 *     async rewindOwnerDevicePollTimer(device_code): void
 *
 *     // Sample registered client_id seeded by setup().
 *     getRegisteredClientId(): string
 *
 *     // Sample manifest connector_id seeded by setup().
 *     getRegisteredConnectorId(): string
 *   }
 *
 * Spec: openspec/changes/add-consent-device-auth-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';

function assertNotSupported(err) {
  return err instanceof Error && err.code === 'not_supported';
}

/**
 * Run the consent + owner-device-auth conformance suite against a driver.
 *
 * @param {object} options
 * @param {string} options.label                                                 distinguishes the driver in test names
 * @param {(name: string, fn: () => Promise<void>) => void} options.test        test runner (e.g. `node:test`'s `test`)
 * @param {() => Promise<object> | object} options.makeDriver                     returns a fresh driver per scenario
 */
export function runConsentDeviceAuthConformance({ label, test, makeDriver }) {
  const t = (name, fn) => test(`[conformance:${label}] ${name}`, fn);

  // -----------------------------------------------------------------------
  // Pending consent lifecycle.
  // -----------------------------------------------------------------------

  // 1. Start + public lookup. A fresh pending consent must be discoverable
  //    via its request_uri until it terminates. The lookup must surface the
  //    user_code so the consent UI can render it, but it must not yet be
  //    bound to a grant.
  t('pending consent: startPendingConsent → lookup returns a pending view bound to the same user_code', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startPendingConsent({
        purpose_description: 'pending consent: start + public lookup',
      });
      assert.ok(start.request_uri, 'startPendingConsent must return a request_uri');
      assert.ok(start.approval_id, 'startPendingConsent must return an approval_id');
      assert.notEqual(
        start.approval_id,
        start.request_uri,
        'approval_id MUST be a separate identifier from request_uri',
      );

      const view = await driver.lookupPendingConsentByRequestUri(start.request_uri);
      assert.ok(view, 'pending consent must be discoverable by request_uri while pending');
      assert.ok(view.user_code, 'pending consent lookup must surface user_code for the consent UI');
    } finally {
      await driver.teardown();
    }
  });

  // 2. Approval terminates the pending row. After approval, the public
  //    lookup MUST stop returning the pending view (the row is no longer
  //    available for re-approval), and a second approval MUST fail with
  //    `not_found`. This pins the terminal-state invariant: approve is a
  //    one-shot transition, not idempotent.
  t('pending consent: approval is terminal — public lookup disappears and re-approval fails', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startPendingConsent({
        purpose_description: 'pending consent: approval is terminal',
      });

      const result = await driver.approvePendingConsent(start.request_uri);
      assert.ok(result?.grant, 'approve must return a grant');
      assert.ok(result?.token, 'approve must return a token');
      assert.equal(typeof result.token, 'string');
      assert.ok(result.token.length > 0);

      const afterApprove = await driver.lookupPendingConsentByRequestUri(start.request_uri);
      assert.equal(
        afterApprove,
        null,
        'after approval, public lookup MUST NOT return a pending view',
      );

      let reApproveError = null;
      try {
        await driver.approvePendingConsent(start.request_uri);
      } catch (err) {
        reApproveError = err;
      }
      assert.ok(reApproveError, 're-approval after approval MUST throw');
      assert.equal(
        reApproveError.code,
        'not_found',
        `re-approval error MUST carry code='not_found'; got '${reApproveError.code}'`,
      );
    } finally {
      await driver.teardown();
    }
  });

  // 3. Denial terminates the pending row. After denial, public lookup MUST
  //    return null, approval MUST fail, and a second denial MUST be a
  //    no-op (return false, not throw) — denial is idempotent in the
  //    reference today, but the public flow must not silently re-deny by
  //    rewriting state.
  t('pending consent: denial is terminal — lookup disappears, approve fails, redeny is a no-op', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startPendingConsent({
        purpose_description: 'pending consent: denial is terminal',
      });

      const denied = await driver.denyPendingConsent(start.request_uri);
      assert.equal(denied, true, 'first denial MUST report success');

      const afterDeny = await driver.lookupPendingConsentByRequestUri(start.request_uri);
      assert.equal(afterDeny, null, 'after denial, public lookup MUST return null');

      let approveErr = null;
      try {
        await driver.approvePendingConsent(start.request_uri);
      } catch (err) {
        approveErr = err;
      }
      assert.ok(approveErr, 'approve after deny MUST throw');
      assert.equal(approveErr.code, 'not_found',
        `approve-after-deny error MUST carry code='not_found'; got '${approveErr.code}'`);

      const redeny = await driver.denyPendingConsent(start.request_uri);
      assert.equal(redeny, false, 'second denial MUST be a no-op (return false)');
    } finally {
      await driver.teardown();
    }
  });

  // 4. Approval-id indirection. The approval_id is the dashboard/control-
  //    plane handle and is NOT the request_uri or the device_code. The
  //    harness pins: (a) approval_id resolves to the same logical row as
  //    the request_uri, (b) once approved, the approval-id projection
  //    reflects the approved state and the issued grant. Whether the
  //    public _ref/approvals projection scrubs device_code/user_code is
  //    a route-level concern and stays in
  //    `security-device-code-exposure.test.js`; see harness docstring.
  t('pending consent: approval_id resolves to the same record and reflects approval', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startPendingConsent({
        purpose_description: 'pending consent: approval_id indirection',
      });
      assert.ok(start.approval_id);

      const beforeApprove = await driver.lookupPendingConsentByApprovalId(start.approval_id);
      assert.ok(beforeApprove, 'approval_id lookup MUST return the staged pending row');
      assert.equal(
        beforeApprove.status,
        'pending',
        `approval_id lookup MUST report status='pending' before approval; got '${beforeApprove.status}'`,
      );

      const { grant } = await driver.approvePendingConsent(start.request_uri);

      const afterApprove = await driver.lookupPendingConsentByApprovalId(start.approval_id);
      assert.ok(afterApprove, 'approval_id lookup MUST keep returning the same record after approval');
      assert.equal(
        afterApprove.status,
        'approved',
        `approval_id lookup MUST report status='approved' after approval; got '${afterApprove.status}'`,
      );
      assert.equal(
        afterApprove.grant_id,
        grant.grant_id,
        'approval_id lookup MUST surface the issued grant_id after approval',
      );
    } finally {
      await driver.teardown();
    }
  });

  // 5. Expired pending consent becomes unavailable. The public lookup
  //    MUST stop returning the pending view, and approval/denial MUST
  //    fail with the expected error shape rather than silently succeeding.
  //    Drivers that cannot simulate time signal `not_supported`; on those
  //    drivers, this scenario is intentionally skipped.
  t('pending consent: expired requests are unavailable for lookup, approval, or denial', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startPendingConsent({
        purpose_description: 'pending consent: expiry',
      });

      try {
        await driver.forceExpirePendingConsent(start.request_uri);
      } catch (err) {
        if (assertNotSupported(err)) {
          // Driver cannot simulate expiry — explicit deferral to route-level
          // tests. The harness still documents the obligation in this scenario.
          return;
        }
        throw err;
      }

      const view = await driver.lookupPendingConsentByRequestUri(start.request_uri);
      assert.equal(view, null, 'expired pending consent MUST NOT be returned by public lookup');

      let approveErr = null;
      try {
        await driver.approvePendingConsent(start.request_uri);
      } catch (err) {
        approveErr = err;
      }
      assert.ok(approveErr, 'approve on an expired pending consent MUST throw');
      assert.equal(
        approveErr.code,
        'not_found',
        `expired-approve error MUST carry code='not_found'; got '${approveErr.code}'`,
      );

      const redeny = await driver.denyPendingConsent(start.request_uri);
      assert.equal(redeny, false, 'deny on an expired pending consent MUST report no-op (false)');
    } finally {
      await driver.teardown();
    }
  });

  // -----------------------------------------------------------------------
  // Owner device authorization lifecycle.
  // -----------------------------------------------------------------------

  // 6. Start emits a usable RFC 8628-shaped envelope: a device_code that
  //    the client polls with, a user_code that the owner enters, an
  //    interval, an expires_in, and a separate approval_id for control-
  //    plane reads.
  t('owner device auth: start returns RFC 8628-shaped fields plus a separate approval_id', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startOwnerDeviceAuth({});
      assert.ok(start.device_code, 'start must return a device_code');
      assert.ok(start.user_code, 'start must return a user_code');
      assert.ok(typeof start.interval === 'number' && start.interval > 0,
        `interval must be a positive number, got ${start.interval}`);
      assert.ok(typeof start.expires_in === 'number' && start.expires_in > 0,
        `expires_in must be a positive number, got ${start.expires_in}`);
      assert.ok(start.approval_id, 'start must return an approval_id');
      assert.notEqual(start.approval_id, start.device_code,
        'approval_id MUST NOT be the device_code itself');
      assert.notEqual(start.approval_id, start.user_code,
        'approval_id MUST NOT be the user_code itself');
    } finally {
      await driver.teardown();
    }
  });

  // 6b. Public lookup by user_code returns the pending view bound to the
  //     same client_id, interval, created_at, expires_at envelope as
  //     `start` produced. This pins the verification-UI surface: until
  //     the row reaches a terminal state, the user_code remains
  //     resolvable and exposes exactly the fields the verification UI
  //     needs (no token, no device_code, no subject_id). The negative
  //     side of this property — that the lookup disappears once the row
  //     terminates — is pinned by the approve and deny terminal scenarios
  //     below; this scenario is the positive companion.
  t('owner device auth: lookupOwnerDeviceAuthByUserCode returns the pending view until terminal state', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startOwnerDeviceAuth({});

      const view = await driver.lookupOwnerDeviceAuthByUserCode(start.user_code);
      assert.ok(view, 'public user_code lookup MUST return the pending view while pending');
      assert.equal(
        view.client_id,
        driver.getRegisteredClientId(),
        'public user_code lookup MUST surface the registered client_id',
      );
      assert.equal(
        view.interval,
        start.interval,
        `public user_code lookup MUST surface the same interval as start (${start.interval}); got ${view.interval}`,
      );
      assert.ok(view.created_at, 'public user_code lookup MUST surface created_at');
      assert.ok(view.expires_at, 'public user_code lookup MUST surface expires_at');
      assert.ok(
        new Date(view.expires_at).getTime() > new Date(view.created_at).getTime(),
        'expires_at MUST be strictly after created_at',
      );

      // Lookup MUST be stable across repeated calls before terminal state.
      const viewAgain = await driver.lookupOwnerDeviceAuthByUserCode(start.user_code);
      assert.ok(viewAgain, 'public user_code lookup MUST keep returning the pending view on repeated calls');
      assert.equal(viewAgain.client_id, view.client_id);
      assert.equal(viewAgain.interval, view.interval);
      assert.equal(viewAgain.created_at, view.created_at);
      assert.equal(viewAgain.expires_at, view.expires_at);
    } finally {
      await driver.teardown();
    }
  });

  // 7. Poll-before-approval returns `authorization_pending`. The poller
  //    MUST not receive a token while the owner has not yet approved.
  t('owner device auth: poll before approval throws authorization_pending', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startOwnerDeviceAuth({});
      let err = null;
      try {
        await driver.exchangeOwnerDeviceCode({
          client_id: driver.getRegisteredClientId(),
          device_code: start.device_code,
        });
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'poll before approval MUST throw');
      assert.equal(
        err.code,
        'authorization_pending',
        `poll-before-approval MUST throw code='authorization_pending'; got '${err.code}'`,
      );
    } finally {
      await driver.teardown();
    }
  });

  // 8. Polling too quickly (within `interval` seconds) returns `slow_down`.
  //    Drivers that cannot simulate the polling clock signal
  //    `not_supported`; on those drivers this scenario is skipped and
  //    the property is explicitly deferred to route-level tests.
  t('owner device auth: polling faster than the interval throws slow_down', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startOwnerDeviceAuth({});

      // First poll — must throw authorization_pending and update the
      // last_polled_at marker. We swallow this so we can test the second
      // (rapid) poll's slow_down behavior without contaminating it.
      try {
        await driver.exchangeOwnerDeviceCode({
          client_id: driver.getRegisteredClientId(),
          device_code: start.device_code,
        });
      } catch (e) {
        // Expected: authorization_pending. Anything else is a regression
        // of scenario 7 and we surface it.
        if (e.code !== 'authorization_pending') {
          throw e;
        }
      }

      // Immediately re-poll — within the interval, this MUST throw
      // slow_down rather than authorization_pending.
      let err = null;
      try {
        await driver.exchangeOwnerDeviceCode({
          client_id: driver.getRegisteredClientId(),
          device_code: start.device_code,
        });
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'rapid second poll MUST throw');
      assert.equal(
        err.code,
        'slow_down',
        `rapid second poll MUST throw code='slow_down'; got '${err.code}'`,
      );
    } finally {
      await driver.teardown();
    }
  });

  // 9. Approve + exchange round-trip mints a usable owner access_token.
  //    Polling timer must be advanced so the post-approval exchange isn't
  //    rejected as `slow_down`. Drivers that cannot rewind the polling
  //    timer signal `not_supported` — those drivers can still cover this
  //    scenario in a fresh start (no prior poll), which is what we do.
  t('owner device auth: approve + exchange round-trip yields an owner access token', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startOwnerDeviceAuth({});

      const approveResult = await driver.approveOwnerDeviceAuth(start.user_code);
      assert.ok(approveResult.access_token,
        'approveOwnerDeviceAuth MUST return an owner access_token');

      const exchange = await driver.exchangeOwnerDeviceCode({
        client_id: driver.getRegisteredClientId(),
        device_code: start.device_code,
      });
      assert.ok(exchange.access_token,
        'exchangeOwnerDeviceCode after approval MUST return an access_token');
      assert.equal(
        exchange.access_token,
        approveResult.access_token,
        'exchange MUST return the same access_token that approval minted',
      );

      // Public lookup by user_code MUST stop returning a pending view
      // once the row is approved.
      const afterApprove = await driver.lookupOwnerDeviceAuthByUserCode(start.user_code);
      assert.equal(
        afterApprove,
        null,
        'after approval, public user_code lookup MUST NOT return a pending view',
      );
    } finally {
      await driver.teardown();
    }
  });

  // 9b. Owner-device approval is terminal. After approveOwnerDeviceAuth
  //     succeeds, a second approveOwnerDeviceAuth on the same user_code
  //     MUST fail with `not_found` — re-approval cannot re-mint a second
  //     owner token against the same row. The originally-issued token
  //     remains usable for exchange (the row is bound to it), so the
  //     poller's contract is not retroactively broken by the rejected
  //     re-approval. This pairs with scenario 2's pending-consent
  //     terminal-approval invariant; the same invariant must hold for
  //     the owner-device flow.
  t('owner device auth: approval is terminal — re-approval throws not_found, original token still exchanges', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startOwnerDeviceAuth({});

      const firstApprove = await driver.approveOwnerDeviceAuth(start.user_code);
      assert.ok(firstApprove.access_token,
        'first approveOwnerDeviceAuth MUST mint an access_token');
      const originalToken = firstApprove.access_token;

      let reApproveErr = null;
      try {
        await driver.approveOwnerDeviceAuth(start.user_code);
      } catch (err) {
        reApproveErr = err;
      }
      assert.ok(reApproveErr, 're-approval after approval MUST throw');
      assert.equal(
        reApproveErr.code,
        'not_found',
        `re-approval error MUST carry code='not_found'; got '${reApproveErr.code}'`,
      );

      // The original token MUST still exchange — the rejected re-approval
      // is not allowed to invalidate the already-issued bearer.
      const exchange = await driver.exchangeOwnerDeviceCode({
        client_id: driver.getRegisteredClientId(),
        device_code: start.device_code,
      });
      assert.ok(exchange.access_token,
        'exchange after a rejected re-approval MUST still return the original access_token');
      assert.equal(
        exchange.access_token,
        originalToken,
        'exchange MUST return the token minted by the FIRST approval, unchanged',
      );
    } finally {
      await driver.teardown();
    }
  });

  // 10. Denial terminates the row. After denial, lookup MUST return null,
  //     approval MUST throw `not_found`, and exchange MUST throw
  //     `access_denied`. This pins the denied-vs-approved distinction
  //     surfaced to the polling client.
  t('owner device auth: denial is terminal — exchange throws access_denied', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startOwnerDeviceAuth({});

      await driver.denyOwnerDeviceAuth(start.user_code);

      const afterDeny = await driver.lookupOwnerDeviceAuthByUserCode(start.user_code);
      assert.equal(afterDeny, null,
        'after denial, public user_code lookup MUST NOT return a pending view');

      let approveErr = null;
      try {
        await driver.approveOwnerDeviceAuth(start.user_code);
      } catch (e) {
        approveErr = e;
      }
      assert.ok(approveErr, 'approve after deny MUST throw');
      assert.equal(approveErr.code, 'not_found',
        `approve-after-deny MUST throw code='not_found'; got '${approveErr.code}'`);

      let exchangeErr = null;
      try {
        await driver.exchangeOwnerDeviceCode({
          client_id: driver.getRegisteredClientId(),
          device_code: start.device_code,
        });
      } catch (e) {
        exchangeErr = e;
      }
      assert.ok(exchangeErr, 'exchange after deny MUST throw');
      assert.equal(exchangeErr.code, 'access_denied',
        `exchange-after-deny MUST throw code='access_denied'; got '${exchangeErr.code}'`);
    } finally {
      await driver.teardown();
    }
  });

  // 11. Expired owner-device authorization rejects exchange with
  //     `expired_token`. Drivers that cannot simulate expiry signal
  //     `not_supported` and skip.
  t('owner device auth: expired requests reject exchange with expired_token', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startOwnerDeviceAuth({});

      try {
        await driver.forceExpireOwnerDeviceAuth(start.device_code);
      } catch (err) {
        if (assertNotSupported(err)) return;
        throw err;
      }

      let exchangeErr = null;
      try {
        await driver.exchangeOwnerDeviceCode({
          client_id: driver.getRegisteredClientId(),
          device_code: start.device_code,
        });
      } catch (e) {
        exchangeErr = e;
      }
      assert.ok(exchangeErr, 'exchange on expired device auth MUST throw');
      assert.equal(exchangeErr.code, 'expired_token',
        `expired exchange MUST throw code='expired_token'; got '${exchangeErr.code}'`);

      const view = await driver.lookupOwnerDeviceAuthByUserCode(start.user_code);
      assert.equal(view, null,
        'expired owner device auth MUST NOT be returned by public lookup');
    } finally {
      await driver.teardown();
    }
  });

  // 12. Approval-id indirection (owner-device): the approval_id resolves
  //     to the same logical row as the device_code/user_code triple, and
  //     once approved, the approval_id projection reflects that.
  t('owner device auth: approval_id resolves to the same record and reflects approval', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const start = await driver.startOwnerDeviceAuth({});

      const before = await driver.lookupOwnerDeviceAuthByApprovalId(start.approval_id);
      assert.ok(before, 'approval_id lookup MUST return the staged owner-device row');
      assert.equal(before.status, 'pending',
        `approval_id lookup MUST report status='pending' before approval; got '${before.status}'`);

      await driver.approveOwnerDeviceAuth(start.user_code);

      const after = await driver.lookupOwnerDeviceAuthByApprovalId(start.approval_id);
      assert.ok(after, 'approval_id lookup MUST keep returning the same record after approval');
      assert.equal(after.status, 'approved',
        `approval_id lookup MUST report status='approved' after approval; got '${after.status}'`);
    } finally {
      await driver.teardown();
    }
  });
}
