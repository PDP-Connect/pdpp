## Context

The reference AS supports public dynamic client registration for hosted MCP and local OAuth clients. The DCR normalizer currently validates authorization-code redirect URIs using `metadata.application_type || "web"`, so a client that omits `application_type` is handled as a web client even when its redirect URI is an HTTP loopback URI.

RFC 8252 treats loopback HTTP redirects as a native-app redirect option. It also requires authorization servers to record client type in registration details.

## Goals / Non-Goals

**Goals:**

- Accept omitted-`application_type` DCR requests with loopback HTTP redirect URIs by inferring `native`.
- Persist and return the inferred `application_type` so later validation does not depend on re-inference.
- Preserve strict validation for explicit `web` clients and non-loopback HTTP redirects.

**Non-Goals:**

- Do not add private-use URI-scheme redirect support in this tranche.
- Do not change PKCE, authorization-code, refresh-token, or hosted MCP grant behavior.
- Do not relax exact redirect matching rules outside the existing loopback-port handling.

## Decisions

### Infer only when `application_type` is omitted

Decision: if the caller supplies `application_type`, validate it and honor it. If it is omitted and any registered redirect URI is HTTP loopback (`localhost`, `127.0.0.1`, or `::1`), set `application_type: "native"`.

Rationale: loopback HTTP is not a valid web-client redirect but is the native-app redirect shape in RFC 8252. Explicit `web` must still mean web.

Alternative considered: accept loopback HTTP under the validator while leaving stored metadata without an application type. Rejected because registration details should record the effective client type and downstream code should not need to repeat inference.

### Keep non-loopback HTTP invalid

Decision: after inference, run the existing redirect validator with the effective application type. Native clients may use HTTPS or loopback HTTP; all other HTTP redirects remain invalid.

Rationale: the interoperability fix is limited to loopback native redirects. It must not widen ordinary HTTP redirects.

## Risks / Trade-offs

- Mixed redirect sets can infer `native` if any loopback HTTP redirect is present. Mitigation: the validator still rejects any non-loopback HTTP redirect in that set.
- Existing clients with omitted type and loopback redirect will be stored more explicitly after normalization. Mitigation: `native` is the standards-aligned effective type for those redirects.
