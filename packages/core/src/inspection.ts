import type { InspectionKind, InspectionStoragePort } from './contracts.js';
import { passages } from './context/passages.js';

/** Trusted human inspection. Never passed to agent adapters. */
export class Inspection {
  constructor(private readonly storage: InspectionStoragePort) {}
  scope(projectId: string, workspaceId = '') {
    const project = this.storage.projects().find(p => p.project_id === projectId);
    if (!project) throw new Error('Project registration not found.');
    const workspace = workspaceId ? this.storage.workspaces(projectId).find(w => w.workspace_id === workspaceId) : undefined;
    if (workspaceId && !workspace) throw new Error('Workspace does not belong to this project.');
    return { project, workspace };
  }
  workspaces(projectId: string) { this.scope(projectId); return this.storage.workspaces(projectId); }
  stats(projectId: string, workspaceId: string) { this.scope(projectId, workspaceId); return this.storage.inspectionStats(projectId, workspaceId); }
  page(projectId: string, workspaceId: string, kind: InspectionKind, limit = 20, after = 0, id?: string, status?: string, sourceFilter?: string) {
    this.scope(projectId, workspaceId);
    const page = this.storage.browse(projectId, workspaceId, kind, limit, after, id, status, sourceFilter);
    for (const { record } of page.items) {
      if ('items' in record && record.items.some(item => item.provenance.project_id !== projectId || (['source', 'rule'].includes(item.kind) && (item.provenance.workspace_id ?? '') !== workspaceId))) throw new Error('Corrupted context item scope.');
    }
    // Lists do not repeatedly ship source bodies, large handoffs or full audit bundles.
    if (id) return page;
    return { ...page, items: page.items.map(({ record, ...meta }) => {
      if ('context_id' in record) return { ...meta, record: { context_id: record.context_id, project_id: record.project_id, role: record.role, budget: record.budget, retrieval: record.retrieval, item_count: record.items.length } };
      if ('content' in record) { const { content, ...rest } = record; return { ...meta, record: { ...rest, bytes: Buffer.byteLength(content), passage_count: record.state === 'fresh' ? passages([record]).length : 0 } }; }
      if ('task' in record) return { ...meta, record: { id: record.id, project_id: record.project_id, from: record.from, task: record.task, recommended_next_action: record.recommended_next_action, provenance: record.provenance } };
      return { ...meta, record };
    }) };
  }
  selection(projectId: string, workspaceId: string, id: string) {
    const page = this.page(projectId, workspaceId, 'contexts', 1, 0, id);
    if (!page.items.length) throw new Error('Context not found in this workspace.');
    return this.storage.selection(projectId, id);
  }
}
