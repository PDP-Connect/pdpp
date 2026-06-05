# Connector config / secret schema — prior art

Date: 2026-06-05
Status: captured (informative; supports PR #10 / OpenSpec change
`promote-connector-config-schema`, which is owner-review-gated)

## Why this note

PR #10 (`feat/connector-config-schema`, OpenSpec change
`promote-connector-config-schema`) promotes a long-parked open question
(`openspec/changes/archive/2026-05-29-add-polyfill-connector-system/design-notes/connector-configuration-open-question.md`).
It makes three concrete design choices for how a polyfill connector declares its
configuration in the manifest:

1. **Two separate JSON Schemas**, not one. `options_schema` declares non-secret
   operator tuning knobs (e.g. Slack `LOOKBACK_DAYS`, `CHANNEL_TYPES`);
   `credentials_schema` declares the *shape* of required secrets (e.g.
   `SLACK_TOKEN`). A build-time honesty test forbids the same field name from
   appearing in both schemas, so a secret can never be smuggled through the
   non-secret options channel.
2. **Options ride on the wire; credentials do not.** `START.connector_options`
   carries option *values* (validated against `options_schema` before spawn and
   captured/frozen in the run spine for reproducibility). Credential *values*
   travel a dedicated credential path (env today, grant-injected later) and are
   never persisted to `spine_events.data_json` or logs.
3. **Validation is informational, not a whitelist.** A declared option is
   type-checked and the run fails fast on a type mismatch. An *undeclared*
   option key is accepted (never pruned, never an error) but surfaced on a
   non-fatal warning channel so a typo'd knob (`LOOKBAK_DAYS`) is not silently
   inert. This is explicitly *not* `additionalProperties: false`.

The change is scoped as reference/polyfill authoring + runtime metadata, NOT
PDPP Core or Collection Profile protocol (see the spec delta in
`openspec/changes/promote-connector-config-schema/specs/polyfill-runtime/spec.md`).

This note collects the external prior art so the owner can judge whether those
three choices match how the ETL/connector ecosystem already solves this problem.
It does not edit the OpenSpec change; the change can cite this file.

## Implementation under review (for grounding)

- Manifest fields: `options_schema`, `credentials_schema` (both optional
  JSON-Schema, `manifests/slack.json` is the worked exemplar — 5 option knobs,
  3 credential fields, no overlap).
- Validator: `packages/polyfill-connectors/src/validate-connector-options.ts`
  (`validateConnectorOptions`) — type-checks declared properties, returns
  `unknownFields` for undeclared keys; no `additionalProperties` enforcement.
- Reader: `packages/polyfill-connectors/src/connector-options.ts`
  (`readOptions`) — precedence `START.connector_options` → env-var prefix →
  schema `default` (defaults applied **in code**, not by the validator).
- Honesty guard:
  `packages/polyfill-connectors/src/connector-config-schema-honesty.test.ts`
  (no field name overlaps the two schemas).
- Runtime: `reference-implementation/runtime/index.js` /
  `runtime/controller.ts` validate before resources are acquired; non-empty
  `connector_options` recorded in `run.started.data_json` *after stripping any
  key declared in `credentials_schema`*.

## Systems inspected

Each entry quotes only what the design choice actually relies on. Full source
links are at the bottom. The recurring axis is **how a system separates secret
from non-secret config**:

- **Family A — one schema, per-field secret flag** (the common convention).
- **Family B — a separate object/construct for secrets** (the minority, used by
  the most security-deliberate systems).

PR #10 chose **Family B at the schema-declaration level** (two schemas) while
also separating at the value/transport level (credentials never on START).

### Airbyte — one combined spec, per-field `airbyte_secret` (Family A)

- A connector ships one `connectionSpecification` JSON Schema (draft-07,
  `type: object`, `required[]` + `properties{}`). Secrets and non-secrets sit
  side by side in the same `properties` block; a secret is marked per-field with
  the custom keyword `airbyte_secret: true`.
- The secret/non-secret *split happens at storage, not in the schema*: on
  persist, Airbyte replaces a secret field's value with a coordinate
  (`{"_secret": "<coordinate>"}`), writes the payload to a secret-persistence
  layer, and re-hydrates it before passing config to the connector.
