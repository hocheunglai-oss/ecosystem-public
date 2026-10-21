import type { AccessUser, RolePreview, PreviewRole } from './access.ts';
export const previewRoles: readonly PreviewRole[] = ['admin','trader','spc-trader','manager','credit'];
export function projectPreviewUser(user: AccessUser, preview: RolePreview | null): AccessUser {
  if (!preview) return user;
  if (!user.isAdmin || !user.isActive || !user.activated || preview.readOnly !== true ||
      !previewRoles.includes(preview.role) || !preview.officeId || !preview.officeName ||
      (preview.role === 'credit' && preview.officeId !== 'CREDIT')) throw new Error('Invalid role preview.');
  return {...user,capabilities:{appearancePreview:false,testWorkspace:false},officeId:preview.officeId,officeName:preview.officeName,
    isAdmin:preview.role==='admin',isManager:preview.role==='manager',isSpcTrader:preview.role==='spc-trader'};
}
