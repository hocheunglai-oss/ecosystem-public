import { boolean, integer, pgSchema, text, timestamp, uuid, index, bigint, jsonb } from 'drizzle-orm/pg-core';
const eco = pgSchema('eco_private');
export const offices = eco.table('offices', { id: text('id').primaryKey(), name: text('name').notNull().unique() });
export const users = eco.table('users', {
  id: uuid('id').primaryKey(), email: text('email').notNull().unique(), displayName: text('display_name').notNull(),
  phone: text('phone').notNull().default(''), accessHoldRequest: uuid('access_hold_request'),
  officeId: text('office_id').references(() => offices.id),
  isAdmin: boolean('is_admin').notNull().default(false), isSpcTrader: boolean('is_spc_trader').notNull().default(false),
  isManager: boolean('is_manager').notNull().default(false), isActive: boolean('is_active').notNull().default(false),
  activatedAt: timestamp('activated_at', { withTimezone: true }), mfaRequired: boolean('mfa_required').notNull().default(false),
  passwordPromptDismissedAt: timestamp('password_prompt_dismissed_at', { withTimezone: true }),
  revision: integer('revision').notNull().default(1), sourceSpcId: uuid('source_spc_id').unique(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('eco_users_office').on(table.officeId)]);
export const revokedSessions = eco.table('revoked_sessions', {
  sessionId: uuid('session_id').primaryKey(), userId: uuid('user_id').notNull().references(() => users.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('eco_revoked_user').on(table.userId)]);
export const accessAudit = eco.table('access_audit', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  actorId: uuid('actor_id'), targetId: uuid('target_id'), action: text('action').notNull(),
  beforeAccess: jsonb('before_access'), afterAccess: jsonb('after_access'),
});
export const loginAttempts = eco.table('login_attempts', {
  bucket: text('bucket').primaryKey(), windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull(),
});
// auth.users belongs to Supabase Auth. Its FK, RLS, RPCs, checks and grants are in the versioned migration;
// do not generate or apply migrations for the provider-owned auth schema.

export const adminOperations = eco.table('admin_operations', {
  requestId: uuid('request_id').primaryKey(), actorId: uuid('actor_id').notNull().references(() => users.id),
  targetId: uuid('target_id').notNull(), kind: text('kind').notNull(), input: jsonb('input').notNull(),
  fingerprint: text('fingerprint').notNull(), state: text('state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

// Provider-session FK/cascade and allowed-role constraint live in the append-only SQL migration.
export const rolePreviews = eco.table('role_previews', {
  sessionId: uuid('session_id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, {onDelete:'cascade'}),
  role: text('role').notNull(), officeId: text('office_id').notNull().references(() => offices.id),
  updatedAt: timestamp('updated_at', {withTimezone:true}).notNull().defaultNow(),
}, table => [index('eco_role_previews_user').on(table.userId)]);
