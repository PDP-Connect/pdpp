# Connector environment policy

The reference server does not let a connector manifest select names from the
server process environment. Manifest entries are logical requirements. An
operator may explicitly authorize a value through
`PDPP_CONNECTOR_ENVIRONMENT_POLICY`.

The variable contains portable JSON:

```json
{
  "bindings": [
    {
      "connector_id": "google-calendar",
      "logical_key": "GOOGLE_OAUTH_CLIENT_ID",
      "source": { "kind": "process_env", "key": "GOOGLE_OAUTH_CLIENT_ID" },
      "target_key": "GOOGLE_OAUTH_CLIENT_ID"
    },
    {
      "connector_id": "github",
      "logical_key": "connector.mode",
      "source": { "kind": "literal", "value": "production" },
      "target_key": "CONNECTOR_MODE"
    }
  ],
  "proxy_connector_ids": ["github"]
}
```

Supported sources are `process_env`, `connection_env`, and `literal`. Every
binding is scoped to one canonical `connector_id`; a sibling manifest cannot
reuse it even if it declares the same logical key. The operator chooses the
source key; the manifest cannot change it. A binding is used only when its
`logical_key` appears in that connector's manifest. Reserved
runtime controls and duplicate target names within one connector are rejected. Invalid JSON,
unknown fields, invalid source kinds, non-string values, and ambiguous
Windows environment aliases fail closed during launch/server startup.

`connection_env` is reserved for the runtime's tagged, connection-scoped
credential fragment. It is not a second ambient-environment escape hatch.

Proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and their lowercase
aliases) are not forwarded by default. Add the canonical connector ID to
`proxy_connector_ids` only when that connector's runtime class requires the
operator's proxy. Proxy URLs can contain credentials and therefore need this
separate allowlist.

The server option `connectorEnvironmentPolicy` accepts the same validated
object for embedded deployments and tests. Normal self-hosted deployments
should use the JSON environment variable so Docker, Windows, and native runs
share one contract.
