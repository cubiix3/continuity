import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: '**/dashboard.spec.ts', workers: 1,
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, colorScheme: 'light', trace: 'retain-on-failure' },
  reporter: 'list',
});
