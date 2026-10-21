import type { AccessUser, PreviewInput } from './access';

/** Presentation only. Never use this ID for authentication, storage or private reads. */
export interface PreviewPerson extends PreviewInput {
  id: string;
  name: string;
  fictional: boolean;
}

export function personPreviewOptions(users: readonly AccessUser[], administrator: AccessUser): PreviewPerson[] {
  if (!administrator.isAdmin || !administrator.isActive || !administrator.activated) return [];
  return [
    ...users.filter(user => user.isActive && user.activated && user.id !== administrator.id && user.officeId)
      .map(user => ({ id: user.id, name: user.displayName, fictional: false, officeId: user.officeId,
        role: user.officeId === 'CREDIT' ? 'credit' as const : user.isAdmin ? 'admin' as const : user.isManager ? 'manager' as const : user.isSpcTrader ? 'spc-trader' as const : 'trader' as const })),
    { id: 'preview-user', name: 'USER', fictional: true, role: 'trader', officeId: administrator.officeId },
    { id: 'gianmichele', name: 'VINCENT', fictional: true, role: 'manager', officeId: administrator.officeId },
  ];
}

export function selectedPreviewPerson(options: readonly PreviewPerson[], id: string): PreviewPerson {
  const selected = options.find(person => person.id === id);
  if (!selected) throw new Error('Select an available user.');
  return { ...selected };
}
