// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// What the AS fetches on its own, observed on a fixture the suite hosts.
//
//   5.8-5   retrieving a declaration: no ambient credentials, every redirect
//           validated, no remote schema retrieved, fail closed
//   6.1-10  a client-supplied logo_uri is untrusted and is not fetched to render
//           the consent surface of an unverified client
//
// The adapter reports the AS's DECISION; what the AS requested is read from the
// fixture's request log, which the adapter cannot influence. A fixture cannot
// speak TLS here, so the HTTPS half of 5.8-5 is not exercised.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DeclarationOutcome } from "../harness/adapter.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";
import { schemaFor, validDeclaration } from "./declaration-validity.ts";

/** Headers an AS must not send when it retrieves a declaration: credentials it holds for other purposes. */
const AMBIENT_CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"] as const;

/** How long to wait for a fetch the AS might make after it has already answered. */
const SETTLE_MS = 250;

interface LoggedRequest {
  readonly headers: IncomingHttpHeaders;
  readonly path: string;
}

interface Fixture {
  readonly close: () => Promise<void>;
  readonly requests: LoggedRequest[];
  /** Replace the handler's route table. */
  readonly serve: (routes: Readonly<Record<string, FixtureRoute>>) => void;
  readonly url: string;
}

interface FixtureRoute {
  readonly body: string;
  readonly location?: string;
  readonly status?: number;
}

