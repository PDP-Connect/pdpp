# Vendored test sandbox

`test-sandbox` runs tests in a transient scope under the shared
`agent-tests.slice`, with CPU, memory, and process limits. It probes bubblewrap
before giving a run private `/tmp` and loopback-only networking (`--net none`
by default). The repository launcher keeps host PID visibility; a private PID
namespace is available to direct callers with `--pidns`. One JSON receipt goes
to stderr per run. If systemd, bubblewrap, or `flock` is unavailable, the receipt
names the enforcement that remains. `TEST_SANDBOX_REQUIRE=1` makes missing
enforcement an error. `TEST_SANDBOX_DISABLE=1` runs the command directly while
keeping scratch ownership and cleanup.

The executable is copied byte-for-byte from `ai/skills/local/test-architecture/scripts/test-sandbox` in Tim Nunamaker's dotfiles at commit `31cad42`. Change and test that source first, then update this copy and digest:

```sh
cp <dotfiles>/ai/skills/local/test-architecture/scripts/test-sandbox scripts/test-sandbox/test-sandbox
chmod 755 scripts/test-sandbox/test-sandbox
(cd scripts/test-sandbox && sha256sum test-sandbox > test-sandbox.sha256)
```

`scripts/test-sandbox-vendored.test.ts` checks the recorded digest and executable mode. The repository's `REUSE.toml` catch-all annotation gives this header-free executable Apache-2.0 coverage.
