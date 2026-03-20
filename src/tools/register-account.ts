import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getHumanApiUrl, loadCredsCache, CREDS_CACHE_PATH } from '../channel.js';
import type { ToolResult } from './agent-fetch.js';
import { textResult } from './agent-fetch.js';

export function registerRegisterTool(api: OpenClawPluginApi): void {
  api.registerTool(() => ({
    name: 'imclaw_register',
    label: 'Register IMClaw Account',
    description:
      'Register a new IMClaw account for the user. This is a two-step process:\n' +
      '1. Call with action "send_code" and the user\'s phone number to send an SMS verification code.\n' +
      '2. Ask the user for the code, then call with action "verify" to complete registration.\n' +
      'On success, credentials are cached automatically. The agent will need to restart the gateway to connect.',
    parameters: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['send_code', 'verify'],
          description: 'Step: "send_code" to send SMS, "verify" to complete registration with the code.',
        },
        phone: {
          type: 'string',
          description: 'User phone number (required for both steps).',
        },
        code: {
          type: 'string',
          description: 'SMS verification code (required for "verify" step).',
        },
      },
      required: ['action', 'phone'],
    },
    async execute(_id: string, params: { action: string; phone: string; code?: string }): Promise<ToolResult> {
      try {
        const humanApiUrl = getHumanApiUrl();

        if (params.action === 'send_code') {
          const res = await fetch(`${humanApiUrl}/public/agent-register/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: params.phone }),
            signal: AbortSignal.timeout(15_000),
          });
          const data = await res.json().catch(() => ({})) as any;
          if (!res.ok) return textResult(`Error: ${data.error || 'Failed to send SMS'}`);
          return textResult(`SMS verification code sent to ${params.phone}. Ask the user for the code, then call this tool again with action "verify".`);
        }

        if (params.action === 'verify') {
          if (!params.code) return textResult('Error: code is required for verify step.');
          const res = await fetch(`${humanApiUrl}/public/agent-register/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: params.phone, code: params.code }),
            signal: AbortSignal.timeout(30_000),
          });
          const data = await res.json().catch(() => ({})) as any;
          if (!res.ok) return textResult(`Error: ${data.error || 'Registration failed'}`);

          // Cache credentials so the agent can connect
          const cacheKey = `agent-register-${params.phone}`;
          const cache = loadCredsCache();
          cache[cacheKey] = {
            username: data.tinodeUsername,
            password: data.tinodePassword,
            clawId: data.clawId,
            serverUrl: data.tinodeWsUrl,
            apiKey: data.tinodeApiKey,
            httpBaseUrl: data.httpBaseUrl,
          };
          // Write cache
          const fsModule = await import('fs');
          const pathModule = await import('path');
          const osModule = await import('os');
          const cacheDir = pathModule.default.join(osModule.default.homedir(), '.openclaw', 'imclaw');
          fsModule.default.mkdirSync(cacheDir, { recursive: true });
          fsModule.default.writeFileSync(CREDS_CACHE_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 });

          const dashboardUrl = humanApiUrl.replace(/\/api\/?$/, '');
          return textResult(
            `Registration successful!\n\n` +
            `Temporary password: ${data.tempPassword}\n\n` +
            `IMPORTANT: Tell the user to:\n` +
            `1. Go to ${dashboardUrl} and log in with their phone number and temporary password "${data.tempPassword}"\n` +
            `2. Set their username and a new password on first login\n\n` +
            `Credentials have been cached. Now enable the channel:\n` +
            `openclaw config set channels.imclaw.accounts.default '{"enabled":true}'`
          );
        }

        return textResult('Error: Invalid action. Use "send_code" or "verify".');
      } catch (err: any) {
        return textResult(`Error: ${err.message}`);
      }
    },
  }));
}
