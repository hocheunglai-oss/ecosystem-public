import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PhoneChangeRequest } from '../shared/access';
import { accessRequest, useAccess } from './auth';
import './phone-change-requests.css';

type PhoneRequestsContext = {
  requests: PhoneChangeRequest[];
  pendingRequests: PhoneChangeRequest[];
  pendingCount: number;
  loading: boolean;
  error: string;
  busy: boolean;
  refresh(): Promise<void>;
  submitRequest(requestId: string, phone: string): Promise<PhoneChangeRequest>;
  reviewRequest(id: string, decision: 'approve' | 'decline'): Promise<PhoneChangeRequest>;
};
const Context = createContext<PhoneRequestsContext | null>(null);
const message = (error: unknown) => error instanceof Error ? error.message : 'Phone requests could not be loaded.';

/** A single authenticated feed serves Personal Details, Users & Access and the notification bell. */
export function PhoneChangeRequestsProvider({ children }: { children: ReactNode }) {
  const access = useAccess();
  const userId = access.realUser?.id;
  const [requests, setRequests] = useState<PhoneChangeRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const currentUserId = useRef(userId);
  currentUserId.current = userId;

  const refresh = useCallback(async () => {
    if (!userId || inFlight.current) return;
    const current = ++generation.current;
    try {
      const result = await accessRequest<{ requests: PhoneChangeRequest[] }>('phone-requests');
      if (current !== generation.current || currentUserId.current !== userId) return;
      setRequests(result.requests); setError('');
    } catch (failure) {
      if (current === generation.current && currentUserId.current === userId) setError(message(failure));
    } finally {
      if (current === generation.current && currentUserId.current === userId) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    ++generation.current; setRequests([]); setError(''); setLoading(Boolean(userId));
    if (!userId) return;
    void refresh();
    const check = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(check, 60_000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('eco-phone-requests') : null;
    if (channel) channel.onmessage = check;
    return () => {
      ++generation.current; window.clearInterval(timer); channel?.close();
      window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check);
    };
  }, [userId, refresh]);

  async function mutate(path: string, body: unknown): Promise<PhoneChangeRequest> {
    if (!userId || access.preview) throw new Error('Return to your account to make changes.');
    if (inFlight.current) throw new Error('Wait for the current request to finish.');
    inFlight.current = true; ++generation.current; setBusy(true);
    try {
      const result = await accessRequest<{ request: PhoneChangeRequest }>(path, body);
      if (currentUserId.current === userId) {
        setRequests(previous => [result.request, ...previous.filter(item => item.id !== result.request.id)]);
        setError('');
        if (result.request.userId === userId && result.request.status === 'approved') void access.refresh();
      }
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('eco-phone-requests'); channel.postMessage('refresh-needed'); channel.close();
      }
      return result.request;
    } finally {
      inFlight.current = false; setBusy(false); setLoading(false);
      if (currentUserId.current === userId) void refresh();
    }
  }

  const pendingRequests = access.user?.isAdmin && !access.preview
    ? requests.filter(request => request.status === 'pending').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)) : [];
  return <Context.Provider value={{ requests, pendingRequests, pendingCount: pendingRequests.length, loading, error, busy, refresh,
    submitRequest: (requestId, phone) => mutate('phone-requests', { requestId, phone }),
    reviewRequest: (id, decision) => mutate('phone-requests/review', { id, decision }),
  }}>{children}</Context.Provider>;
}

export function usePhoneChangeRequests() {
  const context = useContext(Context);
  if (!context) throw new Error('Missing phone requests context.');
  return context;
}

function requestedTime(date: string) {
  return new Date(date).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function PhoneChangeRequestQueue({ compact = false, disabled = false, onReviewed }: {
  compact?: boolean; disabled?: boolean; onReviewed?: (request: PhoneChangeRequest) => void;
}) {
  const access = useAccess();
  const { pendingRequests, loading, error, busy, reviewRequest, refresh } = usePhoneChangeRequests();
  const [reviewError, setReviewError] = useState('');
  const [notice, setNotice] = useState('');
  if (!access.user?.isAdmin || access.preview) return null;
  if (!pendingRequests.length && !error && !reviewError && !notice && !loading) return null;
  async function review(request: PhoneChangeRequest, decision: 'approve' | 'decline') {
    setReviewError(''); setNotice('');
    try {
      const result = await reviewRequest(request.id, decision);
      setNotice(result.status === 'approved' ? 'Phone number updated.' : result.status === 'declined' ? 'Phone change declined.' : 'Request no longer pending.');
      onReviewed?.(result);
    } catch (failure) { setReviewError(message(failure)); }
  }
  return <section className={`phone-requests${compact ? ' phone-requests--compact' : ''}`} aria-label="Phone change requests" aria-busy={busy || loading}>
    <header><h3>Phone change requests{pendingRequests.length > 0 ? ` (${pendingRequests.length})` : ''}</h3></header>
    {(reviewError || error) && <div className="phone-request-message is-error" role="alert"><p>{reviewError || error}</p>
      <button type="button" className="ui-button" disabled={busy} onClick={() => { setReviewError(''); void refresh(); }}>Refresh</button></div>}
    {notice && <p className="phone-request-message" role="status">{notice}</p>}
    {loading && !pendingRequests.length && <p className="phone-request-message" role="status">Loading requests…</p>}
    <div className="phone-request-list">{pendingRequests.map(request => <article key={request.id} className="phone-request" aria-label={`Phone change for ${request.displayName}`}>
      <div className="phone-request-person"><strong>{request.displayName}</strong><span>{request.officeName}</span></div>
      {!compact && <span className="phone-request-email" data-email-value>{request.email}</span>}
      <dl><div><dt>Current number</dt><dd>{request.currentPhone || '—'}</dd></div><div><dt>Requested number</dt><dd>{request.requestedPhone}</dd></div></dl>
      <div className="phone-request-footer"><time dateTime={request.requestedAt}>{requestedTime(request.requestedAt)}</time>
        <div className="phone-request-actions"><button type="button" className="ui-button" disabled={busy || disabled} onClick={() => void review(request, 'decline')}>Decline</button>
          <button type="button" className="ui-button ui-button--primary" disabled={busy || disabled} onClick={() => void review(request, 'approve')}>Approve</button></div>
      </div>
    </article>)}</div>
  </section>;
}
