#!/usr/bin/env node
/**
 * cleanup-orphan-seg-sessions.ts — Archive sessionFiles orphaned by the
 * IMClaw runtime-takeover refactor.
 *
 * Before the refactor, the IMClaw channel appended `:seg-N` / `:manual-N`
 * suffixes to sessionKeys (see docs/imclaw-runtime-session-takeover.md). After
 * the refactor, the channel uses a stable per-peer sessionKey, so those old
 * suffixed entries (and the JSONL transcripts they point at) are dead weight —
 * they will never be addressed again.
 *
 * What this script does:
 *   1. Scans ~/.openclaw/agents/<agent>/sessions/sessions.json
 *   2. Finds every entry whose key ends in `:seg-N` or `:manual-N` (case-sensitive,
 *      using the regex below).
 *   3. Optionally also matches stale `:rs-<ts>` suffixes — by default we leave
 *      them alone (the corrupted-session safety net may still reference them
 *      within its 30-minute TTL), unless --include-rs is passed.
 *   4. For each matched entry:
 *        - moves its sessionFile (if present) to sessions/archived/<sessionId>.jsonl
 *        - removes the entry from sessions.json
 *   5. Writes a backup of the original sessions.json to
 *      sessions/sessions.json.pre-orphan-cleanup-<ISO>.bak before mutating.
 *
 * Safety:
 *   - Read-only DRY-RUN by default. Pass --apply to actually mutate.
 *   - Will refuse to run unless --i-have-deployed-runtime-takeover is passed,
 *     so this can't be accidentally run on a host still running the old plugin.
 *   - Never deletes — it archives (rename, not unlink) so you can roll back.
 *
 * Usage:
 *   npx tsx scripts/cleanup-orphan-seg-sessions.ts                         # dry-run report
 *   npx tsx scripts/cleanup-orphan-seg-sessions.ts --apply \
 *     --i-have-deployed-runtime-takeover                                   # actually do it
 *   npx tsx scripts/cleanup-orphan-seg-sessions.ts --apply --include-rs \
 *     --i-have-deployed-runtime-takeover                                   # also sweep rs-<ts>
 *   OPENCLAW_HOME=/path/to/.openclaw npx tsx scripts/cleanup-orphan-seg-sessions.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

type SessionEntry = { sessionId?: string; sessionFile?: string; updatedAt?: number; [k: string]: unknown };

// The legacy resolveBoundedSessionKey() joined its parts with '-', so a session
// with both a manual boundary AND a seg cap could land as ":manual-<seq>-seg-<n>".
// Match all three shapes (manual+seg, manual-only, seg-only).
const SEG_SUFFIX = /:(?:manual-\d+(?:-seg-\d+)?|seg-\d+)$/;
const RS_SUFFIX = /:rs-\d+$/;

interface Args {
  apply: boolean;
  includeRs: boolean;
  ackTakeover: boolean;
  agents: string[];
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply');
  const includeRs = argv.includes('--include-rs');
  const ackTakeover = argv.includes('--i-have-deployed-runtime-takeover');
  const agents: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent' && i + 1 < argv.length) {
      agents.push(argv[i + 1]);
      i++;
    }
  }
  return { apply, includeRs, ackTakeover, agents };
}

function isOrphanKey(key: string, includeRs: boolean): boolean {
  if (SEG_SUFFIX.test(key)) return true;
  if (includeRs && RS_SUFFIX.test(key)) return true;
  return false;
}

function discoverAgentStores(home: string, restrict?: string[]): Array<{ agent: string; sessionsDir: string; storePath: string }> {
  const agentsRoot = path.join(home, 'agents');
  let agents: string[];
  try { agents = fs.readdirSync(agentsRoot); }
  catch { return []; }
  const out: Array<{ agent: string; sessionsDir: string; storePath: string }> = [];
  for (const a of agents) {
    if (restrict && restrict.length > 0 && !restrict.includes(a)) continue;
    const sessionsDir = path.join(agentsRoot, a, 'sessions');
    const storePath = path.join(sessionsDir, 'sessions.json');
    if (fs.existsSync(storePath)) out.push({ agent: a, sessionsDir, storePath });
  }
  return out;
}

interface CleanupPlanItem {
  sessionKey: string;
  sessionId?: string;
  sessionFile?: string;
  fileExists: boolean;
  updatedAtIso: string;
}

interface AgentCleanupPlan {
  agent: string;
  storePath: string;
  totalEntries: number;
  orphans: CleanupPlanItem[];
}

function planAgent(agent: string, sessionsDir: string, storePath: string, includeRs: boolean): AgentCleanupPlan | null {
  let raw: string;
  try { raw = fs.readFileSync(storePath, 'utf-8'); }
  catch (err: any) {
    console.error(`[cleanup] skip ${agent} — cannot read ${storePath}: ${err?.message ?? err}`);
    return null;
  }
  let store: Record<string, SessionEntry>;
  try { store = JSON.parse(raw); }
  catch (err: any) {
    console.error(`[cleanup] skip ${agent} — parse error on ${storePath}: ${err?.message ?? err}`);
    return null;
  }

  const orphans: CleanupPlanItem[] = [];
  for (const [key, entry] of Object.entries(store)) {
    if (!isOrphanKey(key, includeRs)) continue;
    const sessionFile = typeof entry.sessionFile === 'string' ? entry.sessionFile : undefined;
    orphans.push({
      sessionKey: key,
      sessionId: entry.sessionId as string | undefined,
      sessionFile,
      fileExists: sessionFile ? fs.existsSync(sessionFile) : false,
      updatedAtIso: entry.updatedAt ? new Date(entry.updatedAt as number).toISOString() : 'n/a',
    });
  }

  return { agent, storePath, totalEntries: Object.keys(store).length, orphans };
}

function applyPlan(plan: AgentCleanupPlan, sessionsDir: string): { archived: number; removed: number; errors: string[] } {
  const archiveDir = path.join(sessionsDir, 'archived');
  const errors: string[] = [];
  let archived = 0;
  let removed = 0;

  // 1. Backup sessions.json (timestamped).
  const backupPath = `${plan.storePath}.pre-orphan-cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  try { fs.copyFileSync(plan.storePath, backupPath); }
  catch (err: any) {
    errors.push(`backup ${plan.storePath} failed: ${err?.message ?? err}`);
    return { archived, removed, errors };
  }

  // 2. Re-read fresh (defensive: in case anything changed since plan).
  const raw = fs.readFileSync(plan.storePath, 'utf-8');
  const store: Record<string, SessionEntry> = JSON.parse(raw);

  try { fs.mkdirSync(archiveDir, { recursive: true }); }
  catch (err: any) {
    errors.push(`mkdir ${archiveDir} failed: ${err?.message ?? err}`);
    return { archived, removed, errors };
  }

  for (const item of plan.orphans) {
    // (a) move the sessionFile if present
    if (item.sessionFile && fs.existsSync(item.sessionFile)) {
      const destName = item.sessionId ? `${item.sessionId}.jsonl` : path.basename(item.sessionFile);
      const dest = path.join(archiveDir, destName);
      try {
        fs.renameSync(item.sessionFile, dest);
        archived++;
      } catch (err: any) {
        errors.push(`archive ${item.sessionFile} → ${dest} failed: ${err?.message ?? err}`);
        continue;
      }
    }
    // (b) drop the sessions.json entry
    if (store[item.sessionKey]) {
      delete store[item.sessionKey];
      removed++;
    }
  }

  // 3. Write store atomically (write-then-rename via fs.writeFileSync — sessions.json
  //    is already managed under a lock by the runtime, so a quick sync write here is
  //    acceptable as long as the agent is stopped).
  try {
    fs.writeFileSync(plan.storePath, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err: any) {
    errors.push(`writeback ${plan.storePath} failed: ${err?.message ?? err}`);
  }

  return { archived, removed, errors };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');

  if (args.apply && !args.ackTakeover) {
    console.error('[cleanup] refusing to --apply without --i-have-deployed-runtime-takeover');
    console.error('[cleanup] this script only makes sense AFTER the channel.ts seg-N removal is live');
    console.error('[cleanup] running it on an older plugin would orphan still-active sessions');
    process.exit(2);
  }

  const stores = discoverAgentStores(home, args.agents.length > 0 ? args.agents : undefined);
  if (stores.length === 0) {
    console.error(`[cleanup] no session stores under ${home}/agents`);
    process.exit(2);
  }

  console.log('━'.repeat(72));
  console.log(`IMClaw orphan seg-session cleanup · ${new Date().toISOString()}`);
  console.log(`mode: ${args.apply ? 'APPLY (will mutate)' : 'DRY-RUN (read-only)'}${args.includeRs ? ' · including rs-<ts>' : ''}`);
  console.log('━'.repeat(72));

  for (const { agent, sessionsDir, storePath } of stores) {
    const plan = planAgent(agent, sessionsDir, storePath, args.includeRs);
    if (!plan) continue;

    console.log('');
    console.log(`### agent=${agent}  (${plan.totalEntries} entries total, ${plan.orphans.length} orphans)`);
    console.log(`### store=${plan.storePath}`);

    if (plan.orphans.length === 0) {
      console.log('  nothing to clean.');
      continue;
    }

    for (const o of plan.orphans) {
      const fileMark = o.sessionFile ? (o.fileExists ? '✓' : '∅') : '—';
      console.log(`  [${fileMark}] ${o.updatedAtIso}  ${o.sessionKey}`);
      if (o.sessionFile) console.log(`        file: ${o.sessionFile}`);
    }

    if (!args.apply) {
      console.log(`  (dry-run; pass --apply --i-have-deployed-runtime-takeover to archive ${plan.orphans.length} entries)`);
      continue;
    }

    const result = applyPlan(plan, sessionsDir);
    console.log(`  archived ${result.archived} sessionFile(s); removed ${result.removed} sessions.json entry/entries`);
    if (result.errors.length > 0) {
      console.error(`  ⚠ errors:`);
      for (const e of result.errors) console.error(`    - ${e}`);
    }
  }

  console.log('');
  console.log('━'.repeat(72));
}

main();
