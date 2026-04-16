function normalizeDomain(input: string | undefined): string {
  const raw = (input || '').trim();
  if (!raw) return 'imclaw.net';
  return raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

const domain = normalizeDomain(process.env.IMCLAW_DOMAIN);

export const DEFAULT_HUMAN_API_URL = process.env.IMCLAW_HUMAN_API_URL || `https://${domain}/api`;
