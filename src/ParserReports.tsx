import { useEffect, useRef, useState } from 'react';
import { parserFieldKeys, parserFieldLabels, type ParserReport, type ParserReportDetail, type ParserReportPage, type ParserReportSummary, type ParserSnapshot, type ParserReviewAnalysis, type ParserReviewInput } from '../shared/parserService';
import { useAccess } from './auth';
import { useTestWorkspace } from './TestWorkspace';
import { parserApi } from './lib/parserApi';
import { formatEnquiry } from './lib/parser';
import { canReadParserReports } from './lib/testWorkspace';
import './parser-service.css';

type Queue = 'pending_user' | 'pending_ai' | 'reviewed' | 'all';
const queueLabels: Record<Queue, string> = { pending_user: 'PENDING YOUR REVIEW', pending_ai: 'PENDING AI REVIEW', reviewed: 'REVIEWED', all: 'ALL REPORTS' };
const time = (value: string) => `${new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Hong_Kong' })} HKT`;
const legacySnapshot = (fields: ParserSnapshot['fields']): ParserSnapshot => ({ fields, standardText: '', warnings: [], rmk: false, viscosity: [] });
function fallbackDetail(item: ParserReport): ParserReportDetail {
  return { ...item, sourceHash: '', buildFingerprint: null, workflow: { revision: 0, stage: 'pending_user', expected: null, notes: '', aiReview: null, replay: null }, originalAi: null, history: [] };
}
function snapshotValue(snapshot: ParserSnapshot, key: string): string {
  if (parserFieldKeys.includes(key as keyof ParserSnapshot['fields'])) return snapshot.fields[key as keyof ParserSnapshot['fields']] || '—';
  if (key === 'rmk') return snapshot.rmk ? 'YES' : 'NO';
  if (key === 'standardText') return snapshot.standardText || '—';
  return (key === 'viscosity' ? snapshot.viscosity : snapshot.warnings).join(', ') || '—';
}
function updateStructuredSnapshot(value: ParserSnapshot, patch: Partial<Pick<ParserSnapshot, 'fields' | 'rmk' | 'viscosity'>>): ParserSnapshot {
  const next = { ...value, ...patch };
  return { ...next, standardText: formatEnquiry({ ...next.fields, buyerName: next.fields.buyerText, portName: next.fields.portText, rmk: next.rmk, vlsfoMaxRemarks: next.viscosity }) };
}
function SnapshotDetails({ title, value }: { title: string; value?: ParserSnapshot }) {
  return <details><summary>{title}</summary>{value ? <><pre className="parser-source">{value.standardText || 'NO STANDARD FORMAT CAPTURED.'}</pre><p className="admin-meta">RMK: {value.rmk ? 'YES' : 'NO'} · VISCOSITY: {value.viscosity.join(', ') || '—'}</p>{value.warnings.length > 0 && <ul>{value.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}</> : <p>NOT CAPTURED IN THIS LEGACY REPORT.</p>}</details>;
}
function Analysis({ value }: { value: ParserReviewAnalysis }) {
  return <section aria-label="AI review result"><h4>AI REVIEW RESULT</h4><p className="admin-meta">{value.model}</p><details><summary>AI REVIEW DETAILS</summary><p className="admin-reference">{value.requestId}</p><p className="admin-meta">REVIEW REVISION: {value.revision}</p></details><h4>DIAGNOSIS</h4><p>{value.diagnosis}</p><h4>PROPOSED PARSER CHANGE</h4><p>{value.proposedFix}</p>{value.regressionExamples.length > 0 && <><h4>PROPOSED REGRESSION CASES</h4>{value.regressionExamples.map((example, i) => <div key={i}><pre className="parser-source">{example.rawText}</pre><p>{example.reason}</p></div>)}</>}{value.warnings.length > 0 && <ul>{value.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}</section>;
}

export default function ParserReports() {
  const { user, realUser, preview } = useAccess(), { dataMode, generation } = useTestWorkspace();
  const allowed = canReadParserReports(realUser, preview, dataMode, generation);
  const scopeKey = `${user?.id ?? ''}:${dataMode}:${generation ?? ''}:${Boolean(preview)}`;
  const scope = { dataMode, ...(dataMode === 'test' ? { generation } : {}) };
  const [data, setData] = useState<ParserReportPage | null>(null), [selected, setSelected] = useState<ParserReportDetail | null>(null);
  const [pageCursor, setPageCursor] = useState<string | undefined>();
  const [queue, setQueue] = useState<Queue>('pending_user'), [visibleScope, setVisibleScope] = useState(scopeKey);
  const [expected, setExpected] = useState<ParserSnapshot | null>(null), [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false);
  const [discard, setDiscard] = useState<(() => void) | null>(null);
  const epoch = useRef(0), controller = useRef<AbortController | null>(null), operation = useRef<{ key: string; id: string } | null>(null);
  const detailElement = useRef<HTMLElement | null>(null);
  const baseline = selected?.workflow.expected ?? selected?.capture?.submitted ?? (selected ? legacySnapshot(selected.corrected) : null);
  const dirty = selected?.workflow.stage === 'pending_user' && (JSON.stringify(expected) !== JSON.stringify(baseline) || notes !== selected.workflow.notes);
  function begin(label: string) {
    const current = ++epoch.current; controller.current?.abort(); controller.current = new AbortController(); setBusy(label); setError(''); setNotice(''); setConflict(false);
    return { current, signal: controller.current.signal };
  }
  function accept(item: ParserReportDetail) {
    setSelected(item); setExpected(item.workflow.expected ?? item.capture?.submitted ?? legacySnapshot(item.corrected)); setNotes(item.workflow.notes); setDiscard(null); operation.current = null;
  }
  function navigate(action: () => void) { if (busy) return; if (dirty) setDiscard(() => action); else action(); }
  async function load(nextQueue = queue, cursor?: string) {
    if (!allowed) return;
    const { current, signal } = begin('LOADING PARSER REPORTS…'); setSelected(null); setExpected(null); setData(null); setQueue(nextQueue); setPageCursor(cursor);
    try { const result = await parserApi.reports(scope, cursor, signal, nextQueue); if (current === epoch.current) setData(result); }
    catch (failure) { if (current === epoch.current) setError(failure instanceof Error ? failure.message : 'PARSER REPORTS UNAVAILABLE.'); }
    finally { if (current === epoch.current) setBusy(''); }
  }
  async function open(item: ParserReport | ParserReportSummary, force = false) {
    if (!allowed) return;
    const { current, signal } = begin('LOADING PARSER REPORT…');
    try {
      // Older deployments/mocks return capture-only rows. Do not invent missing history or AI output.
      const result = force || 'workflow' in item ? await parserApi.reportDetail(item.id, scope, signal) : fallbackDetail(item);
      if (current === epoch.current) { accept(result); requestAnimationFrame(() => detailElement.current?.scrollIntoView({ block: 'start', behavior: 'instant' })); }
    } catch (failure) { if (current === epoch.current) setError(failure instanceof Error ? failure.message : 'PARSER REPORT UNAVAILABLE.'); }
    finally { if (current === epoch.current) setBusy(''); }
  }
  async function act(action: 'approve' | 'review-ai' | 'complete' | 'replay' | 'reopen') {
    if (!allowed || !selected || busy || !expected) return;
    const base = { reportId: selected.id, expectedRevision: selected.workflow.revision, ...scope };
    const payload = action === 'approve' ? { ...base, action, expected: { ...expected, warnings: expected.warnings.map(value => value.trim()).filter(Boolean) }, notes } : action === 'complete' ? { ...base, action, aiRequestId: selected.workflow.aiReview?.requestId ?? '' } : { ...base, action };
    const key = JSON.stringify(payload); if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    const requestId = operation.current.id, { current, signal } = begin(action === 'review-ai' ? 'AI REVIEW IN PROGRESS…' : action === 'replay' ? 'REPLAYING CURRENT PARSER…' : 'SAVING REVIEW…');
    try {
      if (action === 'review-ai') {
        const result = await parserApi.reviewAi({ ...base, requestId }, signal);
        if (current === epoch.current) {
          accept({ ...selected, workflow: { ...selected.workflow, aiReview: result } }); setNotice('AI REVIEW SAVED.');
          try { const refreshed = await parserApi.reportDetail(selected.id, scope, signal); if (current === epoch.current) accept(refreshed); } catch { /* The successful receipt remains available; history can be refreshed later. */ }
        }
      } else {
        const result = await parserApi.review({ ...payload, requestId } as ParserReviewInput, signal);
        if (current === epoch.current) { accept(result); setData(value => value ? { ...value, items: value.items.map(item => item.id === result.id ? result : item) } : value); setNotice(action === 'approve' ? 'SENT TO AI REVIEW.' : action === 'complete' ? 'REVIEW COMPLETE.' : action === 'reopen' ? 'REVIEW REOPENED.' : 'PARSER REPLAY SAVED.'); }
      }
    } catch (failure) {
      if (current === epoch.current) { if ((failure as { operationState?: string }).operationState === 'failed') operation.current = null; setError(failure instanceof Error ? failure.message : 'REVIEW COULD NOT BE SAVED.'); setConflict((failure as { status?: number }).status === 409); }
    } finally { if (current === epoch.current) setBusy(''); }
  }
  function exportCase() {
    if (!selected || selected.workflow.stage !== 'reviewed' || !selected.workflow.expected) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 1, kind: 'eco-parser-reviewed-case', exportedAt: new Date().toISOString(), dataMode, report: selected }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `eco-parser-case-${selected.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  useEffect(() => {
    setVisibleScope(scopeKey); setData(null); setSelected(null); setExpected(null); setNotes(''); setDiscard(null); setError(''); setNotice(''); operation.current = null; void load('pending_user');
    return () => { epoch.current++; controller.current?.abort(); };
  }, [allowed, scopeKey]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  if (!allowed || visibleScope !== scopeKey) return null;
  const original = selected?.capture?.original.fields ?? selected?.parsed;
  const submitted = selected?.capture?.submitted.fields ?? selected?.corrected;
  const originalLabel = selected?.capture?.parseOrigin === 'reparsed' ? 'CAPTURED REPARSE' : 'ORIGINAL PARSE';
  const invalidWarnings = Boolean(expected && (expected.warnings.length > 100 || expected.warnings.some(value => value.length > 2000)));
  return <section className="parser-reports" aria-label="Parser reports">
    <div className="admin-heading"><h2>PARSER REPORTS</h2><button className="ui-button" onClick={() => navigate(() => void load())} disabled={Boolean(busy)}>REFRESH</button></div>
    <div className="admin-toolbar"><label className="field">REVIEW QUEUE<select aria-label="Review queue" value={queue} disabled={Boolean(busy)} onChange={event => { const next = event.target.value as Queue; navigate(() => void load(next)); }}>{Object.entries(queueLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {discard && <div className="admin-notice" role="alert"><strong>UNSAVED CHANGES</strong><div className="admin-actions"><button className="ui-button" onClick={() => setDiscard(null)}>KEEP EDITING</button><button className="ui-button ui-button--danger" onClick={() => { const action = discard; setDiscard(null); action(); }}>DISCARD CHANGES</button></div></div>}
    {error && <div className="admin-error" role="alert">{error}{conflict && selected && <div className="admin-actions"><button className="ui-button" onClick={() => navigate(() => void open(selected, true))}>RELOAD LATEST</button></div>}</div>}
    {busy && <p role="status">{busy}</p>}{notice && <p role="status">{notice}</p>}
    <div className="admin-results">
      {!selected && <div className="admin-records">{data?.items.map(item => <button className="admin-record" key={item.id} onClick={() => void open(item)} disabled={Boolean(busy)}><strong>{item.corrected.vessel || item.parsed.vessel || 'ENQUIRY'}</strong><span className="admin-meta">{time(item.createdAt)} · {queueLabels[item.workflow?.stage ?? 'pending_user']}</span></button>)}{!busy && !error && data?.items.length === 0 && <p>NO PARSER REPORTS.</p>}{data?.nextCursor && <button className="ui-button" disabled={Boolean(busy)} onClick={() => void load(queue, data.nextCursor!)}>NEXT</button>}</div>}
      {selected && original && submitted && expected && <aside ref={detailElement} className="admin-detail" aria-label="Parser report details">
        <header><div><h3>PARSER REPORT</h3><span className="admin-status">{queueLabels[selected.workflow.stage]}</span></div><button className="ui-button" disabled={Boolean(busy)} onClick={() => navigate(() => void load(queue, pageCursor))}>CLOSE</button></header>
        <details><summary>REPORT DETAILS</summary><p className="admin-reference">PARSER: {selected.parserVersion}</p><p className="admin-reference">SOURCE REVISION: {selected.sourceRevision}</p>{selected.buildFingerprint && <p className="admin-reference">REPORTED BUILD: {selected.buildFingerprint}</p>}</details>
        {selected.capture?.parseOrigin === 'reparsed' && <p className="admin-notice">CURRENT REPARSE CAPTURED. THE HISTORICAL INITIAL PARSE WAS NOT AVAILABLE.</p>}<h4>ORIGINAL ENQUIRY</h4><pre className="parser-source">{selected.rawText}</pre>
        {!selected.capture && <p className="admin-notice">LEGACY REPORT: STANDARD FORMAT AND CAUTION SNAPSHOTS WERE NOT CAPTURED.</p>}
        <div className="parser-report-diff"><section className="parser-diff-header"><strong>FIELD</strong><strong>{originalLabel}</strong><strong>SUBMITTED CORRECTION</strong></section>{parserFieldKeys.map(key => <section key={key}><strong>{parserFieldLabels[key]}</strong><span><small className="parser-mobile-label">{originalLabel}</small>{original[key] || '—'}</span><span><small className="parser-mobile-label">SUBMITTED CORRECTION</small>{submitted[key] || '—'}</span></section>)}</div>
        <SnapshotDetails title={selected.capture?.parseOrigin === 'reparsed' ? 'REPARSED FORMAT AND CAUTIONS' : 'ORIGINAL FORMAT AND CAUTIONS'} value={selected.capture?.original} /><SnapshotDetails title="SUBMITTED FORMAT AND CAUTIONS" value={selected.capture?.submitted} />
        <section aria-label="Original AI result"><h4>ORIGINAL AI RESULT</h4>{selected.originalAi ? <><p className="admin-meta">{selected.originalAi.state.toUpperCase()}</p><details><summary>AI REQUEST DETAILS</summary><p className="admin-reference">{selected.originalAi.requestId}</p><p className="admin-reference">SOURCE REVISION: {selected.originalAi.input.sourceRevision}</p></details>{selected.originalAi.errorCode && <p>{selected.originalAi.errorCode.replaceAll('_', ' ')}</p>}{selected.originalAi.result ? <><p className="admin-reference">{selected.originalAi.result.model}</p><div className="parser-report-diff"><section className="parser-diff-header"><strong>FIELD</strong><strong>BEFORE AI FIX</strong><strong>VALIDATED AI SUGGESTION</strong></section>{selected.originalAi.result.suggestions.map((suggestion, i) => <section key={i}><strong>{parserFieldLabels[suggestion.field]}</strong><span><small className="parser-mobile-label">BEFORE AI FIX</small>{selected.originalAi?.input.current[suggestion.field] || '—'}</span><span><small className="parser-mobile-label">VALIDATED AI SUGGESTION</small>{suggestion.value}<p className="admin-meta">SOURCE EVIDENCE: {suggestion.evidence}</p></span></section>)}</div>{selected.originalAi.result.warnings.length > 0 && <ul>{selected.originalAi.result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}</> : <p>{selected.originalAi.state === 'pending' ? 'AI REQUEST IS PENDING.' : 'NO SUCCESSFUL AI RESULT.'}</p>}</> : <p>{selected.aiRequestId ? 'AI RESULT WAS NOT RETAINED FOR THIS LEGACY REPORT.' : selected.capture ? 'NO AI REQUEST LINKED.' : 'NO AI RESULT RECORDED. LEGACY REPORTS MAY OMIT UNAPPLIED AI RESULTS.'}</p>}</section>
        {selected.notes && <><h4>REPORT NOTE</h4><p>{selected.notes}</p></>}
        <section aria-label="Reviewed correction"><h4>REVIEWED CORRECTION</h4><div className="admin-panels">{parserFieldKeys.map(key => <label key={key} className="field">{parserFieldLabels[key]}<input aria-label={`Reviewed ${parserFieldLabels[key]}`} value={expected.fields[key]} maxLength={key === 'remarks' ? 3000 : 500} disabled={Boolean(busy) || selected.workflow.stage !== 'pending_user'} onChange={event => setExpected(updateStructuredSnapshot(expected, { fields: { ...expected.fields, [key]: event.target.value } }))} /></label>)}</div><label className="field">STANDARD FORMAT<textarea aria-label="Reviewed standard format" rows={5} value={expected.standardText} maxLength={20000} disabled={Boolean(busy) || selected.workflow.stage !== 'pending_user'} onChange={event => setExpected({ ...expected, standardText: event.target.value })} /></label>
          <div className="users-access-permissions"><label className="access-checkbox"><input type="checkbox" checked={expected.rmk} disabled={Boolean(busy) || selected.workflow.stage !== 'pending_user'} onChange={event => setExpected(updateStructuredSnapshot(expected, { rmk: event.target.checked }))} />RMK</label>{['80cst min', '80cst max', '120cst max', '180cst max'].map(value => <label className="access-checkbox" key={value}><input type="checkbox" checked={expected.viscosity.includes(value)} disabled={Boolean(busy) || selected.workflow.stage !== 'pending_user'} onChange={event => setExpected(updateStructuredSnapshot(expected, { viscosity: event.target.checked ? [...expected.viscosity, value] : expected.viscosity.filter(item => item !== value) }))} />{value.toUpperCase()}</label>)}</div>
          <label className="field">REVIEWED CAUTIONS<textarea aria-label="Reviewed cautions" rows={3} value={expected.warnings.join('\n')} maxLength={200100} disabled={Boolean(busy) || selected.workflow.stage !== 'pending_user'} onChange={event => setExpected({ ...expected, warnings: event.target.value.split('\n') })} /></label>{invalidWarnings && <p className="admin-error" role="alert">USE UP TO 100 CAUTIONS, WITH 2000 CHARACTERS PER LINE.</p>}
          <label className="field">REVIEW NOTE<textarea aria-label="Review note" rows={3} value={notes} maxLength={2000} disabled={Boolean(busy) || selected.workflow.stage !== 'pending_user'} onChange={event => setNotes(event.target.value)} /></label>
          {selected.workflow.stage === 'pending_user' && <button className="ui-button ui-button--primary" disabled={Boolean(busy) || invalidWarnings} onClick={() => void act('approve')}>SEND TO AI REVIEW</button>}
        </section>
        {selected.workflow.stage !== 'pending_user' && <><div className="admin-actions"><button className="ui-button" disabled={Boolean(busy)} onClick={() => void act('reopen')}>REOPEN REVIEW</button>{selected.workflow.stage === 'pending_ai' && <button className="ui-button ui-button--primary" disabled={Boolean(busy)} onClick={() => void act('review-ai')}>{selected.workflow.aiReview ? 'RUN AI REVIEW AGAIN' : 'RUN AI REVIEW'}</button>}{selected.workflow.stage === 'pending_ai' && <button className="ui-button" disabled={Boolean(busy) || !selected.workflow.aiReview} onClick={() => void act('complete')}>COMPLETE AI REVIEW</button>}{selected.workflow.stage === 'reviewed' && <button className="ui-button" disabled={Boolean(busy)} onClick={() => void act('replay')}>REPLAY CURRENT PARSER</button>}{selected.workflow.stage === 'reviewed' && <button className="ui-button" disabled={Boolean(busy)} onClick={exportCase}>EXPORT REVIEWED CASE</button>}</div>{selected.workflow.aiReview && <Analysis value={selected.workflow.aiReview} />}<p className="admin-meta">AI REVIEW DOES NOT UPDATE THE PARSER OR TRAIN THE MODEL.</p></>}
        {selected.workflow.replay && <section aria-label="Current parser replay"><h4>CURRENT PARSER REPLAY</h4><p className="admin-status">{selected.workflow.replay.status === 'matched' ? 'MATCHES REVIEWED CORRECTION' : selected.workflow.replay.status === 'different' ? 'DIFFERS FROM REVIEWED CORRECTION' : 'LEGACY SNAPSHOT UNVERIFIED'}</p>{selected.workflow.replay.differences.length > 0 && <div className="parser-report-diff"><section className="parser-diff-header"><strong>FIELD</strong><strong>REVIEWED</strong><strong>CURRENT PARSER</strong></section>{selected.workflow.replay.differences.map(key => <section key={key}><strong>{key in parserFieldLabels ? parserFieldLabels[key as keyof typeof parserFieldLabels] : key === 'standardText' ? 'STANDARD FORMAT' : key.toUpperCase()}</strong><span><small className="parser-mobile-label">REVIEWED</small>{snapshotValue(expected, key)}</span><span><small className="parser-mobile-label">CURRENT PARSER</small>{snapshotValue(selected.workflow.replay!.actual, key)}</span></section>)}</div>}{selected.workflow.replay.directorySensitiveDifferences.length > 0 && <p className="admin-meta">BUYER AND PORT MATCHING MAY DEPEND ON DIRECTORY DATA.</p>}<details><summary>REPLAY BUILD DETAILS</summary><p className="admin-reference">PARSER: {selected.workflow.replay.executedWith.parserVersion}</p><p className="admin-reference">BUILD: {selected.workflow.replay.executedWith.buildFingerprint}</p><p className="admin-reference">REVIEW REVISION: {selected.workflow.replay.provenance.reportRevision}</p></details></section>}
        <details><summary>REVIEW HISTORY ({selected.history.length})</summary>{selected.history.length ? selected.history.map(item => <div key={item.id}><p><strong>{item.action.replaceAll('_', ' ').toUpperCase()}</strong></p><p className="admin-meta">{time(item.createdAt)} · REVISION {item.revision}</p><p className="admin-reference">{item.actor}</p></div>) : <p>NO REVIEW HISTORY.</p>}</details>
      </aside>}
    </div>
  </section>;
}
