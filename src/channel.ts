import fs from 'fs';
import path from 'path';
import os from 'os';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import { ImclawBridge, ChannelConfig } from './imclaw-bridge.js';
import { downloadMedia, getMediaPath } from './media-store.js';
import { imclawOnboardingAdapter } from './onboarding.js';
import { runWithToolAccount } from './tools/tool-account-context.js';
import { DEFAULT_HUMAN_API_URL } from './defaults.js';
import { shouldSuppressAgentBugText } from './agent-bug-filter.js';
import {
  extractApprovalHintFromText,
  resolveApprovalShortcutDecision,
  type ApprovalDecision,
  type ApprovalHint,
} from './approval-shortcuts.js';
import {
  loadCredsCache,
  saveCredsCache,
  type CachedCredential,
} from './credential-cache.js';

export { CREDS_CACHE_PATH, loadCredsCache } from './credential-cache.js';
export type { CachedCredential } from './credential-cache.js';

// ─── URL validation (SSRF protection) ───

const PRIVATE_IP_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^0\./, /^169\.254\./, /^::1$/, /^fc00:/, /^fe80:/,
];

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_IP_RANGES.some(r => r.test(hostname)) ||
    hostname === 'localhost' || hostname.endsWith('.local');
}

function validateHttpUrl(url: string, label: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch {
    throw new Error(`${label}: invalid URL: ${url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label}: only http/https allowed, got ${parsed.protocol}`);
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`${label}: private/internal addresses not allowed`);
  }
}

// ─── Module-level account registry ───

interface ResolvedPluginConfig {
  serverUrl: string;
  apiKey: string;
  httpBaseUrl: string;
  humanApiUrl: string;
}

interface AccountContext {
  bridge: ImclawBridge;
  heartbeatTimer: NodeJS.Timeout;
  plazaDiscoveryTimer: NodeJS.Timeout | null;
  plazaPollTimer: NodeJS.Timeout | null;
  momentsTimer: NodeJS.Timeout | null;
  heartbeatAuth: string;
  humanApiUrl: string;
  pluginConfig: ResolvedPluginConfig;
  accountId: string;
  log: any;
  mediaDir: string;
  configConnectKey: string | null;
  ownerTinodeUid: string | null;
  stopped: boolean;
  authPaused: boolean;
  cleanup: () => Promise<void>;
}

const accounts = new Map<string, AccountContext>();

/** Find account context by ID, or fall back to first connected account */
function findAccountContext(accountId?: string | null): AccountContext | undefined {
  if (accountId) return accounts.get(accountId);
  return accounts.values().next().value as AccountContext | undefined;
}

async function assertGroupFeatureEnabledForTarget(actx: AccountContext, target: string): Promise<void> {
  if (!target.startsWith('grp')) return;
  const res = await fetch(`${actx.humanApiUrl}/agent/settings`, {
    headers: { 'Authorization': `Basic ${actx.heartbeatAuth}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error('IMClaw groups feature is unavailable.');
  const data = await res.json() as any;
  if (data?.groups_enabled === false) {
    throw new Error('IMClaw groups feature is disabled by owner settings.');
  }
}

// ─── Helpers to resolve plugin config from either location ───

/**
 * OpenClaw config may have our accounts in two places:
 * 1. cfg.channels.imclaw.accounts (standard OpenClaw channel layout)
 * 2. (plugin config) passed from plugins.entries.imclaw.config
 *
 * We store plugin-level config at module scope during register().
 */
let pluginLevelConfig: Record<string, any> = {};
let pluginRuntime: PluginRuntime | null = null;
let pluginVersion = '0.0.0';

/**
 * Return the humanApiUrl from plugin-level config, falling back to the default.
 */
export function getHumanApiUrl(): string {
  const url = pluginLevelConfig.humanApiUrl || DEFAULT_HUMAN_API_URL;
  validateHttpUrl(url, 'humanApiUrl');
  return url;
}

/**
 * Exchange a connect key for Tinode credentials via Human API.
 * Returns resolved credentials, or throws on failure.
 */
async function exchangeConnectKey(
  connectKey: string,
  humanApiUrl: string,
  agentName?: string,
): Promise<{ username: string; password: string; clawId: string; serverUrl: string; apiKey: string; httpBaseUrl?: string }> {
  const body: Record<string, string> = { connectKey };
  if (agentName) body.agentName = agentName;

  const res = await fetch(`${humanApiUrl}/claws/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    throw new Error(`Connect key exchange failed: ${body.error || res.statusText}`);
  }

  const data = await res.json() as {
    clawId: string;
    tinodeUsername: string;
    tinodePassword: string;
    tinodeWsUrl: string;
    tinodeApiKey: string;
    httpBaseUrl?: string;
  };

  return {
    username: data.tinodeUsername,
    password: data.tinodePassword,
    clawId: data.clawId,
    serverUrl: data.tinodeWsUrl,
    apiKey: data.tinodeApiKey,
    httpBaseUrl: data.httpBaseUrl,
  };
}

function buildBasicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`).toString('base64');
}

function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function resolveCredentialScopeId(cred: { username: string; clawId?: string }): string {
  return cred.clawId || cred.username;
}

async function fetchAgentOwner(
  humanApiUrl: string,
  basicAuth: string,
): Promise<{ owner?: any; unauthorized: boolean; permanent: boolean; ok: boolean }> {
  try {
    const res = await fetch(`${humanApiUrl}/agent/owner`, {
      headers: { 'Authorization': `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      return {
        ok: true,
        unauthorized: false,
        permanent: false,
        owner: await res.json() as any,
      };
    }
    if (res.status === 410) {
      return { ok: false, unauthorized: true, permanent: true };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, unauthorized: true, permanent: false };
    }
    return { ok: false, unauthorized: false, permanent: false };
  } catch {
    return { ok: false, unauthorized: false, permanent: false };
  }
}

// ─── Config resolution ───

function resolvePluginConfig(cfg: Record<string, any>): ResolvedPluginConfig {
  const pc = pluginLevelConfig;
  const humanApiUrl = pc.humanApiUrl || DEFAULT_HUMAN_API_URL;
  validateHttpUrl(humanApiUrl, 'humanApiUrl');
  // Auto-derive httpBaseUrl from humanApiUrl when not explicitly set:
  // humanApiUrl = "https://imclaw.net/api" → httpBaseUrl = "https://imclaw.net"
  const httpBaseUrl = pc.httpBaseUrl || humanApiUrl.replace(/\/api\/?$/, '');
  if (httpBaseUrl) validateHttpUrl(httpBaseUrl, 'httpBaseUrl');
  return {
    serverUrl: pc.serverUrl || '',
    apiKey: pc.apiKey || '',
    httpBaseUrl,
    humanApiUrl,
  };
}

function resolveAccountsFromConfig(cfg: Record<string, any>): Record<string, any> {
  // Standard location: cfg.channels.imclaw.accounts (keyed by account ID)
  const channelAccounts = (cfg as any).channels?.imclaw?.accounts;
  if (channelAccounts && typeof channelAccounts === 'object' && Object.keys(channelAccounts).length > 0) {
    return channelAccounts;
  }

  // Fallback: plugin-level config has accounts as an array (legacy format)
  const arr = pluginLevelConfig.accounts;
  if (Array.isArray(arr) && arr.length > 0) {
    const result: Record<string, any> = {};
    for (const a of arr) {
      const key = a.username || a.connectKey || `claw-${Object.keys(result).length}`;
      result[key] = a;
    }
    return result;
  }

  return {};
}

const DEFAULT_ACCOUNT_ID = 'default';

// ─── Thinking block error detection ───

function isThinkingBlockError(text: string): boolean {
  return (text.includes('thinking') || text.includes('redacted_thinking'))
    && text.includes('block');
}

// Track corrupted session keys → rotated suffix with TTL, so future messages skip the broken session
// TTL prevents permanent conversation fragmentation from transient errors
const SESSION_KEY_TTL = 30 * 60 * 1000; // 30 minutes
const corruptedSessionKeys = new Map<string, { suffix: string; expiry: number }>();

function getCorruptedSuffix(baseKey: string): string | undefined {
  const entry = corruptedSessionKeys.get(baseKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expiry) {
    corruptedSessionKeys.delete(baseKey);
    return undefined;
  }
  return entry.suffix;
}

function setCorruptedSuffix(baseKey: string, suffix: string): void {
  corruptedSessionKeys.set(baseKey, { suffix, expiry: Date.now() + SESSION_KEY_TTL });
}

// ─── Spam repetition detection ───

/**
 * Detect if a message is just a short phrase repeated many times.
 * e.g. "好的。好的。好的..." or "是的 是的 是的..."
 */
function isSpamRepetition(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 10 || trimmed.length > 2000) return false;

  // Try common delimiters
  for (const sep of ['。', '，', '！', '？', '、', ' ', '\n']) {
    const parts = trimmed.split(sep).filter(Boolean);
    if (parts.length < 5) continue;
    // Check if >80% of parts are the same string
    const counts = new Map<string, number>();
    for (const p of parts) {
      const k = p.trim();
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
    const maxCount = Math.max(...counts.values());
    if (maxCount / parts.length >= 0.8) return true;
  }
  return false;
}

// ─── Approval shortcut bridging ───

type PendingApprovalState = {
  approvalId: string;
  approvalSlug?: string;
  allowedDecisions: ApprovalDecision[];
  expiry: number;
};

const APPROVAL_SHORTCUT_TTL = 30 * 60 * 1000; // align with OpenClaw default approval timeout
const MAX_PENDING_APPROVALS = 200;
const pendingApprovals = new Map<string, PendingApprovalState>();

function makeApprovalStateKey(accountId: string, topic: string): string {
  return `${accountId}:${topic}`;
}

function prunePendingApprovals(now = Date.now()): void {
  for (const [key, state] of pendingApprovals.entries()) {
    if (state.expiry <= now) {
      pendingApprovals.delete(key);
    }
  }
  while (pendingApprovals.size > MAX_PENDING_APPROVALS) {
    const oldestKey = pendingApprovals.keys().next().value as string | undefined;
    if (!oldestKey) break;
    pendingApprovals.delete(oldestKey);
  }
}

function setPendingApproval(key: string, hint: ApprovalHint): void {
  prunePendingApprovals();
  pendingApprovals.set(key, {
    approvalId: hint.approvalId,
    approvalSlug: hint.approvalSlug,
    allowedDecisions: hint.allowedDecisions,
    expiry: Date.now() + APPROVAL_SHORTCUT_TTL,
  });
}

function getPendingApproval(key: string): PendingApprovalState | undefined {
  prunePendingApprovals();
  return pendingApprovals.get(key);
}

function clearPendingApproval(key: string): void {
  pendingApprovals.delete(key);
}

// ─── Reply notification helper ───

/**
 * Fire-and-forget: notify human-api that the agent sent a reply,
 * so it pushes a WebSocket event to the web dashboard.
 * Without this, the frontend won't see the reply until the user sends another message.
 */
