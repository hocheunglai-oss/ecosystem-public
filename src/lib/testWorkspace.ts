import type { AccessUser, RolePreview } from '../../shared/access';
import type { DemoState, Port } from './model';
import { createSeedState, upgradeDemoState } from './seed';
import { flattenLocationHierarchy } from './locationMigration';
import { retireFictionalSupplierRecords } from './supplierRetirement';
import { defaultLostReasons } from './lostReasons';

export type WorkspaceDataMode = 'live' | 'test';
export interface TestWorkspacePolicy { enabled: boolean; generation: string }
export interface WorkspaceStorage { key(index: number): string | null; readonly length: number; getItem(key: string): string | null; removeItem(key: string): void }
export function canUseTestWorkspace(user: AccessUser | null | undefined): user is AccessUser {
  return Boolean(user?.id && user.isActive && user.activated && user.isAdmin && user.capabilities?.testWorkspace === true);
}
export function parseTestWorkspacePolicy(value: unknown): TestWorkspacePolicy | null {
  if (!value || typeof value !== 'object') return null;
  const policy = value as Partial<TestWorkspacePolicy>;
  return typeof policy.enabled === 'boolean' && typeof policy.generation === 'string' && (!policy.enabled || /^[a-zA-Z0-9_-]{1,128}$/.test(policy.generation))
    ? { enabled: policy.enabled, generation: policy.generation } : null;
}
export function canReadParserReports(user: AccessUser | null | undefined, preview: RolePreview | null, mode: WorkspaceDataMode, generation?: string): boolean {
  return Boolean(user?.isActive && user.activated && user.isAdmin && !preview &&
    (mode === 'live' || mode === 'test' && canUseTestWorkspace(user) && parseTestWorkspacePolicy({enabled:true,generation})));
}
const ownerKey = (ownerId: string) => encodeURIComponent(ownerId);
export function testWorkspacePrefix(ownerId: string): string { return `ecosystem.test.v1:${ownerKey(ownerId)}:`; }
export function workspaceNamespace(ownerId: string | undefined, mode: WorkspaceDataMode = 'live', generation?: string): string {
  if (!ownerId) return 'ecosystem.signed-out.live.v1';
  if (mode === 'test') {
    if (!generation || !parseTestWorkspacePolicy({ enabled: true, generation })) throw new Error('Test data is unavailable.');
    return `${testWorkspacePrefix(ownerId)}${generation}`;
  }
  return `ecosystem.live.v1:${ownerKey(ownerId)}`;
}
/** Delete only this authenticated owner's obsolete test generations. Legacy/live work stays untouched. */
export function purgeObsoleteTestWorkspaces(storage: WorkspaceStorage, ownerId: string, policy: TestWorkspacePolicy): void {
  const prefix = testWorkspacePrefix(ownerId);
  const retained = policy.enabled ? `${workspaceNamespace(ownerId, 'test', policy.generation)}:` : null;
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) if (key?.startsWith(prefix) && (!retained || !key.startsWith(retained))) storage.removeItem(key);
}

// Geographic reference values only. Operational advice, credit and trading records
// are deliberately absent; this path must never call the fictional seed/migrations.
const referencePorts = [
  ['singapore', 'Singapore', 'Singapore', 'SGSIN', 'Asia/Singapore'],
  ['hong-kong', 'Hong Kong', 'Hong Kong', 'HKHKG', 'Asia/Hong_Kong'],
  ['rotterdam', 'Rotterdam', 'Netherlands', 'NLRTM', 'Europe/Amsterdam'],
  ['fujairah', 'Fujairah', 'United Arab Emirates', 'AEFJR', 'Asia/Dubai'],
  ['busan', 'Busan', 'South Korea', 'KRPUS', 'Asia/Seoul'],
  ['tokyo', 'Tokyo', 'Japan', 'JPTYO', 'Asia/Tokyo'],
  ['chiba', 'Chiba', 'Japan', '', 'Asia/Tokyo'],
  ['yokohama', 'Yokohama', 'Japan', '', 'Asia/Tokyo'],
  ['osaka', 'Osaka', 'Japan', '', 'Asia/Tokyo'],
  ['ho-chi-minh', 'Ho Chi Minh City', 'Vietnam', 'VNSGN', 'Asia/Ho_Chi_Minh'],
  ['gibraltar', 'Gibraltar', 'Gibraltar', 'GIGIB', 'Europe/Gibraltar'],
] as const;
export function createLiveState(): DemoState {
  const ports: Port[] = referencePorts.map(([id, name, country, code, timezone]) => ({ id: `port-${id}`, name, country, code, timezone, leadTime: '', summary: '', notes: [], tags: [], updatedAt: '' }));
  return { version: 1, companies: [], ports, enquiries: [], requests: [], outcomes: [], contributions: [], audit: [], drops: [], goals: [],
    locationCountries: [...new Set(ports.map(port => port.country))].map(name => ({ id: name, name })), locationStructureVersion: 1, supplierRetirementVersion: 1,
    knowledgeRecords: {}, knowledgeHistory: [], privateNotes: {}, profiles: {}, hats: [], creditHistory: [], creditNotifications: [],
    lostReasons: structuredClone(defaultLostReasons), economy: { version: 2, grants: [] } };
}
function validState(value: unknown): value is DemoState {
  return Boolean(value && typeof value === 'object' && (value as DemoState).version === 1 &&
    ['companies', 'ports', 'enquiries', 'requests', 'outcomes', 'contributions', 'audit', 'drops', 'goals'].every(key => Array.isArray((value as Record<string, unknown>)[key])));
}
/** Fixture ownership is projected onto the authenticated ID, never used as identity. */
function projectTestOwner(state: DemoState, ownerId: string): DemoState {
  const identityFields = new Set(['owner', 'author', 'reviewer', 'requestedBy', 'acknowledgedBy', 'personInChargeId', 'personId', 'recipientId', 'actorId', 'updatedBy', 'createdBy', 'checkedBy', 'by']);
  function project(value: unknown, field = ''): unknown {
    if (value === 'otto' && identityFields.has(field)) return ownerId;
    if (Array.isArray(value)) return value.map(item => project(item, field));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [field === 'profiles' && key === 'otto' ? ownerId : key, project(item, key)]));
    return value;
  }
  return project(state) as DemoState;
}
export function readWorkspaceState(raw: string | null, mode: WorkspaceDataMode, realUser: AccessUser | null | undefined, policy: TestWorkspacePolicy | null): DemoState {
  if (mode === 'test' && (!canUseTestWorkspace(realUser) || !policy?.enabled)) throw new Error('Test data is unavailable.');
  let state: DemoState | undefined;
  try { const parsed: unknown = raw ? JSON.parse(raw) : null; if (validState(parsed)) state = parsed; } catch { /* Corrupt data cannot enable another namespace. */ }
  return mode === 'test' ? projectTestOwner(state ? upgradeDemoState(state) : createSeedState(), realUser!.id) : state ? flattenLocationHierarchy(retireFictionalSupplierRecords(state)) : createLiveState();
}
