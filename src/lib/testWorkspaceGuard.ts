import type { WorkspaceDataMode } from './testWorkspace';
// Transient browser state only. It cannot authorize server access or survive reload.
let dataMode: WorkspaceDataMode = 'live';
let namespace = '';
export function setWorkspaceNamespace(value: string): void { namespace = value; }
export function isCurrentWorkspace(value: string): boolean { return namespace === value; }
export function setWorkspaceDataMode(value: WorkspaceDataMode): void { dataMode = value; }
export function isTestWorkspace(): boolean { return dataMode === 'test'; }
export function assertLiveDataWritable(): void {
  if (isTestWorkspace()) throw new Error('Switch to LIVE to update shared records.');
}
