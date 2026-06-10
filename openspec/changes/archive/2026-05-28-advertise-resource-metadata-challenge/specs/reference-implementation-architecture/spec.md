## ADDED Requirements

### Requirement: RS 401 responses SHALL advertise protected-resource metadata when safe
The reference Resource Server SHALL include a `WWW-Authenticate` header with a `Bearer` challenge and RFC 9728 `resource_metadata` parameter when rejecting a bearer-authenticated public query request with HTTP 401. The `resource_metadata` value SHALL point at the RS protected-resource metadata URL derived from the same configured public resource origin used by `GET /.well-known/oauth-protected-resource`. The JSON error body SHALL include the same URL as `error.resource_metadata` and SHALL include an `error.next_step` hint that tells agents to use resource metadata discovery before retrying protected `/v1/**` endpoints. When the metadata URL would require deriving a public origin from an untrusted request host, the reference SHALL omit the challenge and body hints rather than advertise that host.

#### Scenario: Missing bearer token gets metadata challenge
- **WHEN** a client requests a protected RS `/v1/**` endpoint without an Authorization header
- **THEN** the reference SHALL respond with HTTP 401
- **AND** the response SHALL include `WWW-Authenticate: Bearer resource_metadata="<metadata-url>"`
- **AND** `<metadata-url>` SHALL be the RFC 9728 protected-resource metadata URL for the resolved RS resource origin
- **AND** the JSON body SHALL include `error.resource_metadata` equal to `<metadata-url>`
- **AND** the JSON body SHALL include `error.next_step`

#### Scenario: Invalid bearer token gets metadata challenge
- **WHEN** a client requests a protected RS `/v1/**` endpoint with an invalid bearer token
- **THEN** the reference SHALL respond with HTTP 401
- **AND** the response SHALL include the same `WWW-Authenticate` `resource_metadata` challenge
- **AND** the JSON body SHALL include the same `error.resource_metadata` value

#### Scenario: Untrusted public host is not advertised
- **WHEN** a client requests a protected RS `/v1/**` endpoint through a public request host that is neither local/private nor listed in `PDPP_TRUSTED_HOSTS`
- **AND** no explicit non-loopback RS public URL is configured
- **THEN** the reference SHALL respond with HTTP 401
- **AND** the response SHALL omit `WWW-Authenticate` rather than deriving metadata from the untrusted host
- **AND** the JSON body SHALL omit `error.resource_metadata` and `error.next_step`
