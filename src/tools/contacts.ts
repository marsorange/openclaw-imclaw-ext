import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ToolResult } from './agent-fetch.js';
import { textResult, agentFetch } from './agent-fetch.js';

export function registerContactTools(api: OpenClawPluginApi): void {
  // imclaw_search_contacts — search contacts and groups
  api.registerTool(() => ({
    name: 'imclaw_search_contacts',
    label: 'Search IMClaw Contacts',
    description:
      'Search your IMClaw contacts and groups. Supports fuzzy matching by human name, agent name, alias, phone, claw ID, @customId, or tags. ' +
      'Use this to find people or groups before sending messages. Returns names, aliases, claw IDs, and UIDs you can use with imclaw_send_message.',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword — matches human name, agent name, alias, phone, claw ID, @customId, or tags. Leave empty to list all.',
        },
        kind: {
          type: 'string',
          enum: ['contacts', 'groups'],
          description: 'What to search: "contacts" (default) or "groups".',
        },
      },
    },
    async execute(_id: string, params: { query?: string; kind?: string }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const kind = params.kind === 'groups' ? 'groups' : 'contacts';
        const q = params.query?.trim();

        // For contacts with a query, use server-side fuzzy search
        let url = `/agent/${kind}`;
        if (kind === 'contacts' && q) {
          url = `/agent/contacts?q=${encodeURIComponent(q)}`;
        }

        const { ok, data } = await agentFetch(url, { signal });
        if (!ok) return textResult(`Error: ${data.error || 'API error'}`);

        let items = data as any[];

        // Groups still use client-side filtering (no server search endpoint)
        if (kind === 'groups' && q) {
          const ql = q.toLowerCase();
          items = items.filter((item: any) =>
            (item.name || '').toLowerCase().includes(ql)
            || (item.topic || '').toLowerCase().includes(ql)
          );
        }

        if (items.length === 0) {
          return textResult(q ? `No ${kind} matching "${params.query}".` : `No ${kind} found.`);
        }

        let summary: string;
        if (kind === 'groups') {
          summary = items.map((g: any) =>
            `- ${g.name}${g.tinode_topic ? ` (topic: ${g.tinode_topic})` : ''} [${g.status || 'active'}]` +
            `\n  groupId: ${g.id}`
          ).join('\n');
        } else {
          summary = items.map((c: any) => {
            const agentName = c.contact_agent_name || c.contact_claw_name || '';
            const humanName = c.contact_display_name || '';
            const alias = c.alias || '';
            // Build a clear display: "AgentName (owner: HumanName)"
            let display = agentName || humanName || alias || 'unknown';
            if (humanName && humanName !== display) display += ` (owner: ${humanName})`;
            if (alias && alias !== agentName && alias !== humanName) display += ` [alias: ${alias}]`;
            const level = c.attention_level ? ` [${c.attention_level}]` : '';
            const clawId = c.contact_claw_id ? ` ${c.contact_claw_id}` : '';
            const customId = c.contact_custom_id ? ` @${c.contact_custom_id}` : '';
            const tags = c.tags ? ` tags: ${c.tags}` : '';
            const uid = c.contact_tinode_uid ? ` uid: ${c.contact_tinode_uid}` : '';
            const userId = c.contact_user_id ? ` userId: ${c.contact_user_id}` : '';
            return `- ${display}${level}${clawId}${customId}${uid}${userId}${tags}`;
          }).join('\n');
        }
        return textResult(`Found ${items.length} ${kind}:\n${summary}`);
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));

  // imclaw_search_users — search IMClaw users for adding friends
  api.registerTool(() => ({
    name: 'imclaw_search_users',
    label: 'Search IMClaw Users',
    description:
      'Search for IMClaw users by name, phone number, @customId, or CLAW-ID. Use this to discover people before sending a friend request. Returns user profiles with claw ID, name, bio, tags, and social status.',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search by human name, agent name, phone number, @customId (e.g. "@alice"), or CLAW-ID (e.g. "CLAW-XXXXX").',
        },
      },
      required: ['query'],
    },
    async execute(_id: string, params: { query: string }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const { ok, data } = await agentFetch(`/agent/contacts/search?q=${encodeURIComponent(params.query)}`, { signal });
        if (!ok) return textResult(`Error: ${data.error || 'Search failed'}`);
        const users = data as any[];
        if (users.length === 0) return textResult(`No users found for "${params.query}".`);
        const summary = users.map((u: any) => {
          const name = u.agent_name || u.display_name || 'unknown';
          const customId = u.custom_id ? ` (@${u.custom_id})` : '';
          const clawId = u.claw_id ? ` [${u.claw_id}]` : '';
          const bio = u.bio ? ` — ${u.bio}` : '';
          const status = u.social_status ? ` (${u.social_status})` : '';
          return `- ${name}${customId}${clawId}${status}${bio}\n  userId: ${u.user_id}`;
        }).join('\n');
        return textResult(`Found ${users.length} user(s):\n${summary}\n\nUse imclaw_friend_requests with action "send" and the userId to send a friend request.`);
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));

  // imclaw_sync — sync contacts and groups subscriptions
  api.registerTool(() => ({
    name: 'imclaw_sync',
    label: 'Sync IMClaw Subscriptions',
    description:
      'Sync IMClaw p2p subscriptions with contacts and/or group subscriptions. Use this when you cannot reach a contact (attach/subscribe failed) or are missing group messages. Kind: "contacts" syncs p2p topics with all friends, "groups" subscribes to unsubscribed groups, "all" does both.',
    parameters: {
      type: 'object' as const,
      properties: {
        kind: {
          type: 'string',
          enum: ['contacts', 'groups', 'all'],
          description: 'What to sync: "contacts", "groups", or "all" (default).',
        },
      },
    },
    async execute(_id: string, params: { kind?: string }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const kind = params.kind || 'all';
        const results: string[] = [];

        if (kind === 'contacts' || kind === 'all') {
          const { ok, data } = await agentFetch('/agent/contacts/sync', { method: 'POST', signal });
          if (ok) {
            results.push(`contacts: ${data.synced ?? 0} synced`);
          } else {
            results.push(`contacts: error — ${data.error || 'failed'}`);
          }
        }

        if (kind === 'groups' || kind === 'all') {
          const { ok, data } = await agentFetch('/agent/groups/sync', { method: 'POST', signal });
          if (ok) {
            results.push(`groups: ${data.synced ?? 0} synced`);
          } else {
            results.push(`groups: error — ${data.error || 'failed'}`);
          }
        }

        return textResult(`Sync complete: ${results.join(', ')}`);
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));

  // imclaw_update_attention — adjust contact attention weight
  api.registerTool(() => ({
    name: 'imclaw_update_attention',
    label: 'Update Contact Attention',
    description:
      'Update the attention level or weight for a contact. Levels: "important" (80, prioritize), "normal" (50, default), "low" (15, deprioritize), "mute" (0, ignore). You can set either a level or a numeric attention value (0-100). Use imclaw_search_contacts to find contact IDs first.',
    parameters: {
      type: 'object' as const,
      properties: {
        contactUserId: {
          type: 'string',
          description: 'The contact user ID to update.',
        },
        level: {
          type: 'string',
          enum: ['important', 'normal', 'low', 'mute'],
          description: 'Attention level: "important", "normal", "low", or "mute". Use this instead of numeric attention for clarity.',
        },
        attention: {
          type: 'number',
          description: 'Attention weight (0-100). Alternative to level for fine-grained control.',
        },
      },
      required: ['contactUserId'],
    },
    async execute(_id: string, params: { contactUserId: string; level?: string; attention?: number }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        if (params.level === undefined && params.attention === undefined) {
          return textResult('Error: Either level or attention is required.');
        }
        const apiPath = `/agent/contacts/${encodeURIComponent(params.contactUserId)}/attention`;
        const body: any = {};
        if (params.level) body.level = params.level;
        else body.attention = params.attention;
        const { ok, data } = await agentFetch(apiPath, { method: 'PATCH', body, signal });
        if (!ok) return textResult(`Error: ${data.error || 'Update failed'}`);
        const levelStr = data.attention_level ? ` (${data.attention_level})` : '';
        return textResult(`Attention updated to ${data.attention}${levelStr}.`);
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));

  // imclaw_attention_review — review and bulk-update attention levels
  api.registerTool(() => ({
    name: 'imclaw_attention_review',
    label: 'Review Attention Levels',
    description:
      'Review all contacts\' attention levels and optionally bulk-update them. Call without parameters to see all contacts with their current attention level and how long they\'ve been contacts. Provide "updates" to batch-adjust levels. Use this periodically to reassess which contacts deserve more or less attention.',
    parameters: {
      type: 'object' as const,
      properties: {
        updates: {
          type: 'array',
          description: 'Array of updates: [{ contactUserId, level?, attention? }]. Provide either level ("important"/"normal"/"low"/"mute") or numeric attention (0-100).',
          items: {
            type: 'object',
            properties: {
              contactUserId: { type: 'string', description: 'Contact user ID.' },
              level: { type: 'string', enum: ['important', 'normal', 'low', 'mute'] },
              attention: { type: 'number' },
            },
            required: ['contactUserId'],
          },
        },
      },
    },
    async execute(_id: string, params: { updates?: { contactUserId: string; level?: string; attention?: number }[] }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        if (params.updates && params.updates.length > 0) {
          const { ok, data } = await agentFetch('/agent/contacts/attention-bulk', {
            method: 'PATCH',
            body: { updates: params.updates },
            signal,
          });
          if (!ok) return textResult(`Error: ${data.error || 'Bulk update failed'}`);
          return textResult(`Attention review complete: ${data.updated} contact(s) updated.`);
        }

        // List mode: fetch review data
        const { ok, data } = await agentFetch('/agent/contacts/attention-review', { signal });
        if (!ok) return textResult(`Error: ${data.error || 'Failed to fetch review data'}`);
        const contacts = data as any[];
        if (contacts.length === 0) return textResult('No contacts to review.');

        const summary = contacts.map((c: any) => {
          const name = c.contact_agent_name || c.contact_display_name || c.alias || 'unknown';
          const clawId = c.contact_claw_id ? ` (${c.contact_claw_id})` : '';
          const since = c.contact_since ? new Date(c.contact_since).toLocaleDateString() : 'unknown';
          return `- ${name}${clawId}\n  Level: ${c.attention_level} (${c.attention})\n  Contact since: ${since}\n  userId: ${c.contact_user_id}`;
        }).join('\n\n');

        return textResult(
          `Attention review — ${contacts.length} contact(s):\n\n${summary}\n\n` +
          'To update, call again with updates: [{ contactUserId, level: "important"|"normal"|"low"|"mute" }]'
        );
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));
}
