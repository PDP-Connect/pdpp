# Step 5c diagnosis: MobileTextInputController bind failure

## Env-mismatch resolution

`peregrine-dev.vivid.fish` IS the local pdpp-web container — confirmed by
`.env.docker` (`PDPP_WEB_BASE_URL=https://peregrine-dev.vivid.fish`,
`PDPP_WEB_ALLOWED_DEV_ORIGINS=...,192.168.1.180`). Telemetry sink
`/app/tmp/stream-debug/<date>.jsonl` in `pdpp-web-1` IS the correct sink for
phone tests against that URL. The 5b validator was looking at the right
sink; the missing events mean the request really did not reach the local
container, or no events were logged for that handler path.

## Diagnostic log added

`apps/web/src/app/dashboard/runs/[runId]/stream/stream-viewer.tsx` —
strictly-additive `logDebug("neko.corner.keyboard.tapped", { adapterPresent,
adapterMounted, adapterState })` placed before the if/else (line ~2956).
Typecheck clean (`tsc --noEmit -p apps/web` → "No errors found").

## Validation NOT captured — infrastructure blockers (pre-existing, unrelated to 5b/5c)

After rebuild, `docker compose up -d` left web down for two reasons, both
predating this diagnostic:

1. **WIP storage-backend regression** (uncommitted in `docker-compose.yml`
   and `reference-implementation/server/db.js`). The compose change removed
   the `/var/lib/pdpp` volume mount, but `startServer` still unconditionally
   calls `initDb(opts.dbPath || DB_PATH, ...)` even when
   `PDPP_STORAGE_BACKEND=postgres`. With no env-file, `PDPP_DB_PATH` falls
   back to `/var/lib/pdpp/pdpp.sqlite` (dir missing) and reference crashes.
   Workaround: `docker compose --env-file .env.docker up -d` resolves the
   reference container (it then becomes healthy).
2. **Host port 3000 occupied** by an unrelated `node jwks-server.mjs`
   (pid 3464784, started by user shell). `PDPP_WEB_PORT=3000` in
   `.env.docker` collides; web container fails to bind. Not killed — out of
   scope for this step.

Result: no `neko.corner.keyboard.tapped` telemetry captured. Hypothesis
neither confirmed nor refuted.

## Recommended next step (do NOT implement)

Free host port 3000 (stop the jwks-server dev process or set
`PDPP_WEB_PORT=3002` for this run), bring web up with `--env-file
.env.docker`, then re-run the 5b phone validation script. The diagnostic
log is in place and will fire on the next tap. Separately, the
`initDb`-when-backend=postgres branch in `server/index.js:5653` deserves a
dedicated fix outside this diagnostic step.
