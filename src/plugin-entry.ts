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
 * Ensure imclaw plugin tools are exposed after installation.
 *
 * Per the OpenClaw official "additive" pattern, plugin tools should be enabled
 * via `tools.alsoAllow` rather than seizing the user's `tools.allow` policy.
 * This runtime fallback mirrors what `imclaw-cli`'s `ensureToolsPermission()`
 * does so that users who enable the plugin directly (without running the CLI)
 * still get a working setup.
 *
 * Cases:
 *  ① No tools.allow (default state) — write tools.alsoAllow additively.
 *  ② tools.allow contains the legacy bare "imclaw" — replace with real tool
 *     names in-place (schema forbids allow + alsoAllow coexisting).
 *  ③ tools.allow is user-managed strict mode — only warn, never seize.
 */
function ensureToolsProfile(api: OpenClawPluginApi) {
  if (!api.runtime) return;
  try {
    const cfg = ((api.runtime.config as any).current?.() ?? api.config) as Record<string, any>;
    const tools = cfg?.tools;

    const declaredTools: string[] = manifest?.contracts?.tools;
    const allow: string[] | null = Array.isArray(tools?.allow) ? tools.allow : null;
    const alsoAllow: string[] | null = Array.isArray(tools?.alsoAllow) ? tools.alsoAllow : null;

    const persist = () => {
      const freshCfg = typeof (api.runtime!.config as any).current === 'function'
        ? (api.runtime!.config as any).current()
        : cfg;
      (api.runtime!.config as any).writeConfigFile(freshCfg).catch((err: any) => {
        api.logger.warn(`[imclaw] failed to persist tools policy fix: ${err?.message ?? err}`);
      });
    };

    // Case ①: no allow — additive opt-in via tools.alsoAllow.
    if (!allow || allow.length === 0) {
      if (!Array.isArray(declaredTools) || declaredTools.length === 0) return;
      const existing = alsoAllow ?? [];
      const missing = declaredTools.filter((t) => !existing.includes(t));
      if (missing.length === 0) return;
      const next = Array.from(new Set([...existing, ...declaredTools]));
      const toolsObj = (cfg.tools = cfg.tools ?? {});
      toolsObj.alsoAllow = next;
      api.logger.info(
        `[imclaw] enabled ${missing.length} imclaw tool(s) via tools.alsoAllow`,
      );
      persist();
      return;
    }

    // Case ②: legacy bare "imclaw" — must stay in allow (schema forbids
    // mixing allow + alsoAllow). Replace with real tool names in place.
    const imclawIdx = allow.indexOf('imclaw');
    if (imclawIdx !== -1) {
      if (Array.isArray(declaredTools) && declaredTools.length > 0) {
        allow.splice(imclawIdx, 1, ...declaredTools);
        api.logger.info(
          `[imclaw] replaced bare "imclaw" in tools.allow with ${declaredTools.length} declared tool names`,
        );
      } else {
        allow.splice(imclawIdx, 1);
        api.logger.warn(
          `[imclaw] removed non-matching "imclaw" from tools.allow — declare contracts.tools in manifest for auto-fix`,
        );
      }
      persist();
      return;
    }

    // Case ③: user-managed strict allow. Don't seize; only warn.
    const hasImclawTool = allow.some((e: string) => e.startsWith('imclaw_'));
    if (!hasImclawTool) {
      api.logger.warn(
        `[imclaw] tools.allow is in strict mode without any imclaw_* entries — plugin tools will be blocked. ` +
        `Either add imclaw tool names to tools.allow, or remove tools.allow and use tools.alsoAllow instead.`,
      );
    }
    if (!allow.includes('web_fetch') && !allow.includes('*')) {
      api.logger.warn(
        `[imclaw] tools.allow is in strict mode without "web_fetch" — IMClaw skills that use built-in fetch ` +
        `(MBTI / SBTI / Texas Holdem) will fail. Add "web_fetch" to tools.allow if you want those skills available.`,
      );
    }
  } catch {
    // Non-critical — user can always configure manually
  }
}

export default plugin;
