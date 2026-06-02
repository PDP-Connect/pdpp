import { spawnSync } from "node:child_process";

const isTruthyEnv = (value) => {
  if (value === undefined) {
    return false;
  }
  return !["", "0", "false", "off"].includes(value.toLowerCase());
};

if (
  isTruthyEnv(process.env.PATCHRIGHT_SKIP_BROWSER_DOWNLOAD) ||
  isTruthyEnv(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)
) {
  console.log(
    "Skipping Patchright browser download because a browser-download skip env variable is set."
  );
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
