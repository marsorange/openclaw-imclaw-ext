/**
 * Plugin-side runtime config: fetches /agent/runtime-config from human-api with
 * ETag-based caching. Falls back to baked defaults if the server is unreachable
 * or returns invalid data. Defensive clamps keep agent behavior sane even if
 * the server returns out-of-range values.
 *
 * Contract:
 * - Channel calls `refreshIfStale(apiFetch)` at the top of each autonomous loop
 *   iteration. Re-fetch happens only when cache exceeds CACHE_TTL_MS.
 * - Anywhere needing config (channel.ts, tools/*.ts) calls `getSnapshot()`
 *   synchronously — that returns the most recent good snapshot, or baked
 *   defaults if we have never successfully fetched.
 * - `renderPrompt(template, vars)` does plain "{key}" / "{ns.key}" substitution.
 *   Unknown placeholders are left as literal text — a visible signal that the
 *   YAML and the plugin disagree on which variables exist.
 */

const FIVE_MIN_MS = 5 * 60_000;
const TWENTY_FOUR_H_MS = 24 * 3600_000;
const CACHE_TTL_MS = 6 * 3600_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RuntimeParams {
  plaza: {
    discoveryCycleMs: number;
    discoveryJitterMs: number;
    firstDiscoveryDelayMs: number;
    pollCycleMs: number;
    pollJitterMs: number;
    firstPollDelayMs: number;
    warmupWindowMs: number;
    candidateSortLimits: { popular: number; newest: number; rising: number };
    proactiveCreateMaxCandidates: number;
    skipPattern: string;
    skipPatternFlags: string;
  };
  moments: {
    cycleMs: number;
    jitterMs: number;
    firstDelayMs: number;
    warmupWindowMs: number;
    dailyCap: number;
  };
  group: { staleMentionMs: number };
  dispatch: { maxChunkSize: number };
}

export interface RuntimePrompts {
  plaza: {
    prompts: { discovery: string; poll: string; create: string };
    toolGuidelines: string;
  };
  moments: { prompt: string; toolGuidelines: string };
  group: { replyRules: string };
  messaging: { toolGuidelines: string };
  /** Optional: 1:1 DM conversation contract (injected into UntrustedContext for direct chats only).
   *  Kept optional so plugin keeps running against an older human-api that doesn't serve this field. */
  direct?: { replyClosure?: string };
}

export interface RuntimeConfigSnapshot {
  version: string;
  params: RuntimeParams;
  prompts: RuntimePrompts;
}

// ─── Baked-in fallback (current hardcoded behavior, mirrors channel.ts) ──────

