import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { createRequire } from 'node:module';
import { imclawPlugin, setPluginConfig, setPluginRuntime, setPluginVersion } from './channel.js';
import { startPluginPolicyCheckLoop } from './auto-update.js';
import { registerAllTools } from './tools/register.js';

export { imclawPlugin } from './channel.js';

const require = createRequire(import.meta.url);
const manifest = require('../openclaw.plugin.json');
const pkg = require('../package.json');
const pluginVersion = typeof pkg?.version === 'string' ? pkg.version : manifest.version;
type PluginRegistrationMode = 'full' | 'setup-only' | 'setup-runtime' | 'cli-metadata';

const imclawConfigSchema = {
  jsonSchema: manifest.configSchema,
  safeParse(value: unknown) {
    if (value === undefined || value === null) return { success: true as const, data: {} };
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { success: false as const, error: { issues: [{ path: [], message: 'expected object' }] } };
    }
    return { success: true as const, data: value };
  },
  parse(value: unknown) {
    const r = imclawConfigSchema.safeParse(value);
    if (!r.success) throw new Error((r as any).error.issues[0].message);
    return r.data;
  },
};

function resolveRegistrationMode(api: OpenClawPluginApi): PluginRegistrationMode | undefined {
  const mode = (api as OpenClawPluginApi & { registrationMode?: unknown }).registrationMode;
  return mode === 'full' || mode === 'setup-only' || mode === 'setup-runtime' || mode === 'cli-metadata'
    ? mode
    : undefined;
}

const plugin = {
  id: 'imclaw',
  name: 'IMClaw',
  description: 'Agent-to-Agent instant messaging for OpenClaw',
  configSchema: imclawConfigSchema,
  register(api: OpenClawPluginApi) {
    // OpenClaw >=2026.4: honor registration mode when available.
    const mode = resolveRegistrationMode(api);

    // Metadata capture path should avoid all runtime side effects.
    if (mode === 'cli-metadata') return;

    setPluginConfig(api.pluginConfig ?? {});
    if (api.runtime) setPluginRuntime(api.runtime);
    setPluginVersion(pluginVersion);

    // Setup-only/setup-runtime path: keep channel registration only.
    api.registerChannel({ plugin: imclawPlugin });
    if (mode && mode !== 'full') return;

    // Full runtime mode (or legacy mode without registrationMode).
    startPluginPolicyCheckLoop(api, pluginVersion);
    registerAllTools(api);
    ensureToolsProfile(api);
  },
};

/**
 * Ensure imclaw tools are accessible after installation.
 *
 * OpenClaw's tools.allow is a literal match list — "imclaw" does NOT match
 * "imclaw_send_message" etc. The old code injected the bare string, which
 * broke every tool call.
 *
 * Strategy:
 *  1. If tools.allow is absent or tools.profile is "full" — nothing to do.
 *  2. If tools.allow contains the bare "imclaw" entry — replace it with
 *     the actual tool names declared in contracts.tools.
 *  3. Otherwise — just warn.
 */
function ensureToolsProfile(api: OpenClawPluginApi) {
  if (!api.runtime) return;
  try {
    const cfg = ((api.runtime.config as any).current?.() ?? api.config) as Record<string, any>;
    const tools = cfg?.tools;

    // Case 1: no restrictions — tools are available by default
    if (!tools) return;
    const profile = tools.profile;
    if (!profile || profile === 'full') return;
    if (!Array.isArray(tools.allow) || tools.allow.length === 0) {
      // tools.profile is restrictive but no allowlist — just warn
      api.logger.warn(
        `[imclaw] tools.profile is "${profile}" — imclaw tools may not be available. Set tools.profile to "full" for full access.`,
      );
      return;
    }

    const allow: string[] = tools.allow;

    // Case 2: allowlist exists but contains bare "imclaw" — fix it
    const imclawIdx = allow.indexOf('imclaw');
    if (imclawIdx !== -1) {
      const declaredTools: string[] = manifest?.contracts?.tools;
      if (Array.isArray(declaredTools) && declaredTools.length > 0) {
        // Remove bare "imclaw" and splice in actual tool names
        allow.splice(imclawIdx, 1, ...declaredTools);
        api.logger.info(
          `[imclaw] replaced bare "imclaw" in tools.allow with ${declaredTools.length} declared tool names`,
        );
      } else {
        // No manifest data — just remove the bad entry
        allow.splice(imclawIdx, 1);
        api.logger.warn(
          `[imclaw] removed non-matching "imclaw" from tools.allow — declare contracts.tools in manifest for auto-fix`,
        );
      }

      // Persist the fix
      const freshCfg = (typeof (api.runtime.config as any).current === 'function')
        ? (api.runtime.config as any).current()
        : cfg;
      (api.runtime.config as any).writeConfigFile(freshCfg).catch((err: any) => {
        api.logger.warn(`[imclaw] failed to persist tools.allow fix: ${err?.message ?? err}`);
      });
      return;
    }

    // Case 3: allowlist exists without "imclaw" — check if any imclaw tool is listed
    const hasImclawTool = allow.some((e: string) => e.startsWith('imclaw_'));
    if (!hasImclawTool) {
      api.logger.warn(
        `[imclaw] tools.allow has no imclaw entries — plugin tools will be blocked. ` +
        `Add imclaw tool names to tools.allow, or set tools.profile to "full".`,
      );
    }
  } catch {
    // Non-critical — user can always configure manually
  }
}

export default plugin;
