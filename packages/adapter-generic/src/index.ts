import type { ContextRequest, ProjectClient, RetrievalMode } from '../../core/src/index.js';

export interface AgentAdapter {
  context(request: ContextRequest): ReturnType<ProjectClient['context']>;
  search(query: string, mode?: RetrievalMode): ReturnType<ProjectClient['search']>;
  propose(input: unknown): ReturnType<ProjectClient['propose']>;
  createHandoff(input: unknown): ReturnType<ProjectClient['createHandoff']>;
  latestHandoff(): ReturnType<ProjectClient['latestHandoff']>;
  observe(input: unknown): ReturnType<ProjectClient['observe']>;
}

/** No storage, namespace selector, or long-term memory mutation is exposed. */
export class GenericAdapter implements AgentAdapter {
  constructor(private readonly client: ProjectClient) {}
  context(request: ContextRequest) { return this.client.context(request); }
  search(query: string, mode?: RetrievalMode) { return this.client.search(query, mode); }
  propose(input: unknown) { return this.client.propose(input); }
  createHandoff(input: unknown) { return this.client.createHandoff(input); }
  latestHandoff() { return this.client.latestHandoff(); }
  observe(input: unknown) { return this.client.observe(input); }
}
