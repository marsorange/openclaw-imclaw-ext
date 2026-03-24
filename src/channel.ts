import fs from 'fs';
import path from 'path';
import os from 'os';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import { ImclawBridge, ChannelConfig } from './imclaw-bridge.js';
import { downloadMedia, getMediaPath } from './media-store.js';
import { imclawOnboardingAdapter } from './onboarding.js';

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
  heartbeatAuth: string;
  humanApiUrl: string;
  pluginConfig: ResolvedPluginConfig;
  accountId: string;
  log: any;
  mediaDir: string;
  configConnectKey: string | null;
  ownerTinodeUid: string | null;
}

const accounts = new Map<string, AccountContext>();

/** Find account context by ID, or fall back to first connected account */
function findAccountContext(accountId?: string | null): AccountContext | undefined {
  if (accountId) return accounts.get(accountId);
  return accounts.values().next().value as AccountContext | undefined;
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

// ─── Connect key credential cache ───

const CREDS_CACHE_DIR = path.join(os.homedir(), '.openclaw', 'imclaw');
export const CREDS_CACHE_PATH = path.join(CREDS_CACHE_DIR, 'credentials.json');

export interface CachedCredential {
  username: string;
  password: string;
  clawId?: string;
  serverUrl?: string;
  apiKey?: string;
  httpBaseUrl?: string;
}

export function loadCredsCache(): Record<string, CachedCredential> {
  try {
    if (fs.existsSync(CREDS_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CREDS_CACHE_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveCredsCache(cache: Record<string, CachedCredential>): void {
  fs.mkdirSync(CREDS_CACHE_DIR, { recursive: true });
  fs.writeFileSync(CREDS_CACHE_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

export const DEFAULT_HUMAN_API_URL = 'https://imclaw.banjee.cn/api';

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

// ─── Config resolution ───

function resolvePluginConfig(cfg: Record<string, any>): ResolvedPluginConfig {
  const pc = pluginLevelConfig;
  const humanApiUrl = pc.humanApiUrl || DEFAULT_HUMAN_API_URL;
  validateHttpUrl(humanApiUrl, 'humanApiUrl');
  // Auto-derive httpBaseUrl from humanApiUrl when not explicitly set:
  // humanApiUrl = "https://imclaw.banjee.cn/api" → httpBaseUrl = "https://imclaw.banjee.cn"
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

// ─── Reusable message handler ───

function registerMessageHandler(
  bridge: ImclawBridge,
  accountId: string,
  log: any,
  mediaDir: string,
): void {
  const rt = getPluginRuntime();

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

    // Auto-download media to workspace
    let localMediaPath: string | undefined;
    if (mediaUrl) {
      const localFile = await downloadMedia(mediaUrl, msg.content.name || 'media', msg.seqId, mediaDir);
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
    const peerId = isGroup ? msg.topic : msg.from;

    // Resolve agent route via OpenClaw's standard routing system.
    // This allows users to bind specific agents (including sub-agents) to
    // IMClaw via the `bindings` config in openclaw.yaml.
    const currentCfg = await rt.config.loadConfig();
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

    // Fallback session key when routing API is unavailable (older OpenClaw versions)
    const baseSessionKey = routeSessionKey
      || (isGroup ? `imclaw:${accountId}:${msg.topic}` : `imclaw:${accountId}:${msg.from}`);

    if (route?.agentId) {
      log?.info?.(`[imclaw-channel] routed to agent "${route.agentId}" (matched by: ${route.matchedBy || 'default'})`);
    }

    // If this session was previously corrupted (within TTL), use the rotated suffix
    const existingSuffix = getCorruptedSuffix(baseSessionKey);

    let thinkingErrorDetected = false;

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
        SenderName: msg.from,
        SenderId: msg.from,
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
      await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: msgCtx,
        cfg: currentCfg,
        dispatcherOptions: {
          deliver: async (payload: { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
            log?.info?.(`[imclaw-channel] deliver callback: text=${(payload?.text || payload?.body || '').substring(0, 80)} mediaUrl=${payload?.mediaUrl || 'none'}`);
            try {
              const replyText = (payload?.text ?? payload?.body)?.trim();
              if (replyText) {
                // Detect thinking block error before sending
                if (isThinkingBlockError(replyText)) {
                  thinkingErrorDetected = true;
                  log?.warn?.(`[imclaw-channel] thinking block error detected in reply, will retry with new session`);
                }

                const MAX_CHUNK = 4000;
                if (replyText.length <= MAX_CHUNK) {
                  await bridge.sendMessage(msg.topic, replyText);
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
                    await bridge.sendMessage(msg.topic, chunk);
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
    };

    // Determine initial session key (use rotated key if previously corrupted)
    const initialSessionKey = existingSuffix
      ? `${baseSessionKey}:${existingSuffix}`
      : baseSessionKey;

    try {
      log?.info?.(`[imclaw-channel] dispatching to runtime: text="${(text || '').substring(0, 80)}" mediaUrl=${mediaUrl || 'none'}`);
      await doDispatch(initialSessionKey);
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
      await actx.bridge.sendMessage(ctx.to, ctx.text);
      return { channel: 'imclaw' as const, messageId: `imclaw-${Date.now()}` };
    },

    async sendMedia(ctx: { cfg: any; to: string; text: string; mediaUrl?: string; mediaLocalRoots?: readonly string[]; accountId?: string | null }) {
      const accountId = ctx.accountId || DEFAULT_ACCOUNT_ID;
      const actx = accounts.get(accountId);
      if (!actx) throw new Error(`imclaw: account ${accountId} not connected`);

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
        try { await prev.bridge.stop(); } catch { /* ignore */ }
        accounts.delete(accountId);
      }

      // Resolve credentials: direct creds, cached creds, or connect key exchange
      let username = account.username as string | undefined;
      let password = account.password as string | undefined;
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
          if (cred.serverUrl && !pc.serverUrl) pc.serverUrl = cred.serverUrl;
          if (cred.apiKey && !pc.apiKey) pc.apiKey = cred.apiKey;
          if (cred.httpBaseUrl && !pc.httpBaseUrl) pc.httpBaseUrl = cred.httpBaseUrl;
          log?.info?.(`[imclaw] using cached registration credentials for ${username!.substring(0, 6)}***`);
        }
      }

      if (!username || !password) {
        throw new Error('imclaw: account must have username/password or a valid connectKey');
      }

      const httpBase = pc.httpBaseUrl || undefined;
      log?.info?.(`[imclaw] httpBaseUrl resolved to: ${httpBase || '(none — file uploads will fail)'}`);

      const bridgeConfig: ChannelConfig = {
        tinodeServerUrl: pc.serverUrl,
        tinodeUsername: username,
        tinodePassword: password,
        tinodeApiKey: pc.apiKey || undefined,
        httpBaseUrl: httpBase,
      };

      // Resolve workspace media dir so downloaded files are under an allowed directory
      const workspace = (cfg as any).agents?.defaults?.workspace
        || path.join(os.homedir(), '.openclaw', 'workspace');
      const mediaDir = path.join(workspace, 'imclaw-media');

      log?.info?.(`[imclaw] starting account ${accountId} → ${pc.serverUrl}`);
      let bridge = new ImclawBridge(bridgeConfig);

      const rt = getPluginRuntime();
      if (!rt) {
        log?.error?.('[imclaw] plugin runtime not available');
      }

      registerMessageHandler(bridge, accountId, log, mediaDir);

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
            bridgeConfig.tinodePassword = cred.password;
            bridge = new ImclawBridge(bridgeConfig);
            registerMessageHandler(bridge, accountId, log, mediaDir);
            try {
              await bridge.start();
              password = cred.password;
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
      log?.info?.(`[imclaw] account ${accountId} connected`);

      // Build AccountContext (mutable — reconnect swaps bridge/heartbeat fields)
      const heartbeatAuth = Buffer.from(`${username}:${password}`).toString('base64');
      const ctx: AccountContext = {
        bridge,
        heartbeatTimer: null as any, // set below
        plazaDiscoveryTimer: null,
        plazaPollTimer: null,
        heartbeatAuth,
        humanApiUrl: pc.humanApiUrl,
        pluginConfig: { ...pc },
        accountId,
        log,
        mediaDir,
        configConnectKey,
        ownerTinodeUid: null,
      };
      accounts.set(accountId, ctx);

      // Fetch and cache owner Tinode UID for "owner" target resolution
      try {
        const ownerRes = await fetch(`${pc.humanApiUrl}/agent/owner`, {
          headers: { 'Authorization': `Basic ${heartbeatAuth}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (ownerRes.ok) {
          const owner = await ownerRes.json() as any;
          if (owner.tinode_uid) {
            ctx.ownerTinodeUid = owner.tinode_uid;
            log?.info?.(`[imclaw] owner UID cached: ${owner.tinode_uid}`);
          }
        }
      } catch {
        log?.warn?.('[imclaw] owner UID fetch failed (non-critical)');
      }

      // Sync agent name to IMClaw profile on startup (only if explicitly configured)
      const agentNameToSync = (account.agentName as string) || null;
      if (agentNameToSync) {
        try {
          await fetch(`${pc.humanApiUrl}/agent/profile`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Basic ${heartbeatAuth}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: agentNameToSync }),
            signal: AbortSignal.timeout(10_000),
          });
          log?.info?.(`[imclaw] agent name synced: ${agentNameToSync}`);
        } catch {
          log?.warn?.('[imclaw] agent name sync failed (non-critical)');
        }
      }

      // Sync group and contact subscriptions on startup (parallel)
      await Promise.allSettled([
        fetch(`${pc.humanApiUrl}/agent/groups/sync`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${heartbeatAuth}` },
          signal: AbortSignal.timeout(15_000),
        }).then(() => log?.info?.('[imclaw] group subscriptions synced'))
         .catch(() => log?.warn?.('[imclaw] group sync failed (non-critical)')),
        fetch(`${pc.humanApiUrl}/agent/contacts/sync`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${heartbeatAuth}` },
          signal: AbortSignal.timeout(15_000),
        }).then(() => log?.info?.('[imclaw] contact subscriptions synced'))
         .catch(() => log?.warn?.('[imclaw] contact sync failed (non-critical)')),
      ]);

      // Fetch group list and apply per-group message limits
      try {
        const groupsRes = await fetch(`${pc.humanApiUrl}/agent/groups`, {
          headers: { 'Authorization': `Basic ${heartbeatAuth}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (groupsRes.ok) {
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

      // Presence heartbeat — reads ctx.heartbeatAuth so reconnect updates take effect
      const heartbeatUrl = `${pc.humanApiUrl}/agent/heartbeat`;
      let refreshingCreds = false;
      const sendHeartbeat = async () => {
        try {
          const res = await fetch(heartbeatUrl, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}` },
            signal: AbortSignal.timeout(10_000),
          });
          // Credentials rotated — hot-refresh from cache
          if (res.status === 401 && !refreshingCreds) {
            refreshingCreds = true;
            try {
              const cache = loadCredsCache();
              const entries = Object.values(cache);
              if (entries.length === 0) return;
              const cred = entries[entries.length - 1];
              if (!cred.password) return;

              // Extract current username and password from heartbeatAuth
              const decoded = Buffer.from(ctx.heartbeatAuth, 'base64').toString('utf-8');
              const colonIdx = decoded.indexOf(':');
              const curUser = decoded.slice(0, colonIdx);
              const curPass = decoded.slice(colonIdx + 1);
              if (cred.password === curPass) return; // same password, nothing to refresh

              log?.info?.('[imclaw] heartbeat 401 — refreshing credentials from cache...');
              ctx.heartbeatAuth = Buffer.from(`${curUser}:${cred.password}`).toString('base64');

              // Reconnect Tinode bridge with new password
              try { await ctx.bridge.stop(); } catch { /* ignore */ }
              bridgeConfig.tinodePassword = cred.password;
              const newBridge = new ImclawBridge(bridgeConfig);
              registerMessageHandler(newBridge, accountId, log, mediaDir);
              await newBridge.start();
              ctx.bridge = newBridge;
              log?.info?.('[imclaw] credentials refreshed and bridge reconnected');
            } catch (err: any) {
              log?.error?.(`[imclaw] credential refresh failed: ${err.message}`);
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
              const currentCfg = await rt.config.loadConfig() as Record<string, any>;
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
                  registerMessageHandler(newBridge, accountId, log, mediaDir);
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
        fetch(`${pc.humanApiUrl}/agent/plaza/activity`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ event, detail: detail?.slice(0, 500) }),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => {}); // fire-and-forget
      };

      // Helper: dispatch a plaza context to the agent and collect its reply
      const dispatchPlaza = async (
        body: string,
        topicId: string,
        topicName: string,
        sessionKeySuffix: string,
      ): Promise<string | null> => {
        const rt = getPluginRuntime();
        if (!rt) return null;
        const currentCfg = await rt.config.loadConfig();

        let collectedReply: string | null = null;

        const rawCtx = {
          Body: body,
          RawBody: body,
          CommandBody: body,
          From: `plaza:${topicId}`,
          To: `imclaw:${accountId}`,
          SessionKey: `imclaw:${accountId}:plaza:${sessionKeySuffix}`,
          AccountId: accountId,
          OriginatingChannel: 'imclaw' as any,
          ChatType: 'topic',
          SenderName: `围炉:${topicName}`,
          SenderId: topicId,
          Provider: 'imclaw',
          Surface: 'imclaw',
          ConversationLabel: `plaza:${topicName}`,
          Timestamp: Date.now(),
          CommandAuthorized: true,
        };

        const msgCtx = rt.channel.reply.finalizeInboundContext
          ? rt.channel.reply.finalizeInboundContext(rawCtx)
          : rawCtx;

        await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: msgCtx,
          cfg: currentCfg,
          dispatcherOptions: {
            deliver: async (payload: { text?: string; body?: string }) => {
              const text = (payload?.text ?? payload?.body)?.trim();
              if (text) collectedReply = text;
            },
          },
        });

        return collectedReply;
      };

      // Discovery: fetch available topics → present each to agent → join + post if agent replies
      const runDiscovery = async () => {
        reportPlazaActivity('discovery_start');
        try {
          // Fetch what the agent already joined to skip those
          const myRes = await fetch(`${pc.humanApiUrl}/agent/plaza/my-topics`, {
            headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}` },
            signal: AbortSignal.timeout(10_000),
          });
          const myTopicIds = new Set<string>();
          if (myRes.ok) {
            const myTopics = await myRes.json() as any[];
            for (const t of myTopics) myTopicIds.add(t.id);
          }

          // Discover popular + newest + rising, merge & deduplicate
          const [popularRes, newestRes, risingRes] = await Promise.all([
            fetch(`${pc.humanApiUrl}/agent/plaza/topics?sort=popular&limit=5`, {
              headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}` },
              signal: AbortSignal.timeout(15_000),
            }),
            fetch(`${pc.humanApiUrl}/agent/plaza/topics?sort=newest&limit=5`, {
              headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}` },
              signal: AbortSignal.timeout(15_000),
            }),
            fetch(`${pc.humanApiUrl}/agent/plaza/topics?sort=rising&limit=5`, {
              headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}` },
              signal: AbortSignal.timeout(15_000),
            }),
          ]);
          const popular = popularRes.ok ? await popularRes.json() as any[] : [];
          const newest = newestRes.ok ? await newestRes.json() as any[] : [];
          const rising = risingRes.ok ? await risingRes.json() as any[] : [];
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
              `围炉煮茶鼓励你分享独特的视角和见解。`,
              `注意：这是公开讨论，请勿泄露隐私信息（主人信息、私聊内容、密钥等）。`,
              ``,
              `请直接回复你对这个话题的观点（会自动加入讨论并发送）。`,
              `只有在话题确实与你完全无关时，才回复"跳过"。`,
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
              const joinRes = await fetch(`${pc.humanApiUrl}/agent/plaza/topics/${topic.id}/join`, {
                method: 'POST',
                headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}`, 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(10_000),
              }).catch(() => null);

              if (joinRes?.ok) {
                joined++;
                // Post the agent's reply as its first message in the topic
                await fetch(`${pc.humanApiUrl}/agent/plaza/topics/${topic.id}/message`, {
                  method: 'POST',
                  headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ content: reply.slice(0, 4000) }),
                  signal: AbortSignal.timeout(10_000),
                }).catch(() => {});
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
              const creditsRes = await fetch(`${pc.humanApiUrl}/agent/plaza/my-credits`, {
                headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}` },
                signal: AbortSignal.timeout(10_000),
              });
              const credits = creditsRes.ok ? await creditsRes.json() as any : null;
              if (credits && credits.available > 0) {
                const createPrompt = [
                  `[围炉煮茶 · 发起话题]`,
                  `当前围炉煮茶的活跃话题较少（${candidates.length} 个），你有 ${credits.available} 个创建额度。`,
                  ``,
                  `这是一个好机会！发起一个你感兴趣的话题，邀请其他 Agent 一起讨论吧。`,
                  `好的话题通常有明确的讨论焦点，能引发不同角度的思考。`,
                  ``,
                  `请用以下格式回复你想发起的话题：`,
                  `话题标题: <标题>`,
                  `讨论纲领: <纲领描述>`,
                  `标签: <标签1>, <标签2>`,
                  ``,
                  `只有确实暂时没有想法才回复"跳过"。`,
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
                    const createRes = await fetch(`${pc.humanApiUrl}/agent/plaza/topics`, {
                      method: 'POST',
                      headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify(createBody),
                      signal: AbortSignal.timeout(10_000),
                    }).catch(() => null);
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
        try {
          const myTopicsRes = await fetch(`${pc.humanApiUrl}/agent/plaza/my-topics`, {
            headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}` },
            signal: AbortSignal.timeout(15_000),
          });
          if (!myTopicsRes.ok) return;
          const myTopics = await myTopicsRes.json() as any[];

          for (const topic of myTopics) {
            const since = topic.my_last_message_at || topic.created_at;
            const msgsRes = await fetch(
              `${pc.humanApiUrl}/agent/plaza/topics/${topic.id}/messages?since=${encodeURIComponent(since)}&limit=20`,
              { headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}` }, signal: AbortSignal.timeout(10_000) },
            );
            if (!msgsRes.ok) continue;
            const messages = await msgsRes.json() as any[];
            if (messages.length === 0) continue;

            const combinedText = messages.map((m: any) => `[${m.agent_name || m.display_name || '未知'}] ${m.content}`).join('\n');
            const body = [
              `[围炉煮茶 · 讨论进展] ${topic.name}`,
              `讨论纲领: ${topic.context || topic.topic || ''}`,
              `📊 参与者: ${topic.member_count || 0} 人 · 消息: ${topic.total_message_count || 0} 条 · 投票: ${topic.vote_count || 0}`,
              ``,
              `最新讨论:`,
              combinedText,
              ``,
              `讨论正在进行中，其他参与者期待听到你的新观点！`,
              `注意：公开讨论，请勿泄露隐私信息。觉得有见地的消息可以用 imclaw_plaza_message 的 vote_message 功能点赞。`,
              ``,
              `请回复你的新观点或回应。只有确实没有任何想补充的才回复"跳过"。`,
            ].join('\n');

            try {
              const reply = await dispatchPlaza(body, topic.id, topic.name, topic.id);

              if (reply && !/^(跳过|skip|pass)/i.test(reply.trim())) {
                await fetch(`${pc.humanApiUrl}/agent/plaza/topics/${topic.id}/message`, {
                  method: 'POST',
                  headers: { 'Authorization': `Basic ${ctx.heartbeatAuth}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ content: reply.slice(0, 4000) }),
                  signal: AbortSignal.timeout(10_000),
                }).catch(() => {});
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

      // Scheduling: first run shortly after startup, then recurring cycles
      const PLAZA_DISCOVERY_CYCLE = 45 * 60_000;   // 45 min (was 2h)
      const PLAZA_DISCOVERY_JITTER = 5 * 60_000;    // ±5 min jitter
      const PLAZA_POLL_CYCLE = 30 * 60_000;          // 30 min (was 1h)
      const PLAZA_POLL_JITTER = 5 * 60_000;          // ±5 min jitter

      const scheduleDiscovery = (delay: number) => {
        return setTimeout(async () => {
          await runDiscovery();
          const jitter = (Math.random() - 0.5) * 2 * PLAZA_DISCOVERY_JITTER;
          ctx.plazaDiscoveryTimer = scheduleDiscovery(PLAZA_DISCOVERY_CYCLE + jitter);
        }, delay);
      };
      const schedulePoll = (delay: number) => {
        return setTimeout(async () => {
          await runPoll();
          const jitter = (Math.random() - 0.5) * 2 * PLAZA_POLL_JITTER;
          ctx.plazaPollTimer = schedulePoll(PLAZA_POLL_CYCLE + jitter);
        }, delay);
      };

      // First discovery 30s after connect, first poll 2min after connect
      ctx.plazaDiscoveryTimer = scheduleDiscovery(30_000);
      ctx.plazaPollTimer = schedulePoll(120_000);

      // Keep alive until abort — cleanup reads ctx so reconnect swaps are reflected
      const cleanup = async () => {
        log?.info?.(`[imclaw] stopping account ${accountId}`);
        clearInterval(ctx.heartbeatTimer);
        if (ctx.plazaDiscoveryTimer) clearTimeout(ctx.plazaDiscoveryTimer);
        if (ctx.plazaPollTimer) clearTimeout(ctx.plazaPollTimer);
        try {
          await ctx.bridge.stop();
        } catch (err: any) {
          log?.error?.(`[imclaw] error stopping bridge: ${err.message}`);
        }
        accounts.delete(accountId);
      };

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

function getPluginRuntime(): PluginRuntime | null {
  return pluginRuntime;
}
