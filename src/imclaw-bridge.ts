import { TinodeClient, TinodeMessage, TinodeClientOptions } from './tinode-client.js';
import { MessageStore } from './message-store.js';

/** Minimal in-memory fallback when SQLite is unavailable */
class InMemoryStore {
  private seqs = new Map<string, number>();
  private scopedTopic(topic: string, ownerClawId?: string): string {
    return ownerClawId ? `${ownerClawId}::${topic}` : topic;
  }
  getLastSeq(topic: string, ownerClawId?: string): number {
    return this.seqs.get(this.scopedTopic(topic, ownerClawId)) ?? 0;
  }
  saveMessage(_topic: string, _from: string, seqId: number, _content: any, _ts: Date, _owner?: string): void {
    const topic = this.scopedTopic(_topic, _owner);
    const cur = this.seqs.get(topic) ?? 0;
    if (seqId > cur) this.seqs.set(topic, seqId);
  }
  getRecentMessages(_limit: number): Array<{ topic: string; seqId: number; fromUid: string; content: any; timestamp: string }> {
    return [];
  }
  close(): void { this.seqs.clear(); }
}

export interface ChannelConfig {
  tinodeServerUrl: string;
  tinodeUsername: string;
  tinodePassword: string;
  tinodeApiKey?: string;
  dbPath?: string;
  httpBaseUrl?: string;  // HTTP base URL for file uploads (e.g. "http://localhost:6210")
  clawId?: string;       // Claw identifier for message ownership isolation
}

export interface InboundMessage {
  topic: string;
  from: string;
  content: any;
  seqId: number;
  timestamp: Date;
  isGroup: boolean;
}

export type MessageHandler = (message: InboundMessage) => void | Promise<void>;

/**
 * Temporary one-shot listener. Return `true` to consume the message
 * (removes the listener and skips the normal messageHandler dispatch).
 */
export type TemporaryMessageListener = (message: InboundMessage) => boolean;

/**
 * ImclawBridge - adapts Tinode messaging for OpenClaw agents.
 *
 * Inbound: Tinode {data} → InboundMessage → handler callback
 * Outbound: Agent calls sendMessage() → TinodeClient.sendMessage()
 */
export interface UploadResult {
  url: string;
  name: string;
  size: number;
  mime: string;
}

export class ImclawBridge {
  private client: TinodeClient;
  public readonly store: MessageStore | InMemoryStore;
  private config: ChannelConfig;
  private messageHandler: MessageHandler | null = null;
  private temporaryListeners: TemporaryMessageListener[] = [];

