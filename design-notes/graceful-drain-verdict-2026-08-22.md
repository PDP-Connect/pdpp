# Graceful drain on SIGTERM: do not re-attempt

**Verdict: rejected, with production evidence. `fix/graceful-drain-0821` should
not be landed.**

This note exists because the idea is genuinely appealing and has already been
built twice. Without a durable record it will be rediscovered — the reasoning
below is what stops the third attempt.

## What was tried

`fix/graceful-drain-0821` (uncommitted work in
`~/.tmp/graceful-drain-0821`) makes `drainActiveRuns` CANCEL every in-flight
run on SIGTERM and then await its terminalization within a 5s budget, so the
dying process writes each run's own terminal event instead of leaving it to be
adjudicated at the next boot. It also closes run admission during shutdown and
adds a `shutdown_drained` terminal reason.

The engineering is careful and the diagnosis of the read-side problem is right
(a restart-ended run should not be reported as `run.failed`). The mechanism is
what does not work.

## Why it does not work

**The budget cannot cover the work.** Production sets no `--stop-timeout`, so
Docker's 10s default governs, and `--stop-timeout` is fixed at container
creation — Docker has no equivalent of systemd's runtime `EXTEND_TIMEOUT_USEC=`.
Real runs take minutes: production medians span 9s (github) to 1221s (ynab). The
gap is two orders of magnitude and is not closable by tuning.

**It was measured failing exactly that way.** A production shutdown logged:

```
drained:0, elapsedMs:5000, timedOut:1
```

The drain spent its entire budget and abandoned the run anyway, having consumed
half the window before SIGKILL while making the failure look handled. That is a
negative win — worse than not trying, because it delays the storage close that
still has to happen.

**Correctness never depended on it, and cannot.** A `kill -9`, an OOM kill, or a
power loss gets no drain at all. Any design that needs the dying process to
write its own terminal state has an unhandled case by construction. The
successor must adjudicate regardless, so the drain is a redundant second
mechanism guarding a case the first already covers.

This is the standard layering, not a local shortcut: Temporal's
`WorkerStopTimeout` defaults to 0s and the service writes the terminal state on
a timer; Kafka recovers a dead producer's transaction through the successor's
`InitProducerId` epoch bump.

## What replaced it

`2ddcca1b8` ("perf(shutdown): drop the connector drain from the SIGTERM path")
removed the shutdown call site and left `drainActiveRuns` on the controller,
where it means "await in-flight runs" for the watchdog, `awaitRun`, and the test
suite. Correctness lives in `reconcileOrphanedRunsAtBoot`
(`lib/controller-boot.ts`), which writes `run.abandoned` for any run whose owner
epoch is not the current one.

That commit is an ancestor of the current base. **The drain branch predates it
and does not contain it**, so landing the branch would re-introduce a mechanism
this repo already removed on evidence.

## The valid insight, and where it went instead

The drain branch was right that a restart-ended run must not be reported as a
connector failure. That belongs on the read side, where it works for every
restart shape including `kill -9`:

- `8609f37a8` — restart-abandoned runs no longer classify connection health;
  they defer to the last run that actually observed something.
- `3cf21fd04` — restart-ended runs no longer reset the schedule anchor, so a
  restart stops delaying the next run by a full interval.

Both apply regardless of how the process died, which is precisely the property
the drain could not offer.

## If someone still wants a drain

The only version worth discussing would need all of: a stop timeout raised well
beyond 10s at container creation, evidence that the raised timeout does not get
the process SIGKILLed mid-storage-close, and a reason why successor
adjudication is insufficient despite handling the `kill -9` case the drain
cannot. Absent all three, this is settled.
