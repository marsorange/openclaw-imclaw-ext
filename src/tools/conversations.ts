import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ToolResult } from './agent-fetch.js';
import { textResult, agentFetch } from './agent-fetch.js';

export function registerConversationTools(api: OpenClawPluginApi): void {
  // ── List all conversations ──
  api.registerTool(() => ({
    name: 'imclaw_conversations',
    label: 'IMClaw Conversations',
    description:
      'List all your IMClaw conversations (contacts + groups). ' +
      'Shows who you\'ve been chatting with, unread counts, and last activity time. ' +
      'Use this to get an overview of all your chats before reading specific messages.',
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    async execute(_id: string, _params: Record<string, never>, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const res = await agentFetch('/agent/conversations', { signal });
        if (!res.ok) return textResult(`Error: ${res.status}`);

        const conversations = res.data as any[];
        if (!conversations || conversations.length === 0) {
          return textResult('No conversations yet.');
        }

        const lines = conversations.map((c: any) => {
          const name = c.contactAlias || c.displayName || c.name;
          const type = c.type === 'group' ? '[group]' : c.type === 'pending' ? '[pending]' : '';
          const unread = c.unread ? ` (${c.unread} unread)` : '';
          const online = c.online ? ' [online]' : '';
          const time = c.touchedat ? new Date(c.touchedat).toLocaleString() : '';
          const topic = c.name;
          return `${name} ${type}${online}${unread} — ${time}\n  topic: ${topic}`;
        });

        return textResult(`${conversations.length} conversations:\n\n${lines.join('\n\n')}`);
      } catch (err: any) {
        return textResult(`Error fetching conversations: ${err.message}`);
      }
    },
  }));

  // ── Read messages from a conversation ──
  api.registerTool(() => ({
    name: 'imclaw_read_messages',
    label: 'Read IMClaw Messages',
    description:
      'Read message history from a specific conversation. ' +
      'Provide the topic name (from imclaw_conversations) to read messages. ' +
      'Supports pagination with cursor (seqId) for older messages.',
    parameters: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'The conversation topic name (e.g. p2pXXX, grpXXX). Get this from imclaw_conversations.',
        },
        limit: {
          type: 'number',
          description: 'Number of messages to fetch (default 20, max 100).',
        },
        cursor: {
          type: 'number',
          description: 'Fetch messages before this seqId (for pagination). Omit to get the latest messages.',
        },
      },
      required: ['topic'],
    },
    async execute(_id: string, params: { topic: string; limit?: number; cursor?: number }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const topic = params.topic.trim();
        if (!topic) return textResult('Error: topic is required.');

        const limit = Math.min(params.limit || 20, 100);
        const qs = new URLSearchParams({ limit: String(limit) });
        if (params.cursor) qs.set('cursor', String(params.cursor));

        const res = await agentFetch(`/agent/conversations/${encodeURIComponent(topic)}/messages?${qs}`, { signal });
        if (!res.ok) return textResult(`Error: ${res.status}`);

        const messages = res.data as any[];
        if (!messages || messages.length === 0) {
          return textResult('No messages in this conversation.');
        }

        const lines = messages.map((m: any) => {
          const time = new Date(m.createdat).toLocaleString();
          const sender = m.fromName || m.from;
          let content: string;
          if (typeof m.content === 'string') {
            content = m.content;
          } else if (m.content?.tp === 'image') {
            content = `[Image: ${m.content.name || 'image'}]`;
          } else if (m.content?.tp === 'file') {
            content = `[File: ${m.content.name || 'file'}]`;
          } else if (m.content?.tp === 'announcement') {
            content = `[Announcement] ${m.content.title || ''}: ${m.content.content || ''}`;
          } else {
            content = JSON.stringify(m.content);
          }
          return `[${time}] ${sender}: ${content}`;
        });

        // Messages come in DESC order, reverse for chronological display
        lines.reverse();

        const oldest = messages[messages.length - 1];
        const hint = messages.length >= limit
          ? `\n\n(More messages available. Use cursor=${oldest.seqid} to load older messages.)`
          : '';

        return textResult(lines.join('\n') + hint);
      } catch (err: any) {
        return textResult(`Error reading messages: ${err.message}`);
      }
    },
  }));
}
