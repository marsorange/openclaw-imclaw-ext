import fs from 'fs';
import nodePath from 'path';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getFirstAccountId, getAccountBridge, getOwnerTinodeUid } from '../channel.js';
import type { InboundMessage } from '../imclaw-bridge.js';
import type { ToolResult } from './agent-fetch.js';
import { textResult, agentFetch } from './agent-fetch.js';

const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain', '.pdf': 'application/pdf', '.json': 'application/json',
  '.csv': 'text/csv', '.html': 'text/html', '.xml': 'application/xml',
  '.zip': 'application/zip', '.gz': 'application/gzip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Extract text content from an InboundMessage */
function extractText(msg: InboundMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (msg.content?.tp === 'image') return `[Image: ${msg.content.name || 'image'}]`;
  if (msg.content?.tp === 'file') return `[File: ${msg.content.name || 'file'}]`;
  if (msg.content?.tp === 'announcement') return `[Announcement] ${msg.content.title || ''}: ${msg.content.content || ''}`;
  return JSON.stringify(msg.content);
}

export function registerMessagingTools(api: OpenClawPluginApi): void {
  api.registerTool(() => ({
    name: 'imclaw_send_message',
    label: 'Send IMClaw Message',
    description:
      'Send a text message or file/image to an IMClaw contact or group.\n\n' +
      'Communication norms by context:\n' +
      '· Private chat (1:1): You may discuss personal topics with your contact. Keep the conversation relevant and respectful.\n' +
      '· Group chat: Multiple participants can see your messages. Be mindful of the group topic and avoid sharing others\' private information.\n' +
      '· NEVER forward private chat content to groups or public topics without explicit consent.\n' +
      '· NEVER share your owner\'s personal details, API keys, or internal configurations in any chat.\n\n' +
      'You can specify the target by name, alias, claw ID, or tinode UID. To send a file, provide the local file path in the "media" parameter. Use imclaw_search_contacts first if unsure about the exact name.\n\n' +
      'Set wait_reply=true to wait for the target\'s reply and return it (useful when you need to ask someone a question and bring the answer back).',
    parameters: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Who to send to: "owner" (your human owner), contact name, alias, claw ID (CLAW-XXXXX), tinode UID (usrXXX), or group topic (grpXXX).',
        },
        text: {
          type: 'string',
          description: 'The message text to send. Can be empty when sending media only.',
        },
        media: {
          type: 'string',
          description: 'Local file path to send as an attachment (e.g. /tmp/report.txt, /tmp/photo.png). The file will be uploaded and sent to the target.',
        },
        wait_reply: {
          type: 'boolean',
          description: 'If true, wait for the target to reply and return their response (timeout 60s). Default: false.',
        },
      },
      required: ['target'],
    },
    async execute(_id: string, params: { target: string; text?: string; media?: string; wait_reply?: boolean }, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const accountId = getFirstAccountId();
        if (!accountId) return textResult('Error: No active IMClaw account.');
        const bridge = getAccountBridge(accountId);
        if (!bridge) return textResult('Error: IMClaw bridge not connected.');

        const target = params.target.trim();
        if (!target) return textResult('Error: target is required.');
        if (!params.text?.trim() && !params.media?.trim()) return textResult('Error: provide text, media, or both.');

        let topicId = target;

        // If not already a tinode UID/topic, resolve by looking up contacts/groups
        if (!/^(usr|grp|p2p)[A-Za-z0-9_-]+$/.test(target)) {
          const normalized = target.toLowerCase();

          // "owner" keyword → resolve to owner's Tinode UID
          if (normalized === 'owner') {
            const ownerUid = getOwnerTinodeUid();
            if (ownerUid) {
              topicId = ownerUid;
            } else {
              // Fallback: fetch owner UID on demand
              const ownerRes = await agentFetch('/agent/owner', { signal });
              if (ownerRes.ok && ownerRes.data?.tinode_uid) {
                topicId = ownerRes.data.tinode_uid;
              } else {
                return textResult('Error: Could not resolve owner. Make sure this agent has an owner bound.');
              }
            }
          }

          // Try contacts first (skip if already resolved by "owner")
          if (topicId === target) {
            const contactRes = await agentFetch('/agent/contacts', { signal });
            if (contactRes.ok) {
              const contacts = contactRes.data as any[];
              const match = contacts.find((c: any) =>
                [c.contact_agent_name, c.alias, c.contact_claw_name, c.contact_display_name, c.contact_claw_id]
                  .some(f => f && f.toLowerCase() === normalized)
              );
              if (match?.contact_tinode_uid) {
                topicId = match.contact_tinode_uid;
              }
            }
          }

          // If still unresolved, try owner
          if (topicId === target) {
            const ownerRes = await agentFetch('/agent/owner', { signal });
            if (ownerRes.ok && ownerRes.data?.tinode_uid) {
              const ownerName = (ownerRes.data.display_name || '').toLowerCase();
              if (ownerName === normalized) {
                topicId = ownerRes.data.tinode_uid;
              }
            }
          }

          // If still unresolved, try groups
          if (topicId === target) {
            const groupRes = await agentFetch('/agent/groups', { signal });
            if (groupRes.ok) {
              const groups = groupRes.data as any[];
              const match = groups.find((g: any) =>
                (g.name || '').toLowerCase() === normalized || (g.topic || '').toLowerCase() === normalized
              );
              if (match?.tinode_topic) {
                topicId = match.tinode_topic;
              }
            }
          }

          if (topicId === target) {
            return textResult(`Error: Could not find contact or group "${target}". Use imclaw_search_contacts to find the correct name.`);
          }
        }

        // Set up reply listener BEFORE sending (to avoid missing fast replies)
        let replyPromise: Promise<string | null> | undefined;
        if (params.wait_reply) {
          replyPromise = new Promise<string | null>((resolve) => {
            const TIMEOUT_MS = 60_000;
            let settled = false;

            const cleanup = bridge.addTemporaryListener((msg: InboundMessage) => {
              // Match: message is from the target (by topic or sender UID)
              if (msg.from === topicId || msg.topic === topicId) {
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  resolve(extractText(msg));
                }
                return true; // consume the message
              }
              return false; // not for us
            });

            const timer = setTimeout(() => {
              if (!settled) {
                settled = true;
                cleanup();
                resolve(null);
              }
            }, TIMEOUT_MS);

            // Clean up on abort
            signal?.addEventListener('abort', () => {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                cleanup();
                resolve(null);
              }
            }, { once: true });
          });
        }

        const results: string[] = [];

        // Send text if provided
        if (params.text?.trim()) {
          await bridge.sendMessage(topicId, params.text.trim());
          results.push(`text sent`);
        }

        // Send media if provided
        if (params.media?.trim()) {
          const filePath = params.media.trim();
          if (!fs.existsSync(filePath)) {
            return textResult(`Error: File not found: ${filePath}`);
          }
          const buffer = fs.readFileSync(filePath);
          const filename = nodePath.basename(filePath);
          const ext = nodePath.extname(filePath).toLowerCase();
          const mime = MIME_MAP[ext] || 'application/octet-stream';

          if (mime.startsWith('image/')) {
            await bridge.sendImage(topicId, buffer, filename, mime);
          } else {
            await bridge.sendFile(topicId, buffer, filename, mime);
          }
          results.push(`file "${filename}" sent`);
        }

        // Wait for reply if requested
        if (replyPromise) {
          const reply = await replyPromise;
          if (reply !== null) {
            results.push(`reply received`);
            return textResult(
              `${results.join(', ')} to ${topicId}${topicId !== target ? ` (${target})` : ''}.\n\n` +
              `Reply from ${target}:\n${reply}`
            );
          } else {
            results.push(`no reply within 60s`);
          }
        }

        return textResult(`${results.join(', ')} to ${topicId}${topicId !== target ? ` (${target})` : ''}.`);
      } catch (err: any) {
        return textResult(`Error sending message: ${err.message}`);
      }
    },
  }));
}
