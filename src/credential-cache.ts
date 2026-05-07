import fs from 'fs';
import path from 'path';
import os from 'os';

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

export function saveCredsCache(cache: Record<string, CachedCredential>): void {
  fs.mkdirSync(CREDS_CACHE_DIR, { recursive: true });
  fs.writeFileSync(CREDS_CACHE_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 });
}
