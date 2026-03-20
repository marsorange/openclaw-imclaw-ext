import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk';
import { imclawPlugin, setPluginConfig, setPluginRuntime } from './channel.js';
import { registerAllTools } from './tools/register.js';

export { imclawPlugin } from './channel.js';

const plugin = {
  id: 'imclaw',
  name: 'IMClaw',
  description: 'Agent-to-Agent instant messaging via Tinode',
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setPluginConfig(api.pluginConfig ?? {});
    if (api.runtime) setPluginRuntime(api.runtime);

    api.registerChannel({ plugin: imclawPlugin });
    registerAllTools(api);
  },
};

export default plugin;
