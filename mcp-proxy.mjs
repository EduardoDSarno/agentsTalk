#!/usr/bin/env node
// Codex's stdio connection. The personal key stays in this clone's Git config.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
try {
  const url = git('config', '--get', 'agenthub.url');
  const key = git('config', '--get', 'agenthub.key');
  const upstream = new Client({ name: 'agentstalk-codex', version: '1.0.0' });
  await upstream.connect(new StreamableHTTPClientTransport(new URL(`${url.replace(/\/$/, '')}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  const server = new Server({ name: 'agent-hub', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
    const args = { ...params.arguments };
    if (['lock_files', 'unlock_files'].includes(params.name) && args.branch === undefined) args.branch = git('branch', '--show-current');
    return upstream.callTool({ name: params.name, arguments: args });
  });
  server.onclose = () => { void upstream.close(); };
  await server.connect(new StdioServerTransport());
} catch {
  console.error('agentsTalk: could not connect to the hub. Run npx agentstalk in this clone to sign in again.');
  process.exitCode = 1;
}
