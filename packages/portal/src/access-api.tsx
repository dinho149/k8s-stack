import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, usePlatform } from './api';

// Shapes of the access portal API (docs/teleport/contracts/portal.openapi.yaml), reached through the
// Backstage backend at /access/*.
export type RoleSummary = {
  name: string;
  description?: string;
  node_labels?: Record<string, string[]>;
  db_labels?: Record<string, string[]>;
  kubernetes_labels?: Record<string, string[]>;
  app_labels?: Record<string, string[]>;
  logins?: string[];
  db_users?: string[];
  db_names?: string[];
  kubernetes_groups?: string[];
  can_request_roles?: string[];
  max_session_ttl?: string;
  rules?: string[];
};
export type Whoami = {
  user: string;
  email: string;
  roles: string[];
  traits: Record<string, string[]>;
  active_elevated_roles: Record<string, string>;
  is_approver: boolean;
  effective_access: RoleSummary[];
  note: string;
};
export type RequestableRole = {
  role: string;
  description?: string;
  prediction: string;
  rule?: string;
  approver_roles?: string[];
  ttl_cap?: string;
};
export type Review = { author: string; state: string; reason: string; created: string };
export type AccessRequest = {
  id: string;
  user: string;
  roles: string[];
  resource_ids?: string[];
  reason: string;
  state: string;
  created: string;
  expires: string;
  resolve_reason?: string;
  reviews?: string[];
  reviews_detail?: Review[];
  annotations?: Record<string, string[]>;
  tsh_login_command?: string;
  tsh_status_command?: string;
};
export type Prediction = {
  action: string;
  rule?: string;
  reason?: string;
  ttl_cap?: string;
  approvers?: string[];
};
export type CreateResult = {
  created: boolean;
  dry_run?: boolean;
  request?: AccessRequest;
  prediction?: Prediction | null;
  tsh_command: string;
  note?: string;
  error?: string;
  ttl_clamped_from?: string;
  ttl?: string;
};
export type Resource = {
  kind: string;
  name: string;
  hostname?: string;
  addr?: string;
  description?: string;
  protocol?: string;
  labels: Record<string, string>;
};
export type ApproverInfo = {
  role: string;
  policy_action: string;
  policy_rule: string;
  approver_roles: string[];
  approvers: string[];
  suggested_reviewers?: string[];
  how: string;
  note?: string;
};

/** Fetch an /access path; with `every`, poll it (paused while the tab is hidden) and keep stale data. */
export function useAccess<T>(path: string, every = 0) {
  const { client } = usePlatform();
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [status, setStatus] = useState(0);
  const [loading, setLoading] = useState(true);
  const version = useRef(0);
  const reload = useCallback(async () => {
    const id = ++version.current;
    try {
      const value = await client<T>(path);
      if (version.current === id) {
        setData(value);
        setError('');
        setStatus(200);
      }
    } catch (e) {
      if (version.current === id) {
        setError(errorText(e));
        setStatus(statusOf(e));
      }
    } finally {
      if (version.current === id) setLoading(false);
    }
  }, [client, path]);
  useEffect(() => {
    setLoading(true);
    void reload();
    if (!every) return () => void version.current++;
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, every);
    return () => {
      clearInterval(timer);
      version.current++;
    };
  }, [reload, every]);
  return { data, error, status, loading, reload };
}

const statusOf = (e: unknown) =>
  typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 0;

export const stateTone = (state: string) => state.toLowerCase();
export const predictionLabel = (p?: string) =>
  p === 'auto_approve'
    ? 'Approved automatically'
    : p === 'require_approval'
      ? 'Needs an approver'
      : p === 'deny'
        ? 'Denied by policy'
        : 'Not requestable';
export const predictionTone = (p?: string) => (p ? p.replaceAll('_', '-') : 'not-requestable');
export function expiresIn(iso?: string) {
  if (!iso) return '—';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'expired';
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
export const grantsOf = (r: RoleSummary) =>
  [
    r.node_labels && `servers ${labelText(r.node_labels)}`,
    r.db_labels && `databases ${labelText(r.db_labels)}`,
    r.kubernetes_labels && `kubernetes ${labelText(r.kubernetes_labels)}`,
    r.app_labels && `apps ${labelText(r.app_labels)}`,
  ].filter(Boolean) as string[];
const labelText = (labels: Record<string, string[]>) =>
  Object.entries(labels)
    .map(([k, v]) => `${k}=${v.join('|')}`)
    .join(' ');
export const tshLogin = (id: string) => `tsh login --request-id=${id}`;
