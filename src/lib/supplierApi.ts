import { assertLiveDataWritable } from './testWorkspaceGuard';
import { useCallback, useEffect, useState } from 'react';
import type { SupplierRecord, SupplierUpdate, SupplierCreate, SupplierArchive } from '../../shared/suppliers';
import { useAccess } from '../auth';
import { completeSupplierCatalog, type SupplierPage } from './supplierCatalog';
export type { SupplierPage } from './supplierCatalog';
import { assertPreviewWritable } from './previewGuard';

export interface SupplierQuery { search?: string; country?: string; portId?: string; grade?: string; trader?: string; page?: number; limit?: number }
export function supplierQuery(query: SupplierQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
  return params.size ? `?${params}` : '';
}
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (body !== undefined) { assertPreviewWritable(); assertLiveDataWritable(); }
  const response = await fetch(`/api/suppliers/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Eco-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => ({ message: 'Supplier service unavailable.' }));
  if (!response.ok) throw Object.assign(new Error(result.message ?? 'Supplier request failed.'), { status: response.status });
  return result as T;
}
export const supplierApi = {
  picOptions: (signal?: AbortSignal) => request<{ options: string[] }>('pic-options', undefined, signal),
  list: (query: SupplierQuery = {}, signal?: AbortSignal) => request<SupplierPage>(`list${supplierQuery(query)}`, undefined, signal),
  detail: (id: string, signal?: AbortSignal) => request<{ item: SupplierRecord }>(`detail?id=${encodeURIComponent(id)}`, undefined, signal),
  create: (input: SupplierCreate) => request<{ item: SupplierRecord }>('create', input),
  archive: (input: SupplierArchive) => request<{ id: string; revision: number; archivedAt: string }>('archive', input),
  update: (input: SupplierUpdate) => request<{ item: SupplierRecord }>('update', input),
};
export function announceSupplierUpdate(): void { window.dispatchEvent(new Event('eco-suppliers-updated')); }

/** Query-scoped server data. A failed request never falls back to a prototype directory. */
export function useSupplierList(query: SupplierQuery, enabled = true, completeCatalog = false) {
  const { realUser } = useAccess();
  const queryString = supplierQuery(query);
  const key = `${realUser?.id ?? ""}:${enabled}:${completeCatalog}:${queryString}`;
  const [state, setState] = useState<{ key: string; data: SupplierPage | null; error: string; loading: boolean }>({ key: '', data: null, error: '', loading: false });
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  useEffect(() => {
    window.addEventListener('eco-suppliers-updated', refresh);
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('eco-suppliers-updated', refresh); window.removeEventListener('focus', refresh); };
  }, [refresh]);
  useEffect(() => {
    if (!enabled || !realUser) { setState({ key, data: null, error: '', loading: false }); return; }
    const controller = new AbortController();
    setState({ key, data: null, error: '', loading: true });
    const timer = window.setTimeout(() => {
      void (async () => {
        const first = await request<SupplierPage>(`list${queryString}`, undefined, controller.signal);
        if (!completeCatalog) return first;
        return completeSupplierCatalog(first, page => request<SupplierPage>(`list${supplierQuery({ ...query, page })}`, undefined, controller.signal));
      })().then(data => {
        if (!controller.signal.aborted) setState({ key, data, error: '', loading: false });
      }).catch(error => { if (!controller.signal.aborted) setState({ key, data: null, error: error.message, loading: false }); });
    }, query.search ? 180 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, enabled, realUser?.id, generation, completeCatalog]);
  return { data: state.key === key ? state.data : null, error: state.key === key ? state.error : '', loading: enabled && (state.key !== key || state.loading), refresh };
}

/** Only opened workflows load the complete shared catalog; never use the prototype fixtures. */
export function useSupplierCatalog(enabled = true) { return useSupplierList({ limit: 100 }, enabled, true); }
