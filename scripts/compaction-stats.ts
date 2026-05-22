#!/usr/bin/env node
/**
 * compaction-stats.ts — IMClaw runtime compaction observation script.
 *
 * Reads the OpenClaw agent session store(s) at ~/.openclaw/agents/<agent>/sessions/sessions.json,
 * classifies each session by IMClaw sessionKey pattern, and reports per-bucket
 * statistics (compactionCount / token usage / freshness).
 *
 * Purpose: feed Phase 2 decision (see docs/imclaw-channel-refactor.md).
 *
 *   - Plaza & Moments are the natural A/B control group — they have never used seg-N,
 *     so they rely entirely on runtime compaction. Their compactionCount tells us
 *     whether runtime compaction is firing under IMClaw's traffic pattern.
 *   - DM & Group currently rotate via seg-N. We compare their token profile against
 *     the controls to decide whether to raise the seg-N threshold (Phase 2A) or
 *     leave it as a safety net while we fix the compaction config (Phase 2B).
 *
 * Usage:
 *   npx tsx scripts/compaction-stats.ts            # human-readable report
 *   npx tsx scripts/compaction-stats.ts --json     # JSON output (for piping)
 *   npx tsx scripts/compaction-stats.ts --agent main --agent worker-1
 *                                                  # restrict to specific agent dirs
 *   OPENCLAW_HOME=/path/to/.openclaw npx tsx scripts/compaction-stats.ts
 *                                                  # override store root
 *
 * Read-only — never writes to disk. Safe to run on production hosts.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

type SessionEntry = {
  sessionId?: string;
  updatedAt?: number;
  sessionStartedAt?: number;
  lastInteractionAt?: number;
  compactionCount?: number;
  memoryFlushCompactionCount?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  chatType?: string;
  model?: string;
  modelProvider?: string;
  totalTokensFresh?: boolean;
  [k: string]: unknown;
};

type BucketName = 'dm' | 'group' | 'plaza' | 'moments' | 'other-imclaw' | 'non-imclaw';

interface Classification {
  bucket: BucketName;
  hasSegSuffix: boolean;       // true if sessionKey carries :seg-N or :manual-N or :rs-<ts>
  segDetail?: string;
}

function classifySessionKey(sessionKey: string): Classification {
  // Match the actual session-key shapes observed in the on-disk store.
  // The OpenClaw runtime sometimes prefixes channel-supplied keys with
  // `agent:<agentId>:`, so we accept both rooted forms.
  //
  // DM:      agent:<agentId>:imclaw:<accountId>:dm:<typedPeerId>[:<seg-suffix>]
  // Group:   agent:<agentId>:imclaw:group:<topic>[:<seg-suffix>]
  // Plaza:   agent:<agentId>:imclaw:<accountId>:plaza:<subpath>  (runtime-prefixed form)
  //          imclaw:<accountId>:plaza:<subpath>                  (raw dispatchInternal form)
  // Moments: agent:<agentId>:imclaw:<accountId>:moments:autopilot (prefixed)
  //          imclaw:<accountId>:moments:autopilot                 (raw)
  //
  // <seg-suffix> can be:
  //   :manual-<seq>-seg-<n>   (both boundary + seg cap, joined with '-')
  //   :manual-<seq>           (boundary only)
  //   :seg-<n>                (seg cap only)
  //   :rs-<ts>                (corrupted-session safety net rotation)
  const segMatch = sessionKey.match(/:(manual-\d+(?:-seg-\d+)?|seg-\d+|rs-\d+)$/);
  const hasSegSuffix = !!segMatch;
  const segDetail = segMatch?.[1];

  if (/^agent:[^:]+:imclaw:[^:]+:dm:/.test(sessionKey)) {
    return { bucket: 'dm', hasSegSuffix, segDetail };
  }
  if (/^agent:[^:]+:imclaw:group:/.test(sessionKey)) {
    return { bucket: 'group', hasSegSuffix, segDetail };
  }
  if (/^(?:agent:[^:]+:)?imclaw:[^:]+:plaza:/.test(sessionKey)) {
    return { bucket: 'plaza', hasSegSuffix: false };
  }
  if (/^(?:agent:[^:]+:)?imclaw:[^:]+:moments:/.test(sessionKey)) {
    return { bucket: 'moments', hasSegSuffix: false };
  }
  // Legacy IMClaw shapes (e.g. agent:main:imclaw:direct:usr*) still useful to surface.
  if (/imclaw/i.test(sessionKey)) {
    return { bucket: 'other-imclaw', hasSegSuffix };
  }
  return { bucket: 'non-imclaw', hasSegSuffix: false };
}

interface BucketStats {
  count: number;
  withCompactions: number;      // entries where compactionCount > 0
  totalCompactions: number;
  maxCompactions: number;
  maxTotalTokens: number;
  avgTotalTokens: number;       // mean across entries with totalTokens > 0
  hotEntries: Array<{           // top 5 by totalTokens
    sessionKey: string;
    totalTokens: number;
    compactionCount: number;
    contextTokens: number;
    contextUtilizationPct: number;
    updatedAtIso: string;
    model?: string;
    segDetail?: string;
  }>;
  // Sessions where token usage is high but compaction never fired — a red flag for
  // Phase 2B (compaction is misconfigured or token reporting is broken).
  suspiciousHighTokenZeroCompaction: Array<{
    sessionKey: string;
    totalTokens: number;
    contextTokens: number;
    contextUtilizationPct: number;
    updatedAtIso: string;
  }>;
}

function emptyStats(): BucketStats {
  return {
    count: 0,
    withCompactions: 0,
    totalCompactions: 0,
    maxCompactions: 0,
    maxTotalTokens: 0,
    avgTotalTokens: 0,
    hotEntries: [],
    suspiciousHighTokenZeroCompaction: [],
  };
}

interface AgentReport {
  agent: string;
  storePath: string;
  totalEntries: number;
  buckets: Record<BucketName, BucketStats>;
  generatedAt: string;
}

const BUCKET_ORDER: BucketName[] = ['dm', 'group', 'plaza', 'moments', 'other-imclaw', 'non-imclaw'];

// Heuristic: "high token, never compacted" is suspicious when token usage
// exceeds 60% of the model's context window. (Tunable.)
const SUSPICIOUS_UTILIZATION_THRESHOLD = 0.60;

function buildBucketStats(entries: Array<{ key: string; entry: SessionEntry; cls: Classification }>): BucketStats {
  const stats = emptyStats();
  stats.count = entries.length;
  if (entries.length === 0) return stats;

  let tokenSum = 0;
  let tokenSamples = 0;

  for (const { entry } of entries) {
    const cc = entry.compactionCount ?? 0;
    if (cc > 0) {
      stats.withCompactions++;
      stats.totalCompactions += cc;
      if (cc > stats.maxCompactions) stats.maxCompactions = cc;
    }
    const tt = entry.totalTokens ?? 0;
    if (tt > 0) {
      tokenSum += tt;
      tokenSamples++;
      if (tt > stats.maxTotalTokens) stats.maxTotalTokens = tt;
    }
  }

  stats.avgTotalTokens = tokenSamples > 0 ? Math.round(tokenSum / tokenSamples) : 0;

  // Hot entries: top 5 by totalTokens.
  const sortedByTokens = entries
    .filter(({ entry }) => (entry.totalTokens ?? 0) > 0)
    .sort((a, b) => (b.entry.totalTokens ?? 0) - (a.entry.totalTokens ?? 0))
    .slice(0, 5);
  stats.hotEntries = sortedByTokens.map(({ key, entry, cls }) => {
    const tt = entry.totalTokens ?? 0;
    const ctx = entry.contextTokens ?? 0;
    return {
      sessionKey: key,
      totalTokens: tt,
      compactionCount: entry.compactionCount ?? 0,
      contextTokens: ctx,
      contextUtilizationPct: ctx > 0 ? Math.round((tt / ctx) * 1000) / 10 : 0,
      updatedAtIso: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : 'n/a',
      model: typeof entry.model === 'string' ? entry.model : undefined,
      segDetail: cls.segDetail,
    };
  });

  // Suspicious: high token utilization but zero compactions.
  stats.suspiciousHighTokenZeroCompaction = entries
    .filter(({ entry }) => {
      const tt = entry.totalTokens ?? 0;
      const ctx = entry.contextTokens ?? 0;
      const cc = entry.compactionCount ?? 0;
      return cc === 0 && ctx > 0 && tt / ctx >= SUSPICIOUS_UTILIZATION_THRESHOLD;
    })
    .sort((a, b) => (b.entry.totalTokens ?? 0) - (a.entry.totalTokens ?? 0))
    .slice(0, 10)
    .map(({ key, entry }) => {
      const tt = entry.totalTokens ?? 0;
      const ctx = entry.contextTokens ?? 0;
      return {
        sessionKey: key,
        totalTokens: tt,
        contextTokens: ctx,
        contextUtilizationPct: ctx > 0 ? Math.round((tt / ctx) * 1000) / 10 : 0,
        updatedAtIso: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : 'n/a',
      };
    });

  return stats;
}

function analyzeAgentStore(agent: string, storePath: string): AgentReport | null {
  let raw: string;
  try {
    raw = fs.readFileSync(storePath, 'utf-8');
  } catch (err: any) {
    console.error(`[compaction-stats] skip ${agent} — cannot read ${storePath}: ${err?.message ?? err}`);
    return null;
  }
  let store: Record<string, SessionEntry>;
  try {
    store = JSON.parse(raw);
  } catch (err: any) {
    console.error(`[compaction-stats] skip ${agent} — parse error on ${storePath}: ${err?.message ?? err}`);
    return null;
  }

  const grouped: Record<BucketName, Array<{ key: string; entry: SessionEntry; cls: Classification }>> = {
    'dm': [], 'group': [], 'plaza': [], 'moments': [], 'other-imclaw': [], 'non-imclaw': [],
  };

  for (const [key, entry] of Object.entries(store)) {
    const cls = classifySessionKey(key);
    grouped[cls.bucket].push({ key, entry, cls });
  }

  const buckets: Record<BucketName, BucketStats> = {} as any;
  for (const b of BUCKET_ORDER) buckets[b] = buildBucketStats(grouped[b]);

  return {
    agent,
    storePath,
    totalEntries: Object.keys(store).length,
    buckets,
    generatedAt: new Date().toISOString(),
  };
}

function discoverAgentStores(home: string, restrict?: string[]): Array<{ agent: string; storePath: string }> {
  const agentsRoot = path.join(home, 'agents');
  let entries: string[];
  try {
    entries = fs.readdirSync(agentsRoot);
  } catch {
    return [];
  }
  const found: Array<{ agent: string; storePath: string }> = [];
  for (const agent of entries) {
    if (restrict && restrict.length > 0 && !restrict.includes(agent)) continue;
    const storePath = path.join(agentsRoot, agent, 'sessions', 'sessions.json');
    if (fs.existsSync(storePath)) {
      found.push({ agent, storePath });
    }
  }
  return found;
}

function formatHuman(reports: AgentReport[]): string {
  const lines: string[] = [];
  lines.push('━'.repeat(72));
  lines.push(`IMClaw compaction stats · ${new Date().toISOString()}`);
  lines.push('━'.repeat(72));
  if (reports.length === 0) {
    lines.push('(no agent session stores found)');
    return lines.join('\n');
  }
  for (const r of reports) {
    lines.push('');
    lines.push(`### agent=${r.agent}  (${r.totalEntries} sessions total)`);
    lines.push(`### store=${r.storePath}`);
    lines.push('');
    lines.push('  bucket          count  w/comp  totalComp  maxComp  avgTok    maxTok');
    lines.push('  ' + '─'.repeat(70));
    for (const b of BUCKET_ORDER) {
      const s = r.buckets[b];
      if (s.count === 0) continue;
      const role = b === 'plaza' || b === 'moments' ? ' (control)' : '';
      lines.push(`  ${b.padEnd(14)}${role.padEnd(0)}  ${String(s.count).padStart(5)}  ${String(s.withCompactions).padStart(6)}  ${String(s.totalCompactions).padStart(9)}  ${String(s.maxCompactions).padStart(7)}  ${String(s.avgTotalTokens).padStart(6)}  ${String(s.maxTotalTokens).padStart(8)}`);
    }

    // Plaza/Moments are the control: any compactions there prove runtime compaction works.
    const plazaCc = r.buckets.plaza.totalCompactions;
    const momentsCc = r.buckets.moments.totalCompactions;
    const controlCc = plazaCc + momentsCc;
    if (r.buckets.plaza.count + r.buckets.moments.count > 0) {
      lines.push('');
      if (controlCc > 0) {
        lines.push(`  ✓ control compaction signal: plaza+moments fired ${controlCc} total compactions → Phase 2A candidate`);
      } else {
        lines.push(`  ⚠ control compaction signal: plaza+moments have 0 compactions (sessions may be too small, or compaction misconfigured) → Phase 2B candidate if traffic is non-trivial`);
      }
    }

    // Per-bucket hot lists.
    for (const b of BUCKET_ORDER) {
      const s = r.buckets[b];
      if (s.hotEntries.length === 0) continue;
      lines.push('');
      lines.push(`  · top ${s.hotEntries.length} ${b} sessions by totalTokens:`);
      for (const h of s.hotEntries) {
        const seg = h.segDetail ? ` [${h.segDetail}]` : '';
        const model = h.model ? ` model=${h.model}` : '';
        lines.push(`      tok=${String(h.totalTokens).padStart(7)} ctx=${String(h.contextTokens).padStart(6)} util=${String(h.contextUtilizationPct).padStart(5)}% comp=${h.compactionCount}  ${h.updatedAtIso}${seg}${model}`);
        lines.push(`        ${h.sessionKey}`);
      }
    }

    // Suspicious entries across all IMClaw buckets.
    const suspicious = [
      ...r.buckets.dm.suspiciousHighTokenZeroCompaction,
      ...r.buckets.group.suspiciousHighTokenZeroCompaction,
      ...r.buckets.plaza.suspiciousHighTokenZeroCompaction,
      ...r.buckets.moments.suspiciousHighTokenZeroCompaction,
    ];
    if (suspicious.length > 0) {
      lines.push('');
      lines.push(`  ⚠ suspicious: high token utilization (>=${Math.round(SUSPICIOUS_UTILIZATION_THRESHOLD * 100)}%) with zero compaction:`);
      for (const s of suspicious) {
        lines.push(`      tok=${String(s.totalTokens).padStart(7)} ctx=${String(s.contextTokens).padStart(6)} util=${String(s.contextUtilizationPct).padStart(5)}%  ${s.updatedAtIso}`);
        lines.push(`        ${s.sessionKey}`);
      }
      lines.push('');
      lines.push(`    → these sessions are at risk of token explosion if seg-N is removed without verifying compaction config.`);
    }
  }
  lines.push('');
  lines.push('━'.repeat(72));
  return lines.join('\n');
}

function parseArgs(argv: string[]): { json: boolean; agents: string[] } {
  const json = argv.includes('--json');
  const agents: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent' && i + 1 < argv.length) {
      agents.push(argv[i + 1]);
      i++;
    }
  }
  return { json, agents };
}

function main() {
  const { json, agents } = parseArgs(process.argv.slice(2));
  const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
  const stores = discoverAgentStores(home, agents.length > 0 ? agents : undefined);

  if (stores.length === 0) {
    const restricted = agents.length > 0 ? ` (restricted to: ${agents.join(', ')})` : '';
    console.error(`[compaction-stats] no session stores found under ${home}/agents${restricted}`);
    process.exit(2);
  }

  const reports: AgentReport[] = [];
  for (const { agent, storePath } of stores) {
    const r = analyzeAgentStore(agent, storePath);
    if (r) reports.push(r);
  }

  if (json) {
    process.stdout.write(JSON.stringify(reports, null, 2) + '\n');
  } else {
    process.stdout.write(formatHuman(reports) + '\n');
  }
}

main();
