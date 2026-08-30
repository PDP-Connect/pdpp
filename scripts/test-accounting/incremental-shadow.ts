// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  makeShadowReceipt,
  parseAuthorityReport,
  renderShadowReport,
  selectIncrementalShadow,
  verifyShadowReceipt,
  writeShadowReceipt,
  writeUnknownShadowReceipt,
} from "./incremental-selector.ts";
import { assertCleanSourceTree, contentDigest, gitHead, gitRoot } from "./inventory.ts";

function fail(message: string): never {
  throw new Error(`incremental shadow: ${message}`);
}

function value(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const result = argv[index + 1];
  if (index < 0 || !result || result.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return result;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = gitRoot();
  const baseSha = value(argv, "--base");
  const headSha = value(argv, "--head");
  const receiptPath = value(argv, "--receipt");
  const reportPath = argv.includes("--report") ? value(argv, "--report") : null;
  const authorityReportPath = argv.includes("--authority-report") ? value(argv, "--authority-report") : null;
  try {
    if (!authorityReportPath) {
      fail("--authority-report requires the exact full-gate report path");
    }
    await writeUnknownShadowReceipt(receiptPath);
    const authorityReport = parseAuthorityReport(await readFile(authorityReportPath, "utf8"), headSha);
    const authorityReportIdentity = `full-gate-report:v1:${authorityReport.head_sha}:sha256:${contentDigest(await readFile(authorityReportPath))}`;
    const selection = await selectIncrementalShadow({ root, baseSha, headSha });
    if (gitHead(root) !== headSha) {
      fail("head changed before shadow receipt publication");
    }
    assertCleanSourceTree(root);
    const receipt = makeShadowReceipt(selection, authorityReportIdentity);
    verifyShadowReceipt(receipt, {
      root,
      expectedHead: headSha,
      authorityReportIdentity,
    });
    if (reportPath) {
      const reportDestination = resolve(reportPath);
      const reportTemporary = `${reportDestination}.${process.pid}.tmp`;
      await mkdir(dirname(reportDestination), { recursive: true });
      try {
        await writeFile(reportTemporary, renderShadowReport(receipt), { flag: "wx" });
        await rename(reportTemporary, reportDestination);
      } catch (error) {
        await unlink(reportTemporary).catch(() => undefined);
        throw error;
      }
    }
    await writeShadowReceipt(receiptPath, receipt);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    await writeUnknownShadowReceipt(receiptPath).catch(() => undefined);
    if (reportPath) {
      const reportDestination = resolve(reportPath);
      const reportTemporary = `${reportDestination}.${process.pid}.unknown.tmp`;
      await mkdir(dirname(reportDestination), { recursive: true });
      try {
        await writeFile(
          reportTemporary,
          renderShadowReport({
            schema: "pdpp.test-accounting.shadow-receipt/v1",
            terminal_status: "unknown",
            shadow_only: true,
            ci_green: false,
            reason: "receipt-missing",
            head_sha: null,
          }),
          { flag: "wx" }
        );
        await rename(reportTemporary, reportDestination);
      } catch (reportError) {
        await unlink(reportTemporary).catch(() => undefined);
        throw reportError;
      }
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
