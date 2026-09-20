import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { contextRequestSchema, handoffInputSchema, memoryCandidateSchema, observationSchema } from '../../core/src/contracts.js';
import type { AgentAdapter } from '../../adapter-generic/src/index.js';

async function result(action: () => unknown) {
  try {
    const data = { result: await action() };
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
  } catch {
    return { isError: true, content: [{ type: 'text' as const, text: 'Continuity could not complete this request. Check input fields and run continuity doctor and continuity sync in the configured project.' }] };
  }
}
export function createMcpServer(adapter: AgentAdapter): McpServer {
  const server = new McpServer({ name: 'continuity', version: '0.1.0' });
  const annotations = { destructiveHint: false, openWorldHint: false };
  server.registerTool('continuity_observe', { description: 'Record bounded execution observations in this project. Observations never become memory automatically.', inputSchema: observationSchema, annotations }, args => result(() => adapter.observe(args)));
  server.registerTool('continuity_context', { description: 'Get a budgeted, source-checked context bundle for the host-configured project. Budget is UTF-8 bytes, including metadata.', inputSchema: contextRequestSchema, annotations }, args => result(() => adapter.context(args)));
  server.registerTool('continuity_search', { description: 'Search current sources in the host-configured project. Returns up to 10 excerpts with provenance.', inputSchema: z.object({ query: z.string().min(1).max(2000), mode: z.enum(['lexical', 'semantic', 'hybrid']).optional() }).strict(), annotations }, args => result(() => adapter.search(args.query, args.mode)));
  server.registerTool('continuity_memory_propose', { description: 'Propose a durable source excerpt. Unsupported claims and conflicts need attention; routine output is rejected.', inputSchema: memoryCandidateSchema, annotations }, args => result(() => adapter.propose(args)));
  server.registerTool('continuity_handoff_create', { description: 'Save a structured handoff in the configured project for another agent or session.', inputSchema: handoffInputSchema, annotations }, args => result(() => adapter.createHandoff(args)));
  server.registerTool('continuity_handoff_latest', { description: 'Read the latest structured handoff in the configured project, or null.', inputSchema: z.object({}).strict(), annotations: { ...annotations, readOnlyHint: true, idempotentHint: true } }, () => result(() => adapter.latestHandoff()));
  return server;
}
export async function serveMcp(adapter: AgentAdapter): Promise<McpServer> {
  const server = createMcpServer(adapter);
  await server.connect(new StdioServerTransport());
  return server;
}
