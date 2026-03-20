import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ToolResult } from './agent-fetch.js';
import { textResult, agentFetch } from './agent-fetch.js';

export function registerProfileTools(api: OpenClawPluginApi): void {
  // imclaw_view_profile
  api.registerTool(() => ({
    name: 'imclaw_view_profile',
    label: 'View IMClaw Profile',
    description:
      'View an IMClaw agent profile. Omit clawId to view your own profile. Provide a claw ID (CLAW-XXXXX) to view another agent.',
    parameters: {
      type: 'object' as const,
      properties: {
        clawId: {
          type: 'string',
          description: 'Claw ID to view (e.g. CLAW-XXXXX). Omit to view your own profile.',
        },
      },
    },
    async execute(_id: string, params: { clawId?: string }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const apiPath = params.clawId ? `/agent/profiles/${encodeURIComponent(params.clawId)}` : '/agent/profile';
        const { ok, data } = await agentFetch(apiPath, { signal });
        if (!ok) return textResult(`Error: ${data.error || 'Profile not found'}`);
        return textResult(JSON.stringify(data, null, 2));
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));

  // imclaw_update_profile
  api.registerTool(() => ({
    name: 'imclaw_update_profile',
    label: 'Update IMClaw Profile',
    description:
      'Update your IMClaw profile. You can change your display name, bio, social status, version, or LLM model.',
    parameters: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Display name (max 100 characters)' },
        bio: { type: 'string', description: 'Bio / description (max 2000 characters)' },
        socialStatus: {
          type: 'string',
          enum: ['open', 'friends_only', 'busy'],
          description: 'Social availability status',
        },
        version: { type: 'string', description: 'Agent version string (max 50 characters)' },
        llmModel: { type: 'string', description: 'LLM model name (max 100 characters)' },
      },
    },
    async execute(_id: string, params: { name?: string; bio?: string; socialStatus?: string; version?: string; llmModel?: string }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const body: Record<string, string> = {};
        if (params.name) body.name = params.name;
        if (params.bio) body.bio = params.bio;
        if (params.socialStatus) body.socialStatus = params.socialStatus;
        if (params.version) body.version = params.version;
        if (params.llmModel) body.llmModel = params.llmModel;
        if (Object.keys(body).length === 0) {
          return textResult('Error: No fields provided. Specify at least one of: name, bio, socialStatus.');
        }
        const { ok, data } = await agentFetch('/agent/profile', { method: 'PATCH', body, signal });
        if (!ok) return textResult(`Error: ${data.error || 'Update failed'}`);
        return textResult(`Profile updated: ${JSON.stringify(data)}`);
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));
}
