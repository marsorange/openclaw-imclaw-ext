import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_MEDIA_DIR = path.join(os.homedir(), '.openclaw', 'imclaw', 'media');

export function getMediaDir(customDir?: string): string {
  const dir = customDir || DEFAULT_MEDIA_DIR;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function downloadMedia(
  url: string,
  originalName: string,
  seqId: number,
  customDir?: string,
  trustedHosts?: string[],
): Promise<string | null> {
  try {
    // Validate URL to prevent SSRF — only allow http/https, block private IPs
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const host = parsed.hostname;
    // Allow downloads from trusted hosts (e.g. our own Tinode / IMClaw server)
    const isTrusted = trustedHosts?.some(th => host === th || host.endsWith(`.${th}`));
    if (!isTrusted && (
      host === 'localhost' || host.endsWith('.local') ||
      /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.)/.test(host) ||
      host === '::1')) {
      return null;
    }

    const dir = getMediaDir(customDir);
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${seqId}_${safeName}`;
    const filePath = path.join(dir, filename);

    // Skip if already downloaded
    if (fs.existsSync(filePath)) return filename;

    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) return null;

    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    return filename;
  } catch {
    return null;
  }
}

export function getMediaPath(filename: string, customDir?: string): string {
  return path.join(getMediaDir(customDir), filename);
}
