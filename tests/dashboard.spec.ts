import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
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

test('workspace shows source scope and diagnostics explain invalid local configuration', async ({ page }) => {
  host.setSourceScope(primary, { include: ['README.md'] }); await host.project(primary).sync();
  await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' });
  await page.getByRole('link', { name: 'Workspaces', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Source index scope' })).toBeVisible();
  await expect(page.getByText('Filtered source scope', { exact: true })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: /^Yes$/ })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: /^README.md$/ })).toBeVisible();
  const count = page.locator('dt').filter({ hasText: /^Sources at last sync$/ }); await expect(count.locator('+ dd')).toHaveText('1');
  writeFileSync(join(root, 'state', 'sources.json'), '{invalid');
  await page.getByRole('link', { name: 'Diagnostics', exact: true }).click();
  await expect(page.getByText(/Invalid sources.json/)).toBeVisible();
});

test('agent-learned memories are active without approval and can be explicitly forgotten', async ({ page }) => {
  const client = host.project(primary), m = client.propose({ key: 'automatic-reconnect', kind: 'experience', text: 'Reconnect cancellation releases the registry lease before replacement.', from: { agent: 'generic', session: 'automatic-session' } });
  await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' }); await expect(page.getByText('Active memories', { exact: true })).toBeVisible(); await expect(page.getByText('Pending review', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Memories', exact: true }).click(); await page.getByLabel('Memory status').selectOption('agent_learned');
  await page.getByRole('link', { name: m.key, exact: true }).click();
  await expect(page.getByText('generic / automatic-session', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Forget', exact: true }).click(); const dialog = page.getByRole('dialog'); await expect(dialog).toHaveAccessibleName('Forget this memory?'); await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Forget memory' }).click(); expect(client.memory(m.id).status).toBe('forgotten');
  await expect(page.getByRole('heading', { name: 'Revision history' })).toBeVisible();
});