/** A loopback server that logs every request it receives and serves the routes it is given. */
async function startFixture(): Promise<Fixture> {
  const requests: LoggedRequest[] = [];
  let routes: Readonly<Record<string, FixtureRoute>> = {};
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    requests.push({ path, headers: request.headers });
    const route = routes[path];
    if (!route) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(route.status ?? 200, {
      "content-type": "application/json",
      ...(route.location === undefined ? {} : { location: route.location }),
    });
    response.end(route.body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    serve: (next) => {
      routes = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function outcomeEvidence(label: string, outcome: DeclarationOutcome): Evidence {
  return {
    request: { method: "POST", url: label, headers: {} },
    response: {
      status: outcome.status ?? (outcome.accepted ? 200 : 400),
      headers: {},
      body: typeof outcome.body === "string" ? outcome.body : JSON.stringify({ accepted: outcome.accepted }),
    },
  };
}

function requestsEvidence(label: string, fixture: Fixture): Evidence {
  return {
    request: { method: "GET", url: label, headers: {} },
    response: { status: 0, headers: {}, body: JSON.stringify(fixture.requests) },
  };
}

const NO_POINTER_HOOK =
  "The adapter has no offerDeclarationPointer hook, so the AS cannot be asked to retrieve a declaration and its retrieval behaviour is unobserved.";

const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });

export const OUTBOUND_FETCH_CASES: readonly ConformanceCase[] = [
  // ----------------------------------------------------------------- 5.8-5 ---
  {
    caseId: "AS-16/declaration-retrieval-sends-no-ambient-credentials",
    requirementId: "AS-16",
    assertion:
      "The request the AS makes to retrieve a declaration carries no Authorization, Cookie or Proxy-Authorization header.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      if (!adapter.offerDeclarationPointer) {
        return skip(NO_POINTER_HOOK);
      }
      const fixture = await startFixture();
      try {
        const version = `retrieval-credentials-${Date.now()}`;
        fixture.serve({
          "/declaration.json": { body: JSON.stringify(validDeclaration(seeded.name, seeded.fields, version)) },
        });
        const outcome = await adapter.offerDeclarationPointer({ pointerUrl: `${fixture.url}/declaration.json` });
        if (!outcome?.accepted) {
          return skip(
            "The AS did not accept a valid declaration from the fixture pointer (for example because it requires HTTPS), so what it sends when it retrieves one is unobserved."
          );
        }
        const [first] = fixture.requests;
        if (!first) {
          return skip("The AS accepted the declaration but made no request to the fixture, so nothing was observed.");
        }
        const sent = AMBIENT_CREDENTIAL_HEADERS.filter((name) => first.headers[name] !== undefined);
        const evidence = [
          outcomeEvidence("offer: declaration pointer", outcome),
          requestsEvidence("fixture log", fixture),
        ];
        if (sent.length > 0) {
          return fail(
            `The AS sent ${sent.join(", ")} when it retrieved a declaration. Core Section 5: the authorization server MUST retrieve a declaration "without ambient credentials"; a credential held for another purpose is handed to whoever controls the pointer.`,
            evidence
          );
        }
        return pass(evidence);
      } finally {
        await fixture.close();
      }
    },
  },
  {
    caseId: "AS-16/declaration-retrieval-validates-redirect-targets",
    requirementId: "AS-16",
    assertion:
      "A declaration pointer that redirects to another origin is not followed or accepted, while the direct pointer is accepted.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      if (!adapter.offerDeclarationPointer) {
        return skip(NO_POINTER_HOOK);
      }
      const [pointer, elsewhere] = [await startFixture(), await startFixture()];
      try {
        const stamp = Date.now();
        const document = (label: string) =>
          JSON.stringify(validDeclaration(seeded.name, seeded.fields, `${label}-${stamp}`));
        elsewhere.serve({ "/declaration.json": { body: document("redirect-target") } });
        pointer.serve({
          "/declaration.json": { body: document("redirect-control") },
          "/redirect.json": { body: "", status: 302, location: `${elsewhere.url}/declaration.json` },
        });
        const control = await adapter.offerDeclarationPointer({ pointerUrl: `${pointer.url}/declaration.json` });
        if (!control?.accepted) {
          return skip(
            "The AS did not accept a valid declaration from the fixture pointer, so a refusal of a redirecting one proves nothing about redirect validation."
          );
        }
        const redirected = await adapter.offerDeclarationPointer({ pointerUrl: `${pointer.url}/redirect.json` });
        if (!redirected) {
          return skip(NO_POINTER_HOOK);
        }
        await settle();
        const evidence = [
          outcomeEvidence("offer: direct pointer (control)", control),
          outcomeEvidence("offer: pointer that redirects to another origin", redirected),
          requestsEvidence("redirect target log", elsewhere),
        ];
        if (elsewhere.requests.length > 0 || redirected.accepted) {
          return fail(
            `The AS ${elsewhere.requests.length > 0 ? "followed a declaration pointer's redirect to another origin" : "accepted a declaration reached through an unvalidated redirect"}. Core Section 5: it MUST validate every redirect target and the final URL against its accepted declaration pointer and network policy, and fail closed when a check fails.`,
            evidence
          );
        }
        return pass(evidence);
      } finally {
        await Promise.all([pointer.close(), elsewhere.close()]);
      }
    },
  },
  {
    caseId: "AS-16/declaration-retrieval-does-not-fetch-remote-schema",
    requirementId: "AS-16",
    assertion:
      "A retrieved declaration whose schema references a remote document is rejected and the reference is not fetched, while a purely local one is accepted.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      if (!adapter.offerDeclarationPointer) {
        return skip(NO_POINTER_HOOK);
      }
      const [pointer, remote] = [await startFixture(), await startFixture()];
      try {
        const stamp = Date.now();
        const control = validDeclaration(seeded.name, seeded.fields, `remote-schema-control-${stamp}`);
        const [stream] = control.streams;
        const [other] = seeded.fields.filter((field) => field !== stream?.consentTimeField);
        if (!(stream && other)) {
          return skip("The baseline declaration has no second field to reference a remote schema from.");
        }
        const remoteSchema = schemaFor(
          seeded.fields,
          stream.consentTimeField ? { [stream.consentTimeField]: "date-time" } : {}
        );
        const withRemoteRef = {
          ...control,
          declarationVersion: `remote-schema-negative-${stamp}`,
          streams: [
            {
              ...stream,
              schema: {
                ...remoteSchema,
                properties: {
                  ...(remoteSchema.properties as Record<string, unknown>),
                  [other]: { $ref: `${remote.url}/field.json` },
                },
              },
            },
          ],
        };
        remote.serve({ "/field.json": { body: JSON.stringify({ type: "string" }) } });
        pointer.serve({
          "/control.json": { body: JSON.stringify(control) },
          "/negative.json": { body: JSON.stringify(withRemoteRef) },
        });
        const accepted = await adapter.offerDeclarationPointer({ pointerUrl: `${pointer.url}/control.json` });
        if (!accepted?.accepted) {
          return skip(
            "The AS did not accept a valid local-schema declaration from the fixture pointer, so a refusal of one with a remote reference proves nothing."
          );
        }
        const outcome = await adapter.offerDeclarationPointer({ pointerUrl: `${pointer.url}/negative.json` });
        if (!outcome) {
          return skip(NO_POINTER_HOOK);
        }
        await settle();
        const evidence = [
          outcomeEvidence("offer: local schema (control)", accepted),
          outcomeEvidence("offer: schema with a remote $ref", outcome),
          requestsEvidence("remote schema log", remote),
        ];
        if (remote.requests.length > 0 || outcome.accepted) {
          return fail(
            `The AS ${remote.requests.length > 0 ? "retrieved a remote schema a declaration referenced" : "accepted a declaration that references a remote schema"}. Core Section 5: it MUST reject a declaration that requires automatic retrieval of a remote schema, and fail closed when a check fails.`,
            evidence
          );
        }
        return pass(evidence);
      } finally {
        await Promise.all([pointer.close(), remote.close()]);
      }
    },
  },

  // ---------------------------------------------------------------- 6.1-10 ---
  {
    caseId: "AS-7/unverified-client-logo-is-not-fetched",
    requirementId: "AS-7",
    assertion:
      "Opening the consent surface for an unverified client whose logo_uri names the suite's fixture causes no request to that URI.",
    async run({ adapter }) {
      if (!adapter.openConsentSurface) {
        return skip(
          "The adapter has no openConsentSurface hook, so no consent surface is rendered for a client-supplied logo and a fetch triggered by rendering it is unobserved."
        );
      }
      const fixture = await startFixture();
      try {
        fixture.serve({ "/logo.png": { body: "not-really-a-png" } });
        // The fixture must be able to record a request at all; the probe is the
        // suite's own and is cleared before the AS is involved.
        await fetch(`${fixture.url}/logo.png`);
        fixture.requests.length = 0;
        const opened = await adapter.openConsentSurface({
          clientId: "https://client.example/unverified",
          clientName: "Unverified Client",
          logoUri: `${fixture.url}/logo.png`,
        });
        if (!opened?.rendered) {
          return skip(
            "The AS did not render a consent surface for the unverified client, so no fetch could be triggered."
          );
        }
        await settle();
        const evidence = [requestsEvidence("logo_uri fixture log", fixture)];
        if (fixture.requests.length > 0) {
          return fail(
            "The AS fetched an unverified client's logo_uri when it rendered the consent surface. Core Section 6: the AS MUST treat logo_uri as untrusted and MUST NOT fetch and render a client-supplied remote logo unless the client is verified or the asset has been proxied, cached and approved; fetching it lets any client make the AS issue requests to a URL it chose.",
            evidence
          );
        }
        return pass(evidence);
      } finally {
        await fixture.close();
      }
    },
  },
];
