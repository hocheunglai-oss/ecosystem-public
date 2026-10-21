/** Credential-free migration input. This is never used to authorize a login. */
export interface SpcRosterRow {
  id: string; username: string; display_name: string; role: string; is_active: boolean;
  assigned_roles: Array<{ role: string }>;
  profiles: Array<{ office: string; isSupplierTrader: boolean }>;
}
export interface RosterDecisions { demoteIds: string[]; excludeIds: string[]; managerIds: string[] }
export function prepareSpcRoster(rows: SpcRosterRow[], decisions: RosterDecisions) {
  const sourceIds = new Set(rows.map(row => row.id));
  for (const id of [...decisions.demoteIds, ...decisions.excludeIds, ...decisions.managerIds]) {
    if (!sourceIds.has(id)) throw new Error('An approved decision does not match a source user.');
  }
  const emails = new Set<string>();
  const users = rows.filter(row => !decisions.excludeIds.includes(row.id)).map(row => {
    const email = row.username.trim().toLowerCase();
    const officeNames = [...new Set(row.profiles.map(profile => profile.office?.trim().toUpperCase()).filter(Boolean))];
    const roles = [...new Set(row.assigned_roles.map(item => item.role.trim().toUpperCase()))];
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) || emails.has(email) || officeNames.length !== 1 || roles.length > 1 || !row.display_name.trim()) {
      throw new Error('Source user needs review; no default office or email matching is allowed.');
    }
    emails.add(email);
    const role = (roles[0] ?? row.role).replaceAll('_',' ').toUpperCase();
    if (!['ADMIN','SUPPLIER TRADER','BUYER TRADER'].includes(role)) throw new Error('Unmapped SPC authority requires review.');
    return { sourceSpcId: row.id, email, displayName: row.display_name.trim(), officeId: officeNames[0], officeName: officeNames[0],
      isAdmin: role === 'ADMIN' && !decisions.demoteIds.includes(row.id),
      isSpcTrader: row.profiles.some(profile => profile.isSupplierTrader === true),
      isManager: decisions.managerIds.includes(row.id), isActive: row.is_active === true };
  });
  const offices = [...new Set(users.map(user => user.officeId))].sort().map(name => ({ id:name, name }));
  if (!users.some(user => user.isAdmin && user.isActive)) throw new Error('The roster would have no active administrator.');
  return { schemaVersion:1, offices, users };
}
