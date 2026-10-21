import type { AccessUser } from './access';

/** UI examples require the real signed-in administrator's server-issued capability. */
export function canPreviewAppearance(user: AccessUser | null | undefined): boolean {
  return Boolean(user?.id && user.isActive && user.activated && user.isAdmin && user.capabilities?.appearancePreview === true);
}
