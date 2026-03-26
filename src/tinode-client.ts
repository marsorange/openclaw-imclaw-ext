import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface TinodeMessage {
  topic: string;
  from: string;
  seqId: number;
  content: any;
  timestamp: Date;
}

export interface TinodeClientOptions {
  serverUrl: string;
  username: string;
  password: string;
  apiKey?: string;
  userAgent?: string;
}

export class TinodeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: TinodeClientOptions;
  private msgId = 0;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private token: string | null = null;
  private shouldReconnect = true;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private subscribedTopics = new Set<string>();
  private topicLimits = new Map<string, number>();
  /** Maps requested topic name → resolved topic name (e.g. "usrXXXX" → "p2pXXXXYYYY") */
  private resolvedTopics = new Map<string, string>();
  /** Maps peer UID → display name (from {meta} sub public.fn) */
  private peerNames = new Map<string, string>();
  private _selfUid: string | null = null;
  /** Suppresses {pres} auto-subscribe during reconnection to avoid subscription storm */
  private _reconnecting = false;
  /** Deduplicates concurrent subscribeTopic calls for the same topic */
  private _pendingSubscribes = new Map<string, Promise<void>>();

  constructor(options: TinodeClientOptions) {
    super();
    this.setMaxListeners(50);
    this.options = options;
  }

  private safeParse(data: WebSocket.Data): any | null {
    try {
      return JSON.parse(data.toString());
    } catch {
      return null;
    }
  }

  getSelfUid(): string | null {
    return this._selfUid;
  }

  getPeerName(uid: string): string | undefined {
    return this.peerNames.get(uid);
  }

  setTopicLimit(topic: string, limit: number): void {
    this.topicLimits.set(topic, limit);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.shouldReconnect = true;

      // Close previous WebSocket if any, to prevent duplicate connections
      if (this.ws) {
        try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
        this.ws = null;
      }

      let url = this.options.serverUrl;

      // Warn if using unencrypted WebSocket to a remote server
      if (url.startsWith('ws://') && !url.startsWith('ws://localhost') && !url.startsWith('ws://127.0.0.1')) {
        console.warn('[Security] Using unencrypted ws:// to remote server. Consider using wss:// instead.');
      }

      // Tinode requires apikey as URL query parameter
      if (this.options.apiKey) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}apikey=${this.options.apiKey}`;
      }
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        this.ws?.close();
        reject(new Error('Connection timeout'));
      }, 10000);

      this.ws.on('open', () => {
        this.sendHi();
      });

      this.ws.on('message', (data) => {
        const msg = this.safeParse(data);
        if (!msg) return;
        this.handleMessage(msg, resolve, reject, timeout);
      });

      this.ws.on('close', () => {
        clearTimeout(timeout);
        this.stopHeartbeat();
        this.emit('disconnected');
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        this.emit('error', err);
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  async sendMessage(topicName: string, content: any): Promise<number> {
    // Ensure subscribed before publishing
    await this._ensureSubscribed(topicName);

    const publishTopic = this.resolvedTopics.get(topicName) || topicName;
    if (publishTopic !== topicName) {
      console.log(`[tinode] sendMessage: resolved ${topicName} → ${publishTopic}`);
    }

    try {
      return await this._doPublish(publishTopic, content);
    } catch (err: any) {
      // On 409 "must attach first", re-subscribe and retry once
      if (err.message?.includes('409')) {
        console.log(`[tinode] sendMessage: got 409 for ${publishTopic}, re-subscribing and retrying`);
        this.subscribedTopics.delete(topicName);
        this.subscribedTopics.delete(publishTopic);
        await this._ensureSubscribed(topicName);
        const retryTopic = this.resolvedTopics.get(topicName) || topicName;
        return this._doPublish(retryTopic, content);
      }
      throw err;
    }
  }

  private async _ensureSubscribed(topicName: string): Promise<void> {
    const alreadyResolved = this.resolvedTopics.get(topicName);
    const isSubscribed = this.subscribedTopics.has(topicName) ||
      (alreadyResolved && this.subscribedTopics.has(alreadyResolved));
    if (!isSubscribed) {
      await this.subscribeTopic(alreadyResolved || topicName);
    }
  }

  private _doPublish(topic: string, content: any): Promise<number> {
    const id = String(++this.msgId);
    return new Promise((resolve, reject) => {
      const handler = (data: WebSocket.Data) => {
        const msg = this.safeParse(data);
        if (!msg) return;
        if (msg.ctrl && msg.ctrl.id === id) {
          clearTimeout(timeout);
          this.ws?.off('message', handler);
          if (msg.ctrl.code >= 200 && msg.ctrl.code < 300) {
            resolve(msg.ctrl.params?.seq || 0);
          } else {
            reject(new Error(`Send failed: ${msg.ctrl.code} ${msg.ctrl.text}`));
          }
        }
      };
      const timeout = setTimeout(() => {
        this.ws?.off('message', handler);
        reject(new Error('Send timeout'));
      }, 10000);

      this.ws?.on('message', handler);
      this.send({
        pub: {
          id,
          topic,
          noecho: true,
          content,
        }
      });
    });
  }

  private async subscribeTopic(topicName: string): Promise<void> {
    // Dedup: if already subscribing to this topic, return existing promise
    const pending = this._pendingSubscribes.get(topicName);
    if (pending) return pending;

    const promise = this._doSubscribeTopic(topicName);
    this._pendingSubscribes.set(topicName, promise);
    try {
      await promise;
    } finally {
      this._pendingSubscribes.delete(topicName);
    }
  }

  private async _doSubscribeTopic(topicName: string): Promise<void> {
    const id = String(++this.msgId);

    return new Promise((resolve, reject) => {
      const handler = (data: WebSocket.Data) => {
        const msg = this.safeParse(data);
        if (!msg) return;
        if (msg.ctrl && msg.ctrl.id === id) {
          clearTimeout(timeout);
          this.ws?.off('message', handler);
          if (msg.ctrl.code >= 200 && msg.ctrl.code < 400) {
            // 2xx = success, 3xx (304 = already subscribed) = also fine
            const resolvedTopic = msg.ctrl.topic || topicName;
            this.subscribedTopics.add(resolvedTopic);
            // Track mapping if Tinode resolved to a different topic (e.g. "usrXXX" → "p2pXXXYYY")
            if (resolvedTopic !== topicName) {
              this.resolvedTopics.set(topicName, resolvedTopic);
              this.subscribedTopics.add(topicName); // Also mark original as known
            }
            resolve();
          } else {
            reject(new Error(`Subscribe failed: ${msg.ctrl.code}`));
          }
        }
      };

      const timeout = setTimeout(() => {
        this.ws?.off('message', handler);
        reject(new Error('Subscribe timeout'));
      }, 10000);

      this.ws?.on('message', handler);
      const dataLimit = this.topicLimits.get(topicName) || 24;
      this.send({
        sub: {
          id,
          topic: topicName,
          get: { what: 'desc sub data', data: { limit: dataLimit } },
        }
      });
    });
  }

  /** Subscribe to "me" topic to discover existing conversations and receive presence notifications. */
  private subscribeMe(): void {
    const id = String(++this.msgId);
    this.send({
      sub: {
        id,
        topic: 'me',
        get: { what: 'sub' },
      }
    });
  }

  private handleMessage(msg: any, resolve?: Function, reject?: Function, timeout?: NodeJS.Timeout): void {
    // Handle {ctrl} for hi/login flow
    if (msg.ctrl) {
      if (msg.ctrl.id === 'hi_1' && msg.ctrl.code >= 200 && msg.ctrl.code < 300) {
        this.loginBasic();
      } else if (msg.ctrl.id === 'login_1') {
        if (msg.ctrl.code === 200) {
          this.token = msg.ctrl.params?.token || null;
          this._selfUid = msg.ctrl.params?.user || null;
          this.startHeartbeat();
          this.reconnectDelay = 1000;
          if (timeout) clearTimeout(timeout);
          // Subscribe to "me" to discover topics and receive presence notifications
          this.subscribeMe();
          resolve?.();
        } else {
          if (timeout) clearTimeout(timeout);
          reject?.(new Error(`Login failed: ${msg.ctrl.code} ${msg.ctrl.text}`));
        }
      }
    }

    // Handle {meta} — auto-subscribe to topics from "me" subscription list
    if (msg.meta && msg.meta.sub) {
      console.log(`[tinode] {meta} sub count=${msg.meta.sub.length} topics=${msg.meta.sub.map((s: any) => s.topic).join(',')}`);
      for (const sub of msg.meta.sub) {
        if (sub.topic && !this.subscribedTopics.has(sub.topic)) {
          this.subscribeTopic(sub.topic).catch(() => {});
        }
        // Build user → p2p topic mapping from "me" subscriptions
        // Tinode uses "with" field for the other user in p2p topics
        const peerUid = sub.with || sub.user;
        if (sub.topic?.startsWith('p2p') && peerUid) {
          this.resolvedTopics.set(peerUid, sub.topic);
        }
        // Cache peer display name from subscription public data
        if (peerUid && sub.public?.fn) {
          this.peerNames.set(peerUid, sub.public.fn);
        }
      }
    }

    // Handle incoming {data} messages
    if (msg.data) {
      const contentPreview = typeof msg.data.content === 'string'
        ? msg.data.content.substring(0, 100)
        : JSON.stringify(msg.data.content).substring(0, 100);
      console.log(`[tinode] {data} topic=${msg.data.topic} from=${msg.data.from} seq=${msg.data.seq} ts=${msg.data.ts} content=${contentPreview}`);

      // Track user → p2p topic mapping from incoming messages
      if (msg.data.topic?.startsWith('p2p') && msg.data.from) {
        this.resolvedTopics.set(msg.data.from, msg.data.topic);
      }

      const tinodeMsg: TinodeMessage = {
        topic: msg.data.topic,
        from: msg.data.from,
        seqId: msg.data.seq,
        content: msg.data.content,
        timestamp: new Date(msg.data.ts),
      };
      this.emit('message', tinodeMsg);
    }

    // Handle {pres} for presence — auto-subscribe to topics with new messages or access changes
    // Suppress auto-subscribe during reconnection to avoid subscription storm
    if (msg.pres) {
      if (this._reconnecting) {
        // During reconnect, {meta} handler already resubscribes all topics — skip {pres} auto-subscribe
      } else if ((msg.pres.what === 'msg' || msg.pres.what === 'acs') && msg.pres.src && !this.subscribedTopics.has(msg.pres.src)) {
        console.log(`[tinode] {pres} auto-subscribing to new topic: ${msg.pres.src}`);
        this.subscribeTopic(msg.pres.src).catch((err) => {
          console.error(`[tinode] {pres} auto-subscribe failed for ${msg.pres.src}: ${err.message}`);
        });
      }
      this.emit('presence', msg.pres);
    }
  }

  private sendHi(): void {
    this.send({
      hi: {
        id: 'hi_1',
        ver: '0.22',
        ua: this.options.userAgent || 'OpenClaw-IMClaw/0.1',
      }
    });
  }

  private loginBasic(): void {
    const secret = Buffer.from(
      `${this.options.username}:${this.options.password}`
    ).toString('base64');

    this.send({
      login: {
        id: 'login_1',
        scheme: 'basic',
        secret,
      }
    });
  }

  private send(msg: any): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    } catch { /* ignore send errors on closing socket */ }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat(); // Prevent duplicate intervals on reconnect
    this.heartbeatInterval = setInterval(() => {
      this.send({ note: { what: 'kp', topic: 'me' } });
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    console.log(`[tinode] reconnect in ${this.reconnectDelay}ms`);
    setTimeout(async () => {
      if (!this.shouldReconnect) return;
      try {
        this._reconnecting = true;
        // Snapshot before clearing
        const topics = [...this.subscribedTopics];
        const resolvedSnapshot = new Map(this.resolvedTopics);
        const namesSnapshot = new Map(this.peerNames);
        // Clear sets so handlers and resubscribe loop work correctly on new connection
        this.subscribedTopics.clear();
        this.resolvedTopics.clear();
        this.peerNames.clear();
        this._pendingSubscribes.clear();
        await this.connect();
        // Explicitly resubscribe known topics. Dedup ensures no duplicate requests
        // even if {meta} handler subscribes the same topics concurrently.
        for (const topic of topics) {
          await this.subscribeTopic(topic).catch(() => {});
        }
        // Restore resolved topic mappings not rebuilt during resubscription
        for (const [key, val] of resolvedSnapshot) {
          if (!this.resolvedTopics.has(key)) {
            this.resolvedTopics.set(key, val);
          }
        }
        // Restore peer names not rebuilt during resubscription
        for (const [key, val] of namesSnapshot) {
          if (!this.peerNames.has(key)) {
            this.peerNames.set(key, val);
          }
        }
        this._reconnecting = false;
      } catch {
        this._reconnecting = false;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }
}