  constructor(config: ChannelConfig) {
    this.config = config;
    const clientOptions: TinodeClientOptions = {
      serverUrl: config.tinodeServerUrl,
      username: config.tinodeUsername,
      password: config.tinodePassword,
      apiKey: config.tinodeApiKey,
    };

    this.client = new TinodeClient(clientOptions);
    try {
      this.store = new MessageStore(config.dbPath);
    } catch {
      // SQLite unavailable — fall back to in-memory dedup
      this.store = new InMemoryStore();
    }
    this.client.on('message', (msg: TinodeMessage) => {
      console.log(`[imclaw-bridge] raw message: topic=${msg.topic} from=${msg.from} seq=${msg.seqId} selfUid=${this.client.getSelfUid()}`);

      // 1. Skip own messages (agent's own replies echoed back)
      //    Exception: announcements sent by human-api using the claw's credentials
      const isAnnouncementMsg = msg.content && typeof msg.content === 'object' && msg.content.tp === 'announcement';
      if (msg.from === this.client.getSelfUid() && !isAnnouncementMsg) {
        console.log(`[imclaw-bridge] skipped own message: topic=${msg.topic} seq=${msg.seqId}`);
        return;
      }

      // 2. Check last known seq for dedup
      const lastSeq = this.store.getLastSeq(msg.topic, config.clawId);

      // 3. Persist locally (INSERT OR IGNORE — idempotent)
      this.store.saveMessage(msg.topic, msg.from, msg.seqId, msg.content, msg.timestamp, config.clawId);

      // 4. Only dispatch genuinely new messages
      if (msg.seqId <= lastSeq) {
        console.log(`[imclaw-bridge] skipped dedup: topic=${msg.topic} seq=${msg.seqId} lastSeq=${lastSeq}`);
        return;
      }

      // 5. Skip stale messages (history replay older than 2 minutes)
      //    Exception: announcements are always delivered regardless of age
      const isAnnouncement = msg.content && typeof msg.content === 'object' && msg.content.tp === 'announcement';
      const ageMs = Date.now() - msg.timestamp.getTime();
      if (!isAnnouncement && ageMs > 2 * 60 * 1000) {
        console.log(`[imclaw-bridge] skipped stale: topic=${msg.topic} seq=${msg.seqId} ageMs=${ageMs}`);
        return;
      }

      const inbound: InboundMessage = {
        topic: msg.topic,
        from: msg.from,
        content: msg.content,
        seqId: msg.seqId,
        timestamp: msg.timestamp,
        isGroup: msg.topic.startsWith('grp'),
      };

      // Check temporary listeners first (reverse order, one-shot)
      for (let i = this.temporaryListeners.length - 1; i >= 0; i--) {
        try {
          if (this.temporaryListeners[i](inbound)) {
            this.temporaryListeners.splice(i, 1);
            return; // consumed — skip normal handler
          }
        } catch (err) {
          this.temporaryListeners.splice(i, 1);
          console.error('[imclaw-bridge] temporary listener error:', err);
        }
      }

      // Dispatch to normal handler
      if (this.messageHandler) {
        Promise.resolve(this.messageHandler(inbound)).catch((err) => {
          console.error('Message handler error:', err);
        });
      }
    });

    this.client.on('disconnected', () => {
      console.log('IMClaw: disconnected from Tinode');
    });

    this.client.on('error', (err: Error) => {
      console.error('IMClaw: Tinode error:', err.message);
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Register a one-shot temporary listener. Returns a cleanup function.
   * If the listener returns `true`, the message is consumed and the listener is removed.
   */
  addTemporaryListener(listener: TemporaryMessageListener): () => void {
    this.temporaryListeners.push(listener);
    return () => {
      const idx = this.temporaryListeners.indexOf(listener);
      if (idx >= 0) this.temporaryListeners.splice(idx, 1);
    };
  }

  async start(): Promise<void> {
    await this.client.connect();
    console.log('IMClaw: connected to Tinode');
  }

  /**
   * Subscribe to a peer's p2p topic. Pass a usr UID — Tinode resolves to p2p topic.
   * Returns the resolved topic name (e.g. p2pXXX).
   */
  async subscribeToPeer(peerUid: string): Promise<string> {
    const topic = peerUid.startsWith('usr') ? peerUid : `usr${peerUid}`;
    const resolved = await this.client.subscribe(topic);
    console.log(`[imclaw-bridge] subscribeToPeer: ${topic} → ${resolved}`);
    return resolved;
  }

  async sendMessage(topicName: string, content: any): Promise<number> {
    return this.client.sendMessage(topicName, content);
  }

  async uploadFile(fileBuffer: Buffer, filename: string, mime?: string): Promise<UploadResult> {
    if (!this.config.httpBaseUrl) {
      throw new Error('httpBaseUrl is required for file uploads. Set it in ChannelConfig.');
    }

    const boundary = '----IMClawBoundary' + Date.now().toString(36);
    const safeFilename = filename.replace(/["\r\n\\]/g, '_');
    const safeMime = (mime || 'application/octet-stream').replace(/[\r\n]/g, '');

    // Build multipart body manually to avoid extra dependencies
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
      `Content-Type: ${safeMime}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileBuffer, footer]);

    const basicAuth = Buffer.from(
      `${this.config.tinodeUsername}:${this.config.tinodePassword}`
    ).toString('base64');

    const url = `${this.config.httpBaseUrl}/api/files/upload`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Upload failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<UploadResult>;
  }

  async sendImage(topic: string, imageBuffer: Buffer, filename: string, mime?: string): Promise<number> {
    const uploaded = await this.uploadFile(imageBuffer, filename, mime || 'image/png');
    return this.sendMessage(topic, {
      tp: 'image',
      url: uploaded.url,
      name: uploaded.name,
      size: uploaded.size,
      mime: uploaded.mime,
    });
  }

  async sendFile(topic: string, fileBuffer: Buffer, filename: string, mime?: string): Promise<number> {
    const uploaded = await this.uploadFile(fileBuffer, filename, mime);
    return this.sendMessage(topic, {
      tp: 'file',
      url: uploaded.url,
      name: uploaded.name,
      size: uploaded.size,
      mime: uploaded.mime,
    });
  }

  setTopicLimit(topic: string, limit: number): void {
    this.client.setTopicLimit(topic, limit);
  }

  getPeerName(uid: string): string | undefined {
    return this.client.getPeerName(uid);
  }

  async stop(): Promise<void> {
    this.client.disconnect();
    this.store.close();
  }
}
