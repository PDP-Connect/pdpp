// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveProtectedResourceMetadataUrl,
  hasExactProtectedResourceIdentity,
  validateProviderNativeDiscoveryMetadata,
  validateResponse,
} from "../src/index.ts";

const RESOURCE = "https://resource.example.com/owner/alice?tenant=primary";

function protectedResourceMetadata() {
  return {
    authorization_servers: ["https://authorization.example.com"],
    bearer_methods_supported: ["header"],
    pdpp_core_query_base: "https://resource.example.com/v1",
    pdpp_provider_connect_version: "0.1",
    pdpp_self_export_supported: true,
    pdpp_token_kinds_supported: ["owner", "client"],
    resource: RESOURCE,
    resource_name: "Example resource",
  };
}

test("generic protected-resource metadata keeps the provider-native pointer optional and constrained", () => {
  assert.deepEqual(
    validateResponse("getProtectedResourceMetadata", {
      body: protectedResourceMetadata(),
      status: 200,
    }),
    { ok: true, skipped: false }
  );

  assert.deepEqual(
    validateResponse("getProtectedResourceMetadata", {
      body: {
        ...protectedResourceMetadata(),
        pdpp_source_declaration_uri: "https://declarations.example.com/source.json",
      },
      status: 200,
    }),
    { ok: true, skipped: false }
  );

  for (const pointer of [
    "http://declarations.example.com/source.json",
    "https://declarations.example.com/source.json#latest",
    "https://user@declarations.example.com/source.json",
    "https://user:password@declarations.example.com/source.json",
    "https:///source.json",
    "https://declarations.example.com/%",
    "https://declarations.example.com:",
    "https://declarations.example.com/source.json\u0000",
    "https://declarations.example.com/source.json\n",
    "https://declarations.example.com/source.json\t",
    "https://éxample.com/source.json",
    ["https://declarations.example.com/source.json"],
  ]) {
    const body = { ...protectedResourceMetadata(), pdpp_source_declaration_uri: pointer };
    assert.equal(validateResponse("getProtectedResourceMetadata", { body, status: 200 }).ok, false);
  }
});

test("provider-native discovery requires one valid pointer and exact resource identity", () => {
  const valid = {
    ...protectedResourceMetadata(),
    pdpp_source_declaration_uri: "https://declarations.example.com/source.json",
  };
  assert.deepEqual(validateProviderNativeDiscoveryMetadata(RESOURCE, valid), {
    ok: true,
    sourceDeclarationUri: "https://declarations.example.com/source.json",
  });

  for (const pointer of [
    undefined,
    "http://declarations.example.com/source.json",
    "https://declarations.example.com/source.json#latest",
    "https://user@declarations.example.com/source.json",
    "https://user:password@declarations.example.com/source.json",
    ["https://declarations.example.com/source.json"],
  ]) {
    assert.deepEqual(
      validateProviderNativeDiscoveryMetadata(RESOURCE, {
        ...protectedResourceMetadata(),
        pdpp_source_declaration_uri: pointer,
      }),
      { ok: false, reason: "invalid_source_declaration_uri" }
    );
  }

  assert.deepEqual(validateProviderNativeDiscoveryMetadata("https://resource.example.com/another-owner", valid), {
    ok: false,
    reason: "resource_mismatch",
  });

  for (const invalidResource of [
    "http://resource.example.com",
    "https://user@resource.example.com",
    "https://resource.example.com#fragment",
    "https:///owner/alice",
    "https://resource.example.com/%",
    "https://resource.example.com:",
    "https://resource.example.com/owner/alice\u0000",
    "https://resource.example.com/owner/alice\n",
    "https://éxample.com/owner/alice",
    "not a URI",
  ]) {
    assert.deepEqual(
      validateProviderNativeDiscoveryMetadata(invalidResource, {
        ...valid,
        resource: invalidResource,
      }),
      { ok: false, reason: "invalid_resource" }
    );
  }

  assert.deepEqual(
    validateProviderNativeDiscoveryMetadata(RESOURCE, { ...valid, resource: "https://resource.example.com/%" }),
    { ok: false, reason: "invalid_resource" }
  );

  for (const pointer of [
    "https:///source.json",
    "https://declarations.example.com/%",
    "https://declarations.example.com:",
    "https://declarations.example.com/source.json\u0000",
    "https://declarations.example.com/source.json\n",
    "https://declarations.example.com/source.json\t",
    "https://éxample.com/source.json",
  ]) {
    assert.deepEqual(
      validateProviderNativeDiscoveryMetadata(RESOURCE, { ...valid, pdpp_source_declaration_uri: pointer }),
      { ok: false, reason: "invalid_source_declaration_uri" }
    );
  }
});

test("RFC 9728 metadata URLs insert the well-known path before resource path and query", () => {
  assert.equal(
    deriveProtectedResourceMetadataUrl("https://resource.example.com"),
    "https://resource.example.com/.well-known/oauth-protected-resource"
  );
  assert.equal(
    deriveProtectedResourceMetadataUrl("https://resource.example.com/resource1"),
    "https://resource.example.com/.well-known/oauth-protected-resource/resource1"
  );
  assert.equal(
    deriveProtectedResourceMetadataUrl("https://resource.example.com?tenant=primary"),
    "https://resource.example.com/.well-known/oauth-protected-resource?tenant=primary"
  );
  assert.equal(
    deriveProtectedResourceMetadataUrl("https://resource.example.com/"),
    "https://resource.example.com/.well-known/oauth-protected-resource"
  );
  assert.equal(
    deriveProtectedResourceMetadataUrl("https://resource.example.com/?tenant=primary"),
    "https://resource.example.com/.well-known/oauth-protected-resource?tenant=primary"
  );
  assert.equal(
    deriveProtectedResourceMetadataUrl(RESOURCE),
    "https://resource.example.com/.well-known/oauth-protected-resource/owner/alice?tenant=primary"
  );
  assert.throws(() => deriveProtectedResourceMetadataUrl("http://resource.example.com"), TypeError);
  assert.throws(() => deriveProtectedResourceMetadataUrl("https://resource.example.com#fragment"), TypeError);
  assert.throws(() => deriveProtectedResourceMetadataUrl("https://user@resource.example.com"), TypeError);
  assert.throws(() => deriveProtectedResourceMetadataUrl("https://resource.example.com/%"), TypeError);
  assert.throws(() => deriveProtectedResourceMetadataUrl("https://resource.example.com:"), TypeError);
  assert.throws(() => deriveProtectedResourceMetadataUrl("https://resource.example.com\u0000"), TypeError);
  assert.throws(() => deriveProtectedResourceMetadataUrl("https://resource.example.com\n"), TypeError);
  assert.throws(() => deriveProtectedResourceMetadataUrl("https://éxample.com"), TypeError);
  assert.throws(() => deriveProtectedResourceMetadataUrl("https://resource.example.com\\resource1"), TypeError);
});

test("RFC 9728 returned-resource validation uses exact string identity", () => {
  assert.equal(hasExactProtectedResourceIdentity(RESOURCE, RESOURCE), true);
  assert.equal(
    hasExactProtectedResourceIdentity(RESOURCE, "https://resource.example.com/owner/alice?tenant=secondary"),
    false
  );
  assert.equal(
    hasExactProtectedResourceIdentity(RESOURCE, "https://RESOURCE.example.com/owner/alice?tenant=primary"),
    false
  );
});
