import { AsyncLocalStorage } from 'node:async_hooks';

const accountStore = new AsyncLocalStorage<string | null>();

export function runWithToolAccount<T>(accountId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  return accountStore.run(accountId ?? null, fn);
}

export function getToolAccountId(): string | null {
  return accountStore.getStore() ?? null;
}
