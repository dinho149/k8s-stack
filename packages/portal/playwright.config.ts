import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  timeout: 30000,
  expect: { timeout: 10000 },
  workers: process.env.CI ? 2 : 4,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 1080 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    env: { VITE_LOCAL_DEVELOPMENT: 'true', VITE_BACKEND_URL: 'http://127.0.0.1:4707' },
    reuseExistingServer: !process.env.CI,
  },
});
