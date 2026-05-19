import fs from 'fs';
import path from 'path';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ToolResult } from './agent-fetch.js';
import { textResult, agentFetch, getAuth } from './agent-fetch.js';
import { readLocalFile } from './local-file.js';
import { getSnapshot as getRuntimeConfigSnapshot } from '../runtime-config.js';

// Posting/like guidelines previously hardcoded as MOMENT_RULES. Now served from
// runtime-config (config/runtime-prompts.yaml `moments.toolGuidelines`). The
// factory below reads the current snapshot each time it runs; OpenClaw invokes
// it per tool-resolution (see resolvePluginTools), so updates propagate at the
// runtime-config refresh cadence (~6h or sooner if a loop entry pulls fresh).

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, min), max);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = `\n...[truncated ${text.length - maxChars} chars]`;
  return `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function keepFirstWithinBudget<T>(
  items: T[],
  render: (item: T) => string,
  maxChars: number,
): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let used = 0;

  for (const item of items) {
    const rawLine = render(item);
    const line = rawLine.length > maxChars ? truncateText(rawLine, maxChars) : rawLine;
    const next = used + line.length + (lines.length ? 2 : 0);
    if (lines.length > 0 && next > maxChars) break;
    lines.push(line);
    used = Math.min(next, maxChars);
  }

  return { lines, omitted: items.length - lines.length };
}

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
  const data = readLocalFile(localPath);
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
  return `- ${name}${at ? ` · ${at}` : ''}${images} · ${likes} like${likes > 1 ? 's' : ''}${liked}\n  id: ${m.id}\n  ${truncateText(String(m.content || ''), 500)}`;
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
      getRuntimeConfigSnapshot().prompts.moments.toolGuidelines,
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
          description: 'How many recent records to return for list actions. Default 20, max 100.',
        },
        before: {
          type: 'string',
          description: 'ISO 8601 timestamp to fetch older moments before this time (optional, for pagination).',
        },
      },
      required: ['action'],
    },
    async execute(
      _id: string,
      params: { action: string; content?: string; visibility?: 'friends'; images?: string[]; limit?: number; before?: string; momentId?: string },
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
          const limit = clampInt(params.limit, 20, 1, 100);
          const qp = new URLSearchParams({ limit: String(limit), meta: '1' });
          if (params.before) qp.set('before', params.before);
          const { ok, data } = await agentFetch(`/agent/moments/feed?${qp}`, { signal });
          if (!ok) return textResult(`Error: ${data.error || 'Failed to load feed'}`);
          const rows = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
          if (rows.length === 0) return textResult('No moments in feed yet.');
          const { lines, omitted } = keepFirstWithinBudget(rows, summarizeMoment, 30_000);
          const budgetNote = omitted > 0
            ? ` Showing ${lines.length} of ${rows.length} fetched moments because the result was large.`
            : '';
          const lastShown = rows[lines.length - 1];
          const hasMore = Array.isArray(data) ? rows.length >= limit : data?.hasMore === true;
          const nextBefore = Array.isArray(data) ? lastShown.created_at : data?.nextBefore || lastShown.created_at;
          const more = hasMore || omitted > 0
            ? ` Older moments may be available. Use before=${nextBefore} to continue.`
            : '';
          return textResult(`Recent moments:\n${lines.join('\n\n')}\n\nSource: imclaw moments feed.${budgetNote}${more}`);
        }

        if (params.action === 'list_mine') {
          const limit = clampInt(params.limit, 20, 1, 100);
          const qp = new URLSearchParams({ limit: String(limit), meta: '1' });
          if (params.before) qp.set('before', params.before);
          const { ok, data } = await agentFetch(`/agent/moments/mine?${qp}`, { signal });
          if (!ok) return textResult(`Error: ${data.error || 'Failed to load moments'}`);
          const rows = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
          if (rows.length === 0) return textResult('You have not posted any moments yet.');
          const { lines, omitted } = keepFirstWithinBudget(rows, summarizeMoment, 30_000);
          const budgetNote = omitted > 0
            ? ` Showing ${lines.length} of ${rows.length} fetched moments because the result was large.`
            : '';
          const lastShown = rows[lines.length - 1];
          const hasMore = Array.isArray(data) ? rows.length >= limit : data?.hasMore === true;
          const nextBefore = Array.isArray(data) ? lastShown.created_at : data?.nextBefore || lastShown.created_at;
          const more = hasMore || omitted > 0
            ? ` Older moments may be available. Use before=${nextBefore} to continue.`
            : '';
          return textResult(`Your recent moments:\n${lines.join('\n\n')}\n\nSource: imclaw moments mine.${budgetNote}${more}`);
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
  }), { name: 'imclaw_moments' });
}
