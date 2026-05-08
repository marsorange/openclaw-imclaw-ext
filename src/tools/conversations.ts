import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ToolResult } from './agent-fetch.js';
import { textResult, agentFetch } from './agent-fetch.js';

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, min), max);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = `\n...[truncated ${text.length - maxChars} chars]`;
  return `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function keepNewestWithinBudget<T>(
  items: T[],
  render: (item: T) => string,
  maxChars: number,
): { shown: T[]; lines: string[]; omitted: number } {
  const shown: T[] = [];
  const lines: string[] = [];
  let used = 0;

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const rawLine = render(item);
    const line = rawLine.length > maxChars ? truncateText(rawLine, maxChars) : rawLine;
    const next = used + line.length + (lines.length ? 1 : 0);
    if (lines.length > 0 && next > maxChars) break;
    lines.unshift(line);
    shown.unshift(item);
    used = Math.min(next, maxChars);
  }

  return { shown, lines, omitted: items.length - shown.length };
}

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
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum conversations to return (default 30, max 100).',
        },
      },
    },
    async execute(_id: string, params: { limit?: number }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const res = await agentFetch('/agent/conversations', { signal });
        if (!res.ok) return textResult(`Error: ${res.status}`);

        const allConversations = (res.data as any[]) || [];
        const limit = clampInt(params.limit, 30, 1, 100);
        const conversations = allConversations.slice(0, limit);
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

        const more = allConversations.length > conversations.length
          ? `\n\nShowing ${conversations.length} of ${allConversations.length}. Use a higher limit only when you need a broader scan.`
          : '';
        return textResult(`${conversations.length} conversations:\n\n${lines.join('\n\n')}\n\nSource: imclaw conversations.${more}`);
      } catch (err: any) {
        return textResult(`Error fetching conversations: ${err.message}`);
      }
    },
  }), { name: 'imclaw_conversations' });

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
          description: 'Number of messages to fetch (default 10, max 100). Use cursor to page older history.',
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

        const limit = clampInt(params.limit, 10, 1, 100);
        const qs = new URLSearchParams({ limit: String(limit) });
        if (params.cursor) qs.set('cursor', String(params.cursor));

        const res = await agentFetch(`/agent/conversations/${encodeURIComponent(topic)}/messages?${qs}`, { signal });
        if (!res.ok) return textResult(`Error: ${res.status}`);

        const messages = res.data as any[];
        if (!messages || messages.length === 0) {
          return textResult('No messages in this conversation.');
        }

        const orderedMessages = messages.slice().reverse();
        const { shown, lines, omitted } = keepNewestWithinBudget(orderedMessages, (m: any) => {
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
          return `[seq=${m.seqid} ${time}] ${sender}: ${content}`;
        }, 50_000);

        const oldestShown = shown[0] || messages[messages.length - 1];
        const budgetNote = omitted > 0
          ? ` Showing ${shown.length} of ${messages.length} fetched messages because the result was large.`
          : '';
        const hint = messages.length >= limit || omitted > 0
          ? `\n\nSource: imclaw topic=${topic}.${budgetNote} More messages available. Use cursor=${oldestShown.seqid} to load older messages.`
          : `\n\nSource: imclaw topic=${topic}.`;

        return textResult(lines.join('\n') + hint);
      } catch (err: any) {
        return textResult(`Error reading messages: ${err.message}`);
      }
    },
  }), { name: 'imclaw_read_messages' });
}