const BAKED_DEFAULTS: RuntimeConfigSnapshot = {
  version: 'baked',
  params: {
    plaza: {
      discoveryCycleMs: 12 * 3600_000,
      discoveryJitterMs: 30 * 60_000,
      firstDiscoveryDelayMs: 5 * 60_000,
      pollCycleMs: 12 * 3600_000,
      pollJitterMs: 30 * 60_000,
      firstPollDelayMs: 10 * 60_000,
      warmupWindowMs: 30 * 60_000,
      candidateSortLimits: { popular: 5, newest: 5, rising: 5 },
      proactiveCreateMaxCandidates: 2,
      skipPattern: '^(跳过|skip|pass|不感兴趣)',
      skipPatternFlags: 'i',
    },
    moments: {
      cycleMs: 24 * 3600_000,
      jitterMs: 60 * 60_000,
      firstDelayMs: 15 * 60_000,
      warmupWindowMs: 60 * 60_000,
      dailyCap: 3,
    },
    group: { staleMentionMs: 10 * 60_000 },
    dispatch: { maxChunkSize: 4000 },
  },
  prompts: {
    plaza: {
      prompts: {
        discovery: '[围炉煮茶 · 话题邀请]\n🔥 话题: {topic.name}\n讨论纲领: {topic.context}\n\n如果你有真正值得分享的观点，请直接回复；否则回复"跳过"。',
        poll: '[围炉煮茶 · 讨论进展] {topic.name}\n讨论纲领: {topic.context}\n\n最新讨论:\n{latestMessages}\n\n如果有新观点请回复，否则回复"跳过"。',
        create: '[围炉煮茶 · 发起话题]\n当前活跃话题较少（{candidatesCount} 个），你有 {creditsAvailable} 个创建额度。\n\n请用以下格式回复：\n话题标题: <标题>\n讨论纲领: <纲领>\n标签: <标签1>, <标签2>\n\n否则回复"跳过"。',
      },
      toolGuidelines: 'This is a public forum. Do not share credentials. Do not discuss politics. Respect others.',
    },
    moments: {
      prompt: '[IMClaw · Moments self-check]\nLast moment: {lastAtDescription}.\nPosts in last 24h: {dailyCount}/{dailyCap}.\nRecent active chats:\n{recentChats}\n\nPost only if you have new value, else reply: 跳过',
      toolGuidelines: 'Post a moment only when you have new useful observation, progress, or result. Never expose private chats or credentials.',
    },
    group: {
      replyRules: 'You are in an IMClaw multi-agent group chat. Apply these reply rules in priority order:\n1. If IsSummary=true on the incoming message, do NOT reply.\n2. Otherwise if MentionsMe=true on a fresh message, you must reply.\n3. Otherwise, reply only when you have substantive content from your own expertise.\nHard limit: you may not send more than 2 consecutive messages without another member speaking.',
    },
    messaging: {
      toolGuidelines: 'NEVER forward private chat content to groups without explicit consent. NEVER share owner personal details, API keys, or internal configurations in any chat.',
    },
    direct: {
      replyClosure: '你正在 IMClaw 1:1 对话里回应用户消息。即便已通过工具完成请求，也必须在本轮以一条对话回复收尾，告知用户做了什么。沉默会被用户理解为消息没收到。',
    },
  },
};

// ─── Defensive clamps ────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampParams(p: RuntimeParams): RuntimeParams {
  const d = BAKED_DEFAULTS.params;
  return {
    plaza: {
      discoveryCycleMs: clamp(p.plaza.discoveryCycleMs, FIVE_MIN_MS, TWENTY_FOUR_H_MS, d.plaza.discoveryCycleMs),
      discoveryJitterMs: clamp(p.plaza.discoveryJitterMs, 0, 3600_000, d.plaza.discoveryJitterMs),
      firstDiscoveryDelayMs: clamp(p.plaza.firstDiscoveryDelayMs, 0, TWENTY_FOUR_H_MS, d.plaza.firstDiscoveryDelayMs),
      pollCycleMs: clamp(p.plaza.pollCycleMs, FIVE_MIN_MS, TWENTY_FOUR_H_MS, d.plaza.pollCycleMs),
      pollJitterMs: clamp(p.plaza.pollJitterMs, 0, 3600_000, d.plaza.pollJitterMs),
      firstPollDelayMs: clamp(p.plaza.firstPollDelayMs, 0, TWENTY_FOUR_H_MS, d.plaza.firstPollDelayMs),
      warmupWindowMs: clamp(p.plaza.warmupWindowMs, 0, TWENTY_FOUR_H_MS, d.plaza.warmupWindowMs),
      candidateSortLimits: {
        popular: clamp(p.plaza.candidateSortLimits?.popular, 0, 50, d.plaza.candidateSortLimits.popular),
        newest: clamp(p.plaza.candidateSortLimits?.newest, 0, 50, d.plaza.candidateSortLimits.newest),
        rising: clamp(p.plaza.candidateSortLimits?.rising, 0, 50, d.plaza.candidateSortLimits.rising),
      },
      proactiveCreateMaxCandidates: clamp(p.plaza.proactiveCreateMaxCandidates, 0, 20, d.plaza.proactiveCreateMaxCandidates),
      skipPattern: typeof p.plaza.skipPattern === 'string' && p.plaza.skipPattern
        ? safeRegexString(p.plaza.skipPattern, d.plaza.skipPattern)
        : d.plaza.skipPattern,
      // Stay in sync with the server-side zod allowlist: g/y are rejected
      // because they make .test() stateful via lastIndex.
      skipPatternFlags: typeof p.plaza.skipPatternFlags === 'string' && /^[imsu]*$/.test(p.plaza.skipPatternFlags)
        ? p.plaza.skipPatternFlags
        : d.plaza.skipPatternFlags,
    },
    moments: {
      cycleMs: clamp(p.moments.cycleMs, FIVE_MIN_MS, TWENTY_FOUR_H_MS, d.moments.cycleMs),
      jitterMs: clamp(p.moments.jitterMs, 0, 3600_000, d.moments.jitterMs),
      firstDelayMs: clamp(p.moments.firstDelayMs, 0, TWENTY_FOUR_H_MS, d.moments.firstDelayMs),
      warmupWindowMs: clamp(p.moments.warmupWindowMs, 0, TWENTY_FOUR_H_MS, d.moments.warmupWindowMs),
      dailyCap: clamp(p.moments.dailyCap, 1, 50, d.moments.dailyCap),
    },
    group: { staleMentionMs: clamp(p.group.staleMentionMs, 0, TWENTY_FOUR_H_MS, d.group.staleMentionMs) },
    dispatch: { maxChunkSize: clamp(p.dispatch.maxChunkSize, 500, 8000, d.dispatch.maxChunkSize) },
  };
}

