import { useState } from 'react';
import { Modal } from './ui';
import { parserFieldKeys, parserFieldLabels, type ParserReportInput, type ParserFixResult, type ParserFields } from '../shared/parserService';
export type CapturedAiAttempt = { id: string; raw: string; state: 'pending' | 'complete' | 'failed'; before?: ParserFields; result?: ParserFixResult };
export default function ParserReportPreview({ report, ai, busy, onClose, onSubmit }: { report: Omit<ParserReportInput, 'requestId'>; ai?: CapturedAiAttempt; busy: boolean; onClose(): void; onSubmit(notes: string): void }) {
  const [notes, setNotes] = useState(report.notes);
  return <Modal title="PARSER REPORT" wide onClose={() => { if (!busy) onClose(); }}>
    <section className="admin-section" aria-label="Report evidence">
      {report.capture?.parseOrigin === 'reparsed' && <p>CURRENT REPARSE OF THE SAVED ENQUIRY</p>}
      <details><summary>ORIGINAL ENQUIRY</summary><pre className="parser-source">{report.rawText}</pre></details>
      <div className="parser-report-diff">
        <section className="parser-diff-header"><strong>FIELD</strong><strong>ORIGINAL PARSE</strong><strong>YOUR CORRECTION</strong></section>
        {parserFieldKeys.map(key => <section key={key}><strong>{parserFieldLabels[key]}</strong><div><small className="parser-mobile-label">ORIGINAL PARSE</small>{report.parsed[key] || '—'}</div><div><small className="parser-mobile-label">YOUR CORRECTION</small>{report.corrected[key] || '—'}</div></section>)}
      </div>
      <details><summary>STANDARD FORMAT</summary><strong>ORIGINAL PARSE</strong><pre className="parser-source">{report.capture?.original.standardText || '—'}</pre><strong>YOUR CORRECTION</strong><pre className="parser-source">{report.capture?.submitted.standardText || '—'}</pre></details>
      <section aria-label="Reported AI result">
        <h3>AI RESULT</h3>
        {!ai ? <p>NOT REQUESTED</p> : ai.state !== 'complete' || !ai.result ? <p>{ai.state === 'failed' ? 'FAILED' : 'PENDING'}</p> : <>
          <p>{ai.result.model}</p>
          {ai.result.suggestions.length ? <dl>{ai.result.suggestions.map(item => <div key={item.field}><dt>{parserFieldLabels[item.field]}</dt><dd>{ai.before?.[item.field] || '—'} → {item.value}<br /><small>{item.evidence}</small></dd></div>)}</dl> : <p>NO SUGGESTED CHANGES</p>}
          {ai.result.warnings.length > 0 && <ul>{ai.result.warnings.map((item,index) => <li key={index}>{item}</li>)}</ul>}
        </>}
      </section>
      <label className="field"><span>NOTE</span><textarea aria-label="Report note" value={notes} maxLength={2000} disabled={busy} onChange={event => setNotes(event.target.value)} /></label>
      <div className="admin-actions"><button className="ui-button" disabled={busy} onClick={onClose}>CANCEL</button><button className="button primary" disabled={busy} onClick={() => onSubmit(notes)}>{busy ? 'SUBMITTING…' : 'SUBMIT REPORT'}</button></div>
    </section>
  </Modal>;
}
