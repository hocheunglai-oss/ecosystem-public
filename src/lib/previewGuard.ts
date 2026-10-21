// Ephemeral UI guard only. Server membership and session-bound database state are
// authoritative; never use this flag to grant identity or privileges.
let readOnly = false;
let sessionUnavailable = false;
export function setPreviewReadOnly(value: boolean): void { readOnly = value; }
export function setSessionUnavailable(value: boolean): void { sessionUnavailable = value; }
export function assertPreviewWritable(): void {
  if (sessionUnavailable) throw new Error('CONNECTION UNAVAILABLE. WAIT FOR YOUR SESSION TO RECONNECT.');
  if (readOnly) throw new Error('PREVIEW IS READ ONLY.');
}
export function isPreviewReadOnly(): boolean { return readOnly || sessionUnavailable; }
