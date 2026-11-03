import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useAccess } from './auth';
import { adminApi } from './lib/adminApi';
import { backupNotice } from './lib/backupAlert';
import type { SystemHealth } from '../shared/system';
import './backup-alert.css';

/** Mounted only inside the open notification panel; no extra enquiry records or permissions. */
export default function BackupAlert({ enabled = true }: { enabled?: boolean }) {
  const { realUser, user, preview } = useAccess();
  const owner = enabled && realUser?.isAdmin && realUser.isActive && user?.id === realUser.id && !preview ? realUser.id : null;
  const [result, setResult] = useState<{ owner: string; health: SystemHealth | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    if (!owner) return;
    let alive = true, denied = false, controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      if (!alive || denied || document.hidden || controller) return;
      clearTimeout(timer);
      controller = new AbortController();
      setLoading(true);
      try {
        const health = await adminApi.health(controller.signal);
        if (alive) setResult({ owner: owner!, health });
      } catch (error) {
        if (!alive) return;
        const status = (error as { status?: number }).status;
        denied = status === 401 || status === 403;
        setResult(denied ? null : { owner: owner!, health: null });
      } finally {
        controller = undefined;
        if (alive) {
          setLoading(false);
          if (!denied) timer = setTimeout(() => { void check(); }, 30_000);
        }
      }
    }
    const visible = () => { if (!document.hidden) void check(); };
    refresh.current = () => { void check(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', visible);
    void check();
    return () => {
      alive = false; clearTimeout(timer); controller?.abort(); refresh.current = () => {};
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', visible);
    };
  }, [owner]);

  if (!owner || !result || result.owner !== owner) return null;
  const notice = backupNotice(result.health);
  if (!notice) return null;
  return <section className="backup-alert" aria-label="Backup alert" role="status" aria-busy={loading}>
    <div className="backup-alert-heading"><TriangleAlert size={16} aria-hidden="true" /><strong>{notice.title}</strong></div>
    <p>{notice.detail}</p>
    <button type="button" className="ui-button ui-button--secondary" disabled={loading} onClick={() => refresh.current()}>REFRESH</button>
  </section>;
}
