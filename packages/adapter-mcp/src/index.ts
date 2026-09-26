import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { contextRequestSchema, handoffInputSchema, memoryCandidateSchema, observationSchema } from '../../core/src/contracts.js';
import { renderBootstrap } from '../../core/src/context/bootstrap.js';
import type { AgentAdapter } from '../../adapter-generic/src/index.js';

async function result(action: () => unknown) {
  try {
    const data = { result: await action() };
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
  } catch {
    return { isError: true, content: [{ type: 'text' as const, text: 'Continuity could not complete this request. Check input fields and run continuity doctor and continuity sync in the configured project.' }] };
  }
}
export const MCP_TOOLS = ['continuity_observe', 'continuity_context', 'continuity_search', 'continuity_memory_propose', 'continuity_handoff_create', 'continuity_bootstrap', 'continuity_handoff_latest'] as const;
export type McpToolName = typeof MCP_TOOLS[number];
/**
 * The detail tools a provider integration installs next to its hooks. They write no memories or handoffs (saving stays
 * with the hooks); context and search refresh the source index and record a context audit like any retrieval.
 */
export const DETAIL_TOOLS: readonly McpToolName[] = ['continuity_context', 'continuity_search', 'continuity_handoff_latest'];
export interface McpServerOptions {
  /** Registers only these tools (all seven by default). */
  tools?: readonly McpToolName[];
  /** Tool `_meta` for every registered tool, e.g. a client's loading hint. */
  meta?: Record<string, unknown>;
}
/**
 * The project is bound by the host before any tool exists: tools take no project, root, workspace or database input.
 * Without an adapter (a session outside every registered project) the server registers no tools and says nothing.
 */
export function createMcpServer(adapter: AgentAdapter | undefined, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'continuity', version: '0.1.0' });
  if (!adapter) return server;
  const wanted = new Set<McpToolName>(options.tools ?? MCP_TOOLS);
  const annotations = { destructiveHint: false, openWorldHint: false };
  const extra = options.meta ? { _meta: options.meta } : {};
  if (wanted.has('continuity_observe')) server.registerTool('continuity_observe', { ...extra, description: 'Record bounded execution observations in this project. Observations never become memory automatically.', inputSchema: observationSchema, annotations }, args => result(() => adapter.observe(args)));
  if (wanted.has('continuity_context')) server.registerTool('continuity_context', { ...extra, description: 'Get a task-specific context bundle for this project: current project rules, the most relevant source passages, durable memories (decisions and lessons, including ones not listed at session start) and the latest open handoff, each with provenance. Budget is UTF-8 bytes, including metadata.', inputSchema: contextRequestSchema, annotations }, args => result(() => adapter.context(args)));
  if (wanted.has('continuity_search')) server.registerTool('continuity_search', { ...extra, description: 'Search current sources in this project. Returns up to 10 excerpts with provenance.', inputSchema: z.object({ query: z.string().min(1).max(2000), mode: z.enum(['lexical', 'semantic', 'hybrid']).optional() }).strict(), annotations }, args => result(() => adapter.search(args.query, args.mode)));
  if (wanted.has('continuity_memory_propose')) server.registerTool('continuity_memory_propose', { ...extra, description: 'Record durable project knowledge. Current source excerpts activate automatically. Agent lessons require from.agent/from.session and activate with agent_observation trust. Routine output is rejected; conflicts are quarantined. Results report persisted, duplicate, superseded, rejected or quarantined. Do not submit generic advice, TODOs or guesses.', inputSchema: memoryCandidateSchema, annotations }, args => result(() => adapter.propose(args)));
  if (wanted.has('continuity_handoff_create')) server.registerTool('continuity_handoff_create', { ...extra, description: 'Save a structured handoff in the configured project for another agent or session.', inputSchema: handoffInputSchema, annotations }, args => result(() => adapter.createHandoff(args)));
  if (wanted.has('continuity_bootstrap')) server.registerTool('continuity_bootstrap', { ...extra, description: 'Read the compact startup index for the host-configured project: health, conflicts, latest handoff and a bounded list of durable memories with trust labels. Read-only; no sync. Use at session start when the host has not already injected it.', inputSchema: z.object({}).strict(), annotations: { ...annotations, readOnlyHint: true, idempotentHint: true } }, () => result(() => { const bundle = adapter.bootstrap(); return { text: renderBootstrap(bundle, new Date(), { tools: ['continuity_context', 'continuity_search'] }), bundle }; }));
  if (wanted.has('continuity_handoff_latest')) server.registerTool('continuity_handoff_latest', { ...extra, description: 'Read the latest structured handoff in the configured project, or null.', inputSchema: z.object({}).strict(), annotations: { ...annotations, readOnlyHint: true, idempotentHint: true } }, () => result(() => adapter.latestHandoff()));
  return server;
}
export async function serveMcp(adapter: AgentAdapter | undefined, options: McpServerOptions = {}): Promise<McpServer> {
  const server = createMcpServer(adapter, options);
  await server.connect(new StdioServerTransport());
  return server;
}
