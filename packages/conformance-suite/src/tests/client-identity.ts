// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// URL-hosted client identity: the interoperability floor Core Section 6 sets
// for clients an authorization server has never seen before.
//
// Two clauses, and they are the same obligation stated from both sides:
//
//   6.1-2  the AS MUST NOT reject a valid client ID metadata document SOLELY
//          because the client is not preregistered.
//   6.1-4  for v0.1 interoperability, the AS MUST accept a valid URL-hosted
//          client identity unless local policy denies authorization.
//
// Why this matters more than it looks. Without it, every client-AS pair needs
// an out-of-band registration step before any authorization can happen, which
// is exactly the bilateral arrangement a protocol exists to avoid. A server
// that quietly requires preregistration is interoperable with nobody it has not
// already met, while looking perfectly conformant on every other surface.
//
// The hard part is not the positive case; it is telling a FORBIDDEN rejection
// apart from a PERMITTED one. Clause 6.1-3 expressly allows the AS to "deny
// authorization, rate-limit the client, or require a registry-derived trust or
// admission result, under local policy and for any reason other than the
// absence of preregistration". So "the AS said no" is not a finding. What these
// cases establish is narrower and is the only thing that can be established
// from outside: that a valid document is RESOLVED, and that an invalid one is
// refused — which together show the server is deciding on the identity rather
// than on the absence of a prior relationship.
//
// Every case here serves its own document over real HTTP, so the AS performs a
// genuine outbound fetch. A document the AS never retrieved cannot be a
// document it wrongly accepted, and the malformed case would prove nothing
// against a target that was simply handed a body.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TargetAdapter, UrlHostedClientOutcome } from "../harness/adapter.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";

const NO_HOOK =
  "The adapter has no offerUrlHostedClientIdentity hook, so no client identity document can be presented to this AS and the unregistered-client interoperability obligation is unobservable.";

/**
 * A document server on a host the target trusts.
 *
 * Bound to 127.0.0.1 rather than a public interface: the document only has to
 * be reachable by the AS under test, and a suite that opened a port to the
 * network to run a test would be a worse neighbour than the bug it is looking
 * for.
 */
