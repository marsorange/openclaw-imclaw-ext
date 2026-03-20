// Library exports (for programmatic use)
export { TinodeClient } from './tinode-client.js';
export type { TinodeMessage, TinodeClientOptions } from './tinode-client.js';

export { ImclawBridge } from './imclaw-bridge.js';
export type { ChannelConfig, InboundMessage, MessageHandler, UploadResult } from './imclaw-bridge.js';

export { MessageStore } from './message-store.js';
export type { StoredMessage } from './message-store.js';

// OpenClaw channel plugin
export { imclawPlugin } from './channel.js';
