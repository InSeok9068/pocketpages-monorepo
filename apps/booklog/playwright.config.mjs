import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.BOOKLOG_BASE_URL || 'http://127.0.0.1:8090'
const baseHostname = new URL(baseURL).hostname

if (!['127.0.0.1', 'localhost', '[::1]'].includes(baseHostname)) {
  throw new Error('Booklog Playwright tests only allow a local base URL.')
}

export default defineConfig({
  testDir: './tests',
  workers: 1,
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  use: {
    baseURL,
    navigationTimeout: 300_000,
    actionTimeout: 30_000,
  },
})