function notifyReplyDelivered(
  accountCtx: AccountContext | undefined,
  topic: string,
  seqId: number,
  fromUid: string | null | undefined,
  content: string,
): void {
  if (!accountCtx || accountCtx.stopped) return;
  const body = JSON.stringify({
    messages: [{
      topic,
      seqId,
      fromUid: fromUid || '',
      content,
      timestamp: new Date().toISOString(),
      direction: 'outbound' as const,
    }],
  });
  fetch(`${accountCtx.humanApiUrl}/agent/messages/sync`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${accountCtx.heartbeatAuth}`,
      'Content-Type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(5_000),
  }).then(res => {
    if (res.ok) {
      accountCtx.log?.debug?.(`[imclaw] reply notification sent: topic=${topic} seq=${seqId}`);
    } else {
      accountCtx.log?.warn?.(`[imclaw] reply notification failed: ${res.status}`);
    }
  }).catch(() => { /* fire-and-forget */ });
}

// ─── Reusable message handler ───

function extractTrustedHosts(...urls: (string | undefined)[]): string[] {
  const hosts: string[] = [];
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const normalized = raw.startsWith('ws') ? raw.replace(/^ws/, 'http') : raw;
      const hostname = new URL(normalized).hostname;
      if (hostname && !hosts.includes(hostname)) hosts.push(hostname);
    } catch { /* ignore */ }
  }
  return hosts;
}

function registerMessageHandler(
  bridge: ImclawBridge,
  accountId: string,
  log: any,
  mediaDir: string,
  trustedHosts?: string[],
): void {
  const rt = getPluginRuntime();
  let groupFeatureCache: { enabled: boolean; fetchedAt: number } | null = null;

  const isGroupFeatureEnabled = async (): Promise<boolean> => {
    if (groupFeatureCache && !groupFeatureCache.enabled && Date.now() - groupFeatureCache.fetchedAt <= 30_000) {
      return groupFeatureCache.enabled;
    }
    const actx = findAccountContext(accountId);
    if (!actx) return false;
    try {
      const res = await fetch(`${actx.humanApiUrl}/agent/settings`, {
        headers: { 'Authorization': `Basic ${actx.heartbeatAuth}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return false;
      const data = await res.json() as any;
      groupFeatureCache = { enabled: data?.groups_enabled !== false, fetchedAt: Date.now() };
      return groupFeatureCache.enabled;
    } catch {
      return false;
    }
  };

  bridge.onMessage(async (msg) => {
    const contentPreview = typeof msg.content === 'string'
      ? msg.content.substring(0, 100)
      : JSON.stringify(msg.content).substring(0, 100);
    log?.info?.(`[imclaw-channel] onMessage: topic=${msg.topic} from=${msg.from} seq=${msg.seqId} isGroup=${msg.isGroup} content=${contentPreview}`);

    let text: string | undefined;
    let mediaUrl: string | undefined;
    let mediaType: string | undefined;

    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (msg.content && typeof msg.content === 'object' && msg.content.tp) {
      if (msg.content.tp === 'announcement') {
        // Structured announcement (legacy format) — extract as text
        const title = msg.content.title ? `【${msg.content.title}】` : '【公告】';
        text = `${title}${msg.content.content || ''}`;
      } else if (msg.content.tp === 'image') {
        mediaUrl = msg.content.url;
        mediaType = msg.content.mime;
        text = `[Image: ${msg.content.name || 'image'}]`;
      } else if (msg.content.tp === 'file') {
        mediaUrl = msg.content.url;
        mediaType = msg.content.mime;
        text = `[File: ${msg.content.name || 'file'}]`;
      }
    }

    if (!text && !mediaUrl) {
      log?.warn?.(`[imclaw-channel] unrecognized content from ${msg.from}: ${JSON.stringify(msg.content).substring(0, 100)}`);
      return;
    }

    // Filter inbound error messages from other agents (context overflow, quota errors, etc.)
    // Prevents agents from receiving and replying to error messages, which causes error loops.
    if (text && shouldSuppressAgentBugText(text)) {
      log?.warn?.(`[imclaw-channel] suppressed inbound error message from ${msg.from}: ${text.substring(0, 120)}`);
      return;
    }

    // Spam detection: skip messages that are just a short phrase repeated many times
    // (e.g. "好的。好的。好的..." — agents shouldn't waste context on these)
    if (text && isSpamRepetition(text)) {
      log?.warn?.(`[imclaw-channel] suppressed spam repetition from ${msg.from}: ${text.substring(0, 80)}`);
      return;
    }

    // Auto-download media to workspace
    let localMediaPath: string | undefined;
    if (mediaUrl) {
      const localFile = await downloadMedia(mediaUrl, msg.content.name || 'media', msg.seqId, mediaDir, trustedHosts);
      if (localFile) {
        localMediaPath = getMediaPath(localFile, mediaDir);
      } else {
        log?.warn?.(`[imclaw] media download failed: ${mediaUrl}`);
      }
    }

    log?.info?.(`[imclaw] ← ${msg.from} ${mediaUrl ? `[${msg.content.tp}:${msg.content.name}]` : (text || '').substring(0, 60)}`);

    if (!rt) {
      log?.error?.('[imclaw-channel] cannot dispatch: runtime is null');
      return;
    }

    const isGroup = msg.topic.startsWith('grp');
    if (isGroup && !(await isGroupFeatureEnabled())) {
      log?.info?.(`[imclaw-channel] ignored group message because groups are disabled: topic=${msg.topic}`);
      return;
    }
    const peerId = isGroup ? msg.topic : msg.from;

    // Resolve agent route via OpenClaw's standard routing system.
    // This allows users to bind specific agents (including sub-agents) to
    // IMClaw via the `bindings` config in openclaw.yaml.
    const currentCfg = (rt.config as any).current?.() ?? rt.config.loadConfig();
    const route = rt.channel.routing?.resolveAgentRoute?.({
      cfg: currentCfg,
      channel: 'imclaw',
      accountId,
      peer: {
        kind: isGroup ? 'group' : 'direct',
        id: peerId,
      },
    });

    const routeSessionKey = route?.sessionKey;
    const routeAccountId = route?.accountId ?? accountId;
    const approvalStateKey = makeApprovalStateKey(routeAccountId, msg.topic);

    // Fallback session key when routing API is unavailable (older OpenClaw versions)
    const baseSessionKey = routeSessionKey
      || (isGroup ? `imclaw:${accountId}:${msg.topic}` : `imclaw:${accountId}:${msg.from}`);

    if (route?.agentId) {
      log?.info?.(`[imclaw-channel] routed to agent "${route.agentId}" (matched by: ${route.matchedBy || 'default'})`);
    }

    // If this session was previously corrupted (within TTL), use the rotated suffix
    const existingSuffix = getCorruptedSuffix(baseSessionKey);

    // Resolve owner UID once — used for approval shortcuts and sender role
    const ownerUid = accounts.get(routeAccountId)?.ownerTinodeUid;

    // Natural-language approval shortcuts:
    // "确认/同意/拒绝" → "/approve <id> <decision>" when a pending approval exists.
    const isOwnerDirectMessage = !isGroup && (!ownerUid || ownerUid === msg.from);
    if (text && isOwnerDirectMessage) {
      const pending = getPendingApproval(approvalStateKey);
      if (pending) {
        const decision = resolveApprovalShortcutDecision(text, pending.allowedDecisions);
        if (decision) {
          text = `/approve ${pending.approvalId} ${decision}`;
          clearPendingApproval(approvalStateKey);
          log?.info?.(
            `[imclaw-channel] mapped approval shortcut for ${msg.topic}: decision=${decision} id=${pending.approvalSlug || pending.approvalId}`,
          );
        }
      }
    }

    let thinkingErrorDetected = false;

    // Resolve sender role so the agent knows who it's talking to
    const resolveSenderRole = (): string => {
      if (!isGroup) {
        return (!ownerUid || ownerUid === msg.from) ? 'owner' : 'peer';
      }
      // Group: owner is still owner; everyone else is a group member
      return (ownerUid && ownerUid === msg.from) ? 'owner' : 'group_member';
    };
    const senderRole = resolveSenderRole();

    const doDispatch = async (sessionKey: string) => {
      thinkingErrorDetected = false;

      const rawCtx = {
        Body: text || '',
        RawBody: text || '',
        CommandBody: text || '',
        From: `imclaw:${msg.from}`,
        To: `imclaw:${accountId}`,
        SessionKey: sessionKey,
        AccountId: routeAccountId,
        OriginatingChannel: 'imclaw' as any,
        OriginatingTo: msg.from,
        ChatType: isGroup ? 'group' : 'direct',
        SenderName: bridge.getPeerName(msg.from) || msg.from,
        SenderId: msg.from,
        SenderRole: senderRole,
        Provider: 'imclaw',
        Surface: 'imclaw',
        ConversationLabel: isGroup ? msg.topic : msg.from,
        Timestamp: Date.now(),
        CommandAuthorized: true,
        ...(mediaUrl ? {
          MediaUrl: mediaUrl,
          MediaPath: localMediaPath || mediaUrl,
          MediaType: mediaType || 'application/octet-stream',
          MediaUrls: [mediaUrl],
          MediaPaths: [localMediaPath || mediaUrl],
          MediaTypes: [mediaType || 'application/octet-stream'],
        } : {}),
      };

      const msgCtx = rt.channel.reply.finalizeInboundContext
        ? rt.channel.reply.finalizeInboundContext(rawCtx)
        : rawCtx;

      log?.info?.(`[imclaw-channel] dispatching sessionKey=${sessionKey} agentId=${route?.agentId || 'default'}`);
      await runWithToolAccount({
        accountId: routeAccountId ?? null,
        chatType: isGroup ? 'group' : 'direct',
        conversationLabel: isGroup ? msg.topic : msg.from,
        sessionKey,
        senderId: msg.from,
        originatingTo: msg.topic,
      }, async () => {
        await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: msgCtx,
          cfg: currentCfg,
          dispatcherOptions: {
            deliver: async (payload: { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
              log?.info?.(`[imclaw-channel] deliver callback: text=${(payload?.text || payload?.body || '').substring(0, 80)} mediaUrl=${payload?.mediaUrl || 'none'}`);
              try {
                const replyText = (payload?.text ?? payload?.body)?.trim();
                const suppressReply = !!replyText && shouldSuppressAgentBugText(replyText);
                if (suppressReply) {
                  log?.warn?.(`[imclaw-channel] suppressed suspected upstream bug message: ${(replyText || '').slice(0, 120)}`);
                }
                if (replyText && !suppressReply) {
                  const approvalHint = extractApprovalHintFromText(replyText);
                  if (approvalHint) {
                    setPendingApproval(approvalStateKey, approvalHint);
                    log?.info?.(
                      `[imclaw-channel] captured pending approval for ${msg.topic}: id=${approvalHint.approvalSlug || approvalHint.approvalId}`,
                    );
                  }

                  // Detect thinking block error before sending
                  if (isThinkingBlockError(replyText)) {
                    thinkingErrorDetected = true;
                    log?.warn?.(`[imclaw-channel] thinking block error detected in reply, will retry with new session`);
                  }

                  const MAX_CHUNK = 4000;
                  const actx = findAccountContext(routeAccountId);
                  const selfUid = bridge.getSelfUid?.();
                  if (replyText.length <= MAX_CHUNK) {
                    const seqId = await bridge.sendMessage(msg.topic, replyText);
                    notifyReplyDelivered(actx, msg.topic, seqId, selfUid, replyText);
                  } else {
                    const chunks: string[] = [];
                    let remaining = replyText;
                    while (remaining.length > 0) {
                      if (remaining.length <= MAX_CHUNK) {
                        chunks.push(remaining);
                        break;
                      }
                      let splitAt = remaining.lastIndexOf('\n\n', MAX_CHUNK);
                      if (splitAt < MAX_CHUNK * 0.3) splitAt = remaining.lastIndexOf('\n', MAX_CHUNK);
                      if (splitAt < MAX_CHUNK * 0.3) splitAt = MAX_CHUNK;
                      chunks.push(remaining.slice(0, splitAt).trimEnd());
                      remaining = remaining.slice(splitAt).trimStart();
                    }
                    for (const chunk of chunks) {
                      const seqId = await bridge.sendMessage(msg.topic, chunk);
                      notifyReplyDelivered(actx, msg.topic, seqId, selfUid, chunk);
                    }
                  }
                  log?.info?.(`[imclaw] → ${msg.topic} reply ${replyText.length} chars`);
                }

                const mediaUrls = payload?.mediaUrls ?? (payload?.mediaUrl ? [payload.mediaUrl] : []);
                for (const url of mediaUrls) {
                  // Use OpenClaw's standard loadWebMedia to resolve media
                  // (handles remote URLs, local paths, file:// URIs, tilde paths — same as WhatsApp/Telegram)
                  const { loadWebMedia } = await import('openclaw/plugin-sdk');
                  const localRoots = [os.tmpdir(), '/tmp', '/private/tmp', mediaDir];
                  const media = await loadWebMedia(url, { localRoots });
                  const fileName = media.fileName || url.split('/').pop()?.split('?')[0] || 'media';
                  const mime = media.contentType || 'application/octet-stream';

                  if (media.kind === 'image') {
                    await bridge.sendImage(msg.topic, media.buffer, fileName, mime);
                  } else {
                    await bridge.sendFile(msg.topic, media.buffer, fileName, mime);
                  }
                  log?.info?.(`[imclaw] → ${msg.topic} media (${media.kind}): ${fileName} ${(media.buffer.length / 1024).toFixed(1)}KB`);
                }
              } catch (deliverErr: any) {
                log?.error?.(`[imclaw] deliver error ${msg.topic}: ${deliverErr.message}`);
              }
            },
          },
        });
      });
    };

    // Determine initial session key (use rotated key if previously corrupted)
    const initialSessionKey = existingSuffix
      ? `${baseSessionKey}:${existingSuffix}`
      : baseSessionKey;

    const DISPATCH_TIMEOUT_MS = 120_000; // 2 minutes
    try {
      log?.info?.(`[imclaw-channel] dispatching to runtime: text="${(text || '').substring(0, 80)}" mediaUrl=${mediaUrl || 'none'}`);
      await Promise.race([
        doDispatch(initialSessionKey),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`dispatch timed out after ${DISPATCH_TIMEOUT_MS}ms`)), DISPATCH_TIMEOUT_MS),
        ),
      ]);
    } catch (err: any) {
      // Detect thinking block error from thrown exception
      if (isThinkingBlockError(err.message || '')) {
        thinkingErrorDetected = true;
        log?.warn?.(`[imclaw-channel] thinking block error detected in exception: ${err.message}`);
      } else {
        log?.error?.(`[imclaw-channel] dispatch error: ${err.message}\n${err.stack}`);
      }
    }

    if (thinkingErrorDetected) {
      // Rotate session key with TTL so future messages skip the broken session temporarily
      const newSuffix = `rs-${Date.now()}`;
      setCorruptedSuffix(baseSessionKey, newSuffix);
      const newSessionKey = `${baseSessionKey}:${newSuffix}`;
      log?.info?.(`[imclaw-channel] session corrupted, rotating key: ${initialSessionKey} → ${newSessionKey}`);

      try {
        await bridge.sendMessage(msg.topic, '⚠️ 检测到会话上下文异常，正在使用新会话重试...');
        await doDispatch(newSessionKey);
      } catch (retryErr: any) {
        log?.error?.(`[imclaw-channel] retry dispatch error: ${retryErr.message}\n${retryErr.stack}`);
      }
    }
  });
}

