import KnowledgeUpdateButton from "./KnowledgeUpdateButton";
import { importAttempt, startImportAttempt, recordImportAttempt } from './lib/importActivity';
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ClipboardPaste, Plus, X } from "lucide-react";
import { useDemo } from "./store";
import { Field, Modal } from "./ui";
import SearchableSelect from "./SearchableSelect";
import { useMobileInterface } from "./mobile";
import { KnowledgeBlockView } from "./KnowledgeWorkspace";
import { knowledgeDocument } from "./lib/knowledge";
import { locationRecords, type LocationRecord } from "./lib/locations";
import { getLocationIntelligence } from "./lib/intelligence";
import { intelligenceFields, INTELLIGENCE_VALUE_MAX_LENGTH } from "./lib/intelligenceFields";
import {
  buildExtractionBatch,
  type ReviewProposal,
} from "./lib/knowledgeExtraction";
import {
  extractKnowledge,
  KnowledgeExtractionError,
  knowledgeSignInUrl,
} from "./lib/knowledgeExtractionApi";
import type { DemoState } from "./lib/model";
import { isEmailText } from "./lib/uppercase";
import "./knowledge-extractor.css";

export default function KnowledgeExtractor({
  current,
  onClose,
  onSaved,
  embedded = false,
}: {
  current?: LocationRecord;
  onClose?: () => void;
  embedded?: boolean;
  onSaved: (key: string) => void;
}) {
  const { state, run, toast, notify } = useDemo();
  const mobile = useMobileInterface();
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [sourceDate, setSourceDate] = useState("");
  const [contextKey, setContextKey] = useState(current?.key || "");
  const [proposals, setProposals] = useState<ReviewProposal[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signIn, setSignIn] = useState(false);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [snapshot, setSnapshot] = useState<DemoState>(state);
  const request = useRef<AbortController | null>(null);
  const errorPanel = useRef<HTMLDivElement | null>(null);
  const batchId = useRef(crypto.randomUUID());
  const records = locationRecords(proposals ? snapshot : state);
  const selected = proposals?.filter((p) => p.selected) || [];
  useEffect(() => () => request.current?.abort(), []);

  async function extract() {
    if (request.current || !text.trim()) return;
    const controller = new AbortController();
    request.current = controller;
    const base = structuredClone(state);
    const attempt = importAttempt('text', 'Knowledge extraction', 'legacy-spc-extraction');
    void startImportAttempt(attempt).catch(() => notify('Import activity could not be started.', true));
    setBusy(true);
    setError("");
    setSignIn(false);
    setSaveAttempted(false);
    const timer = setTimeout(() => controller.abort("timeout"), 85_000);
    try {
      const result = await extractKnowledge(
        {
          text,
          source,
          sourceDate,
          contextKey,
          locations: locationRecords(base),
        },
        controller.signal,
      );
      if (controller.signal.aborted) {
        void recordImportAttempt(attempt, { status: 'cancelled', warningCount: 0, errorCode: 'EXTRACTION_CANCELLED' }).catch(() => {});
        return;
      }
      void recordImportAttempt(attempt, { status: 'awaiting-review', warningCount: result.warnings.length + result.proposals.filter(p => p.warning).length,
        summary: `${result.proposals.length} proposals returned by the legacy SPC extraction service; awaiting user review.` })
        .catch(() => notify('Extraction completed. Import activity could not be recorded.', true));
      setSnapshot(base);
      batchId.current = crypto.randomUUID();
      setWarnings(result.warnings);
      setProposals(
        result.proposals.map((p) => ({
          ...p,
          id: crypto.randomUUID(),
          selected: !!p.locationKey && !p.warning,
        })),
      );
    } catch (cause) {
      void recordImportAttempt(attempt, { status: controller.signal.aborted && controller.signal.reason !== 'timeout' ? 'cancelled' : 'failed', warningCount: 0,
        errorCode: controller.signal.aborted ? 'EXTRACTION_CANCELLED_OR_TIMEOUT' : cause instanceof KnowledgeExtractionError && cause.status === 401 ? 'LEGACY_SPC_SIGN_IN_REQUIRED' : 'EXTRACTION_FAILED',
        summary: 'Legacy SPC extraction did not return a usable result. Reopen the source to retry.' })
        .catch(() => notify('Import activity could not be recorded.', true));
      if (controller.signal.aborted && controller.signal.reason !== "timeout")
        return;
      setSignIn(
        cause instanceof KnowledgeExtractionError && cause.status === 401,
      );
      setError(
        controller.signal.aborted
          ? "Extraction timed out. Please retry."
          : cause instanceof KnowledgeExtractionError
            ? cause.message
            : cause instanceof TypeError
              ? "Could not connect. Please try again."
              : "Could not read the extracted information. Please retry.",
      );
    } finally {
      clearTimeout(timer);
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  function patch(id: string, value: Partial<ReviewProposal>) {
    setProposals(
      (items) =>
        items?.map((p) => (p.id === id ? { ...p, ...value } : p)) || null,
    );
    setError("");
    setSaveAttempted(false);
  }
  function close() {
    if ((text.trim() || source.trim() || sourceDate || proposals || busy) && !window.confirm('DISCARD UNSAVED CHANGES?')) return;
    onClose?.();
  }
  function save() {
    if (!proposals) return;
    setSaveAttempted(true);
    setError("");
    try {
      const action = buildExtractionBatch(snapshot, proposals, {
        source,
        sourceDate,
        batchId: batchId.current,
      });
      if (run(action, "Information updated."))
        onSaved(selected[0]?.locationKey || "");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Please check the selected information.",
      );
    }
  }
  const message = error || (saveAttempted && toast?.error ? toast.message : "");
  useEffect(() => {
    if (message) errorPanel.current?.scrollIntoView({ block: "nearest" });
  }, [message]);
  const content = (
    <div className={`knowledge-extractor${mobile ? " is-mobile" : ""}`}>
      <div className="extract-steps" aria-label="Update steps">
        <span aria-current={!proposals ? "step" : undefined}>
          1. Paste information
        </span>
        <span aria-current={proposals ? "step" : undefined}>
          2. Check changes
        </span>
      </div>
      {message && (
        <div
          ref={errorPanel}
          className="notice rose extract-error"
          role="alert"
        >
          <span>{message}</span>
          {signIn && (
            <a href={knowledgeSignInUrl} target="_blank" rel="noreferrer">
              Sign in to FC UNO / SPC ↗
            </a>
          )}
        </div>
      )}
      {!proposals ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void extract();
          }}
        >
          <div className="extract-input-fields">
            <Field label="Location (optional)">
              <SearchableSelect
                label="Location (optional)"
                value={contextKey}
                onChange={setContextKey}
                disabled={busy}
                placeholder="Auto detect"
                options={records.map((r) => ({
                  value: r.key,
                  label: r.path,
                  keywords: r.kind,
                }))}
              />
            </Field>
            <Field label="Source (optional)">
              <input
                aria-label="Source (optional)"
                value={source}
                maxLength={1000}
                disabled={busy}
                onChange={(e) => setSource(e.target.value)}
              />
            </Field>
            <Field label="Source date (optional)">
              <input
                aria-label="Source date (optional)"
                type="date"
                value={sourceDate}
                disabled={busy}
                onChange={(e) => setSourceDate(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Information">
            <textarea
              aria-label="Information"
              className="extract-paste"
              value={text}
              maxLength={30_000}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              autoFocus={!embedded}
              required
            />
          </Field>
          <div className="extract-count">
            {text.length.toLocaleString()} / 30,000
          </div>
          <footer className="extract-actions">
            {busy ? (
              <>
                <span role="status">Extracting information…</span>
                <button
                  key="cancel-extraction"
                  type="button"
                  className="button secondary"
                  onClick={(event) => {
                    event.preventDefault();
                    request.current?.abort();
                  }}
                >
                  Cancel extraction
                </button>
              </>
            ) : (
              <>
                {!embedded && (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={close}
                  >
                    Cancel
                  </button>
                )}
                <button
                  key="extract"
                  type="submit"
                  className="button primary"
                  disabled={!text.trim()}
                >
                  <ClipboardPaste size={15} />
                  {signIn || error ? "Retry extraction" : "Extract"}
                </button>
              </>
            )}
          </footer>
        </form>
      ) : (
        <>
          <div className="extract-review">
            <aside className="extract-source">
              <details open={!mobile}>
                <summary>Original information</summary>
                {(source || sourceDate) && (
                  <p className="extract-source-meta">
                    {[source, sourceDate].filter(Boolean).join(" · ")}
                  </p>
                )}
                <pre>{text}</pre>
              </details>
            </aside>
            <div className="extract-proposals">
              <header className="extract-review-head">
                <h3>Check changes</h3>
                <span aria-live="polite">
                  {selected.length} / {proposals.length} selected
                </span>
              </header>
              {!!warnings.length && (
                <ul className="extract-warnings">
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              {!proposals.length && (
                <p className="extract-empty">
                  No country or port information found.
                </p>
              )}
              {proposals.map((proposal, index) => (
                <ProposalEditor
                  key={proposal.id}
                  proposal={proposal}
                  index={index}
                  records={records}
                  snapshot={snapshot}
                  onChange={(value) => patch(proposal.id, value)}
                />
              ))}
            </div>
          </div>
          <footer className="extract-actions">
            <button
              className="button secondary"
              onClick={() => {
                setProposals(null);
                setError("");
                setSaveAttempted(false);
              }}
            >
              <ArrowLeft size={14} /> Back
            </button>
            <KnowledgeUpdateButton disabled={!selected.length} onClick={save}>
              <Check size={15} /> CONTRIBUTE +1
            </KnowledgeUpdateButton>
          </footer>
        </>
      )}
    </div>
  );
  return embedded ? (
    content
  ) : (
    <Modal title="Information extractor" onClose={close} wide>
      {content}
    </Modal>
  );
}

function ProposalEditor({
  proposal: p,
  index,
  records,
  snapshot,
  onChange,
}: {
  proposal: ReviewProposal;
  index: number;
  records: LocationRecord[];
  snapshot: DemoState;
  onChange: (value: Partial<ReviewProposal>) => void;
}) {
  const record = records.find((r) => r.key === p.locationKey);
  const doc = record ? knowledgeDocument(snapshot, record.target) : undefined;
  const section = doc?.sections.find((s) =>
    p.sectionId
      ? s.id === p.sectionId
      : s.title.toLowerCase() === p.section.toLowerCase(),
  );
  const replacement = section?.blocks.find((b) => b.id === p.replaceBlockId);
  const field = intelligenceFields.find((f) => f.key === p.field);
  const port =
    record?.kind === "port"
      ? snapshot.ports.find((item) => item.id === record.target.id)
      : undefined;
  const previousKeyInfo =
    port && p.field ? getLocationIntelligence(port).keyInfo[p.field] : null;
  const id = `proposal-${p.id}`;
  return (
    <article
      className={`extract-proposal ${p.selected ? "is-selected" : ""}`}
      aria-label={`Change ${index + 1}`}
    >
      <header className="extract-proposal-head">
        <label>
          <input
            type="checkbox"
            aria-label={`Include change ${index + 1}`}
            checked={p.selected}
            onChange={(e) => onChange({ selected: e.target.checked })}
          />
          <strong>
            {p.kind === "keyInfo"
              ? field?.label || "Key Info"
              : p.title || p.section}
          </strong>
        </label>
        <span>
          {p.kind === "keyInfo"
            ? "Key Info"
            : p.kind === "table"
              ? "Table"
              : "Text"}
        </span>
      </header>
      <div className="extract-proposal-body">
        {p.warning && <p className="extract-warning">{p.warning}</p>}
        <div className="extract-destination">
          <Field label="Location">
            <SearchableSelect
              label={`Location for change ${index + 1}`}
              value={p.locationKey || ""}
              placeholder={p.locationName || "Select location"}
              options={records
                .filter((r) => p.kind !== "keyInfo" || r.kind === "port")
                .map((r) => ({
                  value: r.key,
                  label: r.path,
                  keywords: r.kind,
                }))}
              onChange={(locationKey) =>
                onChange({
                  locationKey: locationKey || null,
                  sectionId: undefined,
                  replaceBlockId: undefined,
                })
              }
            />
          </Field>
          {p.kind !== "keyInfo" && (
            <Field label="Section">
              <input
                aria-label={`Section for change ${index + 1}`}
                list={`${id}-sections`}
                maxLength={150}
                value={p.section}
                onChange={(e) =>
                  onChange({
                    section: e.target.value,
                    sectionId: undefined,
                    replaceBlockId: undefined,
                  })
                }
              />
              <datalist id={`${id}-sections`}>
                {doc?.sections.map((s) => (
                  <option key={s.id} value={s.title} />
                ))}
              </datalist>
            </Field>
          )}
        </div>
        {p.kind === "keyInfo" ? (
          <div className="extract-keyinfo">
            <div>
              <span>Current</span>
              <strong>{previousKeyInfo || "—"}</strong>
            </div>
            <Field label="Update to">
              <textarea
                aria-label={`Value for change ${index + 1}`}
                rows={2}
                maxLength={INTELLIGENCE_VALUE_MAX_LENGTH}
                value={p.value || ""}
                onChange={(e) => onChange({ value: e.target.value })}
              />
            </Field>
          </div>
        ) : (
          <>
            <div className="extract-content-controls">
              <Field label="Title">
                <input
                  aria-label={`Title for change ${index + 1}`}
                  maxLength={150}
                  value={p.title}
                  onChange={(e) => onChange({ title: e.target.value })}
                />
              </Field>
              <Field label="Action">
                <select
                  aria-label={`Action for change ${index + 1}`}
                  value={p.replaceBlockId || ""}
                  onChange={(e) =>
                    onChange({ replaceBlockId: e.target.value || undefined })
                  }
                >
                  <option value="">Add information</option>
                  {section?.blocks
                    .filter((b) => b.type === p.kind)
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        Replace: {b.title || b.type}
                      </option>
                    ))}
                </select>
              </Field>
            </div>
            {replacement && (
              <details className="extract-existing" open>
                <summary>Current information</summary>
                <KnowledgeBlockView block={replacement} />
              </details>
            )}
            {p.kind === "text" ? (
              <Field
                label={replacement ? "Updated information" : "Information"}
              >
                <textarea
                  aria-label={`Information for change ${index + 1}`}
                  value={p.text}
                  maxLength={30_000}
                  rows={4}
                  onChange={(e) => onChange({ text: e.target.value })}
                />
              </Field>
            ) : (
              <ExtractTable proposal={p} index={index} onChange={onChange} />
            )}
          </>
        )}
        <details className="extract-evidence">
          <summary>Source excerpt</summary>
          <blockquote>{p.evidence}</blockquote>
        </details>
      </div>
    </article>
  );
}