- `additionalProperties` defaults **lenient**: source-file, source-github, and
  source-salesforce all set `additionalProperties: true`; the protocol envelope
  is `additionalProperties: true` "for forwards compatibility … allow for
  unknown properties." Strict (`false`) is a rare opt-in.
- OAuth is a *sibling* block (`advanced_auth`) beside the config schema, with a
  `predicate_key`/`predicate_value` pointing into the combined config — not a
  field inside it.
- **Implications for PDPP:**
  - Airbyte gets the same secret/non-secret separation PDPP wants, but defers it
    to runtime via a per-field flag. The known footgun is that a developer must
    tag *every* secret field correctly, and historically `airbyte_secret` was
    silently ignored on some field shapes. PDPP's **build-time no-overlap check
    is a stronger static guarantee for exactly that failure mode** — a secret
    cannot land in the non-secret store because it cannot be declared there.
  - Airbyte's lenient `additionalProperties: true` validates PDPP's
    forward-compatible "don't reject unknown keys" stance. PDPP improves on it
    by *warning* where Airbyte stays silent.
  - Airbyte keeping OAuth out of the field-level config schema is mild support
    for PDPP keeping OAuth distinct from static `credentials_schema` secrets, if
    OAuth connectors are added later.

### dlt (dlthub) — `secrets.toml` vs `config.toml` (Family B; strongest precedent)

- dlt physically separates secrets from config into two files in `.dlt/`:
  `config.toml` for non-sensitive configuration, `secrets.toml` for sensitive
  credentials — explicitly "to keep sensitive information out of your source
  code." Enforced by the provider architecture (a writable provider that
  supports secrets vs. one that does not).
- A source/resource function declares intent in its signature:
  `api_key: str = dlt.secrets.value` (secret) vs
  `start_date: str = dlt.config.value` (config). Type hints (`TSecretValue`,
  `TSecretStrValue`, credentials types) also route a value to the secrets
  provider.
- The load-bearing invariant: **"Configuration resolution fails if a secret
  value is discovered in a config provider that does not support secrets."**
  That is the direct analogue of PDPP forbidding a secret in the `options`
  channel — both make it *impossible to smuggle a secret through the non-secret
  path*.
