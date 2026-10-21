import { useMemo, useState } from 'react';
import { useDemo } from './store';
import { useAccess } from './auth';
import { locationImportAssessment } from './lib/useSharedLocationKnowledge';
import { Modal } from './ui';
import { KnowledgeComparison } from './KnowledgeEditor';
import './location-storage.css';

export default function LocationStorageStatus() {
  const { locations } = useDemo();
  const { preview } = useAccess();
  const [review, setReview] = useState(false);
  const assessment = useMemo(() => locationImportAssessment(locations.data?.snapshot, locations.migration), [locations.data, locations.migration]);
  const conflicts = assessment.conflicts;
  const serviceError = locations.error || locations.migrationError || locations.migrationDigestError;
  if (!locations.enabled) return null;
  const migration = locations.migration;
  return <>
    {locations.loading && <p className="notice" role="status">LOADING SHARED DATA…</p>}
    {(serviceError || assessment.error) && <div className="notice rose location-storage-status" role="alert">
      <span>{serviceError || assessment.error}</span>
      {serviceError && !locations.pending && <button type="button" className="button secondary" disabled={locations.busy} onClick={() => void locations.refresh()}>RETRY</button>}
    </div>}
    {locations.pending && <div className="notice location-storage-status" role="status">
      <span>SAVE AWAITING CONFIRMATION</span>
      <button type="button" className="button secondary" disabled={locations.busy || Boolean(preview)} onClick={() => void locations.retry()}>RETRY SAVE</button>
    </div>}
    {migration && !preview && <div className="notice location-storage-status">
      <span>{locations.canImport ? 'BROWSER DATA AVAILABLE TO IMPORT' : 'BROWSER DATA RETAINED — ADMINISTRATOR IMPORT REQUIRED'}</span>
      {locations.canImport && <button type="button" className="button secondary" disabled={!locations.ready || locations.busy} onClick={() => setReview(true)}>REVIEW IMPORT</button>}
    </div>}
    {review && migration && <Modal title="Import browser data" onClose={() => { if (!locations.busy) setReview(false); }}>
      <div className="location-import-review">
        <p>THE ORIGINAL BROWSER COPY WILL BE RETAINED.</p>
        {assessment.error && <p className="notice rose" role="alert">{assessment.error}</p>}
        {conflicts.length > 0 && <div className="notice rose" role="alert"><p>CONFLICTING RECORDS REQUIRE REVIEW. NO RECORDS WILL BE REPLACED.</p>
          <ul>{conflicts.map((conflict, index) => <li key={index}>{conflict.target.kind}: {conflict.target.id}</li>)}</ul>
        </div>}
        {migration.ports.filter(port => port.summary || port.notes.length || port.intelligenceKeyInfo || !locations.data?.snapshot.ports.some(item => item.id === port.id)).map(port =>
          <details key={port.id}><summary>{port.name} · {port.country}</summary><p>{port.summary}</p>{port.notes.map((note, index) => <p key={index}>{note}</p>)}
            {port.intelligenceKeyInfo && <dl>{Object.entries(port.intelligenceKeyInfo).filter(([, value]) => value).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
          </details>)}
        {migration.locationCountries.filter(country => !locations.data?.snapshot.locationCountries.some(item => item.id === country.id)).map(country => <p key={country.id}>{country.name}</p>)}
        {Object.entries(migration.knowledgeRecords).map(([key, document]) => <details key={key}>
          <summary>{key.slice(key.indexOf(':') + 1)} · {document.sections.length} TABS</summary>
          <KnowledgeComparison before={locations.data?.snapshot.knowledgeRecords[key] ?? { version: 0, sections: [] }} after={document} />
        </details>)}
        <p>{migration.knowledgeHistory.length} HISTORY ENTRIES · {migration.contributions.length} HISTORICAL CONTRIBUTIONS</p>
        {locations.error && <p className="notice rose" role="alert">{locations.error}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" disabled={locations.busy} onClick={() => setReview(false)}>CLOSE</button>
          <button type="button" className="button secondary" disabled={Boolean(assessment.error) || conflicts.length > 0 || locations.busy || locations.pending || Boolean(preview)} onClick={async () => { if (await locations.importLegacy()) setReview(false); }}>IMPORT</button>
        </div>
      </div>
    </Modal>}
  </>;
}
