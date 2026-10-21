import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { applicableSuggestions, PARSER_TEXT_LIMIT, PARSER_VERSION, parserFieldLabels, type ParserFields, type ParserField, type ParserFixResult, type ParserSuggestion } from '../shared/parserService';
import { useAccess } from './auth';
import { useTestWorkspace } from './TestWorkspace';
import { parserApi } from './lib/parserApi';
import './parser-service.css';
import type { CapturedAiAttempt } from './ParserReportPreview';
export default function ParserFixPanel({ rawText, current, sourceRevision, manual, disabled, onApply, onReceipt, onBusyChange }: { rawText: string; current: ParserFields; sourceRevision: string; manual: ReadonlySet<ParserField>; disabled: boolean; onReceipt?(attempt: CapturedAiAttempt): void; onBusyChange?(busy: boolean): void; onApply(items: ParserSuggestion[], warnings: string[], requestId: string): void }) {
  const { user, preview } = useAccess();
  const { dataMode, generation } = useTestWorkspace();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  function updateBusy(value: boolean) { setBusy(value); busyCallback.current?.(value); }
  const [proposal, setProposal] = useState<{ result: ParserFixResult; before: ParserFields } | null>(null);
  const [selected, setSelected] = useState<ParserField[]>([]);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const controller = useRef<AbortController | null>(null), epoch = useRef(0);
  const latest = useRef({ rawText, sourceRevision, dataMode, generation, userId: user?.id });
  latest.current = { rawText, sourceRevision, dataMode, generation, userId: user?.id };
  useEffect(() => () => { epoch.current++; controller.current?.abort(); busyCallback.current?.(false); }, []);
  useEffect(() => { epoch.current++; controller.current?.abort(); updateBusy(false); setProposal(null); setSelected([]); setError(''); request.current = null; }, [dataMode, generation, user?.id]);
  const allowed = proposal ? applicableSuggestions(proposal.result, sourceRevision, proposal.before, current, manual) : [];
  const stale = Boolean(proposal && proposal.result.sourceRevision !== sourceRevision);
  async function fix() {
    if (disabled || preview || busy || !rawText.trim() || dataMode === 'test' && !generation) return;
    if (new TextEncoder().encode(rawText).byteLength > PARSER_TEXT_LIMIT) { setError('Enquiry exceeds 20 KB.'); return; }
    const input = { rawText, current, sourceRevision, parserVersion: PARSER_VERSION, dataMode, ...(dataMode === 'test' ? { generation } : {}) };
    const fingerprint = JSON.stringify(input);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    const requestId = request.current.id, run = ++epoch.current;
    controller.current?.abort(); controller.current = new AbortController(); updateBusy(true); setError(''); setProposal(null);
    try {
      const result = await parserApi.fix({ ...input, requestId }, controller.current.signal);
      if (run !== epoch.current || latest.current.rawText !== rawText || latest.current.dataMode !== dataMode || latest.current.generation !== generation || latest.current.userId !== user?.id) return;
      if (result.sourceRevision !== sourceRevision || result.requestId !== requestId || result.parserVersion !== PARSER_VERSION) throw new Error('AI response does not match this enquiry.');
      onReceipt?.({ id: requestId, raw: rawText, state: 'complete', before: { ...current }, result });
      if (latest.current.sourceRevision !== sourceRevision) return;
      setProposal({ result, before: current });
      setSelected(applicableSuggestions(result, sourceRevision, current, current, manual).map(item => item.field));
    } catch (failure) {
      if (run !== epoch.current || latest.current.rawText !== rawText || latest.current.dataMode !== dataMode || latest.current.generation !== generation || latest.current.userId !== user?.id) return;
      const receiptState = (failure as {operationState?: string}).operationState;
      if (['pending', 'failed'].includes(receiptState ?? '') && latest.current.rawText === rawText && latest.current.dataMode === dataMode && latest.current.generation === generation) onReceipt?.({ id: requestId, raw: rawText, state: receiptState as 'pending' | 'failed', before: { ...current } });
      setError(failure instanceof Error ? failure.message : 'AI FIX unavailable.');
      if ((failure as {operationState?: string}).operationState === 'failed') request.current = null;
    } finally { if (run === epoch.current) updateBusy(false); }
  }
  return <div className="parser-ai">
    <button className="button secondary" disabled={disabled || Boolean(preview) || busy || !rawText.trim() || dataMode === 'test' && !generation} onClick={() => void fix()}><Sparkles size={15} />{busy ? 'AI FIX…' : 'AI FIX'}</button>
    {error && <p role="alert">{error}</p>}
    {proposal && <section className="parser-ai-review" aria-label="AI suggestions">
      <header><strong>AI SUGGESTIONS</strong><button className="ui-button" onClick={() => setProposal(null)}>CLOSE</button></header>
      {stale ? <p role="status">ENQUIRY CHANGED. RUN AI FIX AGAIN.</p> : allowed.length ? <>
        <div className="parser-ai-fields">{allowed.map(item => <label key={item.field}>
          <input type="checkbox" checked={selected.includes(item.field)} onChange={event => setSelected(value => event.target.checked ? [...value, item.field] : value.filter(key => key !== item.field))} />
          <span><strong>{parserFieldLabels[item.field]}</strong><span>{current[item.field] || '—'} → {item.value}</span><small>{item.evidence}</small></span>
        </label>)}</div>
        <button className="button primary" disabled={disabled || Boolean(preview) || !selected.some(key => allowed.some(item => item.field === key))} onClick={() => { onApply(allowed.filter(item => selected.includes(item.field)), proposal.result.warnings, proposal.result.requestId); setProposal(null); }}>APPLY SELECTED</button>
      </> : <p>NO APPLICABLE CHANGES.</p>}
      {proposal.result.warnings.length > 0 && <ul>{proposal.result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    </section>}
  </div>;
}
