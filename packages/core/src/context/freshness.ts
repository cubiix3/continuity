import type { ContextKind, Memory, Resource } from '../contracts.js';

/** A source-backed memory is usable only while its exact source version is fresh in the current snapshot. */
export function sourceBackedCurrent(memory: Memory, sources: readonly Resource[]) {
  return !memory.source_path || sources.some(r => r.state === 'fresh' && r.path === memory.source_path && r.hash === memory.provenance.source_version);
}

/** A memory never becomes a project rule; rules come from current project sources. */
export function memoryContextKind(memory: Memory): Exclude<ContextKind, 'rule'> {
  return memory.kind === 'rule' ? 'memory' : memory.kind;
}
