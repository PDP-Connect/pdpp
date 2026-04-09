---
title: "DTI Alignment Research"
---


Date: 2026-03-28

## DTI's receptiveness to external proposals

- DTI actively solicits external input. CLA-based contribution to DTP codebase. Membership not required.
- Chris Riley led a Brussels working session (early 2024) to gather external input on the third-party trust model.
- 2025 Annual Report: goal is to "be at the table whenever data portability is on the agenda."
- May 2025 blog: "trust is built not on technology alone, but on people and institutions."

## The gap we fill

DTI has publicly acknowledged:
- "Unclear consent processes" in current portability frameworks
- Standard OAuth scopes are too broad for continuous/real-time portability
- EU DMA mandates "continuous and real-time" portability but doesn't specify how third parties should be authorized
- Missing infrastructure for fine-grained, parameterized access controls

No one has proposed parameterized OAuth grants (RFC 9396-based) to DTI. This has only been used in Open Banking.

## What resonates with DTI

1. Solving the DMA "continuous and real-time" mandate with scoped, ongoing grants
2. Trust and harm mitigation: parameterized grants prevent over-sharing
3. User empowerment through explicit, understandable consent
4. Grounded in standard web protocols (OAuth, RFC 9396)

## What to avoid

Chris Riley explicitly criticized "short-lived dreams of 'trustless' technology, powered by blockchains and math." Keep the proposal grounded in institutional trust, not cryptographic trustlessness. Vana's blockchain/Web3 aspects should not be the lead framing for DTI engagement.

## Path to engagement

DTI is an independent 501(c)(4) nonprofit (not Linux Foundation). Path is direct engagement:
1. Build the spec and working implementation
2. Publish openly
3. Engage Chris Riley / DTI team directly
4. Propose as a contribution to the DTP ecosystem for fine-grained consent

## Spec implications

The OAuth approach (define the grant, not the resource API) is the right framing for DTI. The spec should:
- Use RFC 9396 as the envelope (standard web protocol, not custom)
- Define the grant as a portable consent artifact that any server can enforce
- Define the connector protocol as a reference implementation for data collection
- Explicitly not define the resource API (like OAuth doesn't define what you do with the token)
- Frame continuous/recurring grants as the answer to DMA's real-time portability requirement

Source: Gemini 3.1 Pro Preview research with Google Search (2026-03-28), checking dtinit.org, conference talks, blog posts, governance docs.
