# Position: Why a horizontal consent layer, and why now

**Status:** Thesis (forward-looking), honestly labeled as a bet.

## Asked as

- "If a standardized consent layer were valuable, why hasn't OAuth / the industry built it?"
- "Why is this unsolved — is the need real, or just unmet?"
- "Why is now the right time for PDPP?"

## Short answer

Standardized, inspectable consent artifacts have already been solved — but only inside
regulated verticals (FHIR Consent in healthcare, Open Banking and Australia's CDR in
finance), each time because a regulator forced one domain to build one. The horizontal,
cross-domain version was never built, for incentive and coordination reasons, not
technical ones. PDPP is a bet that a general-purpose consent layer is now worth writing —
and that AI agents acting on users' behalf are the first actor with both the need and the
means to consume it.

## Why it's true

- **Solved everywhere it was mandated.** FHIR's `Consent` resource, UK Open Banking's
  consent object, and the CDR's consent records all exist because law required a single
  domain to standardize consent. The pattern is repeatedly, independently validated.
- **The gap is incentive/coordination, not difficulty.** OAuth 2.0 is deliberately a
  framework — it standardizes the access handshake and leaves consent semantics, scope
  meaning, and storage to deployers. RFC 9396 (RAR) acknowledges scopes are too coarse and
  supplies a structured envelope, but leaves the *content* to domain profiles. For general
  personal data, no actor had both the mandate and the neutrality to write that profile:
  platforms have no incentive to make consent portable and inspectable (the opposite), and
  no single regulator spans all personal data.
- **"Why now" is the agent thesis.** When OAuth was designed, the demand-side actor that
  would benefit from a standardized, granular, cross-provider consent layer — software
  acting on the user's behalf at scale — did not exist. AI agents are that actor: they need
  fine-grained, enforceable, portable authorization to use a person's data across many
  sources, and they can consume a structured grant in a way a human clicking a button could
  not.

## What we do NOT claim

- We do **not** claim this is proven demand. "Unsolved because hard to coordinate" and
  "unsolved because demand is weak" look identical from outside, and outside regulated
  domains the beneficiaries (users) have little power while the incumbents (platforms) are
  hostile. The honest framing is that PDPP is a bet on a newly-viable demand-side actor,
  not a claim that the market is already pulling for it.
- We do **not** claim PDPP invented the durable/standardized consent artifact — it
  generalizes a pattern the regulated verticals proved.

## Why this matters beyond any one answer

This "why now / why us" question is the thesis of the whole LFDT submission and the Vana
strategy. It will be asked by the LFDT TAC, investors, and academic partners repeatedly.
Keep the answer consistent and keep the concession (it's a bet) intact — conceding it is
what makes the rest credible to a skeptical technical audience.

## References

- Related: [PDPP and OAuth 2.0](pdpp-and-oauth.md), [Why grants are durable](why-grants-are-durable.md).
