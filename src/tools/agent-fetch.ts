import { loadCredsCache, getHumanApiUrl, getAccountAuth } from '../channel.js';
import { getToolAccountId } from './tool-account-context.js';

export type ToolResult = { content: { type: 'text'; text: string }[]; details: unknown };

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], details: {} };
}

export function getAuth(): { auth: string; humanApiUrl: string } | null {
  const toolAccountId = getToolAccountId();
  const accountAuth = getAccountAuth(toolAccountId);
  if (accountAuth) return accountAuth;

  const fallbackAuth = getAccountAuth();
  if (fallbackAuth) return fallbackAuth;

  const cache = loadCredsCache();
  const entries = Object.values(cache);
  if (entries.length === 0) return null;
  const cred = entries[0];
  return {
    auth: Buffer.from(`${cred.username}:${cred.password}`).toString('base64'),
    humanApiUrl: getHumanApiUrl(),
  };
}

export async function agentFetch(
  path: string,
  opts?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<{ ok: boolean; data: any; status: number }> {
  const creds = getAuth();
  if (!creds) throw new Error('No cached IMClaw credentials. Complete setup first.');
  const headers: Record<string, string> = { 'Authorization': `Basic ${creds.auth}` };
  const init: RequestInit = {
    method: opts?.method ?? 'GET',
    headers,
    signal: opts?.signal ?? AbortSignal.timeout(15_000),
  };
  if (opts?.body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(`${creds.humanApiUrl}${path}`, init);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data, status: res.status };
}
