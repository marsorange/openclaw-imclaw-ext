import { AsyncLocalStorage } from 'node:async_hooks';

export interface ToolRuntimeContext {
  accountId: string | null;
  chatType?: string;
  conversationLabel?: string;
  sessionKey?: string;
  senderId?: string;
  originatingTo?: string;
}

const accountStore = new AsyncLocalStorage<ToolRuntimeContext>();

export function runWithToolAccount<T>(
  contextOrAccountId: string | null | undefined | ToolRuntimeContext,
  fn: () => Promise<T>,
): Promise<T> {
  const context: ToolRuntimeContext =
    typeof contextOrAccountId === 'object' && contextOrAccountId !== null
      ? {
          accountId: contextOrAccountId.accountId ?? null,
          chatType: contextOrAccountId.chatType,
          conversationLabel: contextOrAccountId.conversationLabel,
          sessionKey: contextOrAccountId.sessionKey,
          senderId: contextOrAccountId.senderId,
          originatingTo: contextOrAccountId.originatingTo,
        }
      : { accountId: contextOrAccountId ?? null };

  return accountStore.run(context, fn);
}

export function getToolAccountId(): string | null {
  return accountStore.getStore()?.accountId ?? null;
}

export function getToolRuntimeContext(): ToolRuntimeContext | null {
  return accountStore.getStore() ?? null;
}
