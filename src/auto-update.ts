import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { DEFAULT_HUMAN_API_URL } from './defaults.js';

const execAsync = promisify(exec);
const AUTO_UPDATE_DIR = path.join(os.homedir(), '.openclaw', 'imclaw');
const AUTO_UPDATE_STATE_PATH = path.join(AUTO_UPDATE_DIR, 'auto-update-state.json');
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_JITTER_MS = 30 * 60 * 1000;
const MAX_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 2 * 60 * 1000;
const UPDATE_ATTEMPT_BACKOFF_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

interface AutoUpdateState {
  lastCheckedAt?: number;
  lastAttemptedUpdateAt?: number;
  lastSuccessfulUpdateAt?: number;
  lastSeenMinimumVersion?: string | null;
  lastError?: string | null;
}

interface PluginPolicyResponse {
  minimumVersion?: string | null;
}

let activeApi: OpenClawPluginApi | null = null;
let activeVersion = '0.0.0';
let timer: NodeJS.Timeout | null = null;
let loopStarted = false;
let checkInFlight = false;

function readState(): AutoUpdateState {
  try {
    if (!fs.existsSync(AUTO_UPDATE_STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(AUTO_UPDATE_STATE_PATH, 'utf-8')) as AutoUpdateState;
  } catch {
    return {};
  }
}

function writeState(next: AutoUpdateState): void {
  fs.mkdirSync(AUTO_UPDATE_DIR, { recursive: true });
  fs.writeFileSync(AUTO_UPDATE_STATE_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
}

function scheduleNext(delayMs: number): void {
  if (timer) clearTimeout(timer);
  const boundedDelay = Math.min(Math.max(delayMs, 60_000), MAX_CHECK_INTERVAL_MS);
  timer = setTimeout(() => {
    void runCheck();
  }, boundedDelay);
}

function computeRecurringDelay(): number {
  const jitter = Math.round((Math.random() - 0.5) * 2 * CHECK_JITTER_MS);
  return CHECK_INTERVAL_MS + jitter;
}

function computeInitialDelay(state: AutoUpdateState): number {
  const now = Date.now();
  const lastCheckedAt = state.lastCheckedAt ?? 0;
  const elapsed = now - lastCheckedAt;
  if (!lastCheckedAt || elapsed >= CHECK_INTERVAL_MS) return STARTUP_DELAY_MS;
  return Math.min(CHECK_INTERVAL_MS - elapsed, MAX_CHECK_INTERVAL_MS);
}

function getLogger() {
  return activeApi?.logger ?? console;
}

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

function getOpenClawBin(): string {
  return process.env.OPENCLAW_BIN || 'openclaw';
}

function shellQuote(arg: string): string {
  if (process.platform === 'win32') {
    if (/[\s"&|<>^%!]/.test(arg)) return `"${arg.replace(/"/g, '\\"')}"`;
    return arg;
  }
  if (/[\s"'\\$`!#&|;<>(){}[\]*?~]/.test(arg)) return `'${arg.replace(/'/g, "'\\''")}'`;
  return arg;
}

async function fetchPolicy(humanApiUrl: string): Promise<PluginPolicyResponse> {
  const res = await fetch(`${humanApiUrl}/public/plugin-policy`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`plugin policy fetch failed: HTTP ${res.status}`);
  }
  return res.json() as Promise<PluginPolicyResponse>;
}

async function runOpenClaw(args: string[], timeout: number): Promise<void> {
  const command = [getOpenClawBin(), ...args.map(shellQuote)].join(' ');
  await execAsync(command, {
    timeout,
    windowsHide: true,
  });
}

function scheduleGatewayRestart(): void {
  const child = spawn(getOpenClawBin(), ['gateway', 'restart'], {
    detached: true,
    shell: process.platform === 'win32',
    stdio: 'ignore',
  });
  child.on('error', (err) => {
    getLogger().error?.(`[imclaw] gateway restart command failed: ${err.message}`);
  });
  child.unref();
}

async function runCheck(): Promise<void> {
  if (!activeApi || checkInFlight) {
    scheduleNext(computeRecurringDelay());
    return;
  }

  checkInFlight = true;
  const state = readState();
  const logger = getLogger();
  const now = Date.now();

  try {
    const humanApiUrl = await resolveHumanApiUrl();
    const policy = await fetchPolicy(humanApiUrl);
    const minimumVersion = policy.minimumVersion?.trim() || null;

    state.lastCheckedAt = now;
    state.lastSeenMinimumVersion = minimumVersion;
    state.lastError = null;
    writeState(state);

    if (!minimumVersion) {
      logger.info?.('[imclaw] auto-update check: no minimum version configured');
      return;
    }

    if (compareVersions(activeVersion, minimumVersion) >= 0) {
      logger.info?.(`[imclaw] auto-update check: current version ${activeVersion} satisfies minimum ${minimumVersion}`);
      return;
    }

    if (state.lastAttemptedUpdateAt && now - state.lastAttemptedUpdateAt < UPDATE_ATTEMPT_BACKOFF_MS) {
      logger.warn?.(`[imclaw] auto-update pending: current ${activeVersion}, minimum ${minimumVersion}, waiting for retry window`);
      return;
    }

    logger.warn?.(`[imclaw] auto-update required: current ${activeVersion}, minimum ${minimumVersion}`);
    state.lastAttemptedUpdateAt = now;
    writeState(state);

    await runOpenClaw(['plugins', 'update', 'imclaw'], 10 * 60 * 1000);

    state.lastSuccessfulUpdateAt = Date.now();
    state.lastError = null;
    writeState(state);

    logger.warn?.('[imclaw] plugin updated successfully, restarting gateway to load the new version');
    scheduleGatewayRestart();
  } catch (err: any) {
    state.lastCheckedAt = now;
    state.lastError = err?.message || String(err);
    writeState(state);
    logger.error?.(`[imclaw] auto-update check failed: ${state.lastError}`);
  } finally {
    checkInFlight = false;
    scheduleNext(computeRecurringDelay());
  }
}

export function startAutoUpdateLoop(api: OpenClawPluginApi, currentVersion: string): void {
  activeApi = api;
  activeVersion = currentVersion;

  if (loopStarted) return;
  loopStarted = true;

  const initialDelay = computeInitialDelay(readState());
  getLogger().info?.(`[imclaw] auto-update loop started, first check in ${Math.round(initialDelay / 60_000)} minute(s)`);
  scheduleNext(initialDelay);
}
