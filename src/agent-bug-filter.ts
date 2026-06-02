const HARD_BLOCK_PATTERNS = [
  /not enough credits/i,
  /insufficient[_\s-]?credits?/i,
  /insufficient[_\s-]?balance/i,
  /insufficient[_\s-]?quota/i,
  /you exceeded your current quota/i,
  /allocated quota exceeded/i,
  /free allocated quota exceeded/i,
  /maximum billing reached for this api key/i,
  /account has reached its billing limit/i,
  /您当月的token赠送额度已经消耗完毕/i,
  /stepclaw订阅功能/i,
  /账户余额已用完|余额不足|账户已欠费|欠费停服/i,
  /计费资源已耗尽|资源包余量已用尽|免费资源包余量已用尽/i,
  /OAuth token refresh failed/i,
  /Agent failed before reply/i,
  /Agent couldn't generate a response/i,
  /context[_\s-]?limit[_\s-]?exceeded/i,
  /context[_\s-]?overflow/i,
  /prompt too (?:large|long) for/i,
  /token[_\s-]?limit[_\s-]?(?:exceeded|reached)/i,
  /max(?:imum)?[_\s-]?(?:context|token).*(?:exceeded|reached|limit)/i,
  /compaction[_\s-]?(?:buffer|reserve)/i,
  /reserveTokensFloor/i,
  /try\s*\/(?:reset|new)/i,
  /increase.*compaction/i,
  /start\s*(?:a\s*)?fresh\s*(?:session|conversation)/i,
  /reset.*(?:our|this)\s*(?:conversation|session)/i,
  /this model.*maximum context length/i,
  /上下文.*(?:溢出|超限|过长)/i,
  /⚠️\s*context/i,
  // OpenClaw runtime user-facing model-failure fallback strings — mirrors the
  // *_USER_MESSAGE constants in pi-embedded-helpers/errors.ts. The structured
  // `payload.isError` gate in channel.ts is the primary defense; these are the
  // backstop for any path that doesn't carry the flag (and older runtimes).
  /api rate limit reached/i,
  /returned a billing error/i,
  /the ai service is temporarily overloaded/i,
  /the ai service returned an error/i,
];

const PROVIDER_CODE_PATTERNS = [
  /statuscode["']?\s*[:=]\s*1400010161/i,
  /statusmessage["']?\s*[:=]\s*"not enough credits"/i,
  /resourceunavailable\.lowbalance/i,
  /resourceunavailable\.inarrears/i,
  /failedoperation\.freeresourcepackexhausted/i,
  /failedoperation\.resourcepackexhausted/i,
  /resourceinsufficient\.chargeresourceexhaust/i,
  /\bquota(limit)?exceeded\b/i,
];

const WEAK_STANDALONE_PATTERNS = [
  /^request was aborted\.?$/i,
  /^abort(ed)?\.?$/i,
  /^the model is overloaded\.?$/i,
  /^model overloaded\.?$/i,
  /^resource has been exhausted \(e\.g\. check quota\)\.?$/i,
  /^request timed out before a response was generated/i,
];

const QUOTA_LIKE_PATTERNS = [
  /\bquota\b/i,
  /\bcredits?\b/i,
  /\bbalance\b/i,
  /\bresource(?:[_\s-]?exhausted)?\b/i,
  /\bRESOURCE_EXHAUSTED\b/i,
  /配额|额度|余额|欠费|资源包|免费额度/i,
];

const ERROR_CONTEXT_PATTERNS = [
  /\bhttp\s*5\d{2}\b/i,
  /\b(?:429|402|403)\b/i,
  /\btoo many requests\b/i,
  /\bthrottling(?:exception|\.allocationquota)?\b/i,
  /\bservicequotaexceededexception\b/i,
  /\brequest limit exceeded\b/i,
  /exceeded (the )?account quotas/i,
  /you exceeded your current requests list/i,
  /\berror\b/i,
  /"error"\s*:/i,
  /\bstatus(code|message)\b/i,
];

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function looksLikeErrorDump(text: string): boolean {
  return /^\s*\{/.test(text)
    || /\b\d{3}\s*\{/.test(text)
    || /"error"\s*:\s*\{/.test(text)
    || /http\s*5\d{2}/i.test(text);
}

/**
 * Rule-based filter for upstream agent/runtime failure texts which should not be
 * delivered into user chats.
 */
export function shouldSuppressAgentBugText(rawText: string): boolean {
  const text = normalize(rawText);
  if (!text) return false;

  if (hasAny(text, HARD_BLOCK_PATTERNS)) return true;
  if (hasAny(text, PROVIDER_CODE_PATTERNS)) return true;
  if (hasAny(text, WEAK_STANDALONE_PATTERNS)) return true;

  const hasQuotaLike = hasAny(text, QUOTA_LIKE_PATTERNS);
  const hasErrorContext = hasAny(text, ERROR_CONTEXT_PATTERNS) || looksLikeErrorDump(text);

  if (hasQuotaLike && hasErrorContext) return true;
  return false;
}
