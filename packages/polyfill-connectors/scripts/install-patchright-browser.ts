// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, platform } from "node:process";

const isTruthyEnv = (value: string | undefined): boolean => {
  if (value === undefined) {
    return false;
  }
  return !["", "0", "false", "off"].includes(value.toLowerCase());
};

if (
  isTruthyEnv(process.env.PATCHRIGHT_SKIP_BROWSER_DOWNLOAD) ||
  isTruthyEnv(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)
) {
  console.log("Skipping Patchright browser download because a browser-download skip env variable is set.");
  process.exit(0);
}

const readOsRelease = () => {
  try {
    return readFileSync("/etc/os-release", "utf8");
  } catch {
    return "";
  }
};

const UBUNTU_2604_VERSION_ID_PATTERN = /(^|\n)(VERSION_ID="26\.04"|VERSION_ID=26\.04)(\n|$)/;
const UBUNTU_ID_PATTERN = /(^|\n)ID=ubuntu(\n|$)/;

const isUnsupportedPatchrightHost = () => {
  if (platform !== "linux" || arch !== "x64") {
    return false;
  }
  const osRelease = readOsRelease();
  return UBUNTU_2604_VERSION_ID_PATTERN.test(osRelease) && UBUNTU_ID_PATTERN.test(osRelease);
};

if (isUnsupportedPatchrightHost()) {
  const message =
    "Patchright does not currently publish a Chromium browser for ubuntu26.04-x64. " +
    "Skipping the optional browser download for dependency installation.";
  if (isTruthyEnv(process.env.PDPP_REQUIRE_PATCHRIGHT_BROWSER_DOWNLOAD)) {
    console.error(`${message} PDPP_REQUIRE_PATCHRIGHT_BROWSER_DOWNLOAD is set, so failing.`);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

const result = spawnSync("patchright", ["install", "chromium"], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
