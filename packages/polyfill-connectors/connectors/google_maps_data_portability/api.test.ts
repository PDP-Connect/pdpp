// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  DataPortabilityApiError,
  GOOGLE_MAPS_DATA_PORTABILITY_OAUTH_SCOPES,
  GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS,
  GoogleDataPortabilityClient,
} from "./api.ts";

interface CapturedRequest {
  readonly body: unknown;
  readonly headers: Headers;
  readonly method: string;
  readonly url: string;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
    ...init,
  });
}

function makeFetch(responses: readonly Response[]): {
  readonly calls: CapturedRequest[];
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
} {
  const calls: CapturedRequest[] = [];
  const queue = [...responses];
  return {
    calls,
    fetch(url, init) {
      calls.push({
        body: init.body ? JSON.parse(String(init.body)) : null,
        headers: new Headers(init.headers),
        method: init.method ?? "GET",
        url,
      });
      const response = queue.shift();
      assert.ok(response, `unexpected fetch call to ${url}`);
      return Promise.resolve(response);
    },
  };
}

test("Google Maps Data Portability resource set is Maps-only and excludes Timeline", () => {
  assert.ok(GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS.includes("maps.starred_places"));
  assert.ok(GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS.includes("maps.vehicle_profile"));
  assert.ok(GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS.includes("myactivity.maps"));
  assert.ok(GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS.includes("mymaps.maps"));
  assert.equal(
    GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS.some((item) => /timeline|location/i.test(item)),
    false
  );
});

test("OAuth scopes are derived from documented Data Portability resource groups only", () => {
  assert.ok(
    GOOGLE_MAPS_DATA_PORTABILITY_OAUTH_SCOPES.includes(
      "https://www.googleapis.com/auth/dataportability.maps.starred_places"
    )
  );
  assert.ok(
    GOOGLE_MAPS_DATA_PORTABILITY_OAUTH_SCOPES.every((scope) =>
      scope.startsWith("https://www.googleapis.com/auth/dataportability.")
    )
  );
  assert.equal(
    GOOGLE_MAPS_DATA_PORTABILITY_OAUTH_SCOPES.some((scope) => /gmail|userinfo|timeline/i.test(scope)),
    false
  );
});

test("checkAccessType calls the documented accessType endpoint with a bearer token", async () => {
  const transport = makeFetch([
    jsonResponse({
      oneTimeResources: ["maps.starred_places"],
      timeBasedResources: ["myactivity.maps"],
    }),
  ]);
  const client = new GoogleDataPortabilityClient({
    accessToken: "ya29.synthetic",
    baseUrl: "https://dp.example/v1/",
    fetch: transport.fetch,
  });

  const result = await client.checkAccessType();

  assert.deepEqual(result, {
    oneTimeResources: ["maps.starred_places"],
    timeBasedResources: ["myactivity.maps"],
  });
  assert.equal(transport.calls[0]?.url, "https://dp.example/v1/accessType:check");
  assert.equal(transport.calls[0]?.method, "POST");
  assert.equal(transport.calls[0]?.headers.get("Authorization"), "Bearer ya29.synthetic");
  assert.equal(transport.calls[0]?.body, null);
});

test("initiateArchive posts resource groups and optional time range", async () => {
  const transport = makeFetch([
    jsonResponse({
      accessType: "ACCESS_TYPE_TIME_BASED",
      archiveJobId: "job-123",
    }),
  ]);
  const client = new GoogleDataPortabilityClient({
    accessToken: "token",
    baseUrl: "https://dp.example/v1",
    fetch: transport.fetch,
  });

  const result = await client.initiateArchive({
    endTime: "2026-06-01T00:00:00Z",
    resources: ["maps.starred_places", "maps.starred_places", "myactivity.maps"],
    startTime: "2026-05-01T00:00:00Z",
  });

  assert.deepEqual(result, {
    accessType: "ACCESS_TYPE_TIME_BASED",
    archiveJobId: "job-123",
  });
  assert.equal(transport.calls[0]?.url, "https://dp.example/v1/portabilityArchive:initiate");
  assert.deepEqual(transport.calls[0]?.body, {
    endTime: "2026-06-01T00:00:00Z",
    resources: ["maps.starred_places", "myactivity.maps"],
    startTime: "2026-05-01T00:00:00Z",
  });
});

test("getArchiveState calls the documented archive state endpoint", async () => {
  const transport = makeFetch([
    jsonResponse({
      exportTime: "2026-06-11T00:00:00Z",
      name: "archiveJobs/job-123/portabilityArchiveState",
      startTime: "2026-06-10T00:00:00Z",
      state: "COMPLETE",
      urls: ["https://storage.example/signed"],
    }),
  ]);
  const client = new GoogleDataPortabilityClient({
    accessToken: "token",
    baseUrl: "https://dp.example/v1",
    fetch: transport.fetch,
  });

  const result = await client.getArchiveState("job-123");

  assert.deepEqual(result, {
    exportTime: "2026-06-11T00:00:00Z",
    name: "archiveJobs/job-123/portabilityArchiveState",
    startTime: "2026-06-10T00:00:00Z",
    state: "COMPLETE",
    urls: ["https://storage.example/signed"],
  });
  assert.equal(transport.calls[0]?.url, "https://dp.example/v1/archiveJobs/job-123/portabilityArchiveState");
  assert.equal(transport.calls[0]?.method, "GET");
});

test("API errors preserve status without exposing bearer token", async () => {
  const transport = makeFetch([new Response('{"error":"denied"}', { status: 403 })]);
  const client = new GoogleDataPortabilityClient({
    accessToken: "secret-token",
    baseUrl: "https://dp.example/v1",
    fetch: transport.fetch,
  });

  await assert.rejects(
    () => client.checkAccessType(),
    (err) =>
      err instanceof DataPortabilityApiError &&
      err.status === 403 &&
      !err.message.includes("secret-token") &&
      !err.bodySnippet.includes("secret-token")
  );
});
