import { adminApi } from './adminApi';
import { assertPreviewWritable } from './previewGuard';
import type { ImportBegin, ImportItem, ImportTransition } from '../../shared/admin';

type ImportOutcome = Pick<ImportTransition, 'status' | 'warningCount' | 'errorCode' | 'summary'>;
export type ImportAttempt = {
  begin: Readonly<ImportBegin>;
  transitionRequestId: string;
  item?: ImportItem;
  starting?: Promise<ImportItem>;
  outcome?: Readonly<Required<ImportOutcome>>;
  recording?: Promise<ImportItem>;
  complete?: ImportItem;
};
export function importAttempt(kind: ImportBegin['kind'], sourceName: string, sourceType: string): ImportAttempt {
  return { begin: Object.freeze({ requestId: crypto.randomUUID(), kind, sourceName, sourceType }), transitionRequestId: crypto.randomUUID() };
}
export async function startImportAttempt(attempt: ImportAttempt): Promise<ImportItem> {
  assertPreviewWritable();
  if (attempt.item) return attempt.item;
  if (!attempt.starting) attempt.starting = adminApi.beginImport(attempt.begin).then(({ item }) => { attempt.item = item; return item; }).finally(() => { attempt.starting = undefined; });
  return attempt.starting;
}
/** Bind the first outcome before any await. A lost response retries the identical server request. */
export async function recordImportAttempt(attempt: ImportAttempt, result: ImportOutcome): Promise<ImportItem> {
  assertPreviewWritable();
  const outcome = { status: result.status, warningCount: result.warningCount, errorCode: result.errorCode ?? '', summary: result.summary ?? '' };
  if (attempt.outcome && JSON.stringify(attempt.outcome) !== JSON.stringify(outcome)) {
    throw new Error('THIS IMPORT ALREADY HAS A DIFFERENT REPORTED OUTCOME. CHECK IMPORT ACTIVITY BEFORE RETRYING THE SOURCE.');
  }
  attempt.outcome ??= Object.freeze(outcome);
  if (attempt.complete) return attempt.complete;
  if (!attempt.recording) {
    attempt.recording = (async () => {
      const started = await startImportAttempt(attempt);
      const { item } = await adminApi.transitionImport({ ...attempt.outcome!, requestId: attempt.transitionRequestId,
        id: started.id, expectedRevision: started.revision });
      attempt.complete = item;
      return item;
    })().finally(() => { attempt.recording = undefined; });
  }
  return attempt.recording;
}
