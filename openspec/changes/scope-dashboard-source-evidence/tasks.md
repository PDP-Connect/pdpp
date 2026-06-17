## 1. Contract

- [x] 1.1 Add the source-scoped dashboard evidence requirement.
- [x] 1.2 Update the `_ref/connectors?connection=` route contract so connector-id fallback is unambiguous only.
- [x] 1.3 Validate the OpenSpec change strictly.

## 2. Runtime / Route Resolution

- [x] 2.1 Stop ambiguous connector-type route fallback from selecting an arbitrary configured connection.
- [x] 2.2 Preserve unambiguous single-connection fallback only where it cannot misattribute evidence.

## 3. Console Source And Runs Surfaces

- [x] 3.1 Route per-source recovery and action CTAs to the exact `connection_id`.
- [x] 3.2 Stop source detail pages from rendering connector-wide run lists as per-source recent runs.
- [x] 3.3 Keep duplicate fallback-labeled sources distinguishable without hiding legitimate multiple accounts.

## 4. Verification

- [x] 4.1 Add regression coverage for duplicate connector-type connections and exact route ids.
- [x] 4.2 Add regression coverage for connector-wide run evidence not being attributed to a source without exact connection proof.
- [x] 4.3 Run console/reference type checks and targeted tests.
- [ ] 4.4 Verify live behavior before declaring the tranche complete.