function safeRegexString(candidate: string, fallback: string): string {
  try { new RegExp(candidate); return candidate; } catch { return fallback; }
}

function isShapedLikeSnapshot(x: any): x is RuntimeConfigSnapshot {
  return !!x
    && typeof x === 'object'
    && typeof x.version === 'string'
    && x.params && typeof x.params === 'object'
    && x.prompts && typeof x.prompts === 'object'
    && x.params.plaza && x.params.moments && x.params.group && x.params.dispatch
    && x.prompts.plaza?.prompts && x.prompts.moments && x.prompts.group;
}

// ─── Module state ────────────────────────────────────────────────────────────

interface CachedState {
  snapshot: RuntimeConfigSnapshot;
  fetchedAt: number;       // monotonic ms (Date.now())
  source: 'server' | 'baked';
  lastError: string | null;
  skipRegex: RegExp;
}

let state: CachedState = {
  snapshot: BAKED_DEFAULTS,
  fetchedAt: 0,
  source: 'baked',
  lastError: null,
  skipRegex: new RegExp(BAKED_DEFAULTS.params.plaza.skipPattern, BAKED_DEFAULTS.params.plaza.skipPatternFlags),
};

// Internal: pending refresh promise dedup so concurrent loops don't all fire
let pendingRefresh: Promise<void> | null = null;

// Fetcher signature mirrors channel.ts apiFetch — pass null/undefined on error.
export type RuntimeConfigFetcher = (
  path: string,
  init?: RequestInit,
) => Promise<Response | null>;

// Optional logger; matches the shape of per-account `log` used elsewhere in
// the plugin. We only emit on version transitions so log volume stays bounded.
export type RuntimeConfigLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

function applySnapshot(raw: unknown, source: 'server' | 'baked'): void {
  if (!isShapedLikeSnapshot(raw)) {
    state.lastError = 'snapshot shape mismatch';
    return;
  }
  const clampedParams = clampParams(raw.params);
  let regex: RegExp;
  try { regex = new RegExp(clampedParams.plaza.skipPattern, clampedParams.plaza.skipPatternFlags); }
  catch { regex = new RegExp(BAKED_DEFAULTS.params.plaza.skipPattern, BAKED_DEFAULTS.params.plaza.skipPatternFlags); }
  state = {
    snapshot: { version: raw.version, params: clampedParams, prompts: raw.prompts },
    fetchedAt: Date.now(),
    source,
    lastError: null,
    skipRegex: regex,
  };
}

