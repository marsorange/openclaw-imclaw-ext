import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ToolResult } from './agent-fetch.js';
import { textResult, agentFetch } from './agent-fetch.js';

export function registerGroupTools(api: OpenClawPluginApi): void {
  // ── Create a group ──
  api.registerTool(() => ({
    name: 'imclaw_create_group',
    label: 'Create IMClaw Group',
    description:
      'Create a new group chat. Provide a name and optionally invite friends by their userIds ' +
      '(get userIds from imclaw_search_contacts). Returns the new group ID for future reference.',
    parameters: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Group name.',
        },
        topic: {
          type: 'string',
          description: 'Group topic or description (optional).',
        },
        inviteeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Friend userIds to invite (optional). Get from imclaw_search_contacts.',
        },
      },
      required: ['name'],
    },
    async execute(
      _id: string,
      params: { name: string; topic?: string; inviteeIds?: string[] },
      signal?: AbortSignal
    ): Promise<ToolResult> {
      try {
        const body: any = { name: params.name };
        if (params.topic) body.topic = params.topic;
        if (params.inviteeIds?.length) body.inviteeIds = params.inviteeIds;
        const { ok, data } = await agentFetch('/agent/groups', { method: 'POST', body, signal });
        if (!ok) return textResult(`Error: ${data.error || 'Failed to create group'}`);
        const invited = params.inviteeIds?.length ? `\nInvitations sent to ${params.inviteeIds.length} user(s).` : '';
        return textResult(
          `Group created: ${data.name}\n` +
          `  groupId: ${data.id}\n` +
          `  tinode_topic: ${data.tinode_topic || '(none)'}` +
          invited
        );
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));

  // ── Group actions: detail / invite / kick / leave ──
  api.registerTool(() => ({
    name: 'imclaw_group_action',
    label: 'IMClaw Group Actions',
    description:
      'Perform actions on an existing group. Accepts either a groupId (UUID from imclaw_search_contacts kind="groups") or a tinode topic (e.g. "grpXXXXXX" from your ConversationLabel in group chats).\n' +
      '- "detail": View group info and member list (shows each member\'s name, role, claw ID, and userId).\n' +
      '- "invite": Invite friends by userIds (must be your contacts).\n' +
      '- "kick": Remove a member (owner only, provide targetUserId).\n' +
      '- "leave": Leave the group. If you are the owner, the group is disbanded.\n' +
      'Tip: When you are in a group chat, use the topic from your ConversationLabel (e.g. "grpXXXXXX") as the groupId to look up members.',
    parameters: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['detail', 'invite', 'kick', 'leave'],
          description: 'Action to perform.',
        },
        groupId: {
          type: 'string',
          description: 'The group ID (UUID) or tinode topic (e.g. "grpXXXXXX").',
        },
        userIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'User IDs to invite (for "invite" action).',
        },
        targetUserId: {
          type: 'string',
          description: 'User ID to kick (for "kick" action).',
        },
      },
      required: ['action', 'groupId'],
    },
    async execute(
      _id: string,
      params: { action: string; groupId: string; userIds?: string[]; targetUserId?: string },
      signal?: AbortSignal
    ): Promise<ToolResult> {
      try {
        const gid = encodeURIComponent(params.groupId);

        switch (params.action) {
          case 'detail': {
            const { ok, data } = await agentFetch(`/agent/groups/${gid}`, { signal });
            if (!ok) return textResult(`Error: ${data.error || 'Group not found'}`);
            const members = (data.members || []).map((m: any) =>
              `  - ${m.display_name || m.claw_name || m.user_id} [${m.role}]` +
              (m.claw_public_id ? ` (${m.claw_public_id})` : '')
            ).join('\n');
            return textResult(
              `${data.name} (${data.members?.length || 0} members)\n` +
              `  groupId: ${data.id}\n` +
              `  topic: ${data.topic || '(none)'}\n` +
              `  messages: ${data.message_count || 0}\n` +
              `Members:\n${members}`
            );
          }

          case 'invite': {
            if (!params.userIds?.length) return textResult('Error: userIds required for invite.');
            const { ok, data } = await agentFetch(`/agent/groups/${gid}/invite`, {
              method: 'POST', body: { userIds: params.userIds }, signal,
            });
            if (!ok) return textResult(`Error: ${data.error || 'Failed to invite'}`);
            return textResult(`${(data as any[]).length} invitation(s) sent.`);
          }

          case 'kick': {
            if (!params.targetUserId) return textResult('Error: targetUserId required for kick.');
            const { ok, data } = await agentFetch(
              `/agent/groups/${gid}/members/${encodeURIComponent(params.targetUserId)}`,
              { method: 'DELETE', signal },
            );
            if (!ok) return textResult(`Error: ${data.error || 'Failed to kick'}`);
            return textResult('Member removed.');
          }

          case 'leave': {
            const { ok, data } = await agentFetch(`/agent/groups/${gid}/leave`, { method: 'POST', signal });
            if (!ok) return textResult(`Error: ${data.error || 'Failed to leave'}`);
            return textResult(data.left ? 'Left the group.' : 'Group disbanded (you were the owner).');
          }

          default:
            return textResult('Error: use "detail", "invite", "kick", or "leave".');
        }
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));
}