// ─── OpenClaw ChannelPlugin ───

export const imclawPlugin = {
  id: 'imclaw',
  meta: {
    id: 'imclaw',
    label: 'IMClaw',
    selectionLabel: 'IMClaw',
    detailLabel: 'IMClaw',
    docsPath: '/channels/imclaw',
    docsLabel: 'imclaw',
    blurb: 'Agent-to-Agent instant messaging for OpenClaw.',
    order: 100,
  },

  onboarding: imclawOnboardingAdapter,

  capabilities: {
    chatTypes: ['direct' as const, 'group' as const],
    media: true,
    threads: false,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    effects: false,
    blockStreaming: false,
    nativeCommands: false,
  },

  // Tell OpenClaw SDK how to recognize IMClaw IDs and resolve targets by name
  messaging: {
    targetResolver: {
      looksLikeId(raw: string): boolean {
        // IMClaw UIDs: usrXXX, p2pXXX, grpXXX
        return /^(usr|p2p|grp)[A-Za-z0-9_-]+$/.test(raw);
      },
      hint: 'Use a contact name, group name, or IMClaw UID (usrXXX, grpXXX)',
    },
  },

  // Directory adapter for SDK target resolution (name → ID lookup)
  directory: {
    async listPeers(params: { cfg: any; accountId?: string | null }) {
      const actx = findAccountContext(params.accountId);
      if (!actx) return [];
      try {
        const res = await fetch(`${actx.humanApiUrl}/agent/contacts`, {
          headers: { 'Authorization': `Basic ${actx.heartbeatAuth}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return [];
        const contacts = await res.json() as any[];
        // Also fetch owner info (owner is not in contacts list)
        let ownerEntry: any = null;
        try {
          const ownerRes = await fetch(`${actx.humanApiUrl}/agent/owner`, {
            headers: { 'Authorization': `Basic ${actx.heartbeatAuth}` },
            signal: AbortSignal.timeout(5_000),
          });
          if (ownerRes.ok) {
            const owner = await ownerRes.json() as any;
            if (owner.tinode_uid) {
              ownerEntry = { kind: 'user' as const, id: owner.tinode_uid, name: owner.display_name };
            }
          }
        } catch { /* non-critical */ }
        const entries = contacts
          .filter((c: any) => c.contact_tinode_uid)
          .map((c: any) => ({
            kind: 'user' as const,
            id: c.contact_tinode_uid,
            name: c.contact_agent_name || c.alias || c.contact_claw_name || c.contact_display_name,
            handle: c.contact_claw_id,
          }));
        if (ownerEntry) entries.push(ownerEntry);
        return entries;
      } catch { return []; }
    },

    async listGroups(params: { cfg: any; accountId?: string | null }) {
      const actx = findAccountContext(params.accountId);
      if (!actx) return [];
      try {
        const res = await fetch(`${actx.humanApiUrl}/agent/groups`, {
          headers: { 'Authorization': `Basic ${actx.heartbeatAuth}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return [];
        const groups = await res.json() as any[];
        return groups
          .filter((g: any) => g.tinode_topic)
          .map((g: any) => ({
            kind: 'group' as const,
            id: g.tinode_topic,
            name: g.name,
          }));
      } catch { return []; }
    },
  },

  // config must be an object with listAccountIds / resolveAccount methods
  config: {
    listAccountIds(cfg: Record<string, any>): string[] {
      const accts = resolveAccountsFromConfig(cfg);
      const ids = Object.keys(accts).filter(Boolean);
      return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
    },

    resolveAccount(cfg: Record<string, any>, accountId?: string | null): any {
      const accts = resolveAccountsFromConfig(cfg);
      if (accountId) return accts[accountId] ?? accts[Object.keys(accts)[0]] ?? {};
      return accts[Object.keys(accts)[0]] ?? {};
    },

    isEnabled(account: any, _cfg: Record<string, any>): boolean {
      return account?.enabled !== false;
    },

    async isConfigured(account: any, _cfg: Record<string, any>): Promise<boolean> {
      const pc = pluginLevelConfig;
      // Has direct credentials
      if (pc.serverUrl && account?.username && account?.password) return true;
      // Has connect key (will exchange at startup via humanApiUrl or default)
      if (account?.connectKey) return true;
      // Has cached credentials from a previous connect key exchange
      const cache = loadCredsCache();
      if (Object.keys(cache).length > 0) return true;
      return false;
    },
  },

  outbound: {
    deliveryMode: 'gateway' as const,

    resolveTarget(params: { cfg?: any; to?: string; accountId?: string | null }) {
      const to = params.to;
      if (!to) return { ok: false as const, error: new Error('Missing target') };
      // Accept "user:<tinodeUid>" or raw "<tinodeUid>" or "p2p<topic>" or "grp<topic>"
      const resolved = to.replace(/^user:/, '');
      if (!resolved) return { ok: false as const, error: new Error('Empty target') };
      return { ok: true as const, to: resolved };
    },

    async sendText(ctx: { cfg: any; to: string; text: string; accountId?: string | null }) {
      const accountId = ctx.accountId || DEFAULT_ACCOUNT_ID;
      const actx = accounts.get(accountId);
      if (!actx) throw new Error(`imclaw: account ${accountId} not connected`);
      await assertGroupFeatureEnabledForTarget(actx, ctx.to);
      await actx.bridge.sendMessage(ctx.to, ctx.text);
      return { channel: 'imclaw' as const, messageId: `imclaw-${Date.now()}` };
    },

    async sendMedia(ctx: { cfg: any; to: string; text: string; mediaUrl?: string; mediaLocalRoots?: readonly string[]; accountId?: string | null }) {
      const accountId = ctx.accountId || DEFAULT_ACCOUNT_ID;
      const actx = accounts.get(accountId);
      if (!actx) throw new Error(`imclaw: account ${accountId} not connected`);
      await assertGroupFeatureEnabledForTarget(actx, ctx.to);

      if (ctx.mediaUrl) {
        // Use OpenClaw's standard media loading (same as WhatsApp/Telegram outbound)
        // Extend localRoots with common temp directories for agent-generated files
        const extraRoots = [os.tmpdir(), '/tmp', '/private/tmp'];
        const localRoots = ctx.mediaLocalRoots
          ? [...ctx.mediaLocalRoots, ...extraRoots]
          : extraRoots;
        const { loadWebMedia } = await import('openclaw/plugin-sdk');
        const media = await loadWebMedia(ctx.mediaUrl, { localRoots });
        const fileName = media.fileName || ctx.mediaUrl.split('/').pop()?.split('?')[0] || 'media';
        const mime = media.contentType || 'application/octet-stream';

        if (media.kind === 'image') {
          await actx.bridge.sendImage(ctx.to, media.buffer, fileName, mime);
        } else {
          await actx.bridge.sendFile(ctx.to, media.buffer, fileName, mime);
        }
      }

      if (ctx.text) {
        await actx.bridge.sendMessage(ctx.to, ctx.text);
      }

      return { channel: 'imclaw' as const, messageId: `imclaw-${Date.now()}` };
    },
  },

  gateway: {
    async startAccount(params: {
      cfg: Record<string, any>;
      accountId: string;
      account: any;
      runtime: any;
      abortSignal: AbortSignal;
      log?: any;
      getStatus: () => any;
      setStatus: (next: any) => void;
    }): Promise<void> {
      const { cfg, accountId, account, abortSignal, log } = params;
      const pc = resolvePluginConfig(cfg);

      // Clean up any previous account instance (e.g. gateway restart on config change)
      const prev = accounts.get(accountId);
      if (prev) {
        log?.info?.(`[imclaw] cleaning up previous account instance ${accountId}`);
        clearInterval(prev.heartbeatTimer);
        if (prev.plazaDiscoveryTimer) clearTimeout(prev.plazaDiscoveryTimer);
        if (prev.plazaPollTimer) clearTimeout(prev.plazaPollTimer);
        if (prev.momentsTimer) clearTimeout(prev.momentsTimer);
        try { await prev.bridge.stop(); } catch { /* ignore */ }
        accounts.delete(accountId);
      }

      // Resolve credentials: direct creds, cached creds, or connect key exchange
      let username = account.username as string | undefined;
      let password = account.password as string | undefined;
      let credentialScopeId = username;
      let configConnectKey: string | null = null;

      if (!username || !password) {
        const connectKey = account.connectKey as string | undefined;
        if (connectKey) {
          configConnectKey = connectKey;
          // Check local cache first (key may already be consumed)
          const cache = loadCredsCache();
          const cached = cache[connectKey];
          if (cached) {
            log?.info?.(`[imclaw] using cached credentials for ${cached.username.substring(0, 6)}***`);
            username = cached.username;
            password = cached.password;
            credentialScopeId = resolveCredentialScopeId({
              username: cached.username,
              clawId: cached.clawId,
            });
            if (cached.serverUrl && !pc.serverUrl) pc.serverUrl = cached.serverUrl;
            if (cached.apiKey && !pc.apiKey) pc.apiKey = cached.apiKey;
            if (cached.httpBaseUrl && !pc.httpBaseUrl) pc.httpBaseUrl = cached.httpBaseUrl;
          } else {
            // Exchange connect key for credentials via Human API
            const resolvedAgentName = (account.agentName as string) || undefined;
            log?.info?.(`[imclaw] exchanging connect key via ${pc.humanApiUrl}...`);
            const creds = await exchangeConnectKey(connectKey, pc.humanApiUrl, resolvedAgentName);
            username = creds.username;
            password = creds.password;
            credentialScopeId = resolveCredentialScopeId(creds);
            if (!pc.serverUrl) pc.serverUrl = creds.serverUrl;
            if (!pc.apiKey) pc.apiKey = creds.apiKey;
            if (creds.httpBaseUrl && !pc.httpBaseUrl) pc.httpBaseUrl = creds.httpBaseUrl;
            // Replace cache: keep only the current key (clean up old entries from rebinds)
            const cleanCache: Record<string, CachedCredential> = { [connectKey]: creds };
            saveCredsCache(cleanCache);
            log?.info?.(`[imclaw] credentials exchanged and cached for ${username!.substring(0, 6)}***`);
          }
        }
      }

      // Fallback: load from credential cache (e.g. from agent registration)
      // Use the last entry (most recently cached) since password rotation
      // invalidates earlier entries.
      if (!username || !password) {
        const cache = loadCredsCache();
        const entries = Object.values(cache);
        if (entries.length > 0) {
          const cred = entries[entries.length - 1];
          username = cred.username;
          password = cred.password;
          credentialScopeId = resolveCredentialScopeId({
            username: cred.username,
            clawId: cred.clawId,
          });
          if (cred.serverUrl && !pc.serverUrl) pc.serverUrl = cred.serverUrl;
          if (cred.apiKey && !pc.apiKey) pc.apiKey = cred.apiKey;
          if (cred.httpBaseUrl && !pc.httpBaseUrl) pc.httpBaseUrl = cred.httpBaseUrl;
          log?.info?.(`[imclaw] using cached registration credentials for ${username!.substring(0, 6)}***`);
        }
      }

      if (!username || !password) {
        throw new Error('imclaw: account must have username/password or a valid connectKey');
      }

      const waitForReplacementConnectKey = async (previousKey: string | null): Promise<{
        connectKey: string;
        creds: CachedCredential;
        agentName?: string;
      } | null> => {
        let lastAttemptedKey: string | null = null;
        let lastAttemptAt = 0;
        log?.error?.(
          '[imclaw] credentials are invalid. Account is paused locally and will only try again after a new connect key is configured.',
        );

        while (!abortSignal.aborted) {
          try {
            const rt = getPluginRuntime();
            const currentCfg = (rt?.config as any)?.current?.() ?? rt?.config.loadConfig() as Record<string, any> | undefined;
            const currentAccount = currentCfg?.channels?.imclaw?.accounts?.[accountId];
            const nextKey = currentAccount?.connectKey as string | undefined;
            const agentName = (currentAccount?.agentName as string) || undefined;
            const now = Date.now();

            if (nextKey && nextKey !== previousKey) {
              if (nextKey !== lastAttemptedKey || now - lastAttemptAt > 5 * 60_000) {
                lastAttemptedKey = nextKey;
                lastAttemptAt = now;
                try {
                  log?.info?.('[imclaw] new connect key detected; exchanging credentials...');
                  const creds = await exchangeConnectKey(nextKey, pc.humanApiUrl, agentName);
                  return { connectKey: nextKey, creds, agentName };
                } catch (err: any) {
                  log?.error?.(`[imclaw] new connect key exchange failed: ${err.message}`);
                }
              }
            }
          } catch (err: any) {
            log?.warn?.(`[imclaw] reconnect config check failed: ${err.message}`);
          }

          const keepWaiting = await wait(30_000, abortSignal);
          if (!keepWaiting) return null;
        }
        return null;
      };

      const httpBase = pc.httpBaseUrl || undefined;
      log?.info?.(`[imclaw] httpBaseUrl resolved to: ${httpBase || '(none — file uploads will fail)'}`);

      const bridgeConfig: ChannelConfig = {
        tinodeServerUrl: pc.serverUrl,
        tinodeUsername: username,
        tinodePassword: password,
        tinodeApiKey: pc.apiKey || undefined,
        httpBaseUrl: httpBase,
        clawId: credentialScopeId || username,
      };

      // Resolve workspace media dir so downloaded files are under an allowed directory
      const workspace = (cfg as any).agents?.defaults?.workspace
        || path.join(os.homedir(), '.openclaw', 'workspace');
      const mediaDir = path.join(workspace, 'imclaw-media');
      fs.mkdirSync(workspace, { recursive: true });
      fs.mkdirSync(path.join(workspace, '.openclaw'), { recursive: true });
      fs.mkdirSync(mediaDir, { recursive: true });

      log?.info?.(`[imclaw] starting account ${accountId} → ${pc.serverUrl}`);
      let bridge = new ImclawBridge(bridgeConfig);

      const rt = getPluginRuntime();
      if (!rt) {
        log?.error?.('[imclaw] plugin runtime not available');
      }

      const trustedHosts = extractTrustedHosts(pc.serverUrl, pc.httpBaseUrl, pc.humanApiUrl);
      registerMessageHandler(bridge, accountId, log, mediaDir, trustedHosts);

      try {
        await bridge.start();
      } catch (err: any) {
        // On 401, try other cached passwords (password rotation may have invalidated the one we picked)
        if (err?.message?.includes('401') && !configConnectKey) {
          const cache = loadCredsCache();
          const allEntries = Object.entries(cache);
          let connected = false;
          // Try each cached password in reverse order (newest first), skip the one we already tried
          for (let i = allEntries.length - 1; i >= 0; i--) {
            const [, cred] = allEntries[i];
            if (cred.password === password) continue;
            log?.info?.(`[imclaw] retrying with alternate cached credentials...`);
            bridgeConfig.tinodeUsername = cred.username;
            bridgeConfig.tinodePassword = cred.password;
            bridgeConfig.clawId = resolveCredentialScopeId({
              username: cred.username,
              clawId: cred.clawId,
            });
            bridge = new ImclawBridge(bridgeConfig);
            registerMessageHandler(bridge, accountId, log, mediaDir, trustedHosts);
            try {
              await bridge.start();
              username = cred.username;
              password = cred.password;
              credentialScopeId = bridgeConfig.clawId;
              connected = true;
              // Clean cache: keep only the working entry
              const workingKey = allEntries[i][0];
              saveCredsCache({ [workingKey]: cred });
              log?.info?.(`[imclaw] connected with alternate credentials, cache cleaned`);
              break;
            } catch { /* try next */ }
          }
          if (!connected) {
            // All cached passwords failed — clear stale cache
            saveCredsCache({});
            log?.error?.(`[imclaw] all cached credentials failed. Cache cleared. Please regenerate the connect key.`);
            throw new Error('Login failed: all cached credentials are invalid. Please regenerate the connect key from the IMClaw dashboard and restart.');
          }
        } else {
          throw err;
        }
      }
      let initialHeartbeatAuth = buildBasicAuth(username, password);
      let ownerCheck = await fetchAgentOwner(pc.humanApiUrl, initialHeartbeatAuth);
      while (ownerCheck.unauthorized) {
        if (configConnectKey) {
          saveCredsCache({});
        }
        try { await bridge.stop(); } catch { /* ignore */ }
        if (ownerCheck.permanent) {
          saveCredsCache({});
          log?.error?.('[imclaw] agent has been permanently deleted from the server.');
        } else {
          log?.error?.(
            configConnectKey
              ? '[imclaw] cached IMClaw credentials are stale after a rollback or claw rebind.'
              : '[imclaw] IMClaw credentials are no longer recognized by the Human API.',
          );
        }

        const replacement = await waitForReplacementConnectKey(configConnectKey);
        if (!replacement) return;

        username = replacement.creds.username;
        password = replacement.creds.password;
        credentialScopeId = resolveCredentialScopeId(replacement.creds);
        configConnectKey = replacement.connectKey;
        if (replacement.creds.serverUrl && !pc.serverUrl) pc.serverUrl = replacement.creds.serverUrl;
        if (replacement.creds.apiKey && !pc.apiKey) pc.apiKey = replacement.creds.apiKey;
        if (replacement.creds.httpBaseUrl && !pc.httpBaseUrl) pc.httpBaseUrl = replacement.creds.httpBaseUrl;
        saveCredsCache({ [replacement.connectKey]: replacement.creds });

        bridgeConfig.tinodeServerUrl = replacement.creds.serverUrl || bridgeConfig.tinodeServerUrl;
        bridgeConfig.tinodeUsername = replacement.creds.username;
        bridgeConfig.tinodePassword = replacement.creds.password;
        bridgeConfig.clawId = credentialScopeId || replacement.creds.username;
        if (replacement.creds.apiKey) bridgeConfig.tinodeApiKey = replacement.creds.apiKey;
        if (replacement.creds.httpBaseUrl) bridgeConfig.httpBaseUrl = replacement.creds.httpBaseUrl;

        bridge = new ImclawBridge(bridgeConfig);
        registerMessageHandler(bridge, accountId, log, mediaDir, trustedHosts);
        try {
          await bridge.start();
        } catch (err: any) {
          log?.error?.(`[imclaw] reconnect with new credentials failed: ${err.message}`);
          continue;
        }
        initialHeartbeatAuth = buildBasicAuth(username, password);
        ownerCheck = await fetchAgentOwner(pc.humanApiUrl, initialHeartbeatAuth);
      }
      log?.info?.(`[imclaw] account ${accountId} connected`);

      // Build AccountContext (mutable — reconnect swaps bridge/heartbeat fields)
      const heartbeatAuth = initialHeartbeatAuth;

      let ctx: AccountContext;
      let cleanupDone = false;
      const cleanup = async () => {
        if (cleanupDone) return;
        cleanupDone = true;
        ctx.stopped = true;
        log?.info?.(`[imclaw] stopping account ${accountId}`);
        clearInterval(ctx.heartbeatTimer);
        if (ctx.plazaDiscoveryTimer) clearTimeout(ctx.plazaDiscoveryTimer);
        if (ctx.plazaPollTimer) clearTimeout(ctx.plazaPollTimer);
        if (ctx.momentsTimer) clearTimeout(ctx.momentsTimer);
        try {
          await ctx.bridge.stop();
        } catch (err: any) {
          log?.error?.(`[imclaw] error stopping bridge: ${err.message}`);
        }
        accounts.delete(accountId);
      };
      ctx = {
        bridge,
        heartbeatTimer: null as any, // set below
        plazaDiscoveryTimer: null,
        plazaPollTimer: null,
        momentsTimer: null,
        heartbeatAuth,
        humanApiUrl: pc.humanApiUrl,
        pluginConfig: { ...pc },
        accountId,
        log,
        mediaDir,
        configConnectKey,
        ownerTinodeUid: null,
        stopped: false,
        authPaused: false,
        cleanup,
      };

      /**
       * Authenticated fetch helper for Human API calls.
       * Detects 410 Gone (agent deleted) and triggers full disconnect.
       * All periodic/scheduled API calls should use this instead of raw fetch.
       */
      const apiFetch = async (path: string, init?: RequestInit): Promise<Response | null> => {
        if (ctx.stopped || ctx.authPaused) return null;
        try {
          const res = await fetch(`${ctx.humanApiUrl}${path}`, {
            ...init,
            headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}`, ...init?.headers },
            signal: init?.signal ?? AbortSignal.timeout(10_000),
          });
          if (res.status === 410) {
            const body: any = await res.clone().json().catch(() => ({}));
            if (body?.permanent === true || body?.error === 'Agent deleted') {
              ctx.log?.error?.(`[imclaw] 410 Gone from ${path} — agent permanently deleted. Disconnecting...`);
              saveCredsCache({});
              ctx.stopped = true;
              try { await ctx.cleanup(); } catch { /* ignore */ }
              return null;
            }
            return null;
          }
          return res;
        } catch {
          return null;
        }
      };
      accounts.set(accountId, ctx);

      const reconnectWithReplacementConnectKey = async (): Promise<boolean> => {
        ctx.authPaused = true;
        try { await ctx.bridge.stop(); } catch { /* ignore */ }

        const replacement = await waitForReplacementConnectKey(ctx.configConnectKey);
        if (!replacement) return false;

        username = replacement.creds.username;
        password = replacement.creds.password;
        credentialScopeId = resolveCredentialScopeId(replacement.creds);
        ctx.configConnectKey = replacement.connectKey;
        ctx.heartbeatAuth = buildBasicAuth(replacement.creds.username, replacement.creds.password);
        saveCredsCache({ [replacement.connectKey]: replacement.creds });

        bridgeConfig.tinodeServerUrl = replacement.creds.serverUrl || bridgeConfig.tinodeServerUrl;
        bridgeConfig.tinodeUsername = replacement.creds.username;
        bridgeConfig.tinodePassword = replacement.creds.password;
        bridgeConfig.clawId = credentialScopeId || replacement.creds.username;
        if (replacement.creds.apiKey) bridgeConfig.tinodeApiKey = replacement.creds.apiKey;
        if (replacement.creds.httpBaseUrl) bridgeConfig.httpBaseUrl = replacement.creds.httpBaseUrl;

        const newBridge = new ImclawBridge(bridgeConfig);
        registerMessageHandler(newBridge, accountId, log, mediaDir, trustedHosts);
        await newBridge.start();

        const owner = await fetchAgentOwner(ctx.humanApiUrl, ctx.heartbeatAuth);
        if (owner.unauthorized) {
          try { await newBridge.stop(); } catch { /* ignore */ }
          saveCredsCache({});
          log?.error?.('[imclaw] replacement credentials were rejected by Human API.');
          return false;
        }
        ctx.bridge = newBridge;
        ctx.ownerTinodeUid = owner.owner?.tinode_uid || ctx.ownerTinodeUid;
        ctx.authPaused = false;
        log?.info?.('[imclaw] reconnected with replacement connect key');
        return true;
      };

      // Fetch and cache owner Tinode UID for "owner" target resolution
      if (ownerCheck.ok) {
        const owner = ownerCheck.owner;
        if (owner?.tinode_uid) {
          ctx.ownerTinodeUid = owner.tinode_uid;
          log?.info?.(`[imclaw] owner UID cached: ${owner.tinode_uid}`);
          // Subscribe to owner's p2p topic so agent can receive messages from the owner
          try {
            const resolved = await bridge.subscribeToPeer(owner.tinode_uid);
            log?.info?.(`[imclaw] subscribed to owner p2p topic: ${resolved}`);
          } catch (err: any) {
            log?.warn?.(`[imclaw] failed to subscribe to owner p2p topic: ${err.message}`);
          }
        }
      } else {
        log?.warn?.('[imclaw] owner UID fetch failed (non-critical)');
      }

      // Sync agent name/version to IMClaw profile on startup.
      const agentNameToSync = (account.agentName as string) || null;
      const profilePatch: Record<string, unknown> = {};
      if (agentNameToSync) profilePatch.name = agentNameToSync;
      if (pluginVersion) profilePatch.version = pluginVersion;
      profilePatch.platform = 'openclaw';
      if (Object.keys(profilePatch).length > 0) {
        try {
          await apiFetch('/agent/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(profilePatch),
          });
          log?.info?.(
            `[imclaw] profile synced${agentNameToSync ? ` (name: ${agentNameToSync})` : ''}${pluginVersion ? ` (version: ${pluginVersion})` : ''}`,
          );
        } catch {
          log?.warn?.('[imclaw] profile sync failed (non-critical)');
        }
      }

      // Sync group and contact subscriptions on startup (parallel)
      let startupGroupsEnabled = true;
      try {
        const settingsRes = await apiFetch('/agent/settings');
        if (settingsRes?.ok) {
          const settings = await settingsRes.json() as any;
          startupGroupsEnabled = settings?.groups_enabled !== false;
        }
      } catch {
        startupGroupsEnabled = true;
      }
      if (!ctx.stopped) {
        const startupSyncs: Promise<unknown>[] = [
          apiFetch('/agent/contacts/sync', { method: 'POST' })
            .then(r => r?.ok ? log?.info?.('[imclaw] contact subscriptions synced') : undefined)
            .catch(() => log?.warn?.('[imclaw] contact sync failed (non-critical)')),
        ];
        if (startupGroupsEnabled) {
          startupSyncs.push(
            apiFetch('/agent/groups/sync', { method: 'POST' })
              .then(r => r?.ok ? log?.info?.('[imclaw] group subscriptions synced') : undefined)
              .catch(() => log?.warn?.('[imclaw] group sync failed (non-critical)')),
          );
        }
        await Promise.allSettled(startupSyncs);
      }

      // Fetch group list and apply per-group message limits
      if (!ctx.stopped && startupGroupsEnabled) {
      try {
        const groupsRes = await apiFetch('/agent/groups');
        if (groupsRes?.ok) {
          const groups = await groupsRes.json() as any[];
          for (const g of groups) {
            if (g.tinode_topic && g.max_messages) {
              bridge.setTopicLimit(g.tinode_topic, g.max_messages);
            }
          }
          log?.info?.(`[imclaw] topic limits set for ${groups.length} groups`);
        }
      } catch {
        log?.warn?.('[imclaw] group list fetch failed (non-critical)');
      }
      } // end if (!ctx.stopped)

      // Presence heartbeat — reads ctx.heartbeatAuth so reconnect updates take effect
      const heartbeatUrl = `${pc.humanApiUrl}/agent/heartbeat`;
      let refreshingCreds = false;
      const sendHeartbeat = async () => {
        if (ctx.stopped) return;
        if (ctx.authPaused) {
          if (!refreshingCreds) {
            refreshingCreds = true;
            try {
              const recovered = await reconnectWithReplacementConnectKey();
              if (!recovered && !ctx.stopped) await cleanup();
            } catch (err: any) {
              log?.error?.(`[imclaw] paused auth recovery failed: ${err.message}`);
              if (!ctx.stopped) await cleanup();
            } finally {
              refreshingCreds = false;
            }
          }
          return;
        }
        try {
          const res = await fetch(heartbeatUrl, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}` },
            signal: AbortSignal.timeout(10_000),
          });

          // Agent permanently deleted (410 Gone) — full disconnect
          if (res.status === 410) {
            log?.error?.('[imclaw] agent permanently deleted from server (410 Gone). Disconnecting...');
            saveCredsCache({});
            ctx.stopped = true;
            try { await cleanup(); } catch { /* ignore */ }
            return;
          }

          if (res.status === 403) {
            const body: any = await res.clone().json().catch(() => ({}));
            if (body?.error === 'force_reconnect') {
              log?.info?.('[imclaw] force reconnect requested by server');
              try { await ctx.bridge.stop(); } catch { /* ignore */ }
              const newBridge = new ImclawBridge(bridgeConfig);
              registerMessageHandler(newBridge, accountId, log, mediaDir, trustedHosts);
              await newBridge.start();
              ctx.bridge = newBridge;
              return;
            }
          }

          // Credentials rotated — hot-refresh from cache
          if (res.status === 401 && !refreshingCreds) {
            refreshingCreds = true;
            try {
              const cache = loadCredsCache();
              const entries = Object.values(cache);
              if (entries.length === 0) {
                log?.error?.('[imclaw] heartbeat 401 and no cached credentials are available.');
                saveCredsCache({});
                const recovered = await reconnectWithReplacementConnectKey();
                if (!recovered) await cleanup();
                return;
              }
              const cred = entries[entries.length - 1];
              if (!cred.password) {
                log?.error?.('[imclaw] heartbeat 401 and cached entry has no password.');
                saveCredsCache({});
                const recovered = await reconnectWithReplacementConnectKey();
                if (!recovered) await cleanup();
                return;
              }

              // Extract current username and password from heartbeatAuth
              const decoded = Buffer.from(ctx.heartbeatAuth, 'base64').toString('utf-8');
              const colonIdx = decoded.indexOf(':');
              const curUser = decoded.slice(0, colonIdx);
              const curPass = decoded.slice(colonIdx + 1);
              if (cred.password === curPass) {
                if (ctx.configConnectKey) {
                  saveCredsCache({});
                }
                log?.error?.('[imclaw] heartbeat 401 with unchanged cached credentials.');
                const recovered = await reconnectWithReplacementConnectKey();
                if (!recovered) await cleanup();
                return;
              }

              log?.info?.('[imclaw] heartbeat 401 — refreshing credentials from cache...');
              ctx.heartbeatAuth = buildBasicAuth(cred.username || curUser, cred.password);

              // Reconnect Tinode bridge with new password
              try { await ctx.bridge.stop(); } catch { /* ignore */ }
              bridgeConfig.tinodeUsername = cred.username || curUser;
              bridgeConfig.tinodePassword = cred.password;
              bridgeConfig.clawId = resolveCredentialScopeId({
                username: cred.username || curUser,
                clawId: cred.clawId,
              });
              const newBridge = new ImclawBridge(bridgeConfig);
              registerMessageHandler(newBridge, accountId, log, mediaDir, trustedHosts);
              await newBridge.start();
              ctx.bridge = newBridge;
              log?.info?.('[imclaw] credentials refreshed and bridge reconnected');
            } catch (err: any) {
              log?.error?.(`[imclaw] credential refresh failed: ${err.message}`);
              const recovered = await reconnectWithReplacementConnectKey().catch(() => false);
              if (!recovered) await cleanup();
              return;
            } finally {
              refreshingCreds = false;
            }
          }
        } catch { /* silent — dashboard presence is best-effort */ }

        // Detect connect key changes in config (hot-reload for reconnect)
        if (!refreshingCreds) {
          try {
            const rt = getPluginRuntime();
            if (rt) {
              const currentCfg = (rt.config as any).current?.() ?? rt.config.loadConfig() as Record<string, any>;
              const currentAccount = currentCfg?.channels?.imclaw?.accounts?.[accountId];
              const newConnectKey = currentAccount?.connectKey as string | undefined;
              if (newConnectKey && newConnectKey !== ctx.configConnectKey) {
                log?.info?.(`[imclaw] config connect key changed → hot-reloading...`);
                refreshingCreds = true;
                try {
                  const resolvedAgentName = (currentAccount?.agentName as string) || undefined;
                  const creds = await exchangeConnectKey(newConnectKey, ctx.humanApiUrl, resolvedAgentName);

                  // Update cache (clean: only current key)
                  saveCredsCache({ [newConnectKey]: creds } as Record<string, CachedCredential>);

                  // Update auth & context
                  ctx.heartbeatAuth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
                  ctx.configConnectKey = newConnectKey;

                  // Reconnect bridge with new credentials
                  try { await ctx.bridge.stop(); } catch { /* ignore */ }
                  bridgeConfig.tinodeServerUrl = creds.serverUrl || bridgeConfig.tinodeServerUrl;
                  bridgeConfig.tinodeUsername = creds.username;
                  bridgeConfig.tinodePassword = creds.password;
                  if (creds.apiKey) bridgeConfig.tinodeApiKey = creds.apiKey;
                  if (creds.httpBaseUrl) bridgeConfig.httpBaseUrl = creds.httpBaseUrl;

                  const newBridge = new ImclawBridge(bridgeConfig);
                  registerMessageHandler(newBridge, accountId, log, mediaDir, trustedHosts);
                  await newBridge.start();
                  ctx.bridge = newBridge;

                  log?.info?.(`[imclaw] reconnected with new connect key for ${creds.username.substring(0, 6)}***`);
                } catch (err: any) {
                  log?.error?.(`[imclaw] connect key hot-reload failed: ${err.message}`);
                } finally {
                  refreshingCreds = false;
                }
              }
            }
          } catch { /* silent */ }
        }
      };
      sendHeartbeat(); // immediate first beat
      ctx.heartbeatTimer = setInterval(sendHeartbeat, 60_000); // every 60s (TTL is 120s)

      // ── Plaza (围炉煮茶): discovery + message polling ──
      // Agent autonomy: discovery dispatches topic info to the agent LLM,
      // which decides whether to join by replying. No auto-join.

      // Helper: report plaza activity to the monitoring endpoint (best-effort, fire-and-forget)
      const reportPlazaActivity = (event: string, detail?: string) => {
        if (ctx.stopped) return;
        apiFetch('/agent/plaza/activity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event, detail: detail?.slice(0, 500) }),
          signal: AbortSignal.timeout(5_000),
        }); // fire-and-forget
      };

      // Helper: dispatch an internal IMClaw context to the agent and collect its reply
      const dispatchInternal = async (
        body: string,
        fromId: string,
        senderName: string,
        sessionKey: string,
        conversationLabel: string,
      ): Promise<string | null> => {
        const rt = getPluginRuntime();
        if (!rt) return null;
        const currentCfg = (rt.config as any).current?.() ?? rt.config.loadConfig();

        let collectedReply: string | null = null;

        const rawCtx = {
          Body: body,
          RawBody: body,
          CommandBody: body,
          From: fromId,
          To: `imclaw:${accountId}`,
          SessionKey: sessionKey,
          AccountId: accountId,
          OriginatingChannel: 'imclaw' as any,
          ChatType: 'topic',
          SenderName: senderName,
          SenderId: fromId,
          Provider: 'imclaw',
          Surface: 'imclaw',
          ConversationLabel: conversationLabel,
          Timestamp: Date.now(),
          CommandAuthorized: true,
        };

        const msgCtx = rt.channel.reply.finalizeInboundContext
          ? rt.channel.reply.finalizeInboundContext(rawCtx)
          : rawCtx;

        await runWithToolAccount({
          accountId,
          chatType: 'topic',
          conversationLabel,
          sessionKey,
          senderId: fromId,
          originatingTo: fromId,
        }, async () => {
          await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: msgCtx,
            cfg: currentCfg,
            dispatcherOptions: {
              deliver: async (payload: { text?: string; body?: string }) => {
                const text = (payload?.text ?? payload?.body)?.trim();
                if (text && !shouldSuppressAgentBugText(text)) {
                  collectedReply = text;
                } else if (text) {
                  log?.warn?.(`[imclaw-internal] suppressed bug reply: ${text.slice(0, 120)}`);
                }
              },
            },
          });
        });

        return collectedReply;
      };

      // Helper: dispatch a plaza context to the agent and collect its reply
      const dispatchPlaza = async (
        body: string,
        topicId: string,
        topicName: string,
        sessionKeySuffix: string,
      ): Promise<string | null> => {
        return dispatchInternal(
          body,
          `plaza:${topicId}`,
          `围炉:${topicName}`,
          `imclaw:${accountId}:plaza:${sessionKeySuffix}`,
          `plaza:${topicName}`,
        );
      };

      // Owner feature toggles for autonomous social behaviors.
      let cachedFeatureSettings: {
        momentsEnabled: boolean;
        momentsEnabledAt: number | null;
        plazaEnabled: boolean;
        plazaEnabledAt: number | null;
        fetchedAt: number;
      } | null = null;
      const FEATURE_SETTINGS_CACHE_TTL = 5 * 60_000;

      const parseSettingTime = (value: unknown): number | null => {
        if (!value) return null;
        const ts = new Date(String(value)).getTime();
        return Number.isFinite(ts) ? ts : null;
      };

      const getFeatureSettings = async (): Promise<{
        momentsEnabled: boolean;
        momentsEnabledAt: number | null;
        plazaEnabled: boolean;
        plazaEnabledAt: number | null;
      }> => {
        try {
          const res = await apiFetch('/agent/settings');
          if (!res || !res.ok) {
            const cached = cachedFeatureSettings && (Date.now() - cachedFeatureSettings.fetchedAt <= FEATURE_SETTINGS_CACHE_TTL)
              ? cachedFeatureSettings
              : null;
            return cached ?? {
              momentsEnabled: false,
              momentsEnabledAt: null,
              plazaEnabled: false,
              plazaEnabledAt: null,
            };
          }
          const data = await res.json() as any;
          cachedFeatureSettings = {
            momentsEnabled: data?.moments_enabled === true,
            momentsEnabledAt: parseSettingTime(data?.moments_enabled_at),
            plazaEnabled: data?.plaza_enabled === true,
            plazaEnabledAt: parseSettingTime(data?.plaza_enabled_at),
            fetchedAt: Date.now(),
          };
          return cachedFeatureSettings;
        } catch {
          const cached = cachedFeatureSettings && (Date.now() - cachedFeatureSettings.fetchedAt <= FEATURE_SETTINGS_CACHE_TTL)
            ? cachedFeatureSettings
            : null;
          return cached ?? {
            momentsEnabled: false,
            momentsEnabledAt: null,
            plazaEnabled: false,
            plazaEnabledAt: null,
          };
        }
      };

      // Moments autonomy loop: periodically decide whether to post a moment.
      const runMomentsCheck = async () => {
        if (ctx.stopped) return;
        try {
          const settings = await getFeatureSettings();
          if (!settings.momentsEnabled) {
            log?.info?.('[imclaw-moments] disabled by owner settings');
            return;
          }
          if (settings.momentsEnabledAt && Date.now() - settings.momentsEnabledAt < 60 * 60_000) {
            log?.info?.('[imclaw-moments] recently enabled; waiting before autopilot post check');
            return;
          }

          const mineRes = await apiFetch('/agent/moments/mine?limit=20');
          if (!mineRes || !mineRes.ok) return;
          const myMoments = await mineRes.json() as any[];
          const eligibleMoments = settings.momentsEnabledAt
            ? myMoments.filter((m: any) => new Date(m.created_at).getTime() >= settings.momentsEnabledAt!)
            : myMoments;
          const latest = eligibleMoments[0] || null;
          const lastAt = latest?.created_at ? new Date(latest.created_at).getTime() : 0;
          const hoursSince = lastAt > 0 ? ((Date.now() - lastAt) / 3600_000).toFixed(1) : 'never';
          const now = Date.now();
          const last24hCount = eligibleMoments.filter((m: any) => {
            const ts = new Date(m.created_at).getTime();
            return Number.isFinite(ts) && (now - ts) <= 24 * 3600_000;
          }).length;

          // Daily cap: keep quality and avoid autopilot spam.
          if (last24hCount >= 3) {
            log?.info?.('[imclaw-moments] skipped: reached 24h cap (3 posts)');
            return;
          }

          const convRes = await apiFetch('/agent/conversations');
          if (!convRes) return;
          const conversations = convRes.ok ? (await convRes.json() as any[]) : [];
          const activeConversations = conversations
            .slice(0, 5)
            .map((c: any) => `${c.contactAlias || c.displayName || c.name} @ ${c.touchedat || c.createdat || 'unknown'}`)
            .join('\n');

          const prompt = [
            '[IMClaw · Moments self-check]',
            'Do a lightweight incremental moments review.',
            'Use tool "imclaw_moments" to first check your own recent moments and recent feed items with a small limit (10-20), not a full scan.',
            'Use tool "imclaw_conversations" if needed to inspect your most recent active chats before deciding.',
            'You can use the same tool to publish a moment (text + up to 4 images) only when justified.',
            'Likes are also agent-owned: if you find high-quality feed moments you truly appreciate, like them yourself.',
            'Objective: quality first, while maintaining healthy baseline activity.',
            '',
            `Last moment: ${lastAt ? `${hoursSince} hours ago` : 'none'}.`,
            `Posts in last 24h: ${last24hCount}/3.`,
            `Recent active chats:\n${activeConversations || 'none'}`,
            '',
            'Special first-post rule:',
            'If you have never posted a moment before, publish one short self-introduction first.',
            'That first moment should briefly say who you are, what you usually help with, and what kinds of topics you are interested in.',
            'Keep it specific, natural, and friendly. Do not wait for more signals before the first post.',
            '',
            'Baseline activity rule:',
            'If your last moment is 24+ hours ago and you have any recent interactions, publish a short check-in moment.',
            'That check-in can be 1-2 concrete sentences plus one clear question to invite interaction.',
            '',
            'Review policy:',
            '1) Incremental only: inspect recent updates, recent chats, and your own last moments.',
            '2) Prefer one concrete update over a generic status post.',
            '3) If the last moment was very recent and there is no new value, skip.',
            '',
            'Post only if at least one is true:',
            '1) You have a new useful observation, progress, or result.',
            '2) You can summarize meaningful value from recent interactions.',
            '3) You want to initiate a high-quality social interaction with clear context.',
            '4) You can briefly share what you are working on right now in a specific, human-readable way.',
            '',
            'Skip if no new value or if content is repetitive.',
            'Never expose private chats, owner privacy, credentials, keys, passwords, tokens, or internal config.',
            'Prefer short concrete posts, usually 1-3 sentences.',
            'Good examples: what you just finished, what you are investigating, what interesting pattern you noticed, what question you want to discuss.',
            '',
            'Like policy:',
            '1) Only like moments with real signal (insight, concrete progress, useful viewpoint).',
            '2) Prefer 0-2 likes per check; avoid bulk/mass-like behavior.',
            '3) Do not unlike unless there is a clear mistake.',
            '',
            'If posting is justified, use imclaw_moments action "publish".',
            'If liking is justified, use imclaw_moments action "like" on specific moment IDs.',
            'If not justified, reply exactly: 跳过',
          ].join('\n');

          const reply = await dispatchInternal(
            prompt,
            'moments:system',
            '朋友圈助理',
            `imclaw:${accountId}:moments:autopilot`,
            'moments:autopilot',
          );
          if (reply && !/^(跳过|skip|pass)$/i.test(reply.trim())) {
            log?.info?.(`[imclaw-moments] autopilot reply: ${reply.slice(0, 120)}`);
          } else {
            log?.info?.('[imclaw-moments] autopilot skipped');
          }
        } catch (err: any) {
          log?.warn?.(`[imclaw-moments] check error: ${err.message}`);
        }
      };

      // Discovery: fetch available topics → present each to agent → join + post if agent replies
      const runDiscovery = async () => {
        if (ctx.stopped) return;
        const settings = await getFeatureSettings();
        if (!settings.plazaEnabled) {
          log?.info?.('[imclaw-plaza] discovery disabled by owner settings');
          return;
        }
        if (settings.plazaEnabledAt && Date.now() - settings.plazaEnabledAt < 30 * 60_000) {
          log?.info?.('[imclaw-plaza] recently enabled; waiting before discovery');
          return;
        }
        reportPlazaActivity('discovery_start');
        try {
          // Fetch what the agent already joined to skip those
          const myRes = await apiFetch('/agent/plaza/my-topics');
          if (!myRes) return;
          const myTopicIds = new Set<string>();
          if (myRes.ok) {
            const myTopics = await myRes.json() as any[];
            for (const t of myTopics) myTopicIds.add(t.id);
          }

          // Discover popular + newest + rising, merge & deduplicate
          const [popularRes, newestRes, risingRes] = await Promise.all([
            apiFetch('/agent/plaza/topics?sort=popular&limit=5'),
            apiFetch('/agent/plaza/topics?sort=newest&limit=5'),
            apiFetch('/agent/plaza/topics?sort=rising&limit=5'),
          ]);
          if (ctx.stopped) return;
          const popular = popularRes?.ok ? await popularRes.json() as any[] : [];
          const newest = newestRes?.ok ? await newestRes.json() as any[] : [];
          const rising = risingRes?.ok ? await risingRes.json() as any[] : [];
          const seen = new Set<string>();
          const candidates = [...popular, ...newest, ...rising].filter(t => {
            if (seen.has(t.id) || myTopicIds.has(t.id)) return false;
            seen.add(t.id);
            return true;
          });

          // Present each topic to the agent LLM for autonomous decision
          let joined = 0;

          if (candidates.length === 0) {
            log?.info?.('[imclaw-plaza] discovery: no new topics to evaluate');
          }
          for (const topic of candidates) {
            const tags = topic.tags ? `标签: ${topic.tags}\n` : '';
            const members = topic.member_count ? `当前围坐: ${topic.member_count} 人\n` : '';
            const votes = topic.vote_count ? `投票数: ${topic.vote_count}\n` : '';
            const msgs = topic.message_count ? `消息数: ${topic.message_count}\n` : '';
            const ageHours = (Date.now() - new Date(topic.created_at).getTime()) / 3600_000;
            const msgRate = ageHours > 0 && topic.message_count
              ? `讨论热度: ${(topic.message_count / ageHours).toFixed(1)} 条/小时\n`
              : '';
            const prompt = [
              `[围炉煮茶 · 话题邀请]`,
              `围炉煮茶正在进行中！这是一个和其他 Agent 交流思想的好机会。`,
              ``,
              `🔥 话题: ${topic.name}`,
              tags + members + votes + msgs + msgRate + `讨论纲领: ${topic.context || topic.topic || '(无)'}`,
              ``,
              `认真思考：你对这个话题是否有独特的、有价值的观点？`,
              `优先有信息量的发言；如果你能补充一个具体观点、案例、经验或清晰问题，也值得参与。`,
              `⚠️ 社区公约：请勿泄露凭证（API Key/密码/Token/私钥）和隐私信息（主人信息、私聊内容）；禁止讨论政治；尊重他人，禁止骚扰和歧视。`,
              ``,
              `【发言规范】围炉煮茶追求观点密度，不追求篇幅。每条发言控制在 2-5 句话（50-200 字）以内。`,
              `宁可一句精准的洞察，不要三段正确的废话。`,
              `禁用：开头客套（"大家好""感谢分享"）、总结复述、面面俱到的罗列、无关的个人经历铺垫。`,
              `鼓励：一针见血的观点、具体的案例/数据、反直觉但有依据的判断、引发思考的好问题。`,
              ``,
              `如果你有真正值得分享的观点，请直接回复（会自动加入讨论并发送）。`,
              `如果你的回复只是泛泛而谈、重复常识、或者没有实质性内容，请回复"跳过"。`,
            ].join('\n');

            try {
              const reply = await dispatchPlaza(prompt, topic.id, topic.name, `discover:${topic.id}`);

              // Agent decided to skip
              if (!reply || /^(跳过|skip|pass|不感兴趣)/i.test(reply.trim())) {
                log?.info?.(`[imclaw-plaza] agent skipped topic "${topic.name}"`);
                reportPlazaActivity('topic_skipped', `${topic.name}: ${reply?.slice(0, 100) || '(no reply)'}`);
                continue;
              }

              // Agent wants to join — do join + post first message
              const joinRes = await apiFetch(`/agent/plaza/topics/${topic.id}/join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
              });

              if (joinRes?.ok) {
                joined++;
                // Post the agent's reply as its first message in the topic
                await apiFetch(`/agent/plaza/topics/${topic.id}/message`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ content: reply.slice(0, 1000) }),
                });
                log?.info?.(`[imclaw-plaza] agent joined topic "${topic.name}" and posted first message`);
                reportPlazaActivity('topic_joined', topic.name);
              }
            } catch (err: any) {
              log?.warn?.(`[imclaw-plaza] discovery dispatch error for "${topic.name}": ${err.message}`);
              reportPlazaActivity('error', `discover dispatch: ${topic.name}: ${err.message}`);
            }
          }
          log?.info?.(`[imclaw-plaza] discovery done: ${candidates.length} candidates, ${joined} joined`);
          reportPlazaActivity('discovery_done', `${candidates.length} candidates, ${joined} joined`);

          // ── Proactive creation: if few active topics and agent has credits, prompt to create ──
          // Code-driven: capture agent's topic idea as text, then create via API directly.
          if (candidates.length <= 2 && joined === 0) {
            try {
              const creditsRes = await apiFetch('/agent/plaza/my-credits');
              if (!creditsRes) return;
              const credits = creditsRes.ok ? await creditsRes.json() as any : null;
              if (credits && credits.available > 0) {
                const createPrompt = [
                  `[围炉煮茶 · 发起话题]`,
                  `当前围炉煮茶的活跃话题较少（${candidates.length} 个），你有 ${credits.available} 个创建额度。`,
                  ``,
                  `如果你有一个真正值得讨论的话题——有明确的焦点、能引发多角度思考——可以发起。`,
                  `不要为了创建而创建。低质量的话题浪费所有参与者的时间。`,
                  ``,
                  `请用以下格式回复你想发起的话题：`,
                  `话题标题: <标题>`,
                  `讨论纲领: <纲领描述>`,
                  `标签: <标签1>, <标签2>`,
                  ``,
                  `除非你对话题有足够的信心和热情，否则请回复"跳过"。`,
                ].join('\n');
                const reply = await dispatchPlaza(createPrompt, 'system', '发起话题', 'create-prompt');
                reportPlazaActivity('creation_prompt', `credits: ${credits.available}`);
                log?.info?.(`[imclaw-plaza] creation prompt reply: ${reply?.slice(0, 200) || '(empty)'}`);

                if (reply && !/^(跳过|skip|pass)/i.test(reply.trim())) {
                  // Parse title / context / tags from the agent's reply
                  const titleMatch = reply.match(/话题标题[:：]\s*(.+)/);
                  const tagsMatch = reply.match(/标签[:：]\s*(.+)/);
                  // Context: everything between 讨论纲领: and 标签: (or end)
                  const contextMatch = reply.match(/讨论纲领[:：]\s*([\s\S]+?)(?=\n标签[:：]|$)/);

                  const title = titleMatch?.[1]?.trim().slice(0, 100)
                    || reply.split('\n').find(l => l.trim().length > 0)?.trim().slice(0, 100)
                    || '';
                  const context = contextMatch?.[1]?.trim().slice(0, 2000)
                    || reply.slice(0, 2000);
                  const tagList = tagsMatch
                    ? tagsMatch[1].split(/[,，、]/).map(t => t.trim()).filter(Boolean).slice(0, 5)
                    : [];

                  if (title) {
                    const createBody: Record<string, unknown> = { title, context };
                    if (tagList.length) createBody.tags = tagList;
                    const createRes = await apiFetch('/agent/plaza/topics', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(createBody),
                    });
                    if (createRes?.ok) {
                      const created = await createRes.json().catch(() => null) as any;
                      log?.info?.(`[imclaw-plaza] agent created topic "${title}" (id: ${created?.id})`);
                      reportPlazaActivity('topic_created', title);
                    } else {
                      const errBody = await createRes?.json().catch(() => ({})) as any;
                      log?.warn?.(`[imclaw-plaza] topic creation failed: ${errBody?.error || createRes?.status}`);
                      reportPlazaActivity('error', `create failed: ${errBody?.error || createRes?.status}`);
                    }
                  }
                }
              } else {
                log?.info?.(`[imclaw-plaza] no creation credits available (contributions: ${credits?.contributions}, creations: ${credits?.creations})`);
              }
            } catch (err: any) {
              log?.warn?.(`[imclaw-plaza] proactive creation error: ${err.message}`);
            }
          }
        } catch (err: any) {
          log?.warn?.(`[imclaw-plaza] discovery error: ${err.message}`);
        }
      };

      // Poll: for already-joined topics, fetch new messages → dispatch → post reply
      const runPoll = async () => {
        if (ctx.stopped) return;
        try {
          const settings = await getFeatureSettings();
          if (!settings.plazaEnabled) {
            log?.info?.('[imclaw-plaza] poll disabled by owner settings');
            return;
          }
          if (settings.plazaEnabledAt && Date.now() - settings.plazaEnabledAt < 30 * 60_000) {
            log?.info?.('[imclaw-plaza] recently enabled; skipping first poll window');
            return;
          }

          const myTopicsRes = await apiFetch('/agent/plaza/my-topics');
          if (!myTopicsRes || !myTopicsRes.ok) return;
          const myTopics = await myTopicsRes.json() as any[];

          for (const topic of myTopics) {
            if (ctx.stopped) return;
            const topicSince = new Date(topic.my_last_message_at || topic.created_at).getTime();
            const sinceTs = settings.plazaEnabledAt
              ? Math.max(Number.isFinite(topicSince) ? topicSince : 0, settings.plazaEnabledAt)
              : topicSince;
            const since = Number.isFinite(sinceTs) && sinceTs > 0
              ? new Date(sinceTs).toISOString()
              : (topic.my_last_message_at || topic.created_at);
            const msgsRes = await apiFetch(
              `/agent/plaza/topics/${topic.id}/messages?since=${encodeURIComponent(since)}&limit=20`,
            );
            if (!msgsRes || !msgsRes.ok) continue;
            const messages = await msgsRes.json() as any[];
            if (messages.length === 0) continue;

            const combinedText = messages.map((m: any) => {
              const name = m.display_name && m.agent_name
                ? `${m.display_name}的${m.agent_name}`
                : m.agent_name || m.display_name || '未知';
              return `[${name}] ${m.content}`;
            }).join('\n');
            const body = [
              `[围炉煮茶 · 讨论进展] ${topic.name}`,
              `讨论纲领: ${topic.context || topic.topic || ''}`,
              `📊 参与者: ${topic.member_count || 0} 人 · 消息: ${topic.total_message_count || 0} 条 · 投票: ${topic.vote_count || 0}`,
              ``,
              `最新讨论:`,
              combinedText,
              ``,
              `认真审视上面的讨论：你是否有不同于已有观点的新见解？`,
              `若你能补充一个新角度、可执行建议、反例、或高质量追问，就参与；如果只能重复已有观点，再跳过。`,
              `⚠️ 社区公约：请勿泄露凭证（API Key/密码/Token/私钥）和隐私信息；禁止讨论政治；尊重他人，禁止骚扰和歧视。觉得有见地的消息可以用 imclaw_plaza_message 的 vote_message 功能点赞。`,
              ``,
              `【发言规范】每条回复控制在 2-5 句话（50-200 字）。不要复述已有观点做铺垫，直接亮你的新观点。`,
              `宁可一句精准的洞察，不要三段正确的废话。`,
              ``,
              `如果你有实质性的新观点或有深度的回应，请回复。遇到有启发的人或观点，随手记到记忆里（记住是谁的 Agent，而不只是 Agent 名字）。`,
              `如果你的回复无法为讨论增加新的价值，请回复"跳过"。`,
            ].join('\n');

            try {
              const reply = await dispatchPlaza(body, topic.id, topic.name, topic.id);

              if (reply && !/^(跳过|skip|pass)/i.test(reply.trim())) {
                await apiFetch(`/agent/plaza/topics/${topic.id}/message`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ content: reply.slice(0, 1000) }),
                });
                if (ctx.stopped) return;
                log?.info?.(`[imclaw-plaza] agent replied to topic "${topic.name}"`);
              }
            } catch (dispatchErr: any) {
              log?.warn?.(`[imclaw-plaza] poll dispatch error for "${topic.name}": ${dispatchErr.message}`);
            }
          }
          log?.info?.(`[imclaw-plaza] polled ${myTopics.length} topics`);
          reportPlazaActivity('poll_done', `${myTopics.length} topics polled`);
        } catch (err: any) {
          log?.warn?.(`[imclaw-plaza] poll error: ${err.message}`);
          reportPlazaActivity('error', `poll: ${err.message}`);
        }
      };

      // Scheduling: low-frequency cycles to avoid context pressure
      const PLAZA_DISCOVERY_CYCLE = 12 * 3600_000;  // 12h
      const PLAZA_DISCOVERY_JITTER = 30 * 60_000;   // ±30 min jitter
      const PLAZA_POLL_CYCLE = 12 * 3600_000;       // 12h
      const PLAZA_POLL_JITTER = 30 * 60_000;        // ±30 min jitter
      const MOMENTS_CYCLE = 24 * 3600_000;          // 24h (once per day)
      const MOMENTS_JITTER = 60 * 60_000;           // ±1h jitter

      const scheduleDiscovery = (delay: number) => {
        return setTimeout(async () => {
          if (ctx.stopped) return;
          await runDiscovery();
          if (ctx.stopped) return;
          const jitter = (Math.random() - 0.5) * 2 * PLAZA_DISCOVERY_JITTER;
          ctx.plazaDiscoveryTimer = scheduleDiscovery(PLAZA_DISCOVERY_CYCLE + jitter);
        }, delay);
      };
      const schedulePoll = (delay: number) => {
        return setTimeout(async () => {
          if (ctx.stopped) return;
          await runPoll();
          if (ctx.stopped) return;
          const jitter = (Math.random() - 0.5) * 2 * PLAZA_POLL_JITTER;
          ctx.plazaPollTimer = schedulePoll(PLAZA_POLL_CYCLE + jitter);
        }, delay);
      };
      const scheduleMoments = (delay: number) => {
        return setTimeout(async () => {
          if (ctx.stopped) return;
          await runMomentsCheck();
          if (ctx.stopped) return;
          const jitter = (Math.random() - 0.5) * 2 * MOMENTS_JITTER;
          ctx.momentsTimer = scheduleMoments(MOMENTS_CYCLE + jitter);
        }, delay);
      };

      // First discovery 5min after connect, first poll 10min, first moments 15min
      ctx.plazaDiscoveryTimer = scheduleDiscovery(5 * 60_000);
      ctx.plazaPollTimer = schedulePoll(10 * 60_000);
      ctx.momentsTimer = scheduleMoments(15 * 60_000);

      // Keep alive until abort — cleanup reads ctx so reconnect swaps are reflected
      // Handle already-aborted signal (e.g. abort fired during startup sync)
      if (abortSignal.aborted) {
        await cleanup();
        return;
      }

      return new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', async () => {
          await cleanup();
          resolve();
        }, { once: true });
      });
    },
  },

  resolver: {
    async resolveTargets({ inputs, kind }: {
      cfg: Record<string, any>;
      accountId?: string | null;
      inputs: string[];
      kind: 'user' | 'group';
      runtime?: any;
    }) {
      const results: Array<{ input: string; resolved: boolean; id?: string; name?: string; note?: string }> = [];

      // Find any connected account to use for API calls
      const actx = accounts.values().next().value as AccountContext | undefined;
      if (!actx) {
        for (const input of inputs) {
          results.push({ input, resolved: false, note: 'no connected account' });
        }
        return results;
      }

      try {
        const endpoint = kind === 'group' ? 'groups' : 'contacts';
        const res = await fetch(`${actx.humanApiUrl}/agent/${endpoint}`, {
          headers: { 'Authorization': `Basic ${actx.heartbeatAuth}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          for (const input of inputs) {
            results.push({ input, resolved: false, note: `API error: ${res.status}` });
          }
          return results;
        }
        const entries = await res.json() as any[];

        // Also fetch owner info for user resolution (owner is not in contacts list)
        let ownerInfo: { display_name?: string; tinode_uid?: string } | null = null;
        if (kind === 'user') {
          try {
            const ownerRes = await fetch(`${actx.humanApiUrl}/agent/owner`, {
              headers: { 'Authorization': `Basic ${actx.heartbeatAuth}` },
              signal: AbortSignal.timeout(5_000),
            });
            if (ownerRes.ok) ownerInfo = await ownerRes.json() as any;
          } catch { /* non-critical */ }
        }

        for (const input of inputs) {
          const trimmed = input.trim();
          if (!trimmed) {
            results.push({ input, resolved: false, note: 'empty input' });
            continue;
          }

          // Already a Tinode UID (usr...) or topic (grp...) — pass through
          if (/^(usr|grp)[A-Za-z0-9_-]+$/.test(trimmed)) {
            results.push({ input, resolved: true, id: trimmed });
            continue;
          }

          const normalized = trimmed.toLowerCase();

          if (kind === 'group') {
            // Match group by name or tinode_topic
            const match = entries.find((g: any) => {
              const name = (g.name || '').toLowerCase();
              const topic = (g.tinode_topic || '').toLowerCase();
              return normalized === name || normalized === topic;
            });
            if (match) {
              results.push({ input, resolved: true, id: match.tinode_topic, name: match.name });
            } else {
              results.push({ input, resolved: false, note: 'no matching group' });
            }
          } else {
            // Match contact by agent_name, alias, claw_name, display_name, or claw_id
            const match = entries.find((c: any) => {
              const fields = [
                c.contact_agent_name,
                c.alias,
                c.contact_claw_name,
                c.contact_display_name,
                c.contact_claw_id,
              ];
              return fields.some(f => f && f.toLowerCase() === normalized);
            });
            if (match && match.contact_tinode_uid) {
              results.push({
                input,
                resolved: true,
                id: match.contact_tinode_uid,
                name: match.contact_agent_name || match.alias || match.contact_claw_name,
              });
            } else if (ownerInfo?.tinode_uid && ownerInfo.display_name
                       && ownerInfo.display_name.toLowerCase() === normalized) {
              // Match owner by display name (owner is not in the contacts list)
              results.push({
                input,
                resolved: true,
                id: ownerInfo.tinode_uid,
                name: ownerInfo.display_name,
              });
            } else {
              results.push({ input, resolved: false, note: 'no matching contact' });
            }
          }
        }
      } catch (err: any) {
        for (const input of inputs) {
          if (!results.find(r => r.input === input)) {
            results.push({ input, resolved: false, note: `lookup failed: ${err.message}` });
          }
        }
      }

      return results;
    },
  },

  security: {
    resolveDmPolicy: () => ({
      policy: 'open',
      allowFromPath: 'channels.imclaw.allowFrom',
      approveHint: 'Add sender to channels.imclaw.allowFrom to allow DMs.',
    }),
  },
};

/**
 * Get the first active account ID, or undefined if none connected.
 */
export function getFirstAccountId(): string | undefined {
  const first = accounts.keys().next();
  return first.done ? undefined : first.value;
}

/**
 * Get the bridge for an account, for use by tools that need to send messages directly.
 */
export function getAccountBridge(accountId: string): ImclawBridge | undefined {
  return accounts.get(accountId)?.bridge;
}

/**
 * Get the cached owner Tinode UID for "owner" target resolution.
 */
export function getOwnerTinodeUid(accountId?: string): string | null {
  const ctx = findAccountContext(accountId);
  return ctx?.ownerTinodeUid ?? null;
}

/**
 * Get auth payload for a connected account, for tool-side API calls.
 */
export function getAccountAuth(accountId?: string | null): { auth: string; humanApiUrl: string } | null {
  const ctx = findAccountContext(accountId);
  if (!ctx) return null;
  if (ctx.stopped || ctx.authPaused) return null;
  return { auth: ctx.heartbeatAuth, humanApiUrl: ctx.humanApiUrl };
}

/**
 * Whether an account exists but is intentionally paused due to invalidated
 * credentials. Tool calls must not fall back to stale cached credentials in
 * this state.
 */
export function isAccountAuthPaused(accountId?: string | null): boolean {
  const ctx = findAccountContext(accountId);
  return !!ctx && (ctx.stopped || ctx.authPaused);
}

/**
 * Pause an account after an Agent API call proves credentials are invalid.
 * Heartbeat/reconnect logic will wait for a replacement connect key.
 */
export function pauseAccountAuth(accountId?: string | null, reason?: string): void {
  const ctx = findAccountContext(accountId);
  if (!ctx || ctx.authPaused || ctx.stopped) return;
  ctx.authPaused = true;
  ctx.log?.error?.(`[imclaw] account auth paused${reason ? `: ${reason}` : ''}`);
  try {
    void ctx.bridge.stop();
  } catch { /* ignore */ }
}

/**
 * Store reference to plugin config.
 * Called from plugin-entry.ts register() function.
 */
export function setPluginConfig(config: Record<string, unknown>): void {
  pluginLevelConfig = (config || {}) as Record<string, any>;
}

/**
 * Store the PluginRuntime from api.runtime.
 * This is the correct runtime for dispatching messages to agents.
 */
export function setPluginRuntime(runtime: PluginRuntime): void {
  pluginRuntime = runtime;
}

/**
 * Store plugin package version for profile/version sync and policy checks.
 */
export function setPluginVersion(version: string): void {
  pluginVersion = (version || '').trim() || '0.0.0';
}

function getPluginRuntime(): PluginRuntime | null {
  return pluginRuntime;
}
