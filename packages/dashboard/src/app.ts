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
const statusLabels: Record<string, string> = { persist: 'Active', accepted: 'Human reviewed', needs_attention: 'Conflict', done: 'Completed', in_progress: 'In progress', proposed: 'Legacy pending', ok: 'Healthy', fresh: 'Fresh', stale: 'Stale', blocked: 'Blocked', healthy: 'Healthy', degraded: 'Degraded', active: 'Active', unavailable: 'Unavailable', disabled: 'Disabled', rejected: 'Rejected', forgotten: 'Forgotten', superseded: 'Superseded', missing: 'Missing' };
function status(value: string, label?: string) { const node = el('span', label ?? statusLabels[value] ?? value.replaceAll('_', ' '), 'status'); node.dataset.state = value; return node; }
function metaLine(...values: (string | Node | undefined)[]) { const line = el('div', undefined, 'meta-line'); for (const value of values) if (value !== undefined) line.append(typeof value === 'string' ? el('span', value) : value); return line; }
/** Two-column label/value facts; empty values are omitted instead of shown as dashes. */
function facts(values: [string, unknown][]) { const dl = el('dl', undefined, 'facts'); for (const [key, value] of values) { if (value === undefined || value === null || value === '') continue; const row = el('div'), dd = el('dd'); dd.append(value instanceof Node ? value : text(value)); row.append(el('dt', key), dd); dl.append(row); } return dl; }
function identifier(value: string) { const node = el('code', value.length > 20 ? `${value.slice(0, 16)}…` : value); node.title = value; return node; }
function pathText(value: string) { const node = el('span', value, 'path mono'); node.title = value; return node; }
function originLabel(m: Memory) { const value = memoryOrigin(m), node = el('span', value, 'origin'); node.dataset.origin = value.toLowerCase(); return node; }
function workspaceName() { return workspaceId ? workspaces.find(w => w.workspace_id === workspaceId)?.root.split(/[\\/]/).at(-1) ?? 'Workspace' : 'Primary workspace'; }
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
/** Column widths are layout hints (CSS lengths); an empty entry takes the remaining space. */
function table(headers: string[], rows: (string | Node)[][], widths: string[] = []) {
  const wrap = el('div', undefined, 'table-wrap'), t = el('table'), head = el('thead'), tr = el('tr'); headers.forEach(h => { const th = el('th', h); th.scope = 'col'; tr.append(th); }); head.append(tr);
  if (widths.length) { const group = el('colgroup'); for (const width of widths) { const col = el('col'); if (width) col.style.width = width; group.append(col); } t.append(group); }
  t.append(head);
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
  const rootPath = (workspaceId ? workspaces.find(item => item.workspace_id === workspaceId)?.root : undefined) ?? projects.find(item => item.project_id === projectId)?.root ?? 'No project registered';
  const root = el('span', undefined, 'scope-path'); root.title = rootPath; root.append(el('bdi', rootPath));
  p.disabled = !projects.length; w.disabled = !projectId;
  projectControl.append(pLabel, p); workspaceControl.append(wLabel, w); scope.append(projectControl, workspaceControl, root);
  if (loaded.next !== null) scope.append(button('More workspaces', () => selectors(loaded.next!)));
  for (const a of nav.querySelectorAll('a')) a.href = `${a.hash.split('?')[0]}?${new URLSearchParams({ project: projectId, workspace: workspaceId })}`;
}
async function overview(stamp: number) {
  if (!projectId) { heading('Overview', 'Project knowledge and the work carried between sessions.'); empty('No projects registered.', 'Run continuity init inside a project, then continuity sync. Reload this page to see the registration.'); main.append(el('pre', 'continuity init\ncontinuity sync', 'first-run')); return; }
  const [handoffs, counts, snapshot, health, retrieval] = await Promise.all([api<Page>('records', { kind: 'handoffs', limit: '5' }), api<{ active: number; conflicts: number; sources: number; memories: number; handoffs: number }>('stats', {}), api<Record<string, unknown>>('status', {}), api<{ integrity: string; fts5: boolean; problems: string[] }>('diagnostics'), api<{ status: string }>('retrieval', {}).catch(() => ({ status: 'unavailable' }))]);
  if (stamp !== generation) return;
  const healthy = health.integrity === 'ok' && health.fts5 && !health.problems.length, sync = snapshot.sync as { at?: string; files?: number } | undefined;
  const project = projects.find(p => p.project_id === projectId)!, header = el('header', undefined, 'page-header'), hero = el('div', undefined, 'project-hero');
  hero.append(el('span', project.name, 'project-name'), status(healthy ? 'healthy' : 'degraded'));
  header.append(el('h1', 'Overview', 'eyebrow'), hero, metaLine(sync?.at ? `Last synced ${date(sync.at).toLowerCase()}` : 'Not synced yet', sync?.files !== undefined ? `${sync.files.toLocaleString()} sources` : undefined, workspaceName()));
  main.append(header);
  const attention = el('section', undefined, counts.conflicts || !healthy ? 'attention' : 'attention clear'); attention.append(el('h2', 'Needs attention'));
  if (counts.conflicts) attention.append(link(`${counts.conflicts} conflicting or unresolved memories`, '#/memories'));
  if (!healthy) attention.append(link('Inspect registration and storage findings', '#/diagnostics'));
  if (!counts.conflicts && healthy) attention.append(el('p', 'Nothing needs your attention.', 'muted'));
  main.append(attention);
  const split = el('div', undefined, 'split'), left = el('section'), right = el('section'), recent = el('h2', 'Recent handoffs');
  if (handoffs.items.length) recent.append(link('All handoffs', '#/handoffs'));
  left.append(recent, timeline(handoffs.items));
  const state = el('dl', undefined, 'state-list'), row = (label: string, value: string | number, note?: string) => { const dd = el('dd', String(value)); if (note) dd.append(el('small', note)); state.append(el('dt', label), dd); };
  row('Active memories', counts.active); row('Conflicts / unresolved', counts.conflicts); row('Sources at last sync', sync?.files ?? '—', `${counts.sources} indexed versions`); row('Handoffs', counts.handoffs); row('Workspaces', 1 + workspaces.length);
  row('Retrieval', retrieval.status === 'disabled' ? 'Lexical' : statusLabels[retrieval.status] ?? retrieval.status, retrieval.status === 'disabled' ? 'FTS5' : undefined);
  right.append(el('h2', 'Project state'), state, el('p', 'Durable lessons activate automatically. Agent observations remain distinct from source truth.', 'reason'));
  const links = el('div', undefined, 'inline-links'); links.append(link('Inspect memories', '#/memories'), link('Run diagnostics', '#/diagnostics')); right.append(links);
  split.append(left, right); main.append(split);
}
function timeline(rows: Row[]) {
  const list = el('ol', undefined, 'timeline');
  for (const row of rows) {
    const h = row.record as unknown as Handoff, li = el('li'), meta = el('div', undefined, 'handoff-meta'), next = el('p', undefined, 'next');
    meta.append(el('strong', h.from.agent), el('span', h.from.session, 'mono'), status(h.task.status));
    next.append(el('span', 'Next'), h.recommended_next_action || 'No next action recorded.'); next.title = h.recommended_next_action;
    li.append(pageLink('handoffs', h.id, h.task.goal), timestamp(h.provenance.captured_at), meta, next); list.append(li);
  }
  if (!rows.length) { const item = el('li'); item.append(el('p', 'No handoffs yet. Structured work state appears here when an agent leaves a handoff.', 'muted')); list.append(item); } return list;
}
async function list(kind: string, stamp: number, after = 0, filter = 'all') {
  const name = kind === 'contexts' ? 'Context Audit' : kind[0]!.toUpperCase() + kind.slice(1);
  heading(name, kind === 'memories' ? 'Durable project knowledge, learned automatically. Every entry keeps its origin; conflicts are quarantined.' : kind === 'contexts' ? 'Historical context decisions, including provenance and excluded candidates.' : kind === 'sources' ? 'Last indexed metadata. Open a source to validate its current content.' : 'Structured work state between agents and sessions.');
  if (!projectId) { empty('Select a project.', 'Register a project with continuity init to get started.'); return; }
  const page = await api<Page>('records', { kind, after: String(after), ...(filter === 'all' ? {} : kind === 'sources' ? { source_filter: filter } : { status: filter }) }); if (stamp !== generation) return;
  if (kind === 'memories') { const bar = el('div', undefined, 'toolbar'), select = el('select'); select.ariaLabel = 'Memory status';
    for (const [value, label] of [['all', 'All memories'], ['active', 'Active'], ['agent_learned', 'Agent learned'], ['source_backed', 'Source backed'], ['conflicts', 'Conflicts / unresolved'], ['superseded', 'Superseded'], ['forgotten', 'Forgotten'], ['proposed', 'Legacy / incomplete provenance'], ['rejected', 'Rejected']]) { const o = el('option', label!); o.value = value!; select.append(o); } select.value = filter; select.onchange = () => { main.replaceChildren(); void list(kind, ++generation, 0, select.value).catch(showError); };
    const human = el('option', 'Human reviewed'); human.value = 'accepted'; select.insertBefore(human, select.options[4] ?? null); select.value = filter;
    const filters = el('div', undefined, 'filter-tabs'); filters.setAttribute('role', 'group'); filters.ariaLabel = 'Quick memory filters';
    for (const [value, label] of [['all', 'All'], ['active', 'Active'], ['agent_learned', 'Agent learned'], ['source_backed', 'Source backed'], ['accepted', 'Human'], ['conflicts', 'Conflicts']]) { const b = button(label!, async () => { main.replaceChildren(); const next = ++generation; await list(kind, next, 0, value); if (next === generation) main.querySelector<HTMLButtonElement>('.filter-tabs button[aria-pressed="true"]')?.focus(); }); b.setAttribute('aria-pressed', String(value === filter)); filters.append(b); }
    bar.append(filters, select); main.append(bar); }
  if (kind === 'sources') { const bar = el('div', undefined, 'toolbar'), select = el('select'); select.ariaLabel = 'Source filter';
    for (const [value, label] of [['all', 'All indexed versions'], ['fresh', 'Fresh at last sync'], ['stale', 'Stale / superseded / missing'], ['rules', 'Rules'], ['docs', 'Docs (.md, .txt, .rst)'], ['code', 'Common code extensions']]) { const option = el('option', label!); option.value = value!; select.append(option); } select.value = filter; select.onchange = () => { main.replaceChildren(); void list(kind, ++generation, 0, select.value).catch(showError); }; bar.append(select); main.append(bar); }
  const rows = page.items;
  const num = (value: string) => el('span', value, 'num');
  if (!rows.length) empty('No entries on this page.', kind === 'handoffs' ? 'Handoffs appear when an agent records structured work state for another session.' : kind === 'memories' && filter !== 'all' ? 'No memories match this filter.' : 'Use the CLI or your agent integration to create records.');
  else if (kind === 'handoffs') main.append(timeline(rows));
  else if (kind === 'memories') main.append(table(['Memory', 'Origin', 'Kind', 'Status', 'Created'], rows.map(({ record: r }) => { const m = r as unknown as Memory, claim = el('div', undefined, 'record-title'), preview = el('small', text(r.text)); preview.title = text(r.text); claim.append(pageLink(kind, text(r.id), text(r.key)), preview); return [claim, originLabel(m), el('span', text(r.kind), 'faint'), status(text(r.status)), timestamp(m.provenance.captured_at)]; }), ['', '96px', '96px', '128px', '104px']));
  else if (kind === 'sources') main.append(table(['Path', 'State', 'Kind', 'Size', 'Passages', 'Captured'], rows.map(({ record: r }) => { const path = pageLink(kind, text(r.id), text(r.path)); path.className = 'mono'; return [path, status(text(r.state)), el('span', text(r.kind), 'faint'), num(bytes(r.bytes)), num(text(r.passage_count)), timestamp((r.provenance as Resource['provenance']).captured_at)]; }), ['', '96px', '80px', '84px', '80px', '104px']));
  else main.append(table(['Context', 'Mode', 'Used / requested', 'Items', 'Created'], rows.map(({ record: r, created_at }) => { const budget = r.budget as ContextBundle['budget'], title = el('div', undefined, 'record-title'), id = el('small', text(r.context_id), 'mono'); title.append(pageLink('contexts', text(r.context_id), text(r.role)), id); return [title, el('span', text((r.retrieval as ContextBundle['retrieval'])?.effective), 'faint'), num(`${bytes(budget.used)} / ${bytes(budget.requested)}`), num(text(r.item_count)), timestamp(created_at)]; }), ['', '96px', '150px', '72px', '104px']));
  const numeric = kind === 'sources' ? [3, 4] : kind === 'contexts' ? [2, 3] : [];
  main.querySelectorAll('th').forEach((th, index) => { if (numeric.includes(index)) th.classList.add('num'); });
  const pager = el('div', undefined, 'pager');
  if (after) pager.append(button('First page', () => { main.replaceChildren(); return list(kind, ++generation, 0, filter); }));
  if (page.next !== null) pager.append(button('Next page', () => { main.replaceChildren(); return list(kind, ++generation, page.next!, filter); }));
  main.append(pager);
}
async function detail(kind: string, id: string, stamp: number) {
  const data = await api<Page & { resource?: Resource; changed_since_sync?: boolean; passages?: { id: string; start_line: number; end_line: number }[] }>('records', { kind, id }); if (stamp !== generation) return;
  const back = link(`← ${kind === 'contexts' ? 'Context Audit' : kind[0]!.toUpperCase() + kind.slice(1)}`, `#/${kind === 'contexts' ? 'context-audit' : kind}`); back.className = 'back'; main.append(back);
  if (kind === 'sources' && data.resource) {
    const r = data.resource, header = el('header', undefined, 'page-header'), title = el('h1', r.path, 'mono');
    header.append(title, metaLine(status(r.state), r.kind, bytes(new TextEncoder().encode(r.content).length), `Captured ${date(r.provenance.captured_at).toLowerCase()}`, r.provenance.workspace_id ? 'Workspace checkout' : 'Primary workspace'));
    main.append(header);
    if (data.changed_since_sync) main.append(el('p', 'This source differs from the indexed version. Previewing does not update the index; use Sync workspace when ready.', 'notice warning'));
    const code = el('div', undefined, 'code'), bar = el('div', undefined, 'code-bar'), pre = el('pre'), lines = r.content.split('\n');
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    for (const line of lines) pre.append(el('span', line));
    bar.append(el('span', 'PROJECT SOURCE · content, not dashboard instructions', 'source-label'), el('span', `${lines.length} lines · read-only`));
    code.append(bar, pre); main.append(code);
    main.append(el('h2', 'Passages'), table(['Reference', 'Lines'], (data.passages ?? []).map(p => [el('code', p.id), el('span', `${p.start_line}–${p.end_line}`, 'num')]), ['', '120px']), facts([['Source hash', el('code', r.hash)]]), provenanceBlock(r.provenance)); return;
  }
  const row = data.items[0]; if (!row) { empty('Record not found.', 'It may belong to a different project or workspace.'); return; }
  const wrap = el('div', undefined, 'detail'); main.append(wrap);
  if (kind === 'handoffs') {
    const h = row.record as unknown as Handoff, header = el('header', undefined, 'page-header');
    header.append(el('h1', h.task.goal), metaLine(el('strong', h.from.agent), el('span', h.from.session, 'mono'), status(h.task.status), timestamp(h.provenance.captured_at), h.provenance.workspace_id ? 'Workspace checkout' : 'Primary workspace'));
    const next = section('Recommended next action', [h.recommended_next_action]); next.classList.add('next-action');
    const grid = el('div', undefined, 'handoff-grid'), files = section('Files changed', h.files_changed); files.classList.add('files');
    grid.append(section('Completed', h.completed), section('Remaining', h.remaining), section('Decisions', h.decisions), section('Risks', h.risks));
    wrap.append(header, next, grid, files, provenanceBlock(h.provenance));
  } else if (kind === 'memories') {
    const m = row.record as unknown as Memory, header = el('header', undefined, 'page-header'), title = el('h1', m.key, 'mono');
    header.append(title, metaLine(originLabel(m), m.kind, status(m.status), timestamp(m.provenance.captured_at)));
    wrap.append(header, el('pre', m.text, 'memory-content'));
    if (m.status === 'needs_attention') wrap.append(el('p', 'This claim is quarantined. It is not delivered as active project knowledge.', 'notice warning'));
    wrap.append(el('h2', 'Origin'), facts([['Trust', m.provenance.trust], ['Agent / session', m.from ? `${m.from.agent} / ${m.from.session}` : undefined], ['Evidence', m.source_path], ['Source version', m.source_path ? m.provenance.source_version : undefined], ['Superseded by', m.superseded_by], ['Reviewed by', m.review?.by], ['Reviewed', m.review ? timestamp(m.review.at) : undefined]]), el('p', m.reason, 'reason'));
    const controls = el('div', undefined, 'actions');
    if (['proposed', 'needs_attention'].includes(m.status)) controls.append(button('Approve', trigger => review(m, 'accepted', trigger), 'primary'), button('Reject', trigger => review(m, 'rejected', trigger), 'danger'));
    if (!['forgotten', 'superseded'].includes(m.status)) controls.append(button('Forget', trigger => forget(m, trigger), 'danger'));
    wrap.append(controls);
    const revisions = await api<Page>('records', { kind: 'revisions', id, limit: '50' }); if (stamp !== generation) return;
    wrap.append(el('h2', 'Revision history'), table(['Revision', 'Status', 'Reason'], revisions.items.map(r => [el('span', text(r.cursor), 'num'), status(text(r.record.status)), el('span', text(r.record.reason), 'faint')]), ['80px', '140px', '']));
    if (revisions.next) wrap.append(el('p', 'Showing the first 50 revisions. The local audit retains all revisions.', 'muted'));
    wrap.append(provenanceBlock(m.provenance));
  } else if (kind === 'contexts') {
    const c = row.record as unknown as ContextBundle; heading('Context audit', 'Historical snapshot · source excerpts may no longer be current');
    const summary = el('dl', undefined, 'context-summary'), cell = (label: string, value: string | Node) => { const item = el('div'), dd = el('dd'); dd.append(value); item.append(el('dt', label), dd); summary.append(item); };
    const used = el('span', bytes(c.budget.used)), meter = el('span', undefined, 'meter'), fill = el('span'); fill.style.width = `${Math.min(100, Math.round(c.budget.used / Math.max(1, c.budget.requested) * 100))}%`; meter.append(fill); used.append(meter);
    cell('Role', c.role); cell('Mode', text(c.retrieval?.effective)); cell('Budget', bytes(c.budget.requested)); cell('Used', used); cell('Items', String(c.items.length)); cell('Created', timestamp(row.created_at)); cell('Workspace', c.workspace_id ? 'Workspace checkout' : 'Primary');
    main.append(summary, metaLine(el('span', c.context_id, 'mono'), 'Task text is not retained by the current context contract'));
    main.append(el('h2', 'Selected items'));
    const evidence = el('div', undefined, 'evidence');
    for (const item of c.items) {
      const d = el('details'), summaryLine = el('summary');
      summaryLine.append(el('span', `${item.passage?.path ?? item.provenance.origin}${item.passage ? `:${item.passage.start_line}–${item.passage.end_line}` : ''}`, 'mono'), el('span', `${item.kind} · ${item.provenance.trust}`, 'faint'));
      d.append(summaryLine, section('Why included?', item.reasons), facts([['Source version', el('code', item.provenance.source_version)], ['Audit ref', el('code', item.id)]]), el('div', 'HISTORICAL PROJECT CONTENT', 'source-label'), el('pre', item.content)); evidence.append(d);
    }
    main.append(evidence);
    const selection = await api<SelectionAudit | null>('selection', { id }); if (stamp !== generation) return;
    main.append(el('h2', 'Selection decisions'));
    if (selection) { const decisions = table(['Source', 'Outcome', 'Reasons'], selection.entries.map(e => [el('span', e.source, 'mono'), status(e.outcome === 'included' ? 'active' : 'disabled', e.outcome === 'budget' ? 'Budget excluded' : e.outcome[0]!.toUpperCase() + e.outcome.slice(1)), e.reasons.join(' · ')]), ['30%', '130px', '']); decisions.classList.add('decisions'); main.append(decisions, el('p', `${selection.candidates} candidates. Stored selection audit is bounded to 500 entries.`, 'reason')); }
    else main.append(el('p', 'No selection audit recorded for this historical context.', 'muted'));
  }
}
function provenanceBlock(value: unknown) { const d = provenance(value); d.classList.add('provenance'); return d; }
function memoryOrigin(m: Memory) { return m.status === 'needs_attention' ? 'CONFLICT' : m.status === 'accepted' ? 'HUMAN' : m.source_path && m.provenance.trust === 'derived' ? 'SOURCE' : 'AGENT'; }
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
    else if (name === 'projects') { heading('Projects', 'Registered project identities on this installation. Each keeps its own memory, handoffs and sources.');
      const projectTable = table(['Project', 'Primary root', 'Project ID'], projects.map(p => { const choose = button(p.name, async () => { projectId = p.project_id; workspaceId = ''; await selectors(); go('workspaces'); }); if (p.project_id === projectId) choose.setAttribute('aria-current', 'true'); return [choose, pathText(p.root), identifier(p.project_id)]; }), ['28%', '', '200px']);
      projectTable.querySelectorAll('tbody tr').forEach((tr, i) => { if (projects[i]?.project_id === projectId) tr.classList.add('current'); }); main.append(projectTable); if (!projects.length) empty('No projects registered.', 'Run continuity init inside a project.'); if (nextProjects !== null) main.append(button('Load more projects', async () => { const response = await fetch(`/dashboard-api/projects?after=${nextProjects}`, { headers: { 'X-Continuity-Token': token } }); if (!response.ok) throw new Error('Could not load project registrations.'); const page = await response.json() as { projects: Project[]; next: number | null }; projects.push(...page.projects); nextProjects = page.next; await selectors(); await render(); })); }
    else if (name === 'workspaces') {
      heading('Workspaces', 'One project identity. Separate current sources for every registered checkout.');
      const project = projects.find(p => p.project_id === projectId); if (!project) { empty('No project selected.', 'Register a project first.'); return; }
      const all = [{ workspace_id: '', root: project.root }, ...workspaces], workspaceTable = table(['Workspace', 'Canonical root', 'Identity'], all.map(w => { const choose = button(w.workspace_id ? w.root.split(/[\\/]/).at(-1)! : 'Primary', () => { workspaceId = w.workspace_id; return selectors().then(render); }); choose.setAttribute('aria-pressed', String(w.workspace_id === workspaceId)); return [choose, pathText(w.root), identifier(w.workspace_id || 'Primary workspace')]; }), ['24%', '', '200px']);
      workspaceTable.querySelectorAll('tbody tr').forEach((tr, i) => { if (all[i]?.workspace_id === workspaceId) tr.classList.add('current'); }); main.append(workspaceTable);
      const status = await api<Record<string, unknown>>('status', {}); if (stamp !== generation) return;
      const sync = status.sync as { at: string; files: number; bytes: number } | undefined;
      const panels = el('div', undefined, 'workspace-panels'), selected = el('section'), scoped = el('section'); panels.append(selected, scoped); main.append(panels);
      selected.append(el('h2', 'Selected workspace'), fields([['Canonical root', el('span', workspaces.find(w => w.workspace_id === workspaceId)?.root ?? project.root, 'mono')], ['Last sync', timestamp(sync?.at)], ['Sources at last sync', sync?.files], ['Source bytes', bytes(sync?.bytes)]]), button('Sync workspace', async () => { await api('sync', undefined, { project: projectId, workspace: workspaceId }); await render(); }), el('p', 'Sync uses the configured source exclusions and optional semantic backend. It does not edit project files.', 'note'));
      const selection = await api<{ filtered: boolean; include: string[]; exclude: string[]; host_include: string[]; host_exclude: string[] }>('source-scope', {}); if (stamp !== generation) return;
      scoped.append(el('h2', 'Source index scope'), fields([['Filtered source scope', selection.filtered ? 'Yes' : 'No'], ['Include', selection.include.length ? selection.include.join(', ') : 'Default'], ['Exclude', selection.exclude.length ? selection.exclude.join(', ') : 'None']]));
      if (selection.host_include.length || selection.host_exclude.length) scoped.append(fields([['Additional host include', selection.host_include], ['Additional host exclude', selection.host_exclude]]));
      scoped.append(el('p', 'Change with continuity sources set or clear. Project identity is unaffected.', 'note'));
    } else if (name === 'diagnostics') {
      heading('Diagnostics', 'The same local health checks as continuity doctor. Optional semantic services are not required.');
      const health = await api<Record<string, unknown>>('diagnostics'); if (stamp !== generation) return;
      const problems = health.problems as string[];
      const line = el('p', undefined, 'health-line'); line.append(status(problems.length ? 'degraded' : 'healthy', problems.length ? 'Degraded · review the findings below' : 'Healthy · local storage and registrations')); main.append(line);
      const diagnostics = el('div', undefined, 'diagnostic-sections'), core = el('section'), runtime = el('section');
      const roots = (health.roots as { accessible: boolean }[] | undefined) ?? [], adapters = (health.adapters as Record<string, boolean> | undefined) ?? {};
      core.append(el('h2', 'Storage'), fields([['Database', status(text(health.integrity))], ['FTS5', status(health.fts5 ? 'active' : 'unavailable')], ['Schema', `Version ${text(health.schema_version)}`], ['Registered roots', `${roots.filter(r => r.accessible).length} of ${roots.length} accessible`]]));
      runtime.append(el('h2', 'Runtime'), fields([['Package', health.version], ['Node', health.node], ['MCP (stdio)', adapters['mcp-stdio'] ? 'Available' : 'Unavailable'], ['Local HTTP (loopback)', adapters['http-loopback'] ? 'Available' : 'Unavailable']])); diagnostics.append(core);
      if (projectId) { const retrieval = await api<{ status: string; reason: string }>('retrieval', {}).catch(() => ({ status: 'unavailable', reason: 'Workspace unavailable. Check its registration and source root.' })); if (stamp !== generation) return; const retrievalSection = el('section'); retrievalSection.append(el('h2', 'Retrieval'), fields([['Lexical', status(health.fts5 ? 'active' : 'unavailable')], ['Semantic', retrieval.status === 'disabled' ? 'Disabled · FTS5 active' : status(retrieval.status)], ['Detail', retrieval.reason]])); diagnostics.append(retrievalSection); }
      const findings = section('Findings', problems); if (!problems.length) findings.querySelector('p')!.textContent = 'None.';
      diagnostics.append(runtime, findings); main.append(diagnostics);
      main.append(provenanceBlock({ roots: health.roots, workspaces: health.workspaces, adapters: health.adapters }));
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
