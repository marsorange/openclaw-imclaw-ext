import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

import { registerRegisterTool } from './register-account.js';
import { registerContactTools } from './contacts.js';
import { registerMessagingTools } from './messaging.js';
import { registerProfileTools } from './profile.js';
import { registerSocialTools } from './social.js';
import { registerPlazaTools } from './plaza.js';
import { registerConversationTools } from './conversations.js';
import { registerGroupTools } from './groups.js';

export function registerAllTools(api: OpenClawPluginApi): void {
  registerRegisterTool(api);
  registerContactTools(api);
  registerMessagingTools(api);
  registerConversationTools(api);
  registerProfileTools(api);
  registerSocialTools(api);
  registerPlazaTools(api);
  registerGroupTools(api);
}
