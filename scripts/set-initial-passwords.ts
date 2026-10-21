/** One-time, explicitly requested operator action. Credentials are accepted only on stdin. */
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { ecoConnections } from '../config/ecoConnections.ts';

async function main() {
  const apply = process.argv.includes('--apply');
  const ref = ecoConnections.supabaseProjectRef;
  const cli = (args: string[]) => execFileSync('pnpm', ['dlx', '--allow-build=supabase', 'supabase@2.120.0', ...args],
    { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const operator = JSON.parse(cli(['whoami', '--output-format', 'json']));
  if (operator.username !== 'hocheunglai-oss') throw new Error('Operator mismatch.');
  const project = JSON.parse(cli(['projects', 'list', '--output', 'json'])).find((p: { id: string }) => p.id === ref);
  if (!project || project.name !== 'ECO' || project.organization_id !== ecoConnections.supabaseOrganizationId ||
      project.region !== ecoConnections.supabaseRegion || project.status !== 'ACTIVE_HEALTHY') throw new Error('ECO target mismatch.');
  const importReceipt = JSON.parse(readFileSync('output/access/eco-provision-checkpoint.private.json', 'utf8'));
  if (importReceipt.projectRef !== ref || !importReceipt.complete) throw new Error('Missing verified roster import.');
  const importedIds = new Set<string>(Object.values(importReceipt.ids));
  const sql = (query: string) => {
    const path = 'output/access/password-provisioning.private.sql';
    writeFileSync(path, query, { mode: 0o600 }); chmodSync(path, 0o600);
    return JSON.parse(cli(['db', 'query', '--linked', '--project-ref', ref!, '--file', path, '--output', 'json']));
  };
  const result = sql('select id,email,is_admin,is_active,revision,source_spc_id from eco_private.users order by id;');
  const rows = Array.isArray(result) ? result : result.rows;
  if (!Array.isArray(rows) || rows.length !== importedIds.size || rows.some(r => !importedIds.has(r.id))) throw new Error('Directory differs from imported roster.');
  const summary = { users: rows.length, administrators: rows.filter(r => r.is_admin).length,
    active: rows.filter(r => r.is_active).length, inactivePreserved: rows.filter(r => !r.is_active).length, emailsSent: 0 };
  if (!apply) { console.log(JSON.stringify({ ...summary, dryRun: true })); return; }

  const input = JSON.parse(readFileSync(0, 'utf8'));
  for (const key of ['administratorPassword', 'otherPassword']) {
    const value = input[key];
    if (typeof value !== 'string' || value.length < 8 || Buffer.byteLength(value) > 72 ||
        !/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value)) throw new Error('Invalid initial password input.');
  }
  const checkpointPath = 'output/access/password-policy-20261014.private.json';
  let checkpoint: { projectRef: string; completedIds: string[]; complete: boolean };
  try { checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    checkpoint = { projectRef: ref!, completedIds: [], complete: false };
  }
  if (checkpoint.projectRef !== ref || checkpoint.completedIds.some(id => !importedIds.has(id))) throw new Error('Checkpoint mismatch.');
  if (checkpoint.complete) { console.log(JSON.stringify({ ...summary, alreadyCompleted: true })); return; }
  const keys = JSON.parse(readFileSync('output/access/eco-api-keys.private.json', 'utf8'));
  const secret = keys.find((k: { type: string }) => k.type === 'secret')?.api_key;
  if (!secret?.startsWith('sb_secret_')) throw new Error('Missing ECO operator credential.');
  const admin = createClient(`https://${ref}.supabase.co`, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listed.error || listed.data.users.length !== rows.length) throw new Error('Auth directory mismatch.');
  for (const row of rows) {
    const user = listed.data.users.find(u => u.id === row.id);
    if (!user || user.email?.toLowerCase() !== row.email || user.app_metadata.eco_source_spc_id !== row.source_spc_id) throw new Error('Identity provenance mismatch.');
  }
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  for (const row of rows) {
    if (checkpoint.completedIds.includes(row.id)) continue;
    // Revoke old application sessions before changing credentials; never re-enable an inactive member.
    sql(`begin; do $$ begin if not exists(select 1 from eco_private.users where id=${quote(row.id)}::uuid and revision=${row.revision} and is_admin=${row.is_admin}) then raise exception 'Profile changed'; end if; end $$;
      insert into eco_private.revoked_sessions(session_id,user_id) select id,user_id from auth.sessions where user_id=${quote(row.id)}::uuid on conflict do nothing; commit;`);
    const updated = await admin.auth.admin.updateUserById(row.id, {
      password: row.is_admin ? input.administratorPassword : input.otherPassword, email_confirm: true,
    });
    if (updated.error) throw new Error('Credential update failed; resume using private checkpoint.');
    // Admin confirmation is based on the approved SPC directory, not on an email-ownership challenge.
    sql(`begin; do $$ begin if not exists(select 1 from eco_private.users where id=${quote(row.id)}::uuid and revision=${row.revision} and is_admin=${row.is_admin}) then raise exception 'Profile changed'; end if; end $$;
      insert into eco_private.revoked_sessions(session_id,user_id) select id,user_id from auth.sessions where user_id=${quote(row.id)}::uuid on conflict do nothing;
      update eco_private.users set activated_at=coalesce(activated_at,now()),password_prompt_dismissed_at=null,revision=revision+1,updated_at=now() where id=${quote(row.id)}::uuid;
      insert into eco_private.access_audit(target_id,action,after_access) values(${quote(row.id)}::uuid,'operator-initial-password',jsonb_build_object('operator','hocheunglai-oss','changeRequired',false,'emailConfirmation','approved-roster','policyDate','2026-10-14')); commit;`);
    checkpoint.completedIds.push(row.id);
    writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), { mode: 0o600 }); chmodSync(checkpointPath, 0o600);
    if (checkpoint.completedIds.length % 10 === 0) console.log(JSON.stringify({ passwordsAssigned: checkpoint.completedIds.length, total: rows.length }));
  }
  checkpoint.complete = true;
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, passwordsAssigned: checkpoint.completedIds.length, optionalFirstLoginChange: true }));
}
main().catch(() => { console.error('Initial-password operation stopped. No credentials are printed; inspect target, migration and private checkpoint before retrying.'); process.exitCode = 1; });
