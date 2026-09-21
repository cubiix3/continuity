import type { ContextBundle, Handoff, Memory, Project, Resource, SelectionAudit, Workspace } from '../../core/src/contracts.js';

type Row = { record: Record<string, unknown>; cursor: number; created_at?: string };
type Page = { items: Row[]; next: number | null };
const main = document.querySelector<HTMLElement>('main')!;
const nav = document.querySelector<HTMLElement>('nav')!;
const scope = document.querySelector<HTMLElement>('#scope')!;
let token = '', projectId = '', workspaceId = '', generation = 0;
let projects: Project[] = [], workspaces: Workspace[] = [];
let nextProjects: number | null = null;
const pages = ['Overview', 'Projects', 'Workspaces', 'Handoffs', 'Memories', 'Sources', 'Context Audit', 'Diagnostics'];
const slug = (name: string) => name.toLowerCase().replace(' ', '-');
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
}
function link(text: string, href: string) { const a = el('a', text); a.href = href.startsWith('#/') && projectId ? `${href}?${new URLSearchParams({ project: projectId, workspace: workspaceId })}` : href; return a; }
function button(text: string, run: () => void | Promise<void>, className?: string) {
  const b = el('button', text, className); b.type = 'button'; b.onclick = () => { b.disabled = true; Promise.resolve().then(run).catch(showError).finally(() => { b.disabled = false; }); }; return b;
}
function showError(error: unknown) { const box = el('div', undefined, 'error'); box.role = 'alert'; box.append(el('p', error instanceof Error ? error.message : 'Request failed.'), link('Run diagnostics', '#/diagnostics')); main.prepend(box); }
function text(value: unknown): string { return value === undefined || value === null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
function date(value: unknown) { return typeof value === 'string' ? new Date(value).toLocaleString() : 'Not recorded'; }
function bytes(value: unknown) { return typeof value === 'number' ? `${value.toLocaleString()} B` : '—'; }
function route() { return location.hash.slice(2).split('?')[0]!.split('/'); }
function go(page: string) { location.hash = `/${page}`; }
function scopedQuery(values: Record<string, string> = {}) { return new URLSearchParams({ project: projectId, workspace: workspaceId, ...values }).toString(); }
async function api<T>(path: string, values?: Record<string, string>, body?: unknown): Promise<T> {
  const response = await fetch(`/dashboard-api/${path}${values ? `?${scopedQuery(values)}` : ''}`, { headers: { 'X-Continuity-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const data = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`); return data;
}
function heading(title: string, subtitle: string) { main.append(el('div', projectId ? projects.find(p => p.project_id === projectId)?.name ?? 'Local installation' : 'Local installation', 'eyebrow'), el('h1', title), el('p', subtitle, 'subtitle')); }
function empty(title: string, description: string) { const block = el('div', undefined, 'empty'); block.append(el('strong', title), el('p', description, 'muted')); main.append(block); }
function fields(values: [string, unknown][]) { const dl = el('dl', undefined, 'details'); for (const [key, value] of values) dl.append(el('dt', key), el('dd', text(value))); return dl; }
function table(headers: string[], rows: (string | Node)[][]) {
  const wrap = el('div', undefined, 'table-wrap'), t = el('table'), head = el('thead'), tr = el('tr'); headers.forEach(h => tr.append(el('th', h))); head.append(tr); t.append(head);
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
  scope.append(pLabel, p, wLabel, w);
  if (loaded.next !== null) scope.append(button('More workspaces', () => selectors(loaded.next!)));
  for (const a of nav.querySelectorAll('a')) a.href = `${a.hash.split('?')[0]}?${new URLSearchParams({ project: projectId, workspace: workspaceId })}`;
}
async function overview(stamp: number) {
  heading('Project continuity, at a glance.', 'Your local projects, the state agents left behind, and knowledge waiting for review.');
  if (!projectId) { empty('No projects registered.', 'Run continuity init inside a project, then continuity sync. Reload this page to see the registration.'); main.append(el('pre', 'continuity init\ncontinuity sync')); return; }
  const [handoffs, counts, status, health] = await Promise.all([api<Page>('records', { kind: 'handoffs', limit: '5' }), api<{ pending: number; sources: number; memories: number; handoffs: number }>('stats', {}), api<Record<string, unknown>>('status', {}), api<{ integrity: string; fts5: boolean; problems: string[] }>('diagnostics')]);
  if (stamp !== generation) return;
  main.append(el('span', health.integrity === 'ok' && health.fts5 && !health.problems.length ? 'Healthy · local storage and registrations' : 'Degraded · inspect Diagnostics', 'pill'));
  const stats = el('div', undefined, 'stats');
  const pending = counts.pending;
  for (const [label, value] of [['Indexed sources', counts.sources], ['Project memories', counts.memories], ['Pending review', pending], ['Workspace handoffs', counts.handoffs]]) { const stat = el('div', undefined, 'stat'); stat.append(el('strong', String(value)), el('span', String(label))); stats.append(stat); }
  main.append(stats);
  const split = el('div', undefined, 'split'), left = el('section'), right = el('section'); left.append(el('h2', 'Recent handoffs'), timeline(handoffs.items));
  right.append(el('h2', 'Local state'), fields([['Source snapshot', 'Read-only · sync on demand'], ['Last sync', date((status.sync as { at?: string } | undefined)?.at)], ['Memory review', pending ? `${pending} pending` : 'No pending entries']]), link('Inspect diagnostics →', '#/diagnostics'), el('p', 'Search is optional. Native coding tools remain available to your agents.', 'muted'));
  split.append(left, right); main.append(split);
}
function timeline(rows: Row[]) {
  const list = el('ol', undefined, 'timeline');
  for (const row of rows) { const h = row.record as unknown as Handoff, li = el('li'); li.append(el('div', `${h.from.agent} · ${date(h.provenance.captured_at)}`, 'agent'), pageLink('handoffs', h.id, h.task.goal), el('p', `${h.task.status.replaceAll('_', ' ')} · ${h.recommended_next_action || 'No next action recorded.'}`)); list.append(li); }
  if (!rows.length) list.append(el('p', 'No handoffs yet. Structured work state appears here when an agent leaves a handoff.', 'muted')); return list;
}
async function list(kind: string, stamp: number, after = 0, filter = 'all') {
  const name = kind === 'contexts' ? 'Context Audit' : kind[0]!.toUpperCase() + kind.slice(1);
  heading(name, kind === 'memories' ? 'Project-wide knowledge. Proposals become durable knowledge only through the existing memory policy.' : kind === 'contexts' ? 'Historical context decisions, including provenance and excluded candidates.' : kind === 'sources' ? 'Last indexed metadata. Open a source to validate its current content.' : 'Structured work state between agents and sessions. No chat transcripts.');
  if (!projectId) { empty('Select a project.', 'Register a project with continuity init to get started.'); return; }
  const page = await api<Page>('records', { kind, after: String(after), ...(filter === 'all' ? {} : kind === 'sources' ? { source_filter: filter } : { status: filter }) }); if (stamp !== generation) return;
  if (kind === 'memories') { const bar = el('div', undefined, 'toolbar'), select = el('select'); select.ariaLabel = 'Memory status';
    for (const [value, label] of [['all', 'All statuses'], ['accepted', 'Accepted'], ['proposed', 'Pending'], ['needs_attention', 'Needs attention'], ['rejected', 'Rejected'], ['superseded', 'Superseded']]) { const o = el('option', label!); o.value = value!; select.append(o); } select.value = filter; select.onchange = () => { main.replaceChildren(); void list(kind, ++generation, 0, select.value).catch(showError); }; bar.append(select); main.append(bar); }
  if (kind === 'sources') { const bar = el('div', undefined, 'toolbar'), select = el('select'); select.ariaLabel = 'Source filter';
    for (const [value, label] of [['all', 'All indexed versions'], ['fresh', 'Fresh at last sync'], ['stale', 'Stale / superseded / missing'], ['rules', 'Rules'], ['docs', 'Docs (.md, .txt, .rst)'], ['code', 'Common code extensions']]) { const option = el('option', label!); option.value = value!; select.append(option); } select.value = filter; select.onchange = () => { main.replaceChildren(); void list(kind, ++generation, 0, select.value).catch(showError); }; bar.append(select); main.append(bar); }
  const rows = page.items;
  if (!rows.length) empty('No entries on this page.', kind === 'handoffs' ? 'Handoffs appear when an agent records structured work state for another session.' : 'Use the CLI or your agent integration to create records.');
  else if (kind === 'handoffs') main.append(timeline(rows));
  else if (kind === 'memories') main.append(table(['Claim', 'Kind', 'Status', 'Created', 'Reviewed by'], rows.map(({ record: r }) => { const claim = el('div'); claim.append(pageLink(kind, text(r.id), text(r.key)), el('small', text(r.text).slice(0, 120))); return [claim, text(r.kind), text(r.status), date((r.provenance as Memory['provenance']).captured_at), text((r.review as Memory['review'])?.by)]; })));
  else if (kind === 'sources') main.append(table(['Path', 'Kind', 'Indexed state', 'Size', 'Passages', 'Hash'], rows.map(({ record: r }) => [pageLink(kind, text(r.id), text(r.path)), text(r.kind), text(r.state), bytes(r.bytes), text(r.passage_count), el('code', text(r.hash).slice(0, 12))])));
  else main.append(table(['Context', 'Role / mode', 'Used / requested', 'Items', 'Created'], rows.map(({ record: r, created_at }) => { const budget = r.budget as ContextBundle['budget']; return [pageLink('contexts', text(r.context_id), text(r.context_id).slice(0, 20)), `${text(r.role)} / ${text((r.retrieval as ContextBundle['retrieval'])?.effective)}`, `${bytes(budget.used)} / ${bytes(budget.requested)}`, text(r.item_count), date(created_at)]; })));
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
    main.append(fields([['From', h.from.agent], ['Session', h.from.session], ['Status', h.task.status], ['Created', date(h.provenance.captured_at)], ['Workspace', h.provenance.workspace_id ?? 'Primary']]), section('Recommended next action', [h.recommended_next_action]), section('Completed', h.completed), section('Remaining', h.remaining), section('Decisions', h.decisions), section('Files changed', h.files_changed), section('Risks', h.risks), provenance(h.provenance));
  } else if (kind === 'memories') {
    const m = row.record as unknown as Memory; heading(m.key, 'Durable project knowledge · current source takes precedence');
    main.append(fields([['Kind', m.kind], ['Status', m.status], ['Policy reason', m.reason], ['Evidence', m.source_path ?? 'No source supplied'], ['Reviewed by', m.review?.by], ['Reviewed', m.review ? date(m.review.at) : 'Not reviewed']]), el('pre', m.text));
    if (['proposed', 'needs_attention'].includes(m.status)) { const bar = el('div', undefined, 'toolbar'); bar.append(button('Approve', () => review(m, 'accepted'), 'primary'), button('Reject', () => review(m, 'rejected'), 'danger')); main.append(bar); }
    const revisions = await api<Page>('records', { kind: 'revisions', id, limit: '50' }); if (stamp !== generation) return;
    main.append(el('h2', 'Revision history'), table(['Revision', 'Status', 'Reason'], revisions.items.map(r => [text(r.cursor), text(r.record.status), text(r.record.reason)])), provenance(m.provenance));
    if (revisions.next) main.append(el('p', 'Showing the first 50 revisions. The local audit retains all revisions.', 'muted'));
  } else if (kind === 'contexts') {
    const c = row.record as unknown as ContextBundle; heading('Context audit', 'Historical snapshot · source excerpts may no longer be current');
    main.append(fields([['Context', c.context_id], ['Task', 'Not retained by the current context contract'], ['Created', date(row.created_at)], ['Role', c.role], ['Retrieval', c.retrieval?.effective], ['Budget requested', bytes(c.budget.requested)], ['Budget used', bytes(c.budget.used)], ['Workspace', c.workspace_id ?? 'Primary']]));
    main.append(el('h2', 'Selected items'));
    for (const item of c.items) { const d = el('details'); d.append(el('summary', `${item.kind} · ${item.passage?.path ?? item.provenance.origin}${item.passage ? `:${item.passage.start_line}–${item.passage.end_line}` : ''}`), fields([['Trust', item.provenance.trust], ['Source version', item.provenance.source_version], ['Audit ref', item.id]]), section('Why included?', item.reasons), el('div', 'HISTORICAL PROJECT CONTENT', 'source-label'), el('pre', item.content)); main.append(d); }
    const selection = await api<SelectionAudit | null>('selection', { id }); if (stamp !== generation) return;
    main.append(el('h2', 'Selection decisions'));
    if (selection) main.append(table(['Source', 'Outcome', 'Reasons'], selection.entries.map(e => [e.source, e.outcome === 'budget' ? 'Budget excluded' : e.outcome, e.reasons.join(' · ')])), el('p', `${selection.candidates} candidates. Stored selection audit is bounded to 500 entries.`, 'muted'));
    else main.append(el('p', 'No selection audit recorded for this historical context.'));
  }
}
function review(memory: Memory, decision: 'accepted' | 'rejected') {
  const dialog = el('dialog'), title = el('h2', decision === 'accepted' ? 'Approve this memory?' : 'Reject this memory?'), label = el('label', 'Reviewer name'), input = el('input'); input.id = 'reviewer'; input.maxLength = 100; label.htmlFor = input.id;
  title.id = 'review-title'; dialog.setAttribute('aria-labelledby', title.id);
  dialog.append(title, el('p', 'This records an explicit human review. Source authority and conflict checks remain unchanged.'), label, input);
  const failure = el('p'); failure.role = 'alert'; dialog.append(failure);
  const bar = el('div', undefined, 'toolbar'); bar.append(button('Cancel', () => dialog.close()), button(decision === 'accepted' ? 'Approve memory' : 'Reject memory', async () => {
    if (!input.value.trim()) { input.setCustomValidity('Enter a reviewer name.'); input.reportValidity(); return; }
    try { await api('review', undefined, { project: projectId, workspace: workspaceId, id: memory.id, decision, by: input.value.trim() }); }
    catch (error) { failure.textContent = error instanceof Error ? error.message : 'Review failed. Refresh and inspect the memory history.'; return; }
    dialog.close(); await render();
  }, decision === 'accepted' ? 'primary' : 'danger'));
  input.oninput = () => input.setCustomValidity(''); dialog.append(bar); document.body.append(dialog); dialog.onclose = () => dialog.remove(); dialog.showModal(); input.focus();
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
    else if (name === 'projects') { heading('Projects', 'Registered project identities on this installation.'); main.append(table(['Project', 'Project ID', 'Primary root'], projects.map(p => [button(p.name, async () => { projectId = p.project_id; workspaceId = ''; await selectors(); go('workspaces'); }), el('code', p.project_id), el('span', p.root, 'path')]))); if (!projects.length) empty('No projects registered.', 'Run continuity init inside a project.'); if (nextProjects !== null) main.append(button('Load more projects', async () => { const response = await fetch(`/dashboard-api/projects?after=${nextProjects}`, { headers: { 'X-Continuity-Token': token } }); if (!response.ok) throw new Error('Could not load project registrations.'); const page = await response.json() as { projects: Project[]; next: number | null }; projects.push(...page.projects); nextProjects = page.next; await selectors(); await render(); })); }
    else if (name === 'workspaces') {
      heading('Workspaces', 'One project identity. Separate current sources for every registered checkout.');
      const project = projects.find(p => p.project_id === projectId); if (!project) { empty('No project selected.', 'Register a project first.'); return; }
      main.append(table(['Workspace', 'Canonical root', 'Identity'], [{ workspace_id: '', root: project.root }, ...workspaces].map(w => [button(w.workspace_id ? w.root.split(/[\\/]/).at(-1)! : 'Primary', () => { workspaceId = w.workspace_id; return selectors().then(render); }), w.root, el('code', w.workspace_id || 'Primary workspace')])));
      const status = await api<Record<string, unknown>>('status', {}); if (stamp !== generation) return;
      const sync = status.sync as { at: string; files: number; bytes: number } | undefined;
      main.append(el('h2', 'Selected workspace'), fields([['Last sync', date(sync?.at)], ['Sources at last sync', sync?.files], ['Source bytes', bytes(sync?.bytes)]]), button('Sync workspace', async () => { await api('sync', undefined, { project: projectId, workspace: workspaceId }); await render(); }), el('p', 'Sync uses the configured source exclusions and optional semantic backend. It does not edit project files.', 'muted'));
    } else if (name === 'diagnostics') {
      heading('Diagnostics', 'The same local health checks as continuity doctor. Optional semantic services are not required.');
      const health = await api<Record<string, unknown>>('diagnostics'); if (stamp !== generation) return;
      const problems = health.problems as string[];
      main.append(el('p', problems.length ? 'Degraded · review the findings below' : 'Healthy · local storage and registrations', 'notice'), fields([['Database integrity', health.integrity], ['FTS5', health.fts5 ? 'Active' : 'Unavailable'], ['Schema', health.schema_version], ['Package', health.version], ['Node runtime', health.node]]), section('Findings', problems));
      if (projectId) { const retrieval = await api<{ status: string; reason: string }>('retrieval', {}).catch(() => ({ status: 'unavailable', reason: 'Workspace unavailable. Check its registration and source root.' })); if (stamp !== generation) return; main.append(el('h2', 'Semantic retrieval'), fields([['Status', retrieval.status === 'disabled' ? 'Disabled · FTS5 active' : retrieval.status], ['Detail', retrieval.reason]])); }
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
  for (const page of pages) nav.append(link(page, `#/${slug(page)}`));
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
