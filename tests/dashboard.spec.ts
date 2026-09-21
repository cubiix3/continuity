import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openContinuity } from '../packages/sdk/src/index.js';
import { createDashboardServer } from '../packages/server/src/dashboard.js';
import { SqliteStorage } from '../packages/storage-sqlite/src/index.js';

let root: string, primary: string, base: string, host: ReturnType<typeof openContinuity>, server: ReturnType<typeof createDashboardServer>;
const malicious = '<script>window.DASHBOARD_XSS = true</script>';
test.beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'continuity-ui-')); primary = join(root, 'project'); mkdirSync(primary);
  writeFileSync(join(primary, 'AGENTS.md'), '# Project rules\nPreserve workspace isolation. Run the relevant tests.');
  writeFileSync(join(primary, 'README.md'), `# Demo service\nReconnect uses the existing retry budget.\n${malicious}`);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: primary, stdio: 'pipe' });
  git('init'); git('add', '.'); git('-c', 'user.name=Dashboard Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const worker = join(root, 'worker-reconnect'); git('worktree', 'add', '-b', 'worker-reconnect', worker);
  const other = join(root, 'other'); mkdirSync(other); writeFileSync(join(other, 'README.md'), 'SECOND_PROJECT_ONLY');
  host = openContinuity(join(root, 'state')); host.init(primary, 'Demo · Relay'); host.init(other, 'Demo · Empty');
  const client = host.project(primary); await client.sync(); await host.workspace(primary, worker).sync();
  client.createHandoff({ from: { agent: 'Claude Code', session: 'implementation-01' }, task: { goal: 'Preserve reconnect state across provider restarts', status: 'done' }, completed: ['Reconnect state is retained through provider replacement.', 'Focused retry tests pass.'], remaining: ['Review the cancellation boundary.'], decisions: ['Reuse the existing retry budget; do not add another scheduler.'], files_changed: ['src/reconnect.ts', 'tests/reconnect.test.ts'], risks: ['Cancellation can race with a scheduled retry.'], recommended_next_action: 'Review cancellation and verify the focused tests.' });
  client.createHandoff({ from: { agent: 'Codex', session: 'review-02' }, task: { goal: 'Review reconnect cancellation', status: 'blocked' }, completed: ['Reviewed the change and verified workspace provenance.'], remaining: ['Add a regression test for cancellation during backoff.'], decisions: [], files_changed: [], risks: ['A timer may survive cancellation.'], recommended_next_action: 'Add the missing regression test before accepting the change.' });
  client.propose({ key: 'retry-budget', text: 'Reconnect should use the existing retry budget. Human review is needed before this becomes durable knowledge.', kind: 'decision' });
  client.propose({ key: 'hostile-content', text: `Render project text safely: ${malicious}`, kind: 'memory' });
  await client.context({ task: 'Reconnect retry', budget: 3000 });
  server = createDashboardServer(host, new URL('../dist/packages/dashboard/', import.meta.url)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address'); base = `http://127.0.0.1:${address.port}`;
});
test.afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); host.close(); rmSync(root, { recursive: true, force: true }); });

