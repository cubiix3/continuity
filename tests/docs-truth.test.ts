import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { MCP_TOOLS, DETAIL_TOOLS } from '../packages/adapter-mcp/src/index.js';
import { CONTINUITY_HOST_API_VERSION } from '../packages/sdk/src/index.js';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const cli = resolve('dist/packages/cli/src/index.js');
const help = (...args: string[]) => execFileSync(process.execPath, [cli, ...args, '--help'], {
  encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NODE_NO_WARNINGS: '1' }
});
const commands = (...args: string[]) => {
  const section = help(...args).split(/\r?\nCommands:\r?\n/)[1];
  if (!section) throw new Error('CLI help has no Commands section');
  return [...section.matchAll(/^ {2}([a-z][a-z-]*)(?=\s|$)/gm)].map(match => match[1]!).filter(name => name !== 'help');
};

it('documents the actual package directories', () => {
  const modules = readdirSync(resolve('packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const documented = [...read('docs/architecture.md').matchAll(/^\| `([^`]+)` \|/gm)]
    .map(match => match[1]!).sort();
  expect(documented).toEqual(modules);
});

it('keeps MCP tool counts and provider detail tools aligned with exports', () => {
  const count = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][MCP_TOOLS.length];
  expect(count).toBeDefined();
  expect(read('docs/architecture.md')).toMatch(new RegExp('\\| `adapter-mcp` \\| ' + count + ' stdio MCP tools', 'i'));
  expect(read('README.md')).toMatch(new RegExp(`\\| MCP stdio \\| ${count} project-bound tools`, 'i'));
  expect(help()).toMatch(new RegExp(`Serve ${count} project-bound MCP tools`, 'i'));

  const row = read('docs/agent-bootstrap.md').split(/\r?\n/)
    .find(line => line.startsWith('| `claude` or `codex` after '));
  if (!row) throw new Error('Provider detail-tool row is missing');
  const names = [...row.matchAll(/`(continuity_[a-z_]+)`/g)].map(match => match[1]!).sort();
  expect(names).toEqual([...DETAIL_TOOLS].sort());
});

it('documents the registered CLI commands and provider integrations', () => {
  const block = read('README.md').match(/## Commands\s+```text\s+([\s\S]*?)```/)?.[1];
  if (!block) throw new Error('README command table is missing');
  const headings = block.split(/\r?\n/).map(line => line.split(/\s{2,}/)[0] ?? '');
  const documented = new Set(headings.flatMap(heading => {
    const alternatives = heading.split('|').map(part => part.trim());
    const first = alternatives[0]?.split(/\s+/) ?? [];
    if (!first[0]) return [];
    return first.length === 1 ? alternatives.map(part => part.split(/\s+/)[0]!) : [first[0]];
  }));
  expect([...documented].sort()).toEqual(commands().sort());
  const providerHeading = headings.find(heading => heading.startsWith('integrate '));
  if (!providerHeading) throw new Error('README provider command is missing');
  expect(providerHeading.slice('integrate '.length).split('|').sort()).toEqual(commands('integrate').sort());
  for (const provider of commands('integrate')) {
    expect(read('docs/agent-bootstrap.md')).toContain(`continuity integrate ${provider} install`);
  }
});

it('documents the host API and current source and runtime commands', () => {
  const hosts = read('docs/orchestrator-hosts.md');
  expect(hosts).toContain(`currently ${CONTINUITY_HOST_API_VERSION}`);
  expect(hosts).toContain(`CONTINUITY_HOST_API_VERSION !== ${CONTINUITY_HOST_API_VERSION}`);

  const operations = read('docs/operations.md');
  for (const name of commands('sources')) {
    expect(operations).toContain(`continuity sources ${name}`);
  }
  const runtime = read('docs/background-runtime.md');
  for (const name of commands('runtime')) {
    expect(runtime).toContain(`runtime ${name}`);
  }
  for (const name of commands('startup')) {
    expect(runtime).toContain(`startup ${name}`);
  }
});
