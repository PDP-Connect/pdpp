---
layout: home

hero:
  name: "PDPP"
  text: "Personal Data Portability Protocol"
  tagline: "An authorization and disclosure protocol for personal data."
  actions:
    - theme: brand
      text: Read the Spec
      link: /spec-core
    - theme: alt
      text: Collection Profile
      link: /spec-collection-profile

features:
  - title: Authorization-first
    details: The grant is the portable consent artifact. Collection is a companion mechanism, not the conceptual center.
  - title: Parameterized consent
    details: Grants express precise constraints — streams, fields, time ranges, purpose — not just coarse scopes.
  - title: Resource server query API
    details: A Stripe-style REST API with cursor pagination, field filtering, and grant enforcement on every request.
---
