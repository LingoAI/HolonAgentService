// Playwright end-to-end tests for the judged marketplace journey.
//
//   cd e2e && npm install            (once)
//   BASE_URL=http://127.0.0.1:8765 npm test
//
// Runs against a Holon that is already up — locally (any mode) or the public
// instance. Uses the installed Google Chrome; nothing is downloaded. Two
// projects: a desktop window and a phone, because "fits on a phone" is a
// regression that only a real narrow viewport catches.
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.js/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL || "http://127.0.0.1:8765",
    channel: "chrome",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["iPhone 13"], browserName: "chromium", channel: "chrome" } },
  ],
});
