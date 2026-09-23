import { watch, type FSWatcher } from 'node:fs';
import type { openContinuity } from './index.js';
import { SourceScopeError } from './source-scope.js';

type Host = ReturnType<typeof openContinuity>;
type Scope = { id: string; project: string; workspace: string; root: string; projectRoot: string };
type DirectoryWatch = { path: string; accepts: (name: string) => boolean; watcher: FSWatcher };
type Entry = Scope & { selection: string; watchers: DirectoryWatch[]; timer?: ReturnType<typeof setTimeout>; dirty: boolean; runs: number; status: string; last_success?: string; last_error?: string; duration_ms?: number; watcher_status: string };
export const AUTO_SYNC = { debounce: 1500, reconcile: 10 * 60 * 1000, discovery: 30000, maxWatchers: 512 };

/** One bounded queue for all registered scopes. No independent source-selection policy. */
export class AutoSync {
  private entries = new Map<string, Entry>();
  private active: Promise<void> | undefined;
  private stopped = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private next = '';
  constructor(private host: Host, private log: (event: string, id?: string) => void = () => {}, private timing = AUTO_SYNC, private changed: () => void = () => {}) {}
  start() {
    this.next = new Date(Date.now() + this.timing.reconcile).toISOString(); this.discover(); this.changed();
    this.timers.push(setInterval(() => this.discover(), this.timing.discovery), setInterval(() => {
      this.discover(); for (const entry of this.entries.values()) this.mark(entry, false);
      this.next = new Date(Date.now() + this.timing.reconcile).toISOString();
      this.changed();
    }, this.timing.reconcile));
  }
  private discover() {
    if (this.stopped) return;
    try {
      const scopes: Scope[] = this.host.projects().flatMap(p => [{ id: p.project_id, project: p.project_id, workspace: '', root: p.root, projectRoot: p.root }, ...this.host.inspection.workspaces(p.project_id).map(w => ({ id: w.workspace_id, project: p.project_id, workspace: w.workspace_id, root: w.root, projectRoot: p.root }))]);
      let changed = false;
      for (const [id, entry] of this.entries) if (!scopes.some(s => s.id === id && s.root === entry.root && s.projectRoot === entry.projectRoot)) { this.dispose(entry); this.entries.delete(id); changed = true; }
      for (const scope of scopes) if (!this.entries.has(scope.id)) { const entry: Entry = { ...scope, selection: this.selection(scope.project), watchers: [], dirty: false, runs: 0, status: 'pending', watcher_status: 'pending' }; this.entries.set(scope.id, entry); this.mark(entry, false); changed = true; }
      // Newly registered nested projects change the parent's authorized traversal boundaries.
      // A changed local source scope replaces that scope's watches and scan without a restart.
      const refresh = [...this.entries.values()].filter(entry => { const selection = this.selection(entry.project); if (selection === entry.selection) return changed; entry.selection = selection; return true; });
      for (const entry of refresh) { this.plan(entry); this.mark(entry, false); }
      if (refresh.length) this.changed();
    } catch { this.log('registration inspection failed'); }
  }
  private selection(project: string) { try { return JSON.stringify(this.host.sourceScope(project)); } catch { return 'unavailable'; } }
  private dispose(entry: Entry) { clearTimeout(entry.timer); for (const watch of entry.watchers) watch.watcher.close(); entry.watchers = []; }
  private plan(entry: Entry) {
    try {
      const plan = this.host.watchPlan(entry.project, entry.workspace);
      if (plan.length > this.timing.maxWatchers) { for (const watch of entry.watchers) watch.watcher.close(); entry.watchers = []; entry.watcher_status = 'periodic only: directory limit'; return; }
      for (const watch of entry.watchers) if (!plan.some(p => p.path === watch.path)) watch.watcher.close();
      entry.watchers = entry.watchers.filter(w => plan.some(p => p.path === w.path));
      for (const directory of plan) {
        const existing = entry.watchers.find(w => w.path === directory.path);
        if (existing) { existing.accepts = directory.accepts; continue; }
        const watcher = watch(directory.path, { recursive: false }, (_event, filename) => {
          try { if (!filename || entry.watchers.find(w => w.path === directory.path)?.accepts(filename.toString())) this.mark(entry, true); }
          catch { this.mark(entry, true); }
        });
        watcher.on('error', () => { entry.watcher_status = 'degraded: periodic reconciliation active'; watcher.close(); entry.watchers = entry.watchers.filter(w => w.watcher !== watcher); });
        entry.watchers.push({ ...directory, watcher });
      }
      entry.watcher_status = 'active';
    } catch { for (const watch of entry.watchers) watch.watcher.close(); entry.watchers = []; entry.watcher_status = 'unavailable: periodic retry'; }
  }
  private mark(entry: Entry, debounce: boolean) {
    if (this.stopped || this.entries.get(entry.id) !== entry) return;
    clearTimeout(entry.timer);
    if (debounce) { entry.timer = setTimeout(() => { entry.dirty = true; this.pump(); }, this.timing.debounce); }
    else { entry.dirty = true; queueMicrotask(() => this.pump()); }
  }
  private pump() {
    if (this.active || this.stopped) return;
    const entry = [...this.entries.values()].find(e => e.dirty); if (!entry) return;
    this.entries.delete(entry.id); this.entries.set(entry.id, entry);
    entry.dirty = false; entry.status = 'syncing'; entry.runs++; const start = performance.now(); this.log('project sync started', entry.id);
    this.changed();
    this.active = (async () => {
      try {
        // Resolve again on every run; a rebind never grants the stale root continued authority.
        const scope = this.host.inspection.scope(entry.project, entry.workspace);
        if ((scope.workspace?.root ?? scope.project.root) !== entry.root || scope.project.root !== entry.projectRoot) throw new Error('Changed binding');
        await (entry.workspace ? this.host.workspace(entry.projectRoot, entry.root) : this.host.project(entry.root)).sync();
        entry.status = 'healthy'; entry.last_success = new Date().toISOString(); delete entry.last_error; this.log('project sync completed', entry.id);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        entry.status = code === 'ENOENT' || code === 'ENOTDIR' ? 'unavailable' : 'degraded';
        const message = error instanceof Error ? error.message : '';
        entry.last_error = error instanceof SourceScopeError ? error.message
          : message.startsWith('Index limit exceeded') ? 'Source limit exceeded (2,000 files / 8 MiB). Narrow the source scope with continuity sources set.'
          : message.startsWith('Source traversal exceeds') ? 'Source traversal limit exceeded (20,000 entries). Narrow the source scope with continuity sources set.'
          : entry.status === 'unavailable' ? 'Registered directory is unavailable. Periodic retry remains active.'
          : 'Source sync failed or registration changed. Run doctor; periodic retry remains active.';
        this.log(entry.status === 'unavailable' ? 'project unavailable' : error instanceof SourceScopeError ? 'source scope configuration invalid' : 'project sync failed', entry.id);
      }
      finally { entry.duration_ms = Math.round(performance.now() - start); if (!this.stopped && this.entries.get(entry.id) === entry) this.plan(entry); }
    })().finally(() => { this.active = undefined; this.changed(); setImmediate(() => this.pump()); });
  }
  status() { return { next_scheduled_sync: this.next, last_automatic_sync: [...this.entries.values()].flatMap(e => e.last_success ? [e.last_success] : []).sort().at(-1) ?? null, projects: [...this.entries.values()].map(entry => ({ id: entry.id, project: entry.project, workspace: entry.workspace, root: entry.root, status: entry.status, runs: entry.runs, last_success: entry.last_success, last_error: entry.last_error, duration_ms: entry.duration_ms, watcher_status: entry.watcher_status, watcher_count: entry.watchers.length })) }; }
  async stop() { this.stopped = true; this.timers.forEach(clearInterval); for (const entry of this.entries.values()) this.dispose(entry); await this.active; }
}
