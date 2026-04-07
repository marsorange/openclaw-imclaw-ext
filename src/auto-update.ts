import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { DEFAULT_HUMAN_API_URL } from './defaults.js';

interface PluginPolicyResponse {
  minimumVersion?: string | null;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_JITTER_MS = 30 * 60 * 1000;
const STARTUP_DELAY_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

let activeApi: OpenClawPluginApi | null = null;
let activeVersion = '0.0.0';
let timer: NodeJS.Timeout | null = null;
let started = false;

function parseVersion(version: string): { main: number[]; pre: string[] } | null {
  const trimmed = version.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.+)?$/.exec(trimmed);
  if (!match) return null;
  return {
    main: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNum = /^\d+$/.test(left) ? Number(left) : null;
  const rightNum = /^\d+$/.test(right) ? Number(right) : null;
  if (leftNum !== null && rightNum !== null) return leftNum - rightNum;
  if (leftNum !== null) return -1;
  if (rightNum !== null) return 1;
  return left.localeCompare(right);
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return left.localeCompare(right, undefined, { numeric: true });

  for (let i = 0; i < 3; i++) {
    const diff = a.main[i] - b.main[i];
    if (diff !== 0) return diff;
  }

  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;

  const maxLen = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < maxLen; i++) {
    const leftPart = a.pre[i];
    const rightPart = b.pre[i];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const diff = compareIdentifiers(leftPart, rightPart);
    if (diff !== 0) return diff;
  }
  return 0;
}

function scheduleNext(delayMs: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void runCheck();
  }, Math.max(delayMs, 60_000));
}

function recurringDelay(): number {
  const jitter = Math.round((Math.random() - 0.5) * 2 * CHECK_JITTER_MS);
  return CHECK_INTERVAL_MS + jitter;
}

async function resolveHumanApiUrl(): Promise<string> {
  const runtimeConfig = activeApi?.runtime
    ? await Promise.resolve(activeApi.runtime.config.loadConfig() as Record<string, any>)
    : null;
  const value = runtimeConfig?.plugins?.entries?.imclaw?.config?.humanApiUrl
    || activeApi?.pluginConfig?.humanApiUrl
    || DEFAULT_HUMAN_API_URL;
  const parsed = new URL(value);
  return parsed.toString().replace(/\/$/, '');
}

async function runCheck(): Promise<void> {
  try {
    if (!activeApi) return;
    const logger = activeApi.logger ?? console;
    const humanApiUrl = await resolveHumanApiUrl();
    const res = await fetch(`${humanApiUrl}/public/plugin-policy`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn?.(`[imclaw] plugin policy check failed: HTTP ${res.status}`);
      return;
    }
    const policy = await res.json() as PluginPolicyResponse;
    const minimumVersion = policy.minimumVersion?.trim() || null;

    if (!minimumVersion) return;
    if (compareVersions(activeVersion, minimumVersion) < 0) {
      logger.warn?.(
        `[imclaw] plugin upgrade required: current=${activeVersion}, minimum=${minimumVersion}. ` +
        `Please run: openclaw plugins update imclaw && openclaw gateway restart`,
      );
    }
  } catch (err: any) {
    (activeApi?.logger ?? console).warn?.(`[imclaw] plugin policy check error: ${err.message}`);
  } finally {
    scheduleNext(recurringDelay());
  }
}

/**
 * Version policy check loop.
 *
 * This intentionally does NOT auto-update plugins. It only checks whether
 * the current plugin version satisfies server policy and logs a manual action hint.
 */
export function startPluginPolicyCheckLoop(api: OpenClawPluginApi, currentVersion: string): void {
  activeApi = api;
  activeVersion = currentVersion || '0.0.0';
  if (started) return;
  started = true;
  scheduleNext(STARTUP_DELAY_MS);
}

// Backward compatibility alias.
export const startAutoUpdateLoop = startPluginPolicyCheckLoop;