export function getSnapshot(): RuntimeConfigSnapshot {
  return state.snapshot;
}

export function getSkipRegex(): RegExp {
  return state.skipRegex;
}

export function getDiagnostics(): {
  version: string;
  source: string;
  ageMs: number;
  lastError: string | null;
} {
  return {
    version: state.snapshot.version,
    source: state.source,
    ageMs: state.fetchedAt === 0 ? -1 : Date.now() - state.fetchedAt,
    lastError: state.lastError,
  };
}

/**
 * Lazy refresh, stale-while-revalidate semantics:
 *  - Cache age < 6h and server-sourced → return immediately, no fetch.
 *  - Cache age ≥ 6h but still server-sourced → return immediately with the
 *    old snapshot, fire-and-forget a background refresh. Next call sees fresh.
 *    Trade one slightly-stale dispatch for not paying RTT latency on the hot
 *    path (group dispatches in particular).
 *  - source === 'baked' (cold start / never successfully fetched) → block on
 *    the fetch so the very first dispatch has real server config when available.
 */
export async function refreshIfStale(fetcher: RuntimeConfigFetcher, log?: RuntimeConfigLogger): Promise<void> {
  const age = state.fetchedAt === 0 ? Infinity : Date.now() - state.fetchedAt;
  if (state.source === 'server' && age < CACHE_TTL_MS) return;
  if (state.source === 'server') {
    // SWR: serve stale, refresh in background.
    forceRefresh(fetcher, log).catch(() => { /* error already captured in state.lastError */ });
    return;
  }
  // Cold start — must wait so the caller sees server config if it's reachable.
  await forceRefresh(fetcher, log);
}

export async function forceRefresh(fetcher: RuntimeConfigFetcher, log?: RuntimeConfigLogger): Promise<void> {
  if (pendingRefresh) {
    await pendingRefresh;
    return;
  }
  pendingRefresh = (async () => {
    const previousVersion = state.snapshot.version;
    try {
      const headers: Record<string, string> = {};
      if (state.snapshot.version && state.source === 'server') {
        headers['If-None-Match'] = `"${state.snapshot.version}"`;
      }
      const res = await fetcher('/agent/runtime-config', { headers });
      if (!res) {
        state.lastError = 'fetch returned null (network or auth issue)';
        return;
      }
      if (res.status === 304) {
        // Server says our cached version is still current — bump the freshness
        // timer so we don't immediately re-fetch on the next loop iteration.
        state.fetchedAt = Date.now();
        return;
      }
      if (!res.ok) {
        state.lastError = `HTTP ${res.status}`;
        log?.warn?.(`[imclaw-runtime-config] fetch failed: HTTP ${res.status}`);
        return;
      }
      const body = await res.json().catch(() => null);
      applySnapshot(body, 'server');
      if (state.snapshot.version !== previousVersion) {
        log?.info?.(`[imclaw-runtime-config] applied version=${state.snapshot.version} (was ${previousVersion})`);
      }
    } catch (err: any) {
      state.lastError = err?.message || String(err);
      log?.warn?.(`[imclaw-runtime-config] fetch error: ${state.lastError}`);
    } finally {
      pendingRefresh = null;
    }
  })();
  await pendingRefresh;
}

// ─── Prompt rendering ────────────────────────────────────────────────────────

/**
 * Substitutes {key} and {ns.key} (one level deep) with vars values.
 * Unknown placeholders are preserved as literal "{xxx}" so configuration drift
 * surfaces in the rendered prompt instead of silently producing empty text.
 */
export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}/g, (match, key: string) => {
    const parts = key.split('.');
    let value: any = vars;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return match; // preserve literal — visible drift signal
      }
    }
    return value === null || value === undefined ? match : String(value);
  });
}
