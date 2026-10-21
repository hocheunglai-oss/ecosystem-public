// Ephemeral UI guard only. Server membership and session-bound database state are
// authoritative; never use this flag to grant identity or privileges.
let readOnly = false;
export function setPreviewReadOnly(value: boolean): void { readOnly = value; }
export function assertPreviewWritable(): void {
  if (readOnly) throw new Error('PREVIEW IS READ ONLY.');
}
export function isPreviewReadOnly(): boolean { return readOnly; }
