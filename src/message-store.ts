import { Database } from 'node-sqlite3-wasm';
import path from 'path';
import os from 'os';
import fs from 'fs';

export interface StoredMessage {
  id: number;
  topic: string;
  from_user: string;
  seq_id: number;
  content: string;
  timestamp: string;
  synced: number;
  owner_claw_id: string | null;
}

export class MessageStore {
  private db: Database;

  constructor(dbPath?: string) {
    const defaultPath = path.join(os.homedir(), '.openclaw', 'imclaw');
    const resolvedPath = dbPath || path.join(defaultPath, 'messages.db');

    // Ensure directory exists with restrictive permissions
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });

    this.db = new Database(resolvedPath);

    // Restrict database file permissions
    try { fs.chmodSync(resolvedPath, 0o600); } catch { /* new file, will be set on next open */ }
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        from_user TEXT NOT NULL,
        seq_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        synced INTEGER DEFAULT 1,
        UNIQUE(topic, seq_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_topic_seq
        ON messages(topic, seq_id);

      CREATE TABLE IF NOT EXISTS sync_state (
        topic TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL DEFAULT 0
      );
    `);

    // V2: Add owner_claw_id for per-claw message isolation
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN owner_claw_id TEXT`);
    } catch {
      // Column already exists — safe to ignore
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_owner ON messages(owner_claw_id, topic)`);
  }

  private scopedTopic(topic: string, ownerClawId?: string): string {
    // Rebound/recreated claws can reuse the same peer topic names with a fresh seq space.
    // Scope local dedup state by claw identity so an old account cannot suppress new messages.
    return ownerClawId ? `${ownerClawId}::${topic}` : topic;
  }

  saveMessage(topic: string, fromUser: string, seqId: number, content: any, timestamp: Date, ownerClawId?: string): void {
    const scopedTopic = this.scopedTopic(topic, ownerClawId);
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
    // Wrap in transaction for atomicity and better SQLite performance
    this.db.exec('BEGIN');
    try {
      this.db.run(
        `INSERT OR IGNORE INTO messages (topic, from_user, seq_id, content, timestamp, owner_claw_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [scopedTopic, fromUser, seqId, contentStr, timestamp.toISOString(), ownerClawId || null]
      );
      this.db.run(
        `INSERT INTO sync_state (topic, last_seq) VALUES (?, ?)
         ON CONFLICT(topic) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`,
        [scopedTopic, seqId]
      );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getLastSeq(topic: string, ownerClawId?: string): number {
    const row = this.db.get(
      'SELECT last_seq FROM sync_state WHERE topic = ?',
      [this.scopedTopic(topic, ownerClawId)]
    ) as unknown as { last_seq: number } | null;
    return row?.last_seq || 0;
  }

  close(): void {
    this.db.close();
  }
}
