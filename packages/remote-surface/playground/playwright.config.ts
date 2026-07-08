import { defineConfig } from "@playwright/test";

const port = Number(process.env.REMOTE_SURFACE_PLAYGROUND_TEST_PORT ?? 3987);

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  workers: 1,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm playground:dev -- --port ${port} --driver=package`,
    cwd: "..",
    env: {
      ...process.env,
      REMOTE_SURFACE_PLAYGROUND_HEADLESS: "1",
      REMOTE_SURFACE_PLAYGROUND_NO_OPEN: "1",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    url: `http://127.0.0.1:${port}`,
  },
});
