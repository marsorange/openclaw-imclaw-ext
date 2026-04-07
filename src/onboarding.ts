import type {
  ChannelOnboardingAdapter,
  WizardPrompter,
  OpenClawConfig,
} from 'openclaw/plugin-sdk';
import { DEFAULT_ACCOUNT_ID, promptAccountId } from 'openclaw/plugin-sdk';
import { loadCredsCache } from './channel.js';
import { DEFAULT_HUMAN_API_URL } from './defaults.js';

const channel = 'imclaw' as const;

// ─── Config helpers ───

function listImclawAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg as any).channels?.imclaw?.accounts;
  if (accounts && typeof accounts === 'object') {
    const ids = Object.keys(accounts).filter(Boolean);
    if (ids.length > 0) return ids;
  }
  return [DEFAULT_ACCOUNT_ID];
}

function resolveImclawAccount(cfg: OpenClawConfig, accountId: string): Record<string, any> {
  const accounts = (cfg as any).channels?.imclaw?.accounts;
  return accounts?.[accountId] ?? {};
}

function isImclawConfigured(cfg: OpenClawConfig): boolean {
  // Configured if any account has a connectKey, username, or cached creds exist
  const accountIds = listImclawAccountIds(cfg);
  for (const id of accountIds) {
    const acct = resolveImclawAccount(cfg, id);
    if (acct.connectKey || acct.username) return true;
  }
  return Object.keys(loadCredsCache()).length > 0;
}

function patchImclawAccount(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Record<string, unknown>,
): OpenClawConfig {
  const channelConfig = (cfg as any).channels?.imclaw ?? {};
  const accounts = channelConfig.accounts ?? {};
  const existing = accounts[accountId] ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      imclaw: {
        ...channelConfig,
        enabled: true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...existing,
            enabled: existing.enabled ?? true,
            ...patch,
          },
        },
      },
    },
  } as OpenClawConfig;
}

// ─── Setup help note ───

async function noteImclawSetupHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      'Option A: Register via agent (recommended)',
      '  Use the imclaw_register tool to register a new account.',
      '  The agent will guide you through phone verification.',
      '',
      'Option B: Connect key (existing account)',
      '  1) Go to IMClaw Dashboard and log in',
      '  2) Copy the connect key (looks like imclaw_ck_...)',
      '  3) The key expires in 24 hours and is single-use',
      '',
      `Default server: ${DEFAULT_HUMAN_API_URL}`,
    ].join('\n'),
    'IMClaw setup',
  );
}

// ─── Onboarding adapter ───

export const imclawOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const configured = isImclawConfigured(cfg as OpenClawConfig);
    return {
      channel,
      configured,
      statusLines: [`IMClaw: ${configured ? 'configured' : 'needs connect key'}`],
      selectionHint: configured ? 'configured' : 'needs connect key from Dashboard',
      quickstartScore: configured ? 1 : 0,
    };
  },

  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
  }) => {
    let next = cfg as OpenClawConfig;
    const defaultAccountId = DEFAULT_ACCOUNT_ID;
    const override = (accountOverrides as any).imclaw?.trim();
    let accountId = override || defaultAccountId;

    if (shouldPromptAccountIds && !override) {
      // Only prompt for account selection when multiple accounts already exist
      // (multi-agent scenario). Single-account setups skip this step entirely.
      const existingIds = listImclawAccountIds(next);
      if (existingIds.length > 1) {
        await prompter.note(
          'You have multiple IMClaw agent accounts configured.\nSelect which account to configure, or add a new one.',
          'Multi-agent setup',
        );
        accountId = await promptAccountId({
          cfg: next,
          prompter,
          label: 'IMClaw',
          currentId: accountId,
          listAccountIds: listImclawAccountIds,
          defaultAccountId,
        });
      }
    }

    const existing = resolveImclawAccount(next, accountId);
    const alreadyConfigured = Boolean(existing.connectKey || existing.username);

    if (alreadyConfigured) {
      const keep = await prompter.confirm({
        message: 'IMClaw is already configured. Keep current settings?',
        initialValue: true,
      });
      if (keep) {
        return { cfg: next, accountId };
      }
    }

    await noteImclawSetupHelp(prompter);

    // Prompt for connect key
    const connectKey = String(
      await prompter.text({
        message: 'IMClaw connect key',
        placeholder: 'imclaw_ck_...',
        validate: (value) => {
          const v = String(value ?? '').trim();
          if (!v) return 'Connect key is required';
          if (!v.startsWith('imclaw_ck_')) return 'Connect key should start with imclaw_ck_';
          return undefined;
        },
      }),
    ).trim();

    // Prompt for agent display name (optional)
    const agentName = String(
      await prompter.text({
        message: 'Agent display name (shown to other agents)',
        placeholder: 'My Agent',
        initialValue: existing.agentName || undefined,
      }) ?? '',
    ).trim();

    const patch: Record<string, unknown> = { connectKey };
    if (agentName) {
      patch.agentName = agentName;
    }

    next = patchImclawAccount(next, accountId, patch);

    await prompter.note(
      [
        'The connect key will be exchanged for credentials on next gateway start.',
        'If gateway is running, it will auto-reload on config change.',
      ].join('\n'),
      'IMClaw next steps',
    );

    return { cfg: next, accountId };
  },

  disable: (cfg) => {
    const channelConfig = (cfg as any).channels?.imclaw ?? {};
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        imclaw: {
          ...channelConfig,
          enabled: false,
        },
      },
    } as OpenClawConfig;
  },
};
