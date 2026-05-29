import { defineConfig, devices } from "@playwright/test";

const PORT = 8080;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      // Order matters: spread Desktop Chrome first (which sets a 1280x720
      // viewport), then override viewport so the manage panel's 12 rows
      // fit without page scrolling — drag-during-scroll is brittle.
      // reducedMotion skips the tile FLIP animation (version.js/icao-control.js
      // honor it) so tiles are positionally stable for clicks/drags.
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 1280 },
        reducedMotion: "reduce",
      },
    },
  ],
  webServer: {
    command: `npx http-server site -p ${PORT} -c-1 --silent`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
