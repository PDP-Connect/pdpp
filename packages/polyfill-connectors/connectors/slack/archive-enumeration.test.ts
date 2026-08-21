// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The interrupted-enumeration trap.
 *
 * slackdump's `archive` enumerates the workspace and walks each channel;
 * `resume` re-walks the channels the archive ALREADY HOLDS within a lookback
 * window. `resume` never re-enumerates, so a channel that enumeration never
 * reached is not in the archive for `resume` to find, and no number of
 * resumes will ever request it.
 *
 * The connector chose between them on `existsSync(archivePath)` alone. That
 * makes an interrupted enumeration permanent: the directory exists, so the
 * next run resumes, so the unreached channels are still missing, so the
 * directory still exists in the same incomplete shape.
 *
 * Measured on the owner's live archive before this fix:
 *   - SESSION 1, `MODE = 'archive'`, `FINISHED = 0` — died 16 minutes in.
 *   - It opened MESSAGES chunks for 5 channels.
 *   - 1360 `resume` sessions followed over three months.
 *   - The set of channels holding any MESSAGES chunk is STILL exactly those
 *     5. `MIN(SESSION_ID)` over that set is 1 for every one of them.
 *   - 12 joined, unarchived channels hold zero chunks of any type.
 *
 * The shapes below are that archive's, reduced to the columns the decision
 * reads. Channel ids are synthetic — the real ones are the owner's.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { archivePathEnumerationIncomplete, pickResumeTarget } from "./index.ts";

// ─── Archive fixtures ────────────────────────────────────────────────────

function seedSessionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE SESSION (
      ID INTEGER PRIMARY KEY, CREATED_AT TEXT, UPDATED_AT TEXT,
      PAR_SESSION_ID INTEGER, FROM_TS TEXT, TO_TS TEXT,
      FINISHED INTEGER NOT NULL, FILES_ENABLED INTEGER, AVATARS_ENABLED INTEGER,
      MODE TEXT NOT NULL, ARGS TEXT
    );
  `);
}

function insertSession(db: DatabaseSync, id: number, mode: string, finished: number): void {
  db.prepare("INSERT INTO SESSION (ID, FINISHED, MODE, ARGS) VALUES (?, ?, ?, ?)").run(
    id,
    finished,
    mode,
    `${mode}|...`
  );
}

async function withArchive(
  seed: (db: DatabaseSync) => void,
  body: (sqlitePath: string, archiveDir: string) => void | Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "slack-enum-"));
  try {
    const sqlitePath = join(dir, "slackdump.sqlite");
    const db = new DatabaseSync(sqlitePath);
    try {
      seed(db);
    } finally {
      db.close();
    }
    await body(sqlitePath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ─── archivePathEnumerationIncomplete ────────────────────────────────────

test("an archive whose only 'archive' session never finished still owes an enumeration", async () => {
  // The live shape: SESSION 1 archive/FINISHED=0, then a long tail of
  // finished resumes. The finished resumes must NOT satisfy the archive.
  await withArchive(
    (db) => {
      seedSessionSchema(db);
      insertSession(db, 1, "archive", 0);
      for (let i = 2; i <= 40; i += 1) {
        insertSession(db, i, "resume", 1);
      }
    },
    (sqlitePath) => {
      assert.equal(archivePathEnumerationIncomplete(sqlitePath), true);
    }
  );
});

test("an archive with a completed 'archive' session owes nothing", async () => {
  await withArchive(
    (db) => {
      seedSessionSchema(db);
      insertSession(db, 1, "archive", 1);
      insertSession(db, 2, "resume", 1);
    },
    (sqlitePath) => {
      assert.equal(archivePathEnumerationIncomplete(sqlitePath), false);
    }
  );
});

test("one completed 'archive' session settles the debt even after an earlier one was cut short", async () => {
  // MAX(FINISHED) over the archive sessions: an interrupted first attempt
  // followed by a completed one is a finished enumeration.
  await withArchive(
    (db) => {
      seedSessionSchema(db);
      insertSession(db, 1, "archive", 0);
      insertSession(db, 2, "archive", 1);
    },
    (sqlitePath) => {
      assert.equal(archivePathEnumerationIncomplete(sqlitePath), false);
    }
  );
});

test("an archive with resumes but no 'archive' session at all owes nothing", async () => {
  // Absent evidence is not evidence of interruption. Forcing a multi-GB
  // re-archive off a missing row is the same defect pointed the other way.
  await withArchive(
    (db) => {
      seedSessionSchema(db);
      insertSession(db, 1, "resume", 1);
    },
    (sqlitePath) => {
      assert.equal(archivePathEnumerationIncomplete(sqlitePath), false);
    }
  );
});

test("an archive with no SESSION table at all owes nothing", async () => {
  await withArchive(
    (db) => {
      db.exec("CREATE TABLE CHANNEL (ID TEXT NOT NULL, CHUNK_ID INTEGER NOT NULL);");
    },
    (sqlitePath) => {
      assert.equal(archivePathEnumerationIncomplete(sqlitePath), false);
    }
  );
});

test("a path with no archive on it owes nothing", () => {
  assert.equal(
    archivePathEnumerationIncomplete(join(tmpdir(), "slack-enum-does-not-exist", "slackdump.sqlite")),
    false
  );
});

// ─── pickResumeTarget honors the debt ────────────────────────────────────

test("pickResumeTarget resumes a discovered archive when enumeration is complete", async () => {
  await withArchive(
    (db) => {
      seedSessionSchema(db);
      insertSession(db, 1, "archive", 1);
    },
    (_sqlitePath, archiveDir) => {
      const { resumeTarget } = pickResumeTarget({}, archiveDir, { forceFullArchive: false });
      assert.equal(resumeTarget, archiveDir, "a complete archive is cheap to resume and must be resumed");
    }
  );
});

test("pickResumeTarget refuses to resume when the enumeration is still owed", async () => {
  // The defect, stated as a contract: an existing directory is NOT on its own
  // a licence to resume. Before this fix `pickResumeTarget` returned
  // `archiveDir` here, and that single value is what kept 12 of the owner's
  // channels unreachable across 1360 runs.
  await withArchive(
    (db) => {
      seedSessionSchema(db);
      insertSession(db, 1, "archive", 0);
    },
    (_sqlitePath, archiveDir) => {
      const { resumeTarget } = pickResumeTarget({}, archiveDir, { forceFullArchive: true });
      assert.equal(resumeTarget, null, "an owed enumeration must run `archive`, not `resume`");
    }
  );
});

test("pickResumeTarget still reports priorArchive when it forces a full archive", async () => {
  // Callers use `priorArchive` to tell a STATE-named archive from one merely
  // found on disk. Choosing a different subcommand does not change that fact.
  await withArchive(
    (db) => {
      seedSessionSchema(db);
      insertSession(db, 1, "archive", 0);
    },
    (_sqlitePath, archiveDir) => {
      const state = { messages: { archive_dir: archiveDir } };
      const { resumeTarget, priorArchive } = pickResumeTarget(state, archiveDir, { forceFullArchive: true });
      assert.equal(resumeTarget, null);
      assert.equal(priorArchive, archiveDir);
    }
  );
});

test("pickResumeTarget ignores a STATE-named archive too when the enumeration is owed", async () => {
  // The STATE branch was the other road to the same trap: a prior run that
  // recorded `archive_dir` made every later run resume, whether or not the
  // enumeration behind that directory ever finished.
  await withArchive(
    (db) => {
      seedSessionSchema(db);
      insertSession(db, 1, "archive", 0);
    },
    (_sqlitePath, archiveDir) => {
      const state = { messages: { archive_dir: archiveDir } };
      const { resumeTarget } = pickResumeTarget(state, archiveDir, {
        allowStateArchive: true,
        forceFullArchive: true,
      });
      assert.equal(resumeTarget, null);
    }
  );
});