- Unknown config keys are **ignored, not rejected** ("unexpected values in the
  dict will be ignored"); strict rejection in dlt applies to *data* schema
  contracts, not config.
- **Implications for PDPP:**
  - dlt is the **canonical precedent that validates PDPP's secret/option
    separation**. Both treat "is this a secret?" as a first-class,
    structurally-enforced property, not a convention.
  - The difference is the enforcement layer: PDPP separates **by schema
    declaration** (two schemas + forbidden field-name overlap, checked
    statically at build time); dlt separates **by provider + type hint**
    (resolved per value at runtime). PDPP's static boundary is arguably less
    drift-prone — dlt has shipped real bugs where the file-level split silently
    failed (dlt issue #2782: `dlt.config.get()` reading from `secrets.toml`).
  - dlt's lenient "ignore unknown config keys" again supports PDPP's
    non-whitelist stance.

### Singer / Meltano / Singer SDK — one declaration surface, per-field secret flag (Family A)

- Base **Singer** spec has *no* config schema: a tap is run
  `tap --config config.json`, the same JSON object is used for discover and
  sync, and secrets are ordinary keys with no per-field secret concept and no
  spec-level validation.
- **Meltano** `meltano.yml` uses one flat `settings:` list; each setting has
  `name`, `kind`, `value` (default), `label`, `description`, etc. A secret is a
  per-setting boolean `sensitive: true` (`kind: password` is deprecated). The
  split is at the *value* layer: plain config in version-controlled
  `meltano.yml`, secrets in env / `.env` / system DB; `meltano config list`
  prints secrets as `(redacted)`.
- **Singer SDK** taps declare one `config_jsonschema`; `_validate_config()` runs
  a JSON Schema validator and raises `ConfigValidationError`. `secret=True` on a
  `Property` does *not* split secrets out — it adds inline `secret: true` +
  `writeOnly: true` annotations within the single schema.
- Cross-field required groups stay *within one schema*: Meltano
  `settings_group_validation` (list-of-lists of required settings, "group A OR
  group B"); SDK `requires_properties` → JSON Schema `dependentRequired`.
- Unknown keys pass through: Meltano explicitly supports "custom settings"
  (unknown setting behaves like a known one); the SDK emits no
  `additionalProperties: false`.
- **Implications for PDPP:**
  - The dominant ETL convention is **one schema + per-field secret flag**, with
    secrets separated only at storage. PDPP's two-schema split *diverges* from
    this convention. The practical cost: secret-handling tooling and the
    `writeOnly`/`secret` JSON-Schema annotations from this ecosystem won't map
    1:1 onto PDPP's `credentials_schema`.
  - **Caveat to weigh:** if PDPP ever needs "API key OR username+password"
    credential groups, prior art expresses that *within a single schema*
    (`dependentRequired` / `settings_group_validation`). A credential group that
    spans both `options_schema` and `credentials_schema` would be awkward; such
    rules should stay inside `credentials_schema`.
  - Meltano custom settings + SDK leniency confirm PDPP's lenient-on-unknown
    choice is the ecosystem norm; strict rejection would be the outlier.

### Terraform / Kubernetes / OpenAPI / Pulumi — the secret-separation families side by side

- **Terraform** (Family A): one typed schema per resource;
  `Required`/`Optional`/`Computed`, `Default`, `ValidateFunc`; secrets marked
  in-place with `Sensitive: true` (redacted in plan/state). Terraform 1.11+ adds
  `WriteOnly: true` for secrets accepted on input but never persisted to state —
  still a per-field flag, not a second schema.
- **Kubernetes ConfigMap vs Secret** (Family B; heavyweight precedent): a
  deliberate API-level split into two distinct resource *kinds* — non-secret
  config in `ConfigMap`, secret data in `Secret`, the latter with its own RBAC
  surface and optional encryption-at-rest. The docs say plainly: "If the data
  you want to store are confidential, use a Secret rather than a ConfigMap."
  Kubernetes could have shipped a `secret: true` flag on ConfigMap keys and
  chose a separate object instead — because secret handling needed to diverge
  structurally.
- **OpenAPI** (both axes): credentials live in a separate `securitySchemes`
  construct (B-like), while `writeOnly` is a per-field flag for secret-in /
  not-out data (A-like).
- **Pulumi** (Family B at set-time): a secret is set with
  `pulumi config set --secret`, stored as encrypted ciphertext under a `secure:`
  prefix, and read via dedicated `requireSecret` — a binding-time fork, not a
  display flag.
- **Implications for PDPP:**
  - Family A (per-field flag) is the *more common* declaration-level convention;
    Family B (separate object) is the minority but is the model of the **most
    security-deliberate systems**. PDPP's two-schema choice converges on the
    Kubernetes/Pulumi camp, not the Terraform/OpenAPI-`writeOnly` camp.
  - The justification PDPP should lean on: a separate `credentials_schema` is
    warranted precisely when secrets get *different downstream handling*
    (different transport — never on START; redaction; spine-stripping; future
    grant injection) than options. If the only difference were UI redaction,
    Family A (a flag) would be the lighter, more conventional choice. PDPP's
    design already gives credentials different handling, so Family B is
    justified — but the cost (two things to wire, validate, keep in sync) is the
    same one Kubernetes carries.

### JSON Schema strictness — the validation-mode question

- `additionalProperties: false` is strict (reject unknown keys); omitted / `true`
  is lenient. The well-known footgun: `additionalProperties: false` composed
  with `allOf`/`$ref` rejects properties contributed by sibling subschemas;
  `unevaluatedProperties: false` is the composition-safe fix, and closed schemas
  should only be applied at the leaf of an inheritance tree.
- `default` is an annotation, **not** validation behavior — validators do not
  fill in missing values. PR #10 declaring `default` in the schema but applying
  it in `readOptions` is the correct, spec-compliant pattern.
- Forward-compat guidance (robustness principle, Google AIP-180, Confluent
  schema evolution) favors tolerating unknown fields on the read side; the
  counterweight is that strict rejection catches typos. Modern consensus splits
  the difference: lenient where it aids evolution, strict where it is cheap.
- **Kubernetes three-mode field validation** (GA v1.27) is the closest analogue:
  `Ignore` (silently drop), `Warn` (drop but emit a warning; request still
  succeeds — the API-server default), `Strict` (fail). It was introduced
  *because* silently-dropped typos (`replica` vs `replicas`) caused outages.
- `writeOnly` is the JSON-Schema idiom for "settable but not returned" (secret
  fields); used by OpenAPI, Pydantic `SecretStr`, the Singer SDK.
- **Implications for PDPP:**
  - PR #10's "type-check declared fields, accept + warn on unknown" is a sound,
    precedented **middle path**. It avoids the closed-schema composition footgun
    and the forward-compat cost of strict rejection while still surfacing typos.
  - The **strongest precedent is the Kubernetes `Ignore`/`Warn`/`Strict` model;
    PDPP effectively chose `Warn`** — and goes one step safer by *preserving*
    the unknown field (passing it through unpruned) rather than dropping it, so
    no value is lost.
  - If any future `connector_options` is itself a secret, `writeOnly` is the
    right idiom — but PR #10's whole point is that secrets do not live in
    `options_schema` at all.

## Synthesis — design implications for PR #10

1. **The secret/non-secret separation is strongly precedented.** dlt
   (`secrets.toml`/`config.toml`, "resolution fails if a secret is found in a
   non-secret provider") and Kubernetes (`ConfigMap` vs `Secret`) both make the
   same structural split PR #10 makes. The principle "a secret cannot travel the
   non-secret channel" is industry-standard, not novel.
2. **The *two-schema declaration* mechanism diverges from the more common
   per-field-flag convention** (Airbyte `airbyte_secret`, Meltano `sensitive`,
   Singer SDK `secret=True`, Terraform `Sensitive`/`WriteOnly`, OpenAPI
   `writeOnly`). PDPP converges instead on the minority Family-B camp (k8s,
   Pulumi) that is used precisely when secrets get different downstream handling.
   PR #10's credentials *do* get different handling (off-wire, spine-stripped,
   future grant injection), so Family B is justified — but it is a deliberate
   divergence the owner should ratify, not the path of least surprise for
   someone porting an Airbyte/Singer connector.
3. **The build-time no-overlap check is PDPP's distinctive strength.** It is a
   *static* guarantee where Airbyte (per-field flag, dev must tag correctly) and
   dlt (per-value runtime routing, has shipped split-failure bugs) rely on
   correct authoring or runtime resolution. This is the part of PR #10 most
   worth keeping exactly as designed.
4. **The lenient-warn validation mode is well-precedented and sound.** Every ETL
   system surveyed (Airbyte, Meltano, dlt, Singer SDK) passes unknown config
   keys through. PR #10's "type-check declared + warn on unknown + preserve"
   sits at the Kubernetes `Warn` setting (one step safer, since it preserves the
   key). This is a defensible, even exemplary, choice.
5. **Defaults-in-code is correct.** JSON Schema validators do not apply defaults;
   `readOptions` applying them is the only spec-compliant pattern. No change
   needed.

## Open considerations the prior art surfaces (not blockers)

- **Cross-field credential groups.** If a connector ever needs "API key OR
  (username + password)", prior art keeps that logic in one schema
  (`dependentRequired` / Meltano `settings_group_validation`). Keep such rules
  inside `credentials_schema`; do not split a single credential group across
  both schemas.
- **OAuth vs static secrets.** Airbyte (and OpenAPI `securitySchemes`) keep OAuth
  declaration distinct from static-secret config. If PDPP adds OAuth connectors,
  consider whether OAuth belongs in `credentials_schema` or a sibling block;
  this is out of PR #10's scope and need not block it.
- **Validator depth.** PR #10's `validateConnectorOptions` is a hand-rolled
  shape checker (type, array-item type), not a full JSON-Schema validator. That
  is appropriate for the current narrow knob set, but if `options_schema` grows
  constraints (`enum`, `minimum`, `pattern`, `oneOf`), the hand-rolled checker
  would silently not enforce them. Worth a note in the change so the gap is
  intentional, not accidental.

## Is PR #10 narrow or open-ended?

**Narrow and well-scoped, with one deliberate divergence to ratify.** The
secret/option separation, the off-wire credential path, the build-time
no-overlap check, the lenient-warn validation, and defaults-in-code all match
strong prior art (dlt, Kubernetes, the ETL leniency norm). The single
design-level decision the owner must consciously accept is **two schemas vs. one
schema + secret flag** — PR #10 takes the minority (but security-deliberate)
Family-B path, which its own credential-handling justifies. The remaining items
above are forward-looking notes, not redesign triggers. PR #10 does not appear
to need a redesign; it needs owner ratification of the two-schema choice and
(optionally) a one-line note about hand-rolled-validator depth.

## Sources

Airbyte (accessed 2026-06-05):

- Secrets handling — <https://docs.airbyte.com/platform/understanding-airbyte/secrets>
- Connector specification reference — <https://docs.airbyte.com/platform/connector-development/connector-specification-reference>
- Airbyte protocol (`connectionSpecification`, `additionalProperties: true`) — <https://docs.airbyte.com/platform/understanding-airbyte/airbyte-protocol>
- Config-based OAuth (`advanced_auth`) — <https://docs.airbyte.com/platform/connector-development/config-based/advanced-topics/oauth>

dlt (accessed 2026-06-05):

- Credentials setup (`secrets.toml` vs `config.toml`, provider resolution) — <https://dlthub.com/docs/general-usage/credentials/setup>
- Credentials advanced (`dlt.secrets.value`, `TSecretValue`) — <https://dlthub.com/docs/general-usage/credentials/advanced>
- `BaseConfiguration` / `@configspec` — <https://dlthub.com/docs/api_reference/dlt/common/configuration/specs/base_configuration>
- File-split-failure bug (caveat) — <https://github.com/dlt-hub/dlt/issues/2782>

Singer / Meltano (accessed 2026-06-05):

- Singer spec — <https://github.com/singer-io/getting-started/blob/master/docs/SPEC.md>
- Meltano plugin definition syntax (`settings`, `kind`, `sensitive`, `settings_group_validation`) — <https://docs.meltano.com/reference/plugin-definition-syntax/>
- Meltano configuration guide (config layers, custom settings, redaction) — <https://docs.meltano.com/guide/configuration/>
- Singer SDK typing (`Property(secret=...)`, `requires_properties`) — <https://github.com/meltano/sdk/blob/main/singer_sdk/typing.py>
- Singer SDK plugin base (`config_jsonschema`, `_validate_config`) — <https://github.com/meltano/sdk/blob/main/singer_sdk/plugin_base.py>

Terraform / Kubernetes / OpenAPI / Pulumi (accessed 2026-06-05):

- Terraform schema behaviors (`Sensitive`) — <https://developer.hashicorp.com/terraform/plugin/sdkv2/schemas/schema-behaviors>
- Terraform write-only arguments — <https://developer.hashicorp.com/terraform/plugin/framework/resources/write-only-arguments>
- Kubernetes ConfigMaps — <https://kubernetes.io/docs/concepts/configuration/configmap/>
- Kubernetes Secrets — <https://kubernetes.io/docs/concepts/configuration/secret/>
- OpenAPI 3.1.0 (`securitySchemes`, `writeOnly`) — <https://spec.openapis.org/oas/v3.1.0.html>
- Pulumi secrets — <https://www.pulumi.com/docs/iac/concepts/secrets/>

JSON Schema strictness (accessed 2026-06-05):

- Object validation (`additionalProperties`) — <https://json-schema.org/understanding-json-schema/reference/object>
- Annotations (`default`, `writeOnly`) — <https://json-schema.org/understanding-json-schema/reference/annotations>
- Kubernetes field validation GA (`Ignore`/`Warn`/`Strict`) — <https://kubernetes.io/blog/2023/04/24/openapi-v3-field-validation-ga/>
- Robustness principle — <https://en.wikipedia.org/wiki/Robustness_principle>
- Google AIP-180 (backwards compatibility) — <https://google.aip.dev/180>

Related local artifacts (cross-link, do not duplicate):

- `openspec/changes/promote-connector-config-schema/` — the change under review
  (proposal, design, tasks, `polyfill-runtime` spec delta).
- `openspec/changes/archive/2026-05-29-add-polyfill-connector-system/design-notes/connector-configuration-open-question.md`
  — the original open question this change resolves.
- `packages/polyfill-connectors/src/validate-connector-options.ts`,
  `connector-options.ts`, `connector-config-schema-honesty.test.ts` — the
  implementation this note evaluates.
