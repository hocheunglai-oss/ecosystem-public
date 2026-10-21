import { useCallback, useEffect, useState } from 'react';
import { useAccess } from '../auth';
import { supplierApi } from './supplierApi';

/** Authenticated names only, independent of the current supplier filters/page. */
export function useSupplierPicOptions(enabled = true) {
  const { realUser } = useAccess();
  const key = enabled && realUser?.isActive ? realUser.id : '';
  const [state, setState] = useState<{ key: string; options: string[]; loading: boolean; error: string }>({ key: '', options: [], loading: false, error: '' });
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  useEffect(() => {
    window.addEventListener('eco-suppliers-updated', refresh);
    return () => window.removeEventListener('eco-suppliers-updated', refresh);
  }, [refresh]);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    setState(previous => ({ key, options: previous.key === key ? previous.options : [], loading: true, error: '' }));
    void supplierApi.picOptions(controller.signal).then(({ options }) => {
      if (!controller.signal.aborted) setState({ key, options, loading: false, error: '' });
    }).catch((failure: Error) => {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, key, loading: false, error: failure.message }));
    });
    return () => controller.abort();
  }, [key, generation]);
  return {
    options: key && state.key === key ? state.options : [],
    loading: Boolean(key && (state.key !== key || state.loading)),
    error: key && state.key === key ? state.error : '',
    refresh,
  };
}
