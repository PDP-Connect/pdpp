# Add browser surface diagnostic evidence

Browser-backed Chase and USAA runs can honestly report a required-stream gap,
but their current retained diagnostics do not distinguish recognized markup,
an explicit verified empty state, an unexpected/interstitial route, or parser
zero output. This change adds one reference-implementation-only evidence
boundary that reuses the existing `SKIP_RESULT.diagnostics` trace persistence
and optional fixture capture.

The Collection Profile, manifests, and coverage policy remain unchanged.
