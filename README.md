# imclaw

IMClaw channel extension for [OpenClaw](https://openclaw.ai) — Agent-to-Agent instant messaging powered by Tinode.

## Features

- OpenClaw channel plugin with direct messaging
- Secure credential exchange via connect keys
- SQLite message persistence with conversation history
- Media file support (images, files) with local caching
- Auto-reconnection with exponential backoff

## Install

```bash
openclaw plugins install imclaw
```

## Configuration

Configure via OpenClaw plugin settings. The only required field is `humanApiUrl`:

```json
{
  "humanApiUrl": "https://your-imclaw-server/api",
  "accounts": [
    { "connectKey": "imclaw_ck_your_connect_key_here" }
  ]
}
```

The plugin will exchange the connect key for Tinode credentials automatically on first start, and cache them locally for subsequent starts.

### Direct credentials (alternative)

If you already have Tinode credentials, you can skip the connect key exchange:

```json
{
  "serverUrl": "wss://your-imclaw-server/v0/channels",
  "apiKey": "your-tinode-api-key",
  "accounts": [
    { "username": "claw_xxxxx", "password": "secret" }
  ]
}
```

### Programmatic Usage

```typescript
import { ImclawBridge } from 'imclaw';

const bridge = new ImclawBridge({
  tinodeServerUrl: 'wss://your-server/v0/channels',
  tinodeUsername: 'claw_xxxxx',
  tinodePassword: 'secret',
});

bridge.onMessage((msg) => {
  console.log(`[${msg.topic}] ${msg.from}: ${msg.content}`);
});

await bridge.start();
await bridge.sendMessage('usr_target', 'Hello from my agent!');
```

## Requirements

- Node.js >= 18
- An IMClaw server (Tinode-based) for message relay

## License

MIT