function ExtractTable({
  proposal: p,
  index,
  onChange,
}: {
  proposal: ReviewProposal;
  index: number;
  onChange: (value: Partial<ReviewProposal>) => void;
}) {
  const [page, setPage] = useState(0);
  const start = Math.min(
    page * 20,
    Math.max(0, Math.floor((p.rows.length - 1) / 20) * 20),
  );
  return (
    <div className="extract-table-editor">
      <div
        className="extract-table-wrap"
        tabIndex={0}
        role="region"
        aria-label={`Table for change ${index + 1}`}
      >
        <table>
          <thead>
            <tr>
              {p.columns.map((name, column) => (
                <th key={column}>
                  <input
                    aria-label={`Column ${column + 1} for change ${index + 1}`}
                    value={name}
                    maxLength={150}
                    onChange={(e) =>
                      onChange({
                        columns: p.columns.map((v, i) =>
                          i === column ? e.target.value : v,
                        ),
                      })
                    }
                  />
                  {p.columns.length > 1 && (
                    <button
                      aria-label={`Remove column ${column + 1} for change ${index + 1}`}
                      onClick={() =>
                        onChange({
                          columns: p.columns.filter((_, i) => i !== column),
                          rows: p.rows.map((row) =>
                            row.filter((_, i) => i !== column),
                          ),
                        })
                      }
                    >
                      <X size={12} />
                    </button>
                  )}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {p.rows.slice(start, start + 20).map((row, offset) => {
              const rowIndex = start + offset;
              return (
                <tr key={rowIndex}>
                  {p.columns.map((_, column) => (
                    <td key={column}>
                      <input
                        aria-label={`Row ${rowIndex + 1} column ${column + 1} for change ${index + 1}`}
                        maxLength={3000}
                        value={row[column] || ""}
                        data-email-value={
                          isEmailText(row[column] || "") ? "" : undefined
                        }
                        onChange={(e) =>
                          onChange({
                            rows: p.rows.map((r, i) =>
                              i === rowIndex
                                ? r.map((v, j) =>
                                    j === column ? e.target.value : v,
                                  )
                                : r,
                            ),
                          })
                        }
                      />
                    </td>
                  ))}
                  <td>
                    <button
                      aria-label={`Remove row ${rowIndex + 1} for change ${index + 1}`}
                      onClick={() =>
                        onChange({
                          rows: p.rows.filter((_, i) => i !== rowIndex),
                        })
                      }
                    >
                      <X size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="extract-table-tools">
        <button
          disabled={p.rows.length >= 200}
          onClick={() => {
            onChange({ rows: [...p.rows, p.columns.map(() => "")] });
            setPage(Math.floor(p.rows.length / 20));
          }}
        >
          <Plus size={13} /> Row
        </button>
        <button
          disabled={p.columns.length >= 30}
          onClick={() =>
            onChange({
              columns: [...p.columns, `Column ${p.columns.length + 1}`],
              rows: p.rows.map((row) => [...row, ""]),
            })
          }
        >
          <Plus size={13} /> Column
        </button>
        {p.rows.length > 20 && (
          <span>
            <button
              disabled={!start}
              onClick={() => setPage(Math.max(0, start / 20 - 1))}
            >
              Previous
            </button>
            {start + 1}–{Math.min(start + 20, p.rows.length)} / {p.rows.length}
            <button
              disabled={start + 20 >= p.rows.length}
              onClick={() => setPage(start / 20 + 1)}
            >
              Next
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
