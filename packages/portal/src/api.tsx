import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export type Environment = {
  id: string;
  owner: string;
  profile: string;
  provider: string;
  status: string;
  revision: string;
  image: string;
  url: string;
  expiresAt?: string;
  generation: number;
  operationId: string;
};
export type Operation = {
  id: string;
  environmentId: string;
  status: string;
  phase: string;
  warm: boolean;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  timings: Record<string, string>;
  error?: string;
};
export type Tool = { name: string; description: string; url: string; status: string };
export type Policies = {
  role: string;
  enforcement: string;
  source: string;
  notes: string;
  retrievedAt: string;
  lifecycle: {
    ttl: number;
    maxTTL: number;
    warmTarget: number;
    operationTimeout: number;
    maxPreviews: number;
  };
  clusterPolicies?: unknown;
  clusterError?: string;
};
export type Client = <T>(path: string, method?: string, body?: unknown, key?: string) => Promise<T>;
export function createClient(baseUrl: () => Promise<string>, fetcher: typeof fetch): Client {
  return async <T,>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> => {
    const response = await fetcher((await baseUrl()) + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(data?.error ?? `Request failed (${response.status}). Try again.`);
    return data as T;
  };
}
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Data = {
  client: Client;
  environments: Environment[];
  operations: Operation[];
  loading: boolean;
  error: string;
  updated?: Date;
  refresh: () => Promise<void>;
};
const Context = createContext<Data | null>(null);
export function PlatformProvider({
  client,
  children,
}: React.PropsWithChildren<{ client: Client }>) {
  const [state, setState] = useState<Omit<Data, 'client' | 'refresh'>>({
    environments: [],
    operations: [],
    loading: true,
    error: '',
  });
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(false);
  const refresh = useCallback(
    async (fresh = true) => {
      if (inFlight.current) {
        await inFlight.current;
        if (!fresh) return;
      }
      const pending = Promise.all([
        client<Environment[]>('/environments'),
        client<Operation[]>('/operations'),
      ])
        .then(([environments, operations]) => {
          if (mounted.current)
            setState({
              environments: environments.sort((a, b) => a.id.localeCompare(b.id)),
              operations: operations.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
              loading: false,
              error: '',
              updated: new Date(),
            });
        })
        .catch((e) => {
          if (mounted.current) setState((s) => ({ ...s, loading: false, error: errorText(e) }));
        })
        .finally(() => {
          inFlight.current = null;
        });
      inFlight.current = pending;
      return pending;
    },
    [client],
  );
  useEffect(() => {
    mounted.current = true;
    void refresh(false);
    const timer = setInterval(() => void refresh(false), 5000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  return <Context.Provider value={{ ...state, client, refresh }}>{children}</Context.Provider>;
}
export function usePlatform() {
  const value = useContext(Context);
  if (!value) throw new Error('Platform provider missing');
  return value;
}
export function useResource<T>(path: string) {
  const { client } = usePlatform();
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const version = useRef(0);
  const reload = useCallback(async () => {
    const id = ++version.current;
    setLoading(true);
    setError('');
    try {
      const value = await client<T>(path);
      if (version.current === id) setData(value);
    } catch (e) {
      if (version.current === id) setError(errorText(e));
    } finally {
      if (version.current === id) setLoading(false);
    }
  }, [client, path]);
  useEffect(() => {
    void reload();
    return () => {
      version.current++;
    };
  }, [reload]);
  return { data, error, loading, reload };
}
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const lock = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return {
    busy,
    error,
    notice,
    setNotice,
    run,
    clear: () => {
      setError('');
      setNotice('');
    },
  };
}
export const duration = (start?: string, end?: string) => {
  if (!start || !end) return '—';
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? `${seconds.toFixed(1)}s` : '—';
};
export const dateTime = (value?: string) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
export function safeUrl(value?: string) {
  try {
    const url = new URL(value ?? '');
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
