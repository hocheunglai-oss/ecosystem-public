/** Operator-only import. No passwords, links, emails or source-account mutations. */
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { ecoConnections } from '../config/ecoConnections.ts';
import { prepareSpcRoster } from '../server/access/spcRoster.ts';

const apply = process.argv.includes('--apply');
const base = new URL('../output/access/', import.meta.url);
const input = JSON.parse(await readFile(new URL('spc-roster-input.private.json', base), 'utf8'));
const roster = prepareSpcRoster(input.rows, input.decisions);
const summary = { users: roster.users.length, active: roster.users.filter(u => u.isActive).length,
  administrators: roster.users.filter(u => u.isAdmin).length, offices: roster.offices.length, emailsSent: 0 };
if (!apply) { console.log(JSON.stringify({ ...summary, dryRun: true })); process.exit(0); }
function cli(args: string[]) {
  return execFileSync('pnpm', ['dlx','--allow-build=supabase','supabase@2.120.0', ...args],
    { encoding:'utf8', timeout:60_000, stdio:['ignore','pipe','pipe'] });
}
const account = JSON.parse(cli(['whoami','--output-format','json']));
if (account.username !== 'hocheunglai-oss') throw new Error('Unexpected operator.');
const projects = JSON.parse(cli(['projects','list','--output','json']));
const project = projects.find((p: { id:string }) => p.id === ecoConnections.supabaseProjectRef);
if (!project || project.organization_id !== ecoConnections.supabaseOrganizationId ||
    project.region !== ecoConnections.supabaseRegion || project.name !== 'ECO' || project.status !== 'ACTIVE_HEALTHY') {
  throw new Error('ECO target mismatch.');
}
const checkpointPath = new URL('eco-provision-checkpoint.private.json',base);
type Checkpoint = { projectRef:string; operator:string; complete:boolean; ids:Record<string,string> };
let checkpoint: Checkpoint;
try { checkpoint = JSON.parse(await readFile(checkpointPath,'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  checkpoint = { projectRef:project.id, operator:account.username, complete:false, ids:{} }; }
if (checkpoint.projectRef !== project.id || checkpoint.operator !== account.username) throw new Error('Checkpoint target mismatch.');
if (checkpoint.complete) { console.log(JSON.stringify({ ...summary, alreadyCompleted:true })); process.exit(0); }
const keys = JSON.parse(await readFile(new URL('eco-api-keys.private.json',base),'utf8'));
const secret = keys.find((k: { type:string }) => k.type === 'secret')?.api_key;
if (!secret?.startsWith('sb_secret_')) throw new Error('Missing ECO secret key.');
const admin = createClient(`https://${project.id}.supabase.co`,secret,
  { auth:{ persistSession:false, autoRefreshToken:false } });
const { data, error } = await admin.auth.admin.listUsers({ page:1, perPage:1000 });
if (error) throw new Error('Cannot inspect ECO identities.');
const existing = new Map(data.users.map(u => [u.email?.toLowerCase(),u]));
for (const profile of roster.users) {
  let user = existing.get(profile.email);
  if (user && (user.app_metadata.eco_source_spc_id !== profile.sourceSpcId ||
      (checkpoint.ids[profile.sourceSpcId] && checkpoint.ids[profile.sourceSpcId] !== user.id))) {
    throw new Error('Existing identity is not owned by this import.');
  }
  if (!user) {
    const created = await admin.auth.admin.createUser({ email:profile.email, email_confirm:false,
      app_metadata:{ eco_source_spc_id:profile.sourceSpcId, eco_import:'spc-roster-v1' } });
    if (created.error || !created.data.user) throw new Error('Identity creation failed; resume from private checkpoint.');
    user = created.data.user;
  }
  checkpoint.ids[profile.sourceSpcId] = user.id;
  await writeFile(checkpointPath,JSON.stringify(checkpoint,null,2)+'\n',{ mode:0o600 });
  await chmod(checkpointPath,0o600);
}
const quote = (text:string) => "'"+text.replaceAll("'","''")+"'";
const statements = roster.offices.map(o => `insert into eco_private.offices(id,name) values(${quote(o.id)},${quote(o.name)}) on conflict(id) do nothing;`);
for (const profile of roster.users) statements.push(`select eco_private.provision_user(${quote(checkpoint.ids[profile.sourceSpcId])}::uuid,${quote(JSON.stringify(profile))}::jsonb);`);
// Import profile updates and their audit entries atomically; new Auth identities remain inactive on any failure.
const sqlPath = new URL('eco-roster-import.private.sql',base);
await writeFile(sqlPath,'begin;\n'+statements.join('\n')+'\ncommit;\n',{mode:0o600});
await chmod(sqlPath,0o600);
cli(['db','query','--linked','--project-ref',project.id,'--file',sqlPath.pathname,'--output','json']);
checkpoint.complete=true;
await writeFile(checkpointPath,JSON.stringify(checkpoint,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({ ...summary, provisioned:true, passwordsAssigned:0 }));
