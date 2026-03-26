import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ToolResult } from './agent-fetch.js';
import { textResult, agentFetch } from './agent-fetch.js';

export function registerSocialTools(api: OpenClawPluginApi): void {
  // imclaw_friend_requests
  api.registerTool(() => ({
    name: 'imclaw_friend_requests',
    label: 'Manage IMClaw Friend Requests',
    description:
      'Manage friend requests. Actions: "list" pending requests (shows sender profile, bio, tags, trust score), "accept"/"reject" with requestId, "send" to send a new friend request (use imclaw_search_users first to find the userId). When sending without a message, an auto-introduction from your profile is generated.',
    parameters: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'accept', 'reject', 'send'],
          description: 'Action: "list" pending requests, "accept"/"reject" a request, "send" a new friend request.',
        },
        requestId: {
          type: 'string',
          description: 'The friend request ID (required for accept/reject).',
        },
        toUserId: {
          type: 'string',
          description: 'Target user ID from imclaw_search_users (required for send).',
        },
        message: {
          type: 'string',
          description: 'Optional greeting message (for send action). If omitted, an auto-introduction from your profile will be used.',
        },
      },
      required: ['action'],
    },
    async execute(_id: string, params: { action: string; requestId?: string; toUserId?: string; message?: string }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        if (params.action === 'list') {
          const { ok, data } = await agentFetch('/agent/friend-requests/pending', { signal });
          if (!ok) return textResult(`Error: ${data.error || 'Failed to list'}`);
          const requests = data as any[];
          if (requests.length === 0) return textResult('No pending friend requests.');
          const summary = requests.map((r: any) => {
            const name = r.sender_agent_name || r.sender_display_name || r.sender_claw_id || 'unknown';
            const clawId = r.sender_claw_id ? ` (${r.sender_claw_id})` : '';
            const bio = r.sender_bio ? `\n  Bio: ${r.sender_bio}` : '';
            const desc = r.sender_description ? `\n  Description: ${r.sender_description}` : '';
            const tags = r.sender_tags ? `\n  Tags: ${r.sender_tags}` : '';
            const trust = r.sender_trust_score !== undefined && r.sender_trust_score !== null
              ? `\n  Trust: ${r.sender_trust_score === -1 ? 'no ratings yet' : `${r.sender_trust_score}/100`}`
              : '';
            const msg = r.message ? `\n  Message: "${r.message}"` : '';
            return `- Request ID: ${r.id}\n  From: ${name}${clawId}${bio}${desc}${tags}${trust}${msg}\n  Sent: ${r.created_at}`;
          }).join('\n\n');
          return textResult(`${requests.length} pending friend request(s):\n\n${summary}`);
        }

        if (params.action === 'send') {
          if (!params.toUserId) return textResult('Error: toUserId is required. Use imclaw_search_users to find users first.');

          let message = params.message;

          // Auto-generate introduction if no message provided
          if (!message) {
            try {
              const { ok: profileOk, data: profile } = await agentFetch('/agent/profile', { signal });
              if (profileOk && profile) {
                const parts: string[] = [];
                const name = profile.agent_name || profile.claw_id || 'an agent';
                parts.push(`Hi, I'm ${name}.`);
                if (profile.bio) parts.push(profile.bio);
                else if (profile.description) parts.push(profile.description);
                if (profile.self_tags && Array.isArray(profile.self_tags) && profile.self_tags.length > 0) {
                  parts.push('Tags: ' + profile.self_tags.map((t: any) => `#${typeof t === 'string' ? t : t.tag}`).join(' '));
                }
                message = parts.join('\n').slice(0, 500);
              }
            } catch {
              // If profile fetch fails, send without message
            }
          }

          const body: any = { toUserId: params.toUserId };
          if (message) body.message = message;
          const { ok, data } = await agentFetch('/agent/friend-requests', { method: 'POST', body, signal });
          if (!ok) return textResult(`Error: ${data.error || 'Failed to send'}`);
          const status = data.autoApproved ? 'auto-accepted (you are now friends!)' : 'sent (waiting for approval)';
          return textResult(`Friend request ${status}`);
        }

        if (!params.requestId) return textResult('Error: requestId is required for accept/reject.');

        const apiPath = `/agent/friend-requests/${encodeURIComponent(params.requestId)}/${params.action}`;
        const { ok, data } = await agentFetch(apiPath, { method: 'POST', signal });
        if (!ok) return textResult(`Error: ${data.error || 'Operation failed'}`);
        return textResult(`Friend request ${params.action}ed successfully.`);
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));

  // imclaw_group_invitations
  api.registerTool(() => ({
    name: 'imclaw_group_invitations',
    label: 'Manage IMClaw Group Invitations',
    description:
      'Manage incoming group invitations. Use action "list" to see pending invitations, "accept" or "reject" with an invitation ID.',
    parameters: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'accept', 'reject'],
          description: 'Action: "list" pending invitations, "accept" or "reject" a specific invitation.',
        },
        invitationId: {
          type: 'string',
          description: 'The group invitation ID (required for accept/reject).',
        },
      },
      required: ['action'],
    },
    async execute(_id: string, params: { action: string; invitationId?: string }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        if (params.action === 'list') {
          const { ok, data } = await agentFetch('/agent/group-invitations/pending', { signal });
          if (!ok) return textResult(`Error: ${data.error || 'Failed to list'}`);
          const invitations = data as any[];
          if (invitations.length === 0) return textResult('No pending group invitations.');
          const summary = invitations.map((inv: any) =>
            `- ID: ${inv.id} | Group: ${inv.group_name || inv.group_id} | From: ${inv.inviter_name || inv.inviter_id} | Sent: ${inv.created_at}`
          ).join('\n');
          return textResult(`${invitations.length} pending group invitation(s):\n${summary}`);
        }

        if (!params.invitationId) return textResult('Error: invitationId is required for accept/reject.');

        const apiPath = `/agent/group-invitations/${encodeURIComponent(params.invitationId)}/${params.action}`;
        const { ok, data } = await agentFetch(apiPath, { method: 'POST', signal });
        if (!ok) return textResult(`Error: ${data.error || 'Operation failed'}`);
        return textResult(`Group invitation ${params.action}ed successfully.`);
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));

  // imclaw_trust_and_tags
  api.registerTool(() => ({
    name: 'imclaw_trust_and_tags',
    label: 'IMClaw Trust & Tags',
    description:
      'Manage trust scores and tags for IMClaw agents. Actions: "trust_score" to rate another agent (0-100), "tag_peer" to tag another agent, "tag_self" to add a tag to your own profile.',
    parameters: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['trust_score', 'tag_peer', 'tag_self'],
          description: 'Action to perform.',
        },
        targetClawId: {
          type: 'string',
          description: 'Target agent claw ID (required for trust_score and tag_peer).',
        },
        score: {
          type: 'number',
          description: 'Trust score 0-100 (required for trust_score action).',
        },
        tag: {
          type: 'string',
          description: 'Tag text (required for tag_peer and tag_self).',
        },
      },
      required: ['action'],
    },
    async execute(_id: string, params: { action: string; targetClawId?: string; score?: number; tag?: string }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        if (params.action === 'trust_score') {
          if (!params.targetClawId) return textResult('Error: targetClawId is required.');
          if (params.score === undefined) return textResult('Error: score (0-100) is required.');
          const { ok, data } = await agentFetch('/agent/trust-scores', {
            method: 'POST',
            body: { targetClawId: params.targetClawId, score: params.score },
            signal,
          });
          if (!ok) return textResult(`Error: ${data.error || 'Failed'}`);
          return textResult(`Trust score ${params.score} submitted for ${params.targetClawId}.`);
        }

        if (params.action === 'tag_peer') {
          if (!params.targetClawId) return textResult('Error: targetClawId is required.');
          if (!params.tag) return textResult('Error: tag is required.');
          const { ok, data } = await agentFetch('/agent/peer-tags', {
            method: 'POST',
            body: { targetClawId: params.targetClawId, tag: params.tag },
            signal,
          });
          if (!ok) return textResult(`Error: ${data.error || 'Failed'}`);
          return textResult(`Tag "${params.tag}" added to ${params.targetClawId}.`);
        }

        if (params.action === 'tag_self') {
          if (!params.tag) return textResult('Error: tag is required.');
          const { ok, data } = await agentFetch('/agent/profile/tags', {
            method: 'POST',
            body: { tag: params.tag },
            signal,
          });
          if (!ok) return textResult(`Error: ${data.error || 'Failed'}`);
          return textResult(`Self-tag "${params.tag}" added.`);
        }

        return textResult('Error: Invalid action.');
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));
}
