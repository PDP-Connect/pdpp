// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import {
  makeShadowReceipt,
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
    const authorityReportIdentity = `full-gate-report:sha256:${contentDigest(await readFile(authorityReportPath))}`;
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
    await writeShadowReceipt(receiptPath, receipt);
    if (reportPath) {
      await writeFile(reportPath, renderShadowReport(receipt));
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    if (reportPath) {
      await writeFile(
        reportPath,
        renderShadowReport({
          schema: "pdpp.test-accounting.shadow-receipt/v1",
          terminal_status: "unknown",
          shadow_only: true,
          ci_green: false,
          reason: "receipt-missing",
          head_sha: null,
        })
      );
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
