/**
 * SSRF guard for the client-event delivery transport.
 *
 * `defaultHttpTransport` MUST refuse to POST to a callback whose host resolves
 * to a forbidden (private/loopback/link-local/metadata) address, and MUST NOT
 * follow redirects. The guard runs at delivery time (every attempt) so a host
 * that DNS-rebinds to a forbidden address after subscription-create is still
 * blocked. See openspec/changes/fix-client-event-delivery-ssrf-guard.
 *
 * Most tests below mock `globalThis.fetch` entirely, which proves the
 * block/allow decision but NOT that the validated address is the address
 * actually connected to. A guard that resolves DNS once to decide, then calls
 * `fetch(url)` with the original hostname, has a TOCTOU gap: `fetch` re-resolves
 * the hostname itself, so a low-TTL DNS record (attacker-controlled or
 * rebinding) can return a different address at connect time than the one that
 * was validated — the mocked-fetch tests above cannot see this because they
 * never let a real resolution happen. The "send-time address binding" test
 * below does not mock fetch; it spies on `node:net`'s `connect` (what the real
 * HTTP client calls to open the TCP socket) and asserts the literal address
 * dialed is the validated address, never the original hostname string. A
 * guard with the TOCTOU gap would dial the hostname (and so be vulnerable to
 * rebinding); this test fails under that implementation and passes only when
 * the checked and connected addresses are provably the same value.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { defaultHttpTransport } from '../server/client-event-delivery-worker.ts';

const req = (url) => ({
  url,
  method: 'POST',
  headers: { 'content-type': 'application/cloudevents+json' },
  body: '{}',
});

// A DNS seam that maps a hostname to a fixed address, so we can simulate a
// public host that resolves (or rebinds) to a forbidden address.
const resolvesTo = (address) => async (_hostname, _opts) => [{ address }];

test('blocks delivery when the callback host resolves to link-local metadata (169.254.169.254)', async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response('ok', { status: 200 });
  };
  try {
    const res = await defaultHttpTransport(req('https://rebind.example/hook'), {
      dnsLookupImpl: resolvesTo('169.254.169.254'),
    });
    assert.equal(fetched, false, 'must NOT issue the HTTP request');
    assert.equal(res.statusCode, null, 'blocked delivery has no status code');
    assert.match(res.errorMessage ?? '', /blocked/i);
    assert.match(res.errorMessage ?? '', /169\.254\.169\.254/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('blocks delivery when the callback host resolves to loopback (127.0.0.1)', async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response('ok', { status: 200 });
  };
  try {
    const res = await defaultHttpTransport(req('https://rebind.example/hook'), {
      dnsLookupImpl: resolvesTo('127.0.0.1'),
    });
    assert.equal(fetched, false, 'must NOT issue the HTTP request');
    assert.equal(res.statusCode, null);
    assert.match(res.errorMessage ?? '', /forbidden|blocked/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('allows delivery to a public-resolving host and sets redirect: manual', async () => {
  let fetchedUrl = null;
  let fetchedInit = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchedUrl = url;
    fetchedInit = init;
    return new Response('ok', { status: 202, headers: { 'retry-after': '5' } });
  };
  try {
    const res = await defaultHttpTransport(req('https://receiver.example/hook'), {
      dnsLookupImpl: resolvesTo('93.184.216.34'), // public (example.com range)
    });
    assert.equal(fetchedUrl, 'https://receiver.example/hook', 'public host is fetched normally');
    assert.equal(fetchedInit.redirect, 'manual', 'delivery must not follow redirects');
    assert.equal(res.statusCode, 202, 'response passthrough unchanged');
    assert.equal(res.responseHeaders?.['retry-after'], '5', 'retry-after captured unchanged');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('allows the sanctioned http loopback dev callback without an IP check', async () => {
  // http://127.0.0.1 and http://localhost are the exact exception the create-time
  // validator permits; delivery must not block them (the e2e receiver uses this).
  for (const url of ['http://127.0.0.1:5555/hook', 'http://localhost:5555/hook', 'http://[::1]:5555/hook']) {
    let fetchedUrl = null;
    let dnsCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (u) => {
      fetchedUrl = u;
      return new Response('ok', { status: 200 });
    };
    try {
      const res = await defaultHttpTransport(req(url), {
        // If the guard tried to DNS-check the loopback dev host, this would flip.
        dnsLookupImpl: async () => {
          dnsCalled = true;
          return [{ address: '127.0.0.1' }];
        },
      });
      assert.equal(fetchedUrl, url, `${url} must be delivered`);
      assert.equal(dnsCalled, false, `${url} must be exempt from the DNS/IP check`);
      assert.equal(res.statusCode, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('blocks delivery when the callback host fails to resolve', async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response('ok', { status: 200 });
  };
  try {
    const res = await defaultHttpTransport(req('https://nx.example/hook'), {
      dnsLookupImpl: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    assert.equal(fetched, false, 'must NOT fetch when DNS resolution fails');
    assert.equal(res.statusCode, null);
    assert.match(res.errorMessage ?? '', /DNS resolution failed/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('send-time address binding: the connected address is the validated address, not a re-resolved hostname (TOCTOU/rebinding proof)', async () => {
  // A real HTTP server on loopback stands in for "the address that passed
  // validation." The callback URL's hostname is deliberately unresolvable
  // (.invalid TLD, RFC 2606) so the ONLY way this request can succeed is if
  // the transport connects directly to the validated IP without re-resolving
  // the hostname — exactly the property a split lookup/fetch implementation
  // does not have.
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const originalConnect = net.connect;
  const dialedHosts = [];
  net.connect = function spiedConnect(opts, ...rest) {
    dialedHosts.push(opts && opts.host);
    return originalConnect.call(this, opts, ...rest);
  };

  try {
    const res = await defaultHttpTransport(
      req(`http://rebind-proof.invalid:${port}/hook`),
      {
        // Simulates the address that passed the SSRF check (a stand-in for a
        // real public address; validation is stubbed to accept it here so the
        // test isolates address-binding from the allow/block decision, which
        // is already covered above).
        dnsLookupImpl: async () => [{ address: '127.0.0.1' }],
        isGlobalUnicastAddressImpl: () => true,
      },
    );

    assert.equal(res.statusCode, 200, 'delivery must succeed by reaching the validated address directly');
    assert.deepEqual(
      dialedHosts,
      ['127.0.0.1'],
      'net.connect must be called with the validated IP literal, never the original hostname ' +
        '(a re-resolving implementation would dial "rebind-proof.invalid" and fail, since that ' +
        'hostname cannot resolve — or worse, would resolve to whatever a rebinding attacker returns)',
    );
  } finally {
    net.connect = originalConnect;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('send-time address binding: the sanctioned loopback dev exemption is unaffected (no pinning applied)', async () => {
  // The exemption path skips the DNS/IP check entirely (proven above), so it
  // must also skip address pinning and use ordinary resolution — this test
  // proves that not pinning here doesn't silently break the exempt path.
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const res = await defaultHttpTransport(req(`http://127.0.0.1:${port}/hook`), {
      dnsLookupImpl: async () => {
        throw new Error('must not be called for the exempt path');
      },
    });
    assert.equal(res.statusCode, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
