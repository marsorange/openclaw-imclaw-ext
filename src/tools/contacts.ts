import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ToolResult } from './agent-fetch.js';
import { textResult, agentFetch } from './agent-fetch.js';

export function registerContactTools(api: OpenClawPluginApi): void {
  // imclaw_search_contacts — search contacts and groups
  api.registerTool(() => ({
    name: 'imclaw_search_contacts',
    label: 'Search IMClaw Contacts',
    description:
      'Search your IMClaw contacts and groups. Use this to find people or groups before sending messages. Returns names, aliases, claw IDs, and UIDs you can use with imclaw_send_message.',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Filter by name, alias, or claw ID. Leave empty to list all.',
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
        const { ok, data } = await agentFetch(`/agent/${kind}`, { signal });
        if (!ok) return textResult(`Error: ${data.error || 'API error'}`);

        let items = data as any[];
        const q = params.query?.trim().toLowerCase();
        if (q) {
          items = items.filter((item: any) => {
            if (kind === 'groups') {
              return (item.name || '').toLowerCase().includes(q)
                || (item.topic || '').toLowerCase().includes(q);
            }
            return [item.contact_agent_name, item.alias, item.contact_claw_name,
              item.contact_display_name, item.contact_claw_id,
            ].some(f => f && f.toLowerCase().includes(q));
          });
        }

        if (items.length === 0) {
          return textResult(q ? `No ${kind} matching "${params.query}".` : `No ${kind} found.`);
        }

        let summary: string;
        if (kind === 'groups') {
          summary = items.map((g: any) =>
            `- ${g.name}${g.tinode_topic ? ` (topic: ${g.tinode_topic})` : ''} [${g.status || 'active'}]`
          ).join('\n');
        } else {
          summary = items.map((c: any) => {
            const name = c.contact_agent_name || c.contact_claw_name || c.contact_display_name || c.alias || 'unknown';
            const alias = c.alias && c.alias !== name ? ` (alias: ${c.alias})` : '';
            const clawId = c.contact_claw_id ? ` [${c.contact_claw_id}]` : '';
            const uid = c.contact_tinode_uid ? ` uid: ${c.contact_tinode_uid}` : '';
            const userId = c.contact_user_id ? ` userId: ${c.contact_user_id}` : '';
            return `- ${name}${alias}${clawId}${uid}${userId}`;
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
      'Search for IMClaw users by phone number, @customId, or CLAW-ID. Use this to discover people before sending a friend request. Returns user profiles with claw ID, name, bio, tags, and social status.',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search by phone number, @customId (e.g. "@alice"), or CLAW-ID (e.g. "CLAW-XXXXX").',
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
          const name = u.agent_name || u.name || u.display_name || 'unknown';
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
      'Update the attention weight for a contact. Higher attention means the agent should prioritize messages from this contact. Use imclaw_search_contacts to find contact IDs first.',
    parameters: {
      type: 'object' as const,
      properties: {
        contactUserId: {
          type: 'string',
          description: 'The contact user ID to update.',
        },
        attention: {
          type: 'number',
          description: 'Attention weight (0-100).',
        },
      },
      required: ['contactUserId', 'attention'],
    },
    async execute(_id: string, params: { contactUserId: string; attention: number }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const apiPath = `/agent/contacts/${encodeURIComponent(params.contactUserId)}/attention`;
        const { ok, data } = await agentFetch(apiPath, {
          method: 'PATCH',
          body: { attention: params.attention },
          signal,
        });
        if (!ok) return textResult(`Error: ${data.error || 'Update failed'}`);
        return textResult(`Attention updated to ${params.attention}.`);
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));
}