test('overview, navigation, project and workspace switch keep the correct scope', async ({ page }) => {
  await page.goto(base); await expect(page.getByRole('heading', { name: 'Project continuity, at a glance.' })).toBeVisible();
  // Registrations are sorted by root; choose the fixture explicitly.
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' });
  await expect(page.getByText('Review reconnect cancellation', { exact: true })).toBeVisible();
  await page.getByLabel('Workspace', { exact: true }).selectOption({ label: 'worker-reconnect' });
  await expect(page.getByRole('heading', { name: 'Selected workspace' })).toBeVisible();
  await page.reload(); await expect(page.getByLabel('Workspace', { exact: true })).toHaveValue(/ws_/);
  await page.getByRole('link', { name: 'Handoffs', exact: true }).click(); await expect(page.getByText('No entries on this page.')).toBeVisible();
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Empty' });
  await page.getByRole('link', { name: 'Sources', exact: true }).click(); await expect(page.getByText('No entries on this page.')).toBeVisible();
});
test('handoff detail explains work state without a transcript', async ({ page }) => {
  await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' });
  await page.getByRole('link', { name: 'Review reconnect cancellation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recommended next action' })).toBeVisible(); await expect(page.getByText('A timer may survive cancellation.', { exact: true })).toBeVisible(); await expect(page.getByText('review-02', { exact: true })).toBeVisible();
});
test('pending review uses human confirmation and shows persisted revisions', async ({ page }) => {
  await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' }); await page.getByRole('link', { name: 'Memories', exact: true }).click();
  await page.getByRole('link', { name: 'retry-budget', exact: true }).click(); await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByLabel('Reviewer name').fill('Dashboard reviewer'); await page.getByRole('button', { name: 'Approve memory', exact: true }).click();
  await expect(page.getByText('Dashboard reviewer', { exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Revision history' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Memories', exact: true }).click(); await page.getByRole('link', { name: 'hostile-content', exact: true }).click();
  await page.getByRole('button', { name: 'Reject', exact: true }).click(); await page.getByLabel('Reviewer name').fill('Dashboard reviewer'); await page.getByRole('button', { name: 'Reject memory', exact: true }).click(); await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
});
test('source and memory HTML remains text; source previews refresh', async ({ page }) => {
  const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' }); await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await page.getByLabel('Source filter', { exact: true }).selectOption('rules'); await expect(page.getByRole('link', { name: 'AGENTS.md', exact: true })).toBeVisible(); await expect(page.getByRole('link', { name: 'README.md', exact: true })).toHaveCount(0);
  await page.getByLabel('Source filter', { exact: true }).selectOption('docs'); await expect(page.getByRole('link', { name: 'README.md', exact: true })).toBeVisible();
  writeFileSync(join(primary, 'README.md'), `# Current preview\nNEW_CURRENT\n${malicious}`);
  await page.getByRole('link', { name: 'README.md', exact: true }).click(); await expect(page.locator('pre').first()).toContainText('NEW_CURRENT'); await expect(page.locator('pre').first()).toContainText(malicious);
  await page.getByRole('link', { name: 'Memories', exact: true }).click(); await page.getByRole('link', { name: 'hostile-content', exact: true }).click(); await expect(page.locator('pre').first()).toContainText(malicious);
  expect(await page.evaluate(() => Object.hasOwn(window, 'DASHBOARD_XSS'))).toBe(false); expect(dialogs).toEqual([]);
});
test('context audit exposes selection, budgets and historical source semantics', async ({ page }) => {
  await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' }); await page.getByRole('link', { name: 'Context Audit', exact: true }).click();
  await page.locator('tbody a').first().click(); await expect(page.getByRole('heading', { name: 'Selection decisions' })).toBeVisible(); await expect(page.getByText('Historical snapshot · source excerpts may no longer be current')).toBeVisible();
  await page.locator('summary').first().click(); await expect(page.getByRole('heading', { name: 'Why included?' }).first()).toBeVisible();
});
test('diagnostics distinguishes optional disabled semantic from degraded registration', async ({ page }) => {
  await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' }); await page.getByRole('link', { name: 'Diagnostics', exact: true }).click(); await expect(page.getByText('Disabled · FTS5 active', { exact: true })).toBeVisible();
  rmSync(join(root, 'other'), { recursive: true, force: true });
  await page.reload(); await expect(page.getByText('Degraded · review the findings below')).toBeVisible();
});
test('empty installation provides an actionable first run', async ({ page }) => {
  const emptyHost = openContinuity(join(root, 'empty-state')); const emptyServer = createDashboardServer(emptyHost, new URL('../dist/packages/dashboard/', import.meta.url));
  await new Promise<void>(resolve => emptyServer.listen(0, '127.0.0.1', resolve)); const address = emptyServer.address();
  try { if (!address || typeof address === 'string') throw new Error('Missing address'); await page.goto(`http://127.0.0.1:${address.port}`); await expect(page.getByText('No projects registered.', { exact: true })).toBeVisible(); await expect(page.locator('pre')).toContainText('continuity init'); }
  finally { emptyServer.closeAllConnections(); await new Promise<void>(resolve => emptyServer.close(() => resolve())); emptyHost.close(); }
});
test('desktop and tablet layouts use local assets and remain within the viewport', async ({ page }) => {
  const remote: string[] = []; page.on('request', request => { if (!request.url().startsWith(base)) remote.push(request.url()); });
  await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' }); await expect(page.getByText('Review reconnect cancellation', { exact: true })).toBeVisible();
  if (process.env.CONTINUITY_SCREENSHOT === '1') { mkdirSync('docs/screenshots', { recursive: true }); await page.screenshot({ path: 'docs/screenshots/dashboard.png', fullPage: true }); }
  await page.setViewportSize({ width: 820, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ colorScheme: 'dark' }); await expect(page.getByRole('heading', { name: 'Project continuity, at a glance.' })).toBeVisible();
  expect(remote).toEqual([]);
});

test('large memory lists stay paginated and status filtering finds older pending records', async ({ page }) => {
  const store = new SqliteStorage(join(root, 'state', 'continuity.db')); const project = host.projects().find(p => p.name === 'Demo · Relay')!;
  store.atomic(() => { for (let i = 0; i < 1000; i++) store.saveMemory({ id: `mem_bulk-${i}`, project_id: project.project_id, key: `bulk-${i}`, kind: 'memory', text: 'A reviewed local fixture record for bounded list inspection.', status: 'accepted', reason: 'Test fixture', provenance: { project_id: project.project_id, origin: 'fixture', captured_at: new Date().toISOString(), source_version: 'fixture', trust: 'untrusted' } }); }); store.close();
  const started = performance.now(); await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' }); await expect(page.getByText('Review reconnect cancellation', { exact: true })).toBeVisible(); const initialMs = performance.now() - started;
  const listStart = performance.now(); await page.getByRole('link', { name: 'Memories', exact: true }).click(); await expect(page.locator('tbody tr')).toHaveCount(20); const listMs = performance.now() - listStart;
  await page.getByRole('button', { name: 'Next page', exact: true }).click(); await expect(page.locator('tbody tr')).toHaveCount(20);
  await page.getByLabel('Memory status', { exact: true }).selectOption('proposed'); await expect(page.getByRole('link', { name: 'retry-budget', exact: true })).toBeVisible(); await expect(page.locator('tbody tr')).toHaveCount(2);
  console.log(JSON.stringify({ dashboard_measurement: { records: 1002, page_rows: 20, initial_with_project_switch_ms: Math.round(initialMs), list_navigation_ms: Math.round(listMs) } }));
});
