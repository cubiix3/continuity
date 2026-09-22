import type { ContextBundle, Handoff, Memory, Project, Resource, SelectionAudit, Workspace } from '../../core/src/contracts.js';

type Row = { record: Record<string, unknown>; cursor: number; created_at?: string };
type Page = { items: Row[]; next: number | null };
const main = document.querySelector<HTMLElement>('main')!;
const nav = document.querySelector<HTMLElement>('nav')!;
const scope = document.querySelector<HTMLElement>('#scope')!;
let token = '', projectId = '', workspaceId = '', generation = 0;
let projects: Project[] = [], workspaces: Workspace[] = [];
let nextProjects: number | null = null;
const pageGroups = [['Project', ['Overview', 'Projects', 'Workspaces']], ['Continuity', ['Handoffs', 'Memories', 'Context Audit']], ['System', ['Sources', 'Diagnostics']]] as const;
const slug = (name: string) => name.toLowerCase().replace(' ', '-');
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
}
function link(text: string, href: string) { const a = el('a', text); a.href = href.startsWith('#/') && projectId ? `${href}?${new URLSearchParams({ project: projectId, workspace: workspaceId })}` : href; return a; }
function button(text: string, run: (trigger: HTMLButtonElement) => void | Promise<void>, className?: string) {
  const b = el('button', text, className); b.type = 'button'; b.onclick = () => { b.disabled = true; Promise.resolve().then(() => run(b)).catch(showError).finally(() => { b.disabled = false; }); }; return b;
}
function showError(error: unknown) { const box = el('div', undefined, 'error'); box.role = 'alert'; box.append(el('p', error instanceof Error ? error.message : 'Request failed.'), link('Run diagnostics', '#/diagnostics')); main.prepend(box); }
function text(value: unknown): string { return value === undefined || value === null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
function date(value: unknown) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return 'Not recorded';
  const time = new Date(value), minutes = Math.floor((Date.now() - time.getTime()) / 60000);
  if (minutes >= 0 && minutes < 1) return 'Just now';
  if (minutes >= 1 && minutes < 60) return `${minutes} min ago`;
  if (minutes >= 60 && minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  return time.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function timestamp(value: unknown) { const node = el('time', date(value)); if (typeof value === 'string') { node.dateTime = value; node.title = new Date(value).toLocaleString(); } return node; }
function bytes(value: unknown) { return typeof value === 'number' ? value < 1024 ? `${value} B` : `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB` : '—'; }
function status(value: string) { const labels: Record<string, string> = { persist: 'Active', accepted: 'Accepted', needs_attention: 'Needs attention', done: 'Completed', proposed: 'Legacy pending' }; const node = el('span', labels[value] ?? value.replaceAll('_', ' '), 'status'); node.dataset.state = value; return node; }
function identifier(value: string) { const node = el('code', value.length > 20 ? `${value.slice(0, 16)}…` : value); node.title = value; return node; }
function pathText(value: string) { const node = el('span', value, 'path mono'); node.title = value; return node; }
function route() { return location.hash.slice(2).split('?')[0]!.split('/'); }
function go(page: string) { location.hash = `/${page}`; }
function scopedQuery(values: Record<string, string> = {}) { return new URLSearchParams({ project: projectId, workspace: workspaceId, ...values }).toString(); }
async function api<T>(path: string, values?: Record<string, string>, body?: unknown): Promise<T> {
  const response = await fetch(`/dashboard-api/${path}${values ? `?${scopedQuery(values)}` : ''}`, { headers: { 'X-Continuity-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const data = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`); return data;
}
function heading(title: string, subtitle: string) { const header = el('header', undefined, 'page-header'); header.append(el('h1', title), el('p', subtitle, 'subtitle')); main.append(header); }
function empty(title: string, description: string) { const block = el('div', undefined, 'empty'); block.append(el('strong', title), el('p', description, 'muted')); main.append(block); }
function fields(values: [string, unknown][]) { const dl = el('dl', undefined, 'details'); for (const [key, value] of values) { const dd = el('dd'); dd.append(value instanceof Node ? value : text(value)); dl.append(el('dt', key), dd); } return dl; }
function table(headers: string[], rows: (string | Node)[][]) {
  const wrap = el('div', undefined, 'table-wrap'), t = el('table'), head = el('thead'), tr = el('tr'); headers.forEach(h => { const th = el('th', h); th.scope = 'col'; tr.append(th); }); head.append(tr); t.append(head);
  const body = el('tbody'); for (const values of rows) { const row = el('tr'); for (const value of values) { const td = el('td'); td.append(value); row.append(td); } body.append(row); } t.append(body); wrap.append(t); return wrap;
}
function section(title: string, values: string[]) {
  const s = el('section', undefined, 'section'); s.append(el('h2', title));
  if (!values.length) s.append(el('p', 'None recorded.', 'muted'));
  else {
    const ul = el('ul'); values.forEach(v => ul.append(el('li', v)));
    if (values.reduce((size, value) => size + value.length, 0) > 4000) { const disclosure = el('details'); disclosure.append(el('summary', `Show all ${values.length} entries`), ul); s.append(disclosure); }
    else s.append(ul);
  }
  return s;
}
function provenance(value: unknown) { const d = el('details'); d.append(el('summary', 'Provenance & identity'), el('pre', JSON.stringify(value, null, 2))); return d; }
function pageLink(kind: string, id: string, title: string) { return link(title, `#/${kind}/${encodeURIComponent(id)}`); }
async function selectors(after = 0) {
  const requestedProject = projectId;
  scope.replaceChildren();
  const pLabel = el('label', 'Project'), p = el('select'); p.id = 'project'; pLabel.htmlFor = p.id;
  for (const item of projects) { const option = el('option', item.name); option.value = item.project_id; p.append(option); } p.value = projectId;
  const wLabel = el('label', 'Workspace'), w = el('select'); w.id = 'workspace'; wLabel.htmlFor = w.id;
  const primary = el('option', 'Primary workspace'); primary.value = ''; w.append(primary);
  const loaded = projectId ? await api<{ workspaces: Workspace[]; next: number | null; selected?: Workspace }>('workspaces', { after: String(after), limit: '50' }) : { workspaces: [], next: null };
  if (requestedProject !== projectId) return;
  workspaces = [...new Map([...(after ? workspaces : []), ...loaded.workspaces, ...(loaded.selected ? [loaded.selected] : [])].map(w => [w.workspace_id, w])).values()];
  for (const item of workspaces) { const option = el('option', item.root.split(/[\\/]/).at(-1) ?? item.workspace_id); option.value = item.workspace_id; w.append(option); } w.value = workspaceId;
  p.onchange = () => { projectId = p.value; workspaceId = ''; generation++; void selectors().then(() => { go('overview'); return render(); }).catch(showError); };
  w.onchange = () => { workspaceId = w.value; generation++; go('workspaces'); void render(); };
  const projectControl = el('div', undefined, 'scope-project'), workspaceControl = el('div', undefined, 'scope-workspace');
  const root = el('span', projects.find(item => item.project_id === projectId)?.root ?? 'No project registered', 'scope-path'); root.title = root.textContent!;
  p.disabled = !projects.length; w.disabled = !projectId;
  projectControl.append(pLabel, p, root); workspaceControl.append(wLabel, w); scope.append(projectControl, workspaceControl);
  if (loaded.next !== null) scope.append(button('More workspaces', () => selectors(loaded.next!)));
  for (const a of nav.querySelectorAll('a')) a.href = `${a.hash.split('?')[0]}?${new URLSearchParams({ project: projectId, workspace: workspaceId })}`;
}
async function overview(stamp: number) {
  heading('Overview', 'Project knowledge and the work carried between sessions.');
  if (!projectId) { empty('No projects registered.', 'Run continuity init inside a project, then continuity sync. Reload this page to see the registration.'); main.append(el('pre', 'continuity init\ncontinuity sync')); return; }
  const [handoffs, counts, snapshot, health] = await Promise.all([api<Page>('records', { kind: 'handoffs', limit: '5' }), api<{ active: number; conflicts: number; sources: number; memories: number; handoffs: number }>('stats', {}), api<Record<string, unknown>>('status', {}), api<{ integrity: string; fts5: boolean; problems: string[] }>('diagnostics')]);
  if (stamp !== generation) return;
  const healthy = health.integrity === 'ok' && health.fts5 && !health.problems.length;
  const summary = el('div', undefined, 'project-summary'); summary.append(status(healthy ? 'healthy' : 'degraded'), el('span', 'Local storage and registrations', 'muted'), el('span', `Last sync ${date((snapshot.sync as { at?: string } | undefined)?.at)}`, 'muted')); main.append(summary);
  const attention = el('section', undefined, counts.conflicts || !healthy ? 'attention' : 'attention clear'); attention.append(el('h2', 'Needs attention'));
  if (counts.conflicts) attention.append(link(`${counts.conflicts} conflicting or unresolved memories`, '#/memories'));
  if (!healthy) attention.append(link('Inspect registration and storage findings', '#/diagnostics'));
  if (!counts.conflicts && healthy) attention.append(el('p', 'Nothing needs your attention.', 'muted'));
  main.append(attention);
  const split = el('div', undefined, 'split'), left = el('section'), right = el('section'); left.append(el('h2', 'Recent handoffs'), timeline(handoffs.items));
  right.append(el('h2', 'Project state'), fields([['Active memories', counts.active], ['Conflicts / unresolved', counts.conflicts], ['Indexed source versions', counts.sources], ['Workspace handoffs', counts.handoffs], ['Source snapshot', 'Read-only · sync on demand']]), el('p', 'Durable lessons activate automatically. Agent observations remain distinct from source truth.', 'muted'));
  const links = el('div', undefined, 'inline-links'); links.append(link('Inspect memories', '#/memories'), link('Run diagnostics', '#/diagnostics')); right.append(links);
  split.append(left, right); main.append(split);
}
function timeline(rows: Row[]) {
  const list = el('ol', undefined, 'timeline');
  for (const row of rows) { const h = row.record as unknown as Handoff, li = el('li'), meta = el('div', undefined, 'handoff-meta'); meta.append(el('strong', h.from.agent), status(h.task.status), timestamp(h.provenance.captured_at)); li.append(meta, pageLink('handoffs', h.id, h.task.goal), el('p', h.recommended_next_action || 'No next action recorded.')); list.append(li); }
  if (!rows.length) list.append(el('p', 'No handoffs yet. Structured work state appears here when an agent leaves a handoff.', 'muted')); return list;
}
async function list(kind: string, stamp: number, after = 0, filter = 'all') {
  const name = kind === 'contexts' ? 'Context Audit' : kind[0]!.toUpperCase() + kind.slice(1);
  heading(name, kind === 'memories' ? 'Durable project knowledge. Automatically learned, with its origin preserved.' : kind === 'contexts' ? 'Historical context decisions, including provenance and excluded candidates.' : kind === 'sources' ? 'Last indexed metadata. Open a source to validate its current content.' : 'Structured work state between agents and sessions.');
  if (!projectId) { empty('Select a project.', 'Register a project with continuity init to get started.'); return; }
  const page = await api<Page>('records', { kind, after: String(after), ...(filter === 'all' ? {} : kind === 'sources' ? { source_filter: filter } : { status: filter }) }); if (stamp !== generation) return;
  if (kind === 'memories') { const bar = el('div', undefined, 'toolbar'), select = el('select'); select.ariaLabel = 'Memory status';
    for (const [value, label] of [['all', 'All memories'], ['active', 'Active'], ['agent_learned', 'Agent learned'], ['source_backed', 'Source backed'], ['conflicts', 'Conflicts / unresolved'], ['superseded', 'Superseded'], ['forgotten', 'Forgotten'], ['proposed', 'Legacy / incomplete provenance'], ['rejected', 'Rejected']]) { const o = el('option', label!); o.value = value!; select.append(o); } select.value = filter; select.onchange = () => { main.replaceChildren(); void list(kind, ++generation, 0, select.value).catch(showError); };
    const filters = el('div', undefined, 'filter-tabs'); filters.setAttribute('role', 'group'); filters.ariaLabel = 'Quick memory filters';
    for (const [value, label] of [['all', 'All'], ['active', 'Active'], ['conflicts', 'Conflicts']]) { const b = button(label!, async () => { main.replaceChildren(); const next = ++generation; await list(kind, next, 0, value); if (next === generation) main.querySelector<HTMLButtonElement>('.filter-tabs button[aria-pressed="true"]')?.focus(); }); b.setAttribute('aria-pressed', String(value === filter)); filters.append(b); }
    bar.append(filters, select); main.append(bar); }
  if (kind === 'sources') { const bar = el('div', undefined, 'toolbar'), select = el('select'); select.ariaLabel = 'Source filter';
    for (const [value, label] of [['all', 'All indexed versions'], ['fresh', 'Fresh at last sync'], ['stale', 'Stale / superseded / missing'], ['rules', 'Rules'], ['docs', 'Docs (.md, .txt, .rst)'], ['code', 'Common code extensions']]) { const option = el('option', label!); option.value = value!; select.append(option); } select.value = filter; select.onchange = () => { main.replaceChildren(); void list(kind, ++generation, 0, select.value).catch(showError); }; bar.append(select); main.append(bar); }
  const rows = page.items;
  if (!rows.length) empty('No entries on this page.', kind === 'handoffs' ? 'Handoffs appear when an agent records structured work state for another session.' : 'Use the CLI or your agent integration to create records.');
  else if (kind === 'handoffs') main.append(timeline(rows));
  else if (kind === 'memories') main.append(table(['Memory', 'Kind / origin', 'Status', 'Created'], rows.map(({ record: r }) => { const m = r as unknown as Memory, claim = el('div', undefined, 'record-title'), origin = el('div'); claim.append(pageLink(kind, text(r.id), text(r.key)), el('small', text(r.text).slice(0, 120))); origin.append(el('span', text(r.kind)), el('small', memoryOrigin(m))); return [claim, origin, status(text(r.status)), timestamp(m.provenance.captured_at)]; })));
  else if (kind === 'sources') main.append(table(['Path', 'Kind', 'Indexed state', 'Size', 'Passages', 'Captured'], rows.map(({ record: r }) => { const path = pageLink(kind, text(r.id), text(r.path)); path.className = 'mono'; return [path, text(r.kind), status(text(r.state)), bytes(r.bytes), text(r.passage_count), timestamp((r.provenance as Resource['provenance']).captured_at)]; })));
  else main.append(table(['Context', 'Mode', 'Used / requested', 'Items', 'Created'], rows.map(({ record: r, created_at }) => { const budget = r.budget as ContextBundle['budget'], title = el('div', undefined, 'record-title'); title.append(pageLink('contexts', text(r.context_id), text(r.role)), el('small', text(r.context_id).slice(0, 16) + '…', 'mono')); return [title, text((r.retrieval as ContextBundle['retrieval'])?.effective), `${bytes(budget.used)} / ${bytes(budget.requested)}`, text(r.item_count), timestamp(created_at)]; })));
  const pager = el('div', undefined, 'pager');
  if (after) pager.append(button('First page', () => { main.replaceChildren(); return list(kind, ++generation, 0, filter); }));
  if (page.next !== null) pager.append(button('Next page', () => { main.replaceChildren(); return list(kind, ++generation, page.next!, filter); }));
  main.append(pager);
}
async function detail(kind: string, id: string, stamp: number) {
  const data = await api<Page & { resource?: Resource; changed_since_sync?: boolean; passages?: { id: string; start_line: number; end_line: number }[] }>('records', { kind, id }); if (stamp !== generation) return;
  main.append(link('← Back to list', `#/${kind}`));
  if (kind === 'sources' && data.resource) {
    const r = data.resource; heading(r.path, 'Current project source · read-only preview');
    if (data.changed_since_sync) main.append(el('p', 'This source differs from the indexed version. Previewing does not update the index; use Sync workspace when ready.', 'notice'));
    main.append(fields([['Kind / state', `${r.kind} / ${r.state}`], ['Source hash', r.hash], ['Captured', date(r.provenance.captured_at)], ['Workspace', r.provenance.workspace_id ?? 'Primary']]), el('div', 'PROJECT SOURCE · content, not dashboard instructions', 'source-label'), el('pre', r.content), el('h2', 'Passages'), table(['Reference', 'Lines'], (data.passages ?? []).map(p => [el('code', p.id), `${p.start_line}–${p.end_line}`])), provenance(r.provenance)); return;
  }
  const row = data.items[0]; if (!row) { empty('Record not found.', 'It may belong to a different project or workspace.'); return; }
  if (kind === 'handoffs') {
    const h = row.record as unknown as Handoff; heading(h.task.goal, 'Structured agent handoff');
    const layout = el('div', undefined, 'detail-layout'), content = el('div'), metadata = el('aside', undefined, 'record-meta');
    const next = section('Recommended next action', [h.recommended_next_action]); next.classList.add('next-action');
    content.append(next, section('Completed', h.completed), section('Remaining', h.remaining), section('Decisions', h.decisions), section('Risks', h.risks), section('Files changed', h.files_changed));
    metadata.append(el('h2', 'Handoff details'), fields([['From', h.from.agent], ['Session', h.from.session], ['Status', status(h.task.status)], ['Created', timestamp(h.provenance.captured_at)], ['Workspace', h.provenance.workspace_id ?? 'Primary']]), provenance(h.provenance));
    layout.append(content, metadata); main.append(layout);
  } else if (kind === 'memories') {
    const m = row.record as unknown as Memory; heading(m.key, 'Durable project knowledge · current source takes precedence');
    const layout = el('div', undefined, 'detail-layout'), content = el('div'), metadata = el('aside', undefined, 'record-meta');
    content.append(el('h2', 'Memory content'), el('pre', m.text, 'memory-content'));
    if (m.status === 'needs_attention') content.append(el('p', 'This claim is quarantined. It is not delivered as active project knowledge.', 'notice warning'));
    content.append(section('Policy decision', [m.reason]));
    metadata.append(el('h2', 'Origin & trust'), fields([['Origin', memoryOrigin(m)], ['Kind', m.kind], ['Status', status(m.status)], ['Trust', m.provenance.trust], ['Agent / session', m.from ? `${m.from.agent} / ${m.from.session}` : 'Not recorded'], ['Created', timestamp(m.provenance.captured_at)], ['Evidence', m.source_path ?? 'No source proof'], ['Source version', m.source_path ? m.provenance.source_version : undefined], ['Superseded by', m.superseded_by], ['Reviewed by', m.review?.by], ['Reviewed', m.review ? timestamp(m.review.at) : 'Not human-reviewed']]), provenance(m.provenance));
    layout.append(content, metadata); main.append(layout);
    const controls = el('div', undefined, 'toolbar');
    if (!['forgotten', 'superseded'].includes(m.status)) controls.append(button('Forget', trigger => forget(m, trigger)));
    if (['proposed', 'needs_attention'].includes(m.status)) controls.append(button('Approve', trigger => review(m, 'accepted', trigger), 'primary'), button('Reject', trigger => review(m, 'rejected', trigger), 'danger'));
    content.append(controls);
    const revisions = await api<Page>('records', { kind: 'revisions', id, limit: '50' }); if (stamp !== generation) return;
    content.append(el('h2', 'Revision history'), table(['Revision', 'Status', 'Reason'], revisions.items.map(r => [text(r.cursor), text(r.record.status), text(r.record.reason)])));
    if (revisions.next) content.append(el('p', 'Showing the first 50 revisions. The local audit retains all revisions.', 'muted'));
  } else if (kind === 'contexts') {
    const c = row.record as unknown as ContextBundle; heading('Context audit', 'Historical snapshot · source excerpts may no longer be current');
    const summary = fields([['Role', c.role], ['Mode', c.retrieval?.effective], ['Budget requested', bytes(c.budget.requested)], ['Budget used', bytes(c.budget.used)], ['Items', c.items.length]]); summary.classList.add('context-summary'); main.append(summary, fields([['Context', c.context_id], ['Task', 'Not retained by the current context contract'], ['Created', timestamp(row.created_at)], ['Workspace', c.workspace_id ?? 'Primary']]));
    main.append(el('h2', 'Selected items'));
    for (const item of c.items) { const d = el('details'); d.append(el('summary', `${item.kind} · ${item.passage?.path ?? item.provenance.origin}${item.passage ? `:${item.passage.start_line}–${item.passage.end_line}` : ''}`), fields([['Trust', item.provenance.trust], ['Source version', item.provenance.source_version], ['Audit ref', item.id]]), section('Why included?', item.reasons), el('div', 'HISTORICAL PROJECT CONTENT', 'source-label'), el('pre', item.content)); main.append(d); }
    const selection = await api<SelectionAudit | null>('selection', { id }); if (stamp !== generation) return;
    main.append(el('h2', 'Selection decisions'));
    if (selection) main.append(table(['Source', 'Outcome', 'Reasons'], selection.entries.map(e => [e.source, e.outcome === 'budget' ? 'Budget excluded' : e.outcome, e.reasons.join(' · ')])), el('p', `${selection.candidates} candidates. Stored selection audit is bounded to 500 entries.`, 'muted'));
    else main.append(el('p', 'No selection audit recorded for this historical context.'));
  }
}
function memoryOrigin(m: Memory) { return m.status === 'needs_attention' ? 'CONFLICT / UNRESOLVED' : m.status === 'accepted' ? 'HUMAN' : m.source_path && m.provenance.trust === 'derived' ? 'SOURCE' : 'AGENT'; }
function openDialog(dialog: HTMLDialogElement, initial: HTMLElement, trigger: HTMLButtonElement) {
  dialog.onkeydown = event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  document.body.append(dialog); dialog.onclose = () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); }; dialog.showModal(); initial.focus();
}
function forget(memory: Memory, trigger: HTMLButtonElement) {
  const dialog = el('dialog'), title = el('h2', 'Forget this memory?'); title.id = 'forget-title'; dialog.setAttribute('aria-labelledby', title.id);
  const description = el('p', 'This removes the memory from active context. Its revision history is retained.'); description.id = 'forget-description'; dialog.setAttribute('aria-describedby', description.id);
  const failure = el('p'); failure.role = 'alert';
  const cancel = button('Cancel', () => dialog.close());
  dialog.append(title, description, failure, cancel, button('Forget memory', async () => {
    try { await api('forget', undefined, { project: projectId, workspace: workspaceId, id: memory.id }); dialog.close(); await render(); }
    catch (error) { failure.textContent = error instanceof Error ? error.message : 'Could not forget memory.'; }
  }, 'danger'));
  openDialog(dialog, cancel, trigger);
}
function review(memory: Memory, decision: 'accepted' | 'rejected', trigger: HTMLButtonElement) {
  const dialog = el('dialog'), title = el('h2', decision === 'accepted' ? 'Approve this memory?' : 'Reject this memory?'), label = el('label', 'Reviewer name'), input = el('input'); input.id = 'reviewer'; input.maxLength = 100; label.htmlFor = input.id;
  title.id = 'review-title'; dialog.setAttribute('aria-labelledby', title.id);
  const description = el('p', 'This records an explicit human review. Source authority and conflict checks remain unchanged.'); description.id = 'review-description'; dialog.setAttribute('aria-describedby', description.id);
  dialog.append(title, description, label, input);
  const failure = el('p'); failure.role = 'alert'; dialog.append(failure);
  const bar = el('div', undefined, 'toolbar'); bar.append(button('Cancel', () => dialog.close()), button(decision === 'accepted' ? 'Approve memory' : 'Reject memory', async () => {
    if (!input.value.trim()) { input.setCustomValidity('Enter a reviewer name.'); input.reportValidity(); return; }
    try { await api('review', undefined, { project: projectId, workspace: workspaceId, id: memory.id, decision, by: input.value.trim() }); }
    catch (error) { failure.textContent = error instanceof Error ? error.message : 'Review failed. Refresh and inspect the memory history.'; return; }
    dialog.close(); await render();
  }, decision === 'accepted' ? 'primary' : 'danger'));
  input.oninput = () => input.setCustomValidity(''); dialog.append(bar); openDialog(dialog, input, trigger);
}
async function render() {
  const stamp = ++generation; main.replaceChildren(); main.setAttribute('aria-busy', 'true');
  const [name = 'overview', encodedId] = route();
  if (projectId) history.replaceState(null, '', `${location.hash.split('?')[0]}?${new URLSearchParams({ project: projectId, workspace: workspaceId })}`);
  for (const a of nav.querySelectorAll('a')) { if (a.hash.split('?')[0] === `#/${name === 'contexts' ? 'context-audit' : name}`) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  try {
    if (encodedId && ['handoffs', 'memories', 'sources', 'contexts'].includes(name)) await detail(name, decodeURIComponent(encodedId), stamp);
    else if (name === 'overview') await overview(stamp);
    else if (['handoffs', 'memories', 'sources', 'contexts', 'context-audit'].includes(name)) await list(name === 'context-audit' ? 'contexts' : name, stamp);
    else if (name === 'projects') { heading('Projects', 'Registered project identities on this installation.'); main.append(table(['Project', 'Project ID', 'Primary root'], projects.map(p => [button(p.name, async () => { projectId = p.project_id; workspaceId = ''; await selectors(); go('workspaces'); }), identifier(p.project_id), pathText(p.root)]))); if (!projects.length) empty('No projects registered.', 'Run continuity init inside a project.'); if (nextProjects !== null) main.append(button('Load more projects', async () => { const response = await fetch(`/dashboard-api/projects?after=${nextProjects}`, { headers: { 'X-Continuity-Token': token } }); if (!response.ok) throw new Error('Could not load project registrations.'); const page = await response.json() as { projects: Project[]; next: number | null }; projects.push(...page.projects); nextProjects = page.next; await selectors(); await render(); })); }
    else if (name === 'workspaces') {
      heading('Workspaces', 'One project identity. Separate current sources for every registered checkout.');
      const project = projects.find(p => p.project_id === projectId); if (!project) { empty('No project selected.', 'Register a project first.'); return; }
      main.append(table(['Workspace', 'Canonical root', 'Identity'], [{ workspace_id: '', root: project.root }, ...workspaces].map(w => { const choose = button(w.workspace_id ? w.root.split(/[\\/]/).at(-1)! : 'Primary', () => { workspaceId = w.workspace_id; return selectors().then(render); }); choose.setAttribute('aria-pressed', String(w.workspace_id === workspaceId)); return [choose, pathText(w.root), identifier(w.workspace_id || 'Primary workspace')]; })));
      const status = await api<Record<string, unknown>>('status', {}); if (stamp !== generation) return;
      const sync = status.sync as { at: string; files: number; bytes: number } | undefined;
      main.append(el('h2', 'Selected workspace'), fields([['Canonical root', workspaces.find(w => w.workspace_id === workspaceId)?.root ?? project.root], ['Last sync', timestamp(sync?.at)], ['Sources at last sync', sync?.files], ['Source bytes', bytes(sync?.bytes)]]), button('Sync workspace', async () => { await api('sync', undefined, { project: projectId, workspace: workspaceId }); await render(); }), el('p', 'Sync uses the configured source exclusions and optional semantic backend. It does not edit project files.', 'muted'));
    } else if (name === 'diagnostics') {
      heading('Diagnostics', 'The same local health checks as continuity doctor. Optional semantic services are not required.');
      const health = await api<Record<string, unknown>>('diagnostics'); if (stamp !== generation) return;
      const problems = health.problems as string[];
      main.append(el('p', problems.length ? 'Degraded · review the findings below' : 'Healthy · local storage and registrations', problems.length ? 'notice warning' : 'notice'));
      const diagnostics = el('div', undefined, 'diagnostic-sections'), core = el('section'), runtime = el('section');
      core.append(el('h2', 'Core'), fields([['Database integrity', status(text(health.integrity))], ['FTS5', status(health.fts5 ? 'active' : 'unavailable')], ['Schema', health.schema_version]]));
      runtime.append(el('h2', 'Installation'), fields([['Package', health.version], ['Node runtime', health.node]])); diagnostics.append(core);
      if (projectId) { const retrieval = await api<{ status: string; reason: string }>('retrieval', {}).catch(() => ({ status: 'unavailable', reason: 'Workspace unavailable. Check its registration and source root.' })); if (stamp !== generation) return; const retrievalSection = el('section'); retrievalSection.append(el('h2', 'Retrieval'), fields([['Semantic', retrieval.status === 'disabled' ? 'Disabled · FTS5 active' : status(retrieval.status)], ['Detail', retrieval.reason]])); diagnostics.append(retrievalSection); }
      diagnostics.append(runtime); main.append(diagnostics, section('Findings', problems));
      main.append(provenance({ roots: health.roots, workspaces: health.workspaces, adapters: health.adapters }));
    } else { heading('Page not found', 'Choose a section from the navigation.'); }
  } catch (error) { if (stamp === generation) showError(error); }
  finally { if (stamp === generation) main.removeAttribute('aria-busy'); }
}
async function start() {
  const response = await fetch('/dashboard-api/session', { headers: { 'X-Continuity-Dashboard': '1' } }); if (!response.ok) throw new Error('Could not establish a local dashboard session.');
  token = ((await response.json()) as { capability: string }).capability;
  const data = await api<{ projects: Project[]; next: number | null }>('projects'); projects = data.projects; nextProjects = data.next; projectId = projects[0]?.project_id ?? '';
  const savedScope = new URLSearchParams(location.hash.split('?')[1] ?? '');
  if (savedScope.get('project')) {
    projectId = savedScope.get('project')!; workspaceId = savedScope.get('workspace') ?? '';
    const registration = await api<{ project: Project }>('workspaces', {});
    if (!projects.some(p => p.project_id === projectId)) projects.push(registration.project);
  }
  for (const [name, pages] of pageGroups) { const group = el('div', undefined, 'nav-group'); group.append(el('span', name, 'nav-label')); for (const page of pages) group.append(link(page, `#/${slug(page)}`)); nav.append(group); }
  await selectors(); if (!location.hash) location.hash = '/overview'; else await render();
}
window.addEventListener('hashchange', () => {
  const saved = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const requested = saved.get('project');
  if (requested && (requested !== projectId || (saved.get('workspace') ?? '') !== workspaceId)) {
    generation++; projectId = requested; workspaceId = saved.get('workspace') ?? '';
    void selectors().then(render).catch(showError);
  } else void render();
});
void start().catch(showError);
