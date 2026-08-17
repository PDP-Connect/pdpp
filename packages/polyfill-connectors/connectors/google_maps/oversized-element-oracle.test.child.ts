// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Child-process oracle for the per-element memory bound: validates a
 * pre-built fixture file under a caller-supplied heap limit and reports the
 * result over stdout. Does no fixture construction of its own -- the
 * parent process builds the fixture file (outside any heap constraint)
 * and passes only its path and size, so this process's heap budget is
 * spent exclusively on the validation call itself.
 */

import { readFileSync } from "node:fs";
import { streamGoogleMapsExport } from "./archive-stream.ts";
import { validateGoogleMapsTimelineArtifactFromFile } from "./validation.ts";

const [, , path, fileSizeArg, mode] = process.argv;
if (!(path && fileSizeArg)) {
  console.error("usage: oversized-element-oracle.test.child.ts <path> <fileSize>");
  process.exit(2);
}

const fileSize = Number(fileSizeArg);

if (mode === "whole-buffer") {
  const json = JSON.parse(readFileSync(path, "utf8"));
  process.stdout.write(`${JSON.stringify({ status: Array.isArray(json.locations) ? "valid" : "unsupported" })}\n`);
  process.exit(0);
} else if (mode === "stream") {
  let elements = 0;
  streamGoogleMapsExport(path, (event) => {
    if (event.kind === "element") {
      elements += 1;
    }
  })
    .then(() => {
      process.stdout.write(`${JSON.stringify({ elements, status: "valid" })}\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stdout.write(`${JSON.stringify({ error: String(err) })}\n`);
      process.exit(1);
    });
} else {
  validateGoogleMapsTimelineArtifactFromFile(path, fileSize, {
    fileSha256: "oracle-probe",
    maxFileBytes: 200 * 1024 * 1024,
  })
    .then((result) => {
      process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stdout.write(`${JSON.stringify({ error: String(err) })}\n`);
      process.exit(1);
    });
}