async function serveDocument(): Promise<{
  readonly url: string;
  /** Replace what the server serves, before the next offer. */
  readonly setBody: (body: string) => void;
  readonly close: () => Promise<void>;
}> {
  let current = "";
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(current);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/client-metadata.json`,
    setBody: (body: string) => {
      current = body;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function outcomeEvidence(label: string, outcome: UrlHostedClientOutcome): Evidence {
  return {
    request: { method: "POST", url: label, headers: {} },
    response: {
      status: outcome.status ?? 0,
      headers: {},
      body: typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body ?? null),
    },
  };
}

/**
 * The host the target says it trusts, or null when it trusts none.
 *
 * A refusal is only attributable to these clauses when the host was trusted in
 * the first place: a document served from an untrusted host is refused by the
 * SSRF gate every conforming implementation has, which is a policy denial
 * (6.1-3) and not evidence about 6.1-2 or 6.1-4.
 */
function trustsLoopback(adapter: TargetAdapter): boolean {
  const hosts = adapter.urlHostedClientHosts ?? [];
  return hosts.includes("127.0.0.1");
}

/** A valid client ID metadata document asserting the URL it is served from. */
function validDocument(documentUrl: string, redirectUri: string): string {
  return JSON.stringify({
    client_id: documentUrl,
    client_name: "PDPP conformance URL-hosted client",
    redirect_uris: [redirectUri],
  });
}

const REDIRECT_URI = "http://127.0.0.1/conformance-url-hosted-callback";

export const CLIENT_IDENTITY_CASES: readonly ConformanceCase[] = [
  // ------------------------------------------------------- 6.1-2 / 6.1-4 ---
  {
    caseId: "AS-7/valid-url-hosted-client-identity-accepted",
    requirementId: "AS-7",
    assertion:
      "A valid URL-hosted client identity document from a trusted host is resolved and the client admitted, rather than refused for not being preregistered.",
    async run({ adapter }) {
      if (!adapter.offerUrlHostedClientIdentity) {
        return skip(NO_HOOK);
      }
      if (!trustsLoopback(adapter)) {
        return skip(
          `This deployment fetches client identity documents only from ${JSON.stringify(adapter.urlHostedClientHosts ?? [])}, none of which the suite can serve from. A document served from an untrusted host is refused by the SSRF gate every conforming AS has — a local-policy denial under clause 6.1-3, not evidence about this clause.`
        );
      }

      const hosted = await serveDocument();
      try {
        const document = validDocument(hosted.url, REDIRECT_URI);
        hosted.setBody(document);
        const outcome = await adapter.offerUrlHostedClientIdentity({
          documentUrl: hosted.url,
          document,
          redirectUri: REDIRECT_URI,
        });
        if (!outcome) {
          return skip(NO_HOOK);
        }
        const evidence = [outcomeEvidence("offer: valid URL-hosted client identity", outcome)];

        // A local-policy denial is expressly permitted (6.1-3) and is NOT a
        // finding. It is only a violation when the identity itself was refused.
        if (outcome.policyDenied) {
          return skip(
            "The AS resolved the identity and then denied authorization under local policy, which clause 6.1-3 expressly permits. That is not evidence either way about whether a valid identity is accepted."
          );
        }
        if (!outcome.accepted) {
          return fail(
            `A valid client ID metadata document, served from a host this deployment trusts and asserting the URL it was retrieved from, was refused (${outcome.status ?? "no status"}, ${outcome.errorCode ?? "no error code"}). Core Section 6: a conforming AS MUST NOT reject a valid client ID metadata document solely because the client is not preregistered, and MUST accept a valid URL-hosted client identity unless local policy denies authorization. A server that requires preregistration is interoperable only with clients it has already met out of band.`,
            evidence
          );
        }
        return pass(evidence);
      } finally {
        await hosted.close();
      }
    },
  },

  // The negative half, and it is what keeps the case above honest. A target
  // that accepted ANY document — never fetching it, never checking that it
  // asserts its own URL — would pass the positive case while letting any host
  // publish a document claiming to be someone else's client. So a malformed
  // document must be refused, and the refusal must come after a real fetch.
  {
    caseId: "AS-7/malformed-url-hosted-client-identity-refused",
    requirementId: "AS-7",
    assertion:
      "A document that does not assert the URL it was retrieved from is refused, while a valid document from the same host is accepted.",
    async run({ adapter }) {
      if (!adapter.offerUrlHostedClientIdentity) {
        return skip(NO_HOOK);
      }
      if (!trustsLoopback(adapter)) {
        return skip(
          "This deployment fetches client identity documents only from hosts the suite cannot serve from, so a refusal could not be attributed to the document's content."
        );
      }

      const hosted = await serveDocument();
      try {
        hosted.setBody(validDocument(hosted.url, REDIRECT_URI));
        // The positive control FIRST, on the same host and the same hook. A
        // target refusing every document would satisfy the negative below while
        // failing the obligation entirely.
        const control = await adapter.offerUrlHostedClientIdentity({
          documentUrl: hosted.url,
          document: validDocument(hosted.url, REDIRECT_URI),
          redirectUri: REDIRECT_URI,
        });
        if (!control) {
          return skip(NO_HOOK);
        }
        if (!control.accepted) {
          return skip(
            `The positive control was refused (${control.status ?? "no status"}, ${control.errorCode ?? "no error code"}): this target does not accept a valid URL-hosted identity from this host at all, so a refusal of a malformed one proves nothing about document validation.`
          );
        }

        // Valid JSON, well-formed redirect_uris, and it claims to be a
        // DIFFERENT client. Every part of it is individually plausible — only
        // the identity binding is wrong, which is the check that stops one host
        // from speaking for another.
        const impostor = JSON.stringify({
          client_id: "https://someone-else.example/client-metadata.json",
          client_name: "PDPP conformance impostor document",
          redirect_uris: [REDIRECT_URI],
        });
        hosted.setBody(impostor);
        const outcome = await adapter.offerUrlHostedClientIdentity({
          documentUrl: hosted.url,
          document: impostor,
          redirectUri: REDIRECT_URI,
        });
        if (!outcome) {
          return skip(NO_HOOK);
        }
        const evidence = [
          outcomeEvidence("offer: valid document (control)", control),
          outcomeEvidence("offer: document asserting a different client_id", outcome),
        ];
        if (outcome.accepted) {
          return fail(
            "A client identity document that asserts a DIFFERENT `client_id` than the URL it was retrieved from was accepted. The document must assert the URL it came from, or any host able to serve a document can claim to be someone else's client and inherit whatever trust that client has earned.",
            evidence
          );
        }
        if (outcome.documentFetched === false) {
          return fail(
            "The document was refused without being fetched. A server that refuses URL-hosted identities without retrieving them is not validating documents at all — it is declining the mechanism, which is the refusal clause 6.1-2 forbids when the only thing wrong is the absence of preregistration.",
            evidence
          );
        }
        return pass(evidence);
      } finally {
        await hosted.close();
      }
    },
  },
];
