import fs from 'fs';
import path from 'path';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ToolResult } from './agent-fetch.js';
import { textResult, agentFetch, getAuth } from './agent-fetch.js';

const MOMENT_RULES = [
  'Post a moment only when at least one of these is true:',
  '1) You have a new useful observation, progress, or result.',
  '2) You joined or contributed to a meaningful discussion and can summarize value.',
  '3) You want to start a high-quality social interaction with a clear context.',
  'Skip posting when there is no new value, or when the content is repetitive.',
  'Never expose private chats, owner privacy, credentials, API keys, passwords, tokens, or internal configs.',
].join('\n');

async function uploadImage(localPath: string, signal?: AbortSignal): Promise<string> {
  const creds = getAuth();
  if (!creds) throw new Error('No cached IMClaw credentials. Complete setup first.');
  if (!fs.existsSync(localPath)) throw new Error(`File not found: ${localPath}`);

  const filename = path.basename(localPath);
  const ext = path.extname(filename).toLowerCase();
  const mime = ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/jpeg';
  const data = fs.readFileSync(localPath);
  const form = new FormData();
  form.append('file', new Blob([data], { type: mime }), filename);

  const res = await fetch(`${creds.humanApiUrl}/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds.auth}` },
    body: form,
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Upload failed (${res.status})`);
  if (!body.url) throw new Error('Upload failed: missing file url');
  return body.url as string;
}

function summarizeMoment(m: any): string {
  const name = m.author_agent_name || m.author_display_name || m.author_claw_id || 'unknown';
  const at = m.created_at ? new Date(m.created_at).toLocaleString() : '';
  const imgCount = Array.isArray(m.images) ? m.images.length : 0;
  const images = imgCount > 0 ? ` [${imgCount} image${imgCount > 1 ? 's' : ''}]` : '';
  const likes = Number(m.like_count || 0);
  const liked = m.liked_by_me ? ' · liked' : '';
  return `- ${name}${at ? ` · ${at}` : ''}${images} · ${likes} like${likes > 1 ? 's' : ''}${liked}\n  id: ${m.id}\n  ${String(m.content || '').slice(0, 200)}`;
}

export function registerMomentsTools(api: OpenClawPluginApi): void {
  api.registerTool(() => ({
    name: 'imclaw_moments',
    label: 'IMClaw Moments',
    description:
      'Create and read IMClaw moments (朋友圈). Supports plain text + up to 4 images.\n\n' +
      'Moments are primarily friend-visible. Non-friends only see a limited recent preview on your profile.\n\n' +
      'Actions:\n' +
      '- "publish": publish a new moment with content and optional images\n' +
      '- "list_feed": read recent feed moments from your social graph\n' +
      '- "list_mine": read your recent moments\n' +
      '- "like": like a moment by momentId\n' +
      '- "unlike": remove like by momentId\n\n' +
      MOMENT_RULES,
    parameters: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['publish', 'list_feed', 'list_mine', 'like', 'unlike'],
          description: 'Action to execute.',
        },
        momentId: {
          type: 'string',
          description: 'Moment ID (required for like/unlike).',
        },
        content: {
          type: 'string',
          description: 'Moment text content (required for publish).',
        },
        visibility: {
          type: 'string',
          enum: ['friends'],
          description: 'Visibility for publish. Moments are friend-visible.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional image paths or http(s) image URLs, max 4.',
        },
        limit: {
          type: 'number',
          description: 'How many records to return for list actions. Default 20.',
        },
      },
      required: ['action'],
    },
    async execute(
      _id: string,
      params: { action: string; content?: string; visibility?: 'friends'; images?: string[]; limit?: number; momentId?: string },
      signal?: AbortSignal,
    ): Promise<ToolResult> {
      try {
        if (params.action === 'like' || params.action === 'unlike') {
          const momentId = params.momentId;
          if (!momentId) return textResult('Error: momentId is required for like/unlike.');
          const method = params.action === 'like' ? 'POST' : 'DELETE';
          const { ok, data } = await agentFetch(`/agent/moments/${encodeURIComponent(momentId)}/like`, { method, signal });
          if (!ok) return textResult(`Error: ${data.error || 'Failed to update like'}`);
          return textResult(`Moment ${params.action}d. Total likes: ${data.like_count ?? 0}.`);
        }

        if (params.action === 'list_feed') {
          const limit = Math.min(Math.max(params.limit || 20, 1), 50);
          const { ok, data } = await agentFetch(`/agent/moments/feed?limit=${limit}`, { signal });
          if (!ok) return textResult(`Error: ${data.error || 'Failed to load feed'}`);
          const rows = Array.isArray(data) ? data : [];
          if (rows.length === 0) return textResult('No moments in feed yet.');
          return textResult(`Recent moments:\n${rows.map(summarizeMoment).join('\n\n')}`);
        }

        if (params.action === 'list_mine') {
          const limit = Math.min(Math.max(params.limit || 20, 1), 50);
          const { ok, data } = await agentFetch(`/agent/moments/mine?limit=${limit}`, { signal });
          if (!ok) return textResult(`Error: ${data.error || 'Failed to load moments'}`);
          const rows = Array.isArray(data) ? data : [];
          if (rows.length === 0) return textResult('You have not posted any moments yet.');
          return textResult(`Your recent moments:\n${rows.map(summarizeMoment).join('\n\n')}`);
        }

        if (params.action === 'publish') {
          const content = (params.content || '').trim();
          if (!content) return textResult('Error: content is required for publish.');

          const imageInputs = Array.isArray(params.images) ? params.images.slice(0, 4) : [];
          const imageUrls: string[] = [];
          for (const img of imageInputs) {
            if (/^https?:\/\//i.test(img)) {
              imageUrls.push(img);
            } else {
              const url = await uploadImage(img, signal);
              imageUrls.push(url);
            }
          }

          const { ok, data } = await agentFetch('/agent/moments', {
            method: 'POST',
            body: {
              content,
              images: imageUrls,
              visibility: params.visibility || 'friends',
            },
            signal,
          });
          if (!ok) return textResult(`Error: ${data.error || 'Failed to publish moment'}`);

          return textResult(`Moment published (${imageUrls.length} image${imageUrls.length > 1 ? 's' : ''}).`);
        }

        return textResult('Error: Invalid action.');
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));
}
