#!/usr/bin/env node
// Claude Code channel: wakes an idle Claude Code session when a human @mentions its agent in the hub chat.
import os from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_HUB_URL = "http://localhost:4000";
const HUB_URL = (process.env.AGENT_HUB_URL ?? DEFAULT_HUB_URL).replace(/\/$/, "");
const AGENT = (process.env.AGENT_HUB_NAME ?? os.userInfo().username).toLowerCase();
const TOKEN = process.env.AGENT_HUB_TOKEN ?? "";
const PROJECT = process.env.AGENT_HUB_PROJECT ?? "";
const RECONNECT_DELAY_MS = 5000;
const EVENT_SEPARATOR = "\n\n";
const DATA_PREFIX = "data: ";

const mcp = new Server(
  { name: "agent-hub-chat", version: "1.0.0" },
  {
    capabilities: { experimental: { "claude/channel": {} }, tools: {} },
    instructions:
      `You are "${AGENT}" in a team of humans and AI agents. Messages from the team chat arrive as ` +
      `<channel source="agent-hub-chat" from="..." message_id="...">: a teammate @mentioned you. ` +
      "Do what they ask, following the team rules (lock files before editing, never edit files locked by others). " +
      "Use the reply tool to answer in the chat: one or two short lines, when you start a bigger job and when you finish or need an answer. " +
      "Don't reply only to acknowledge small requests.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, listTools);
mcp.setRequestHandler(CallToolRequestSchema, callTool);
await mcp.connect(new StdioServerTransport());
listenForMentions();

/**
 * Keeps a connection to the hub's wake-up stream open for the whole session,
 * reconnecting after a pause whenever the hub restarts or the network drops.
 */
async function listenForMentions() {
  while (true) {
    try {
      await readWakeStream();
    } catch (error) {
      console.error(`agent-hub channel: ${error.message}; retrying`);
    }
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
  }
}

/** Reads server-sent events from the hub and forwards each batch of mentions to Claude. */
async function readWakeStream() {
  const response = await fetch(hubUrl("/api/wake"));
  if (!response.ok) throw new Error(`hub answered ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf(EVENT_SEPARATOR)) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + EVENT_SEPARATOR.length);
      const data = block.split("\n").filter((line) => line.startsWith(DATA_PREFIX)).map((line) => line.slice(DATA_PREFIX.length)).join("\n");
      if (data) await pushToClaude(JSON.parse(data));
    }
  }
  throw new Error("hub closed the stream");
}

/** Injects each chat message into the running Claude Code session, which wakes it if idle. */
async function pushToClaude(messages) {
  for (const message of messages) {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content: message.text, meta: { from: message.from, message_id: String(message.id) } },
    });
  }
}

/** Tells Claude Code about the reply tool. */
async function listTools() {
  return {
    tools: [{
      name: "reply",
      description: "Post a short message in the team chat. Use @name to address someone.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    }],
  };
}

/** Posts Claude's reply to the hub chat as this agent. */
async function callTool(request) {
  if (request.params.name !== "reply") throw new Error(`unknown tool: ${request.params.name}`);
  const response = await fetch(hubUrl("/api/chat"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: request.params.arguments?.text }),
  });
  if (!response.ok) throw new Error(`hub answered ${response.status}`);
  return { content: [{ type: "text", text: "sent" }] };
}

/** Builds a hub URL that identifies this agent and carries the team token. */
function hubUrl(route) {
  return `${HUB_URL}${route}?project=${encodeURIComponent(PROJECT)}&agent=${encodeURIComponent(AGENT)}&token=${encodeURIComponent(TOKEN)}`;
}
