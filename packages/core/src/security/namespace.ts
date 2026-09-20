import type { Project } from '../contracts.js';

export class NamespaceGuard {
  readonly namespace: string;
  constructor(readonly project: Project) { this.namespace = `project:${project.project_id}`; }
  assert(projectId: string): void {
    if (projectId !== this.project.project_id) throw new Error('Project boundary denied.');
  }
}