test('overview, navigation, project and workspace switch keep the correct scope', async ({ page }) => {
  await page.goto(base); await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
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
  await page.emulateMedia({ colorScheme: 'dark' }); await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
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

test('long handoffs and memory stay readable; inaccessible roots show an actionable error', async ({ page }) => {
  const client = host.project(primary);
  const h = client.createHandoff({ from: { agent: 'Demo reviewer', session: 'long-content' }, task: { goal: 'Review a long implementation handoff', status: 'blocked' }, completed: Array.from({ length: 10 }, () => 'Implementation detail '.repeat(80)), remaining: ['Verify the boundary tests.'], decisions: [], files_changed: ['src/' + 'long-segment/'.repeat(25) + 'implementation.ts'], risks: [], recommended_next_action: 'Inspect the original source before continuing.' });
  const memory = client.propose({ key: 'long-memory', kind: 'memory', text: 'Detailed project knowledge. '.repeat(65) });
  await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' });
  await page.getByRole('link', { name: h.task.goal, exact: true }).click(); await expect(page.getByRole('heading', { name: 'Files changed' })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: test.info().outputPath('handoff-dark.png'), fullPage: true });
  await page.getByRole('link', { name: 'Memories', exact: true }).click(); await page.getByRole('link', { name: memory.key, exact: true }).click(); await expect(page.locator('pre').first()).toContainText('Detailed project knowledge.'); await page.screenshot({ path: test.info().outputPath('memory-dark.png'), fullPage: true });
  renameSync(primary, join(root, 'moved-project'));
  await page.getByRole('link', { name: 'Workspaces', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('unavailable'); await expect(page.getByRole('link', { name: 'Run diagnostics', exact: true })).toBeVisible(); await page.screenshot({ path: test.info().outputPath('error-dark.png'), fullPage: true });
});

test('conflicting approval remains blocked and reports the error inside the review dialog', async ({ page }) => {
  const client = host.project(primary);
  const original = client.propose({ key: 'conflicting-claim', kind: 'memory', text: 'Keep the original reviewed claim active.' }); host.review(primary, original.id, 'accepted', 'First reviewer');
  const proposal = client.propose({ key: 'conflicting-claim', kind: 'memory', text: 'A different claim requiring conflict resolution.' });
  await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' }); await page.getByRole('link', { name: 'Memories', exact: true }).click();
  await page.locator(`a[href*="${proposal.id}"]`).click(); await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve this memory?' }); await expect(dialog).toBeVisible(); await expect(page.getByLabel('Reviewer name')).toBeFocused();
  await expect(dialog).toHaveAccessibleDescription(/explicit human review/);
  await page.getByLabel('Reviewer name').fill('Second reviewer'); await page.getByRole('button', { name: 'Approve memory', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('conflict');
  expect(client.memory(proposal.id).status).not.toBe('accepted'); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
});

test('source, handoff and context lists remain bounded beyond the first page', async ({ page }) => {
  const client = host.project(primary);
  for (let i = 0; i < 55; i++) writeFileSync(join(primary, `fixture-${i}.ts`), `export const retry${i} = ${i};`);
  await client.sync();
  for (let i = 0; i < 25; i++) {
    client.createHandoff({ from: { agent: 'Demo', session: `bulk-${i}` }, task: { goal: `Review batch ${i}`, status: 'done' }, completed: [], remaining: [], decisions: [], files_changed: [], risks: [malicious], recommended_next_action: 'Inspect source.' });
    await client.context({ task: 'retry', budget: 3000 });
  }
  await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' });
  for (const screen of ['Sources', 'Context Audit']) {
    await page.getByRole('link', { name: screen, exact: true }).click(); await expect(page.locator('tbody tr')).toHaveCount(20);
    await page.getByRole('button', { name: 'Next page', exact: true }).click(); await expect(page.locator('tbody tr').first()).toBeVisible(); expect(await page.locator('tbody tr').count()).toBeLessThanOrEqual(20);
  }
  await page.getByRole('link', { name: 'Handoffs', exact: true }).click();
  await page.getByRole('link', { name: 'Review batch 24', exact: true }).click(); await expect(page.getByText(malicious, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Object.hasOwn(window, 'DASHBOARD_XSS'))).toBe(false);
  await page.getByRole('link', { name: 'Handoffs', exact: true }).click(); await page.getByRole('button', { name: 'Next page', exact: true }).click(); await expect(page.getByRole('link', { name: 'Review batch 0', exact: true })).toBeVisible();
});

test('overview prioritizes conflicts and quick memory filters preserve automatic origins', async ({ page }) => {
  const client = host.project(primary), from = { agent: 'Demo', session: 'conflict' };
  client.propose({ key: 'transport.mode', kind: 'decision', text: 'Transport reconnect retains the registry lease.', from });
  client.propose({ key: 'transport.mode', kind: 'decision', text: 'Transport reconnect releases the registry lease.', from });
  const source = client.propose({ key: 'source.retry', kind: 'memory', text: 'Reconnect uses the existing retry budget.', source_path: 'README.md' });
  await page.goto(base); await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Relay' });
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await expect(page.getByRole('link', { name: '2 conflicting or unresolved memories' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project state' })).toBeVisible();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByLabel('Project', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Workspace', { exact: true })).toBeVisible();
    }
  }
  await page.getByRole('link', { name: 'Memories', exact: true }).click();
  await page.getByRole('button', { name: 'Conflicts', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Conflicts', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Conflicts', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Active', exact: true }).click(); await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('link', { name: source.key, exact: true }).click(); await expect(page.getByText('SOURCE', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
});

test('long scope paths and memory text stay accessible with keyboard-safe confirmation', async ({ page }) => {
  const longRoot = join(root, 'long workspace directory with spaces '.repeat(4).trim()); mkdirSync(longRoot);
  const registration = host.init(longRoot, 'Demo · Long path');
  const memory = host.project(longRoot).propose({ key: 'provider.' + 'retry_budget.'.repeat(8), kind: 'experience', text: 'Provider retry budgets persist. '.repeat(60), from: { agent: 'Demo', session: 'long-content' } });
  await page.setViewportSize({ width: 1024, height: 900 }); await page.goto(base);
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Demo · Long path' });
  await expect(page.locator('.scope-path')).toHaveAttribute('title', registration.root);
  await page.getByRole('link', { name: 'Workspaces', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Primary', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.details').filter({ hasText: 'Canonical root' })).toContainText(registration.root);
  await page.getByRole('link', { name: 'Memories', exact: true }).click(); await page.getByRole('link', { name: memory.key, exact: true }).click();
  await expect(page.locator('.memory-content')).toHaveText(memory.text); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const forget = page.getByRole('button', { name: 'Forget', exact: true }); await forget.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Forget this memory?' }); await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Forget memory' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(forget).toBeFocused();
  expect(host.project(longRoot).memory(memory.id).status).toBe('persist');
});

test('overview workspace total comes from the server, not the paginated workspace selector', async ({ page }) => {
  // 55 real Git worktrees are slow to create on Windows CI runners.
  test.setTimeout(360_000);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: primary, stdio: 'pipe' });
  for (let i = 0; i < 55; i++) { const worktree = join(root, `ws-${String(i).padStart(2, '0')}`); git('worktree', 'add', '-q', '-b', `ws-${i}`, worktree); host.workspace(primary, worktree); }
  const project = host.projects().find(p => p.name === 'Demo · Relay')!, total = 1 + 1 + 55, registered = host.inspection.workspaces(project.project_id).map(w => w.workspace_id);
  expect(registered).toHaveLength(56);
  expect(host.inspection.stats(project.project_id, '').workspaces).toBe(total);
  const workspacesRow = page.locator('.state-list dt').filter({ hasText: /^Workspaces$/ }).locator('+ dd');
  // Overview health runs doctor synchronously, verifying every registered worktree with git; allow for slow Windows runners.
  const settled = { timeout: 120_000 };
  // Open the scoped Overview directly so only one doctor pass runs per assertion.
  await page.goto(`${base}/#/overview?project=${project.project_id}&workspace=`);
  await expect(workspacesRow).toHaveText(String(total), settled);
  expect(await page.getByLabel('Workspace', { exact: true }).locator('option').count()).toBeLessThan(total);
  // A workspace beyond the selector's first page must not change the project total.
  const outside = registered.at(-1)!; expect(host.inspection.stats(project.project_id, outside).workspaces).toBe(total);
  await page.goto(`${base}/#/overview?project=${project.project_id}&workspace=${outside}`);
  await expect(page.getByLabel('Workspace', { exact: true })).toHaveValue(outside);
  await expect(workspacesRow).toHaveText(String(total), settled);
});
