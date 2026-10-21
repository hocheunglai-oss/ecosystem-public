import type { AccessUser } from '../../shared/access';
import type { Actor } from './model';
const accessActors = new WeakSet<Actor>();

/**
 * Project the live AccessProvider response, never a browser-stored profile.
 * The in-memory identity mark cannot survive JSON storage or a copied actor.
 * This is a local workflow guard; API and database permissions remain server-enforced.
 */
export function actorFromAccess(user: AccessUser): Actor {
  if (!user.isActive || !user.activated) throw new Error('Sign in with an active account.');
  const actor: Actor = Object.freeze({ id:user.id,name:user.displayName,role:user.isManager?'manager':'trader',isAdmin:user.isAdmin,
    officeId:user.officeId,officeName:user.officeName,isSpcTrader:user.isSpcTrader,isManager:user.isManager });
  accessActors.add(actor);
  return actor;
}

export function isAccessActor(actor: Actor): boolean { return accessActors.has(actor); }
