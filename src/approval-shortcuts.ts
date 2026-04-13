export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export interface ApprovalHint {
  approvalId: string;
  approvalSlug?: string;
  allowedDecisions: ApprovalDecision[];
}

const APPROVAL_LINE_RE = /Approval required \(id ([A-Za-z0-9._:-]+), full ([A-Za-z0-9._:-]+)\)\./i;
const REPLY_WITH_RE = /Reply with:\s*\/approve\s+([A-Za-z0-9._:-]+)\s+([A-Za-z-|]+)/i;
const APPROVAL_REQUIRED_RE = /Approval required(?:\.|\b)/i;
const FULL_ID_RE = /Full id:\s*([A-Za-z0-9._:-]+)/i;
const APPROVE_CMD_RE = /\/approve\s+([A-Za-z0-9._:-]+)\s+(allow-once|allow-always|deny)\b/ig;

function isLikelyFullApprovalId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function uniqueDecisions(values: ApprovalDecision[]): ApprovalDecision[] {
  const out: ApprovalDecision[] = [];
  for (const v of values) {
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function parseAllowedDecisions(raw: string): ApprovalDecision[] {
  const result: ApprovalDecision[] = [];
  for (const token of raw.split('|')) {
    const t = token.trim().toLowerCase();
    if (t === 'allow-once') result.push('allow-once');
    else if (t === 'allow-always') result.push('allow-always');
    else if (t === 'deny') result.push('deny');
  }
  return uniqueDecisions(result);
}

export function extractApprovalHintFromText(text: string): ApprovalHint | null {
  if (!text) return null;

  const approvalMatch = text.match(APPROVAL_LINE_RE);
  const replyMatch = text.match(REPLY_WITH_RE);
  const hasApprovalRequired = APPROVAL_REQUIRED_RE.test(text);
  const fullIdMatch = text.match(FULL_ID_RE);
  const approveCommands = [...text.matchAll(APPROVE_CMD_RE)];

  if (!approvalMatch && !replyMatch && !hasApprovalRequired && approveCommands.length === 0) return null;

  const approvalSlug = approvalMatch?.[1];
  const approvalIdFromLine = approvalMatch?.[2];
  const approvalIdFromReply = replyMatch?.[1];
  const approvalIdFromFullLine = fullIdMatch?.[1];
  const commandIds = approveCommands.map((m) => m[1]);
  const approvalIdFromCommands = commandIds.find(isLikelyFullApprovalId) || commandIds[0];
  const approvalId = approvalIdFromLine || approvalIdFromFullLine || approvalIdFromReply || approvalIdFromCommands;
  if (!approvalId) return null;

  const allowedFromCommands = uniqueDecisions(
    approveCommands
      .map((m) => m[2]?.toLowerCase())
      .flatMap((token): ApprovalDecision[] => (
        token === 'allow-once' || token === 'allow-always' || token === 'deny'
          ? [token]
          : []
      )),
  );
  const allowedFromReply = replyMatch ? parseAllowedDecisions(replyMatch[2]) : [];
  const fallbackAllowed: ApprovalDecision[] = ['allow-once', 'deny'];
  const allowedDecisions = allowedFromCommands.length > 0
    ? allowedFromCommands
    : (allowedFromReply.length > 0 ? allowedFromReply : fallbackAllowed);
  const inferredSlug = approvalSlug
    || commandIds.find((id) => id !== approvalId);

  return {
    approvalId,
    approvalSlug: inferredSlug,
    allowedDecisions: uniqueDecisions(allowedDecisions),
  };
}

function normalizeShortcutText(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[。.!！?？,，:：;；~～]+$/g, '')
    .trim();
}

const ALLOW_ONCE_PHRASES = new Set([
  'ok',
  'okay',
  'yes',
  'y',
  '同意',
  '确认',
  '批准',
  '允许',
  '允许一次',
  '继续',
  '执行',
  '通过',
]);

const ALLOW_ALWAYS_PHRASES = new Set([
  'always',
  'allow-always',
  '总是允许',
  '永久允许',
  '一直允许',
  '长期允许',
]);

const DENY_PHRASES = new Set([
  'deny',
  'no',
  'n',
  'reject',
  '拒绝',
  '不同意',
  '不允许',
  '取消',
  '停止',
]);

export function resolveApprovalShortcutDecision(
  inputText: string,
  allowedDecisions: readonly ApprovalDecision[],
): ApprovalDecision | null {
  const normalized = normalizeShortcutText(inputText);
  if (!normalized) return null;
  if (normalized.startsWith('/approve')) return null;

  let desired: ApprovalDecision | null = null;
  if (ALLOW_ONCE_PHRASES.has(normalized)) desired = 'allow-once';
  else if (ALLOW_ALWAYS_PHRASES.has(normalized)) desired = 'allow-always';
  else if (DENY_PHRASES.has(normalized)) desired = 'deny';

  if (!desired) return null;
  if (!allowedDecisions.includes(desired)) return null;
  return desired;
}
