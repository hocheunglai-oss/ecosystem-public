import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAuth } from '../server/auth/handler';
import { ApiError, password } from '../server/auth/validation';
import { authConfig } from '../server/auth/config';
import type { AuthConfig } from '../server/auth/config';
import type { AuthGateway } from '../server/auth/gateway';
import type { AccessUser, AccessSession } from '../shared/access';

const config: AuthConfig = { origin: 'https://eco.example.test', supabaseUrl: 'https://example.supabase.co',
  publishableKey: 'fixture-key', secretKey: 'fixture-secret', rateLimitSecret: 'fixture-rate-secret-not-a-real-secret', secureCookies: true };
const user: AccessUser = { id: '11111111-1111-4111-8111-111111111111', email: 'trader@example.test', displayName: 'Trader',
  officeId: 'hk', officeName: 'Hong Kong', isAdmin: false, isManager: false, isSpcTrader: false, isActive: true, activated: true, passwordChangeSuggested: true, revision: 1 };
function fixture(current: AccessUser | null = user) {
  const calls: string[] = [];
  const gateway: AuthGateway = {
    cookies: [], currentUser: async () => current,
    getPreview: async () => null, previewOptions: async () => ({offices:[{id:'hk',name:'Hong Kong'}]}),
    setPreview: async input => input ? {...input,officeName:input.officeId,readOnly:true} : null,
    consumeLoginAttempt: async () => { calls.push('limit'); },
    signIn: async () => { calls.push('login'); }, signOut: async () => { calls.push('logout'); },
    listUsers: async () => { calls.push('list'); return { users: [user], offices: [{ id: 'hk', name: 'Hong Kong' }] }; },
    updateUser: async input => { calls.push('update'); return { ...user, ...input, revision: 2 }; },
    activate: async () => { calls.push('activate'); },
    createUser: async (_actor, input) => { calls.push('create-user'); return { ...user, email: input.email, displayName: input.displayName, phone: input.phone, revision: 1 }; },
    resetUserPassword: async () => { calls.push('reset-password'); return { ...user, revision: 2 }; },
    deleteUser: async (_actor, input) => { calls.push('delete-user'); return {deletedUserId: input.id}; },
    listPhoneRequests: async () => { calls.push('list-phone'); return {requests:[]}; },
    requestPhoneChange: async input => { calls.push('request-phone'); return {id:input.requestId,userId:user.id,displayName:user.displayName,email:user.email,officeName:user.officeName,currentPhone:'',requestedPhone:input.phone,status:'pending',requestedAt:'2026-10-14T08:00:00Z',reviewedAt:null,reviewedBy:null}; },
    reviewPhoneChange: async input => { calls.push('review-phone'); return {id:input.id,userId:user.id,displayName:user.displayName,email:user.email,officeName:user.officeName,currentPhone:'',requestedPhone:'+6591815902',status:input.decision==='approve'?'approved':'declined',requestedAt:'2026-10-14T08:00:00Z',reviewedAt:'2026-10-14T09:00:00Z',reviewedBy:user.id}; },
    dismissPasswordPrompt: async () => { calls.push('dismiss'); current = { ...user, passwordChangeSuggested: false }; return current; },
    changePassword: async () => { calls.push('password'); current = { ...user, passwordChangeSuggested: false }; return current; },
  };
  return { gateway, calls };
}
function request(path: string, body?: unknown, extra: Record<string,string> = {}) {
  return new Request(config.origin + '/api/access/' + path, body === undefined ? {} : {
    method: 'POST', headers: { origin: config.origin, 'content-type': 'application/json', 'x-eco-request': '1', ...extra }, body: JSON.stringify(body),
  });
}

test('an unconfigured installation fails closed rather than selecting another project', () => {
  assert.throws(() => authConfig({ NODE_ENV: 'production' }), /AUTH_NOT_CONFIGURED/);
});
test('a legacy browser identity, role parameter or forged cookie does not grant a session', async () => {
  const f = fixture(null);
  const response = await handleAuth(new Request(config.origin + '/api/access/session?role=admin', { headers: { cookie: 'ecosystem.session.v1=marco' } }), config, f.gateway);
  assert.equal(response.status, 401); assert.deepEqual(await response.json(), { user: null });
});
test('login applies durable throttling before password verification and returns no tokens', async () => {
  const f = fixture();
  const secret = 'Mixed Case / with spaces';
  f.gateway.signIn = async (address, value) => { assert.equal(address, 'trader@example.test'); assert.equal(value, secret); f.calls.push('login'); };
  f.gateway.cookies.push('eco-auth=fixture; HttpOnly; Secure; SameSite=Strict; Path=/');
  const response = await handleAuth(request('login', { email: 'TRADER@example.test', password: secret, isAdmin: true }), config, f.gateway);
  assert.equal(response.status, 200); assert.deepEqual(f.calls, ['limit','login']);
  const result = await response.json() as { user: AccessUser }; assert.equal(result.user.isAdmin, false);
  assert.deepEqual(Object.keys(result), ['user']); assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(response.headers.get('cache-control')!, /no-store/);
});
test('provider authentication alone does not admit an unprovisioned or suspended user', async () => {
  const f = fixture(null);
  const response = await handleAuth(request('login', { email: user.email, password: 'fixture password' }), config, f.gateway);
  assert.equal(response.status, 401); assert.deepEqual(f.calls, ['limit','login','logout']);
});
for (const [name, headers] of [
  ['foreign origin', { origin: 'https://attacker.example.test' }],
  ['missing origin', { origin: '' }],
  ['missing custom request header', { 'x-eco-request': '' }],
  ['cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
  ['form submission', { 'content-type': 'application/x-www-form-urlencoded' }],
] as const) test(`login rejects ${name} before calling the provider`, async () => {
  const f = fixture();
  const response = await handleAuth(request('login', { email: user.email, password: 'fixture' }, headers), config, f.gateway);
  assert.ok(response.status === 403 || response.status === 415); assert.deepEqual(f.calls, []);
});
test('malformed, oversized and invalid credential requests never reach authentication', async () => {
  for (const body of [null, [], { email: 'invalid', password: 'fixture' }, { email: user.email, password: '' }, { email: user.email, password: 'a'.repeat(9000) }]) {
    const f = fixture(); const response = await handleAuth(request('login', body), config, f.gateway);
    assert.ok(response.status >= 400); assert.deepEqual(f.calls, []);
  }
});
test('distributed rate-limit denial prevents password verification', async () => {
  const f = fixture(); f.gateway.consumeLoginAttempt = async () => { throw new ApiError(429, 'Too many attempts.'); };
  const response = await handleAuth(request('login', { email: user.email, password: 'fixture' }), config, f.gateway);
  assert.equal(response.status, 429); assert.deepEqual(f.calls, []);
});
test('a regular trader or manager cannot list or edit user access through the API', async () => {
  for (const isManager of [false,true]) for (const action of ['read','write']) {
    const f = fixture({ ...user, isManager });
    const response = await handleAuth(request('users', action === 'write' ? { isAdmin: true } : undefined), config, f.gateway);
    assert.equal(response.status, 403); assert.deepEqual(f.calls, []);
  }
});
test('an administrator can read the directory and make a revision-checked edit', async () => {
  const f = fixture({ ...user, isAdmin: true });
  const response = await handleAuth(request('users'), config, f.gateway);
  assert.equal(response.status, 200); assert.deepEqual(f.calls, ['list']);
  const update = await handleAuth(request('users', { id: user.id, expectedRevision: 1, displayName: 'Updated trader', officeId: 'hk',
    isAdmin: false, isManager: true, isSpcTrader: true, isActive: true, email: 'attacker@example.test' }), config, f.gateway);
  assert.equal(update.status, 200); assert.equal((await update.json() as { user: AccessUser }).user.email, user.email);
});
test('missing revisions and coercible checkbox values cannot become privilege changes', async () => {
  for (const extra of [{ expectedRevision: undefined }, { expectedRevision: 0 }, { isAdmin: 'false' }, { isManager: 1 }]) {
    const f = fixture({ ...user, isAdmin: true });
    const response = await handleAuth(request('users', { id: user.id, expectedRevision: 1, displayName: 'Trader', officeId: 'hk',
      isAdmin: false, isManager: false, isSpcTrader: false, isActive: true, ...extra }), config, f.gateway);
    assert.equal(response.status, 400); assert.deepEqual(f.calls, []);
  }
});
test('database conflicts are returned distinctly and internal failures do not disclose secrets', async () => {
  const f = fixture({ ...user, isAdmin: true });
  f.gateway.updateUser = async () => { throw new ApiError(409, 'Reload and try again.'); };
  const conflict = await handleAuth(request('users', { id: user.id, expectedRevision: 1, displayName: 'Trader', officeId: 'hk',
    isAdmin: false, isManager: false, isSpcTrader: false, isActive: true }), config, f.gateway);
  assert.equal(conflict.status, 409);
  f.gateway.listUsers = async () => { throw new Error('private provider credentials'); };
  const response = await handleAuth(request('users'), config, f.gateway);
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /credentials/);
});
test('activation requires a single-use link and a new password; weak passwords never reach the provider', async () => {
  const f = fixture();
  const response = await handleAuth(request('activate', { tokenHash: 'a'.repeat(64), type: 'invite', password: 'weak' }), config, f.gateway);
  assert.equal(response.status, 400); assert.deepEqual(f.calls, []);
  const valid = await handleAuth(request('activate', { tokenHash: 'a'.repeat(64), type: 'invite', password: 'A distinct long passphrase 8' }), config, f.gateway);
  assert.equal(valid.status, 200); assert.deepEqual(f.calls, ['activate']);
});
test('password validation preserves case and whitespace and rejects provider byte-limit overflow', () => {
  assert.equal(password(' a sufficiently Long phrase 8 ', true), ' a sufficiently Long phrase 8 ');
  assert.throws(() => password('🙂'.repeat(19), true));
});
test('logout does not claim success when provider revocation fails', async () => {
  const f = fixture(); f.gateway.signOut = async () => { throw new ApiError(503, 'Retry sign-out.'); };
  const response = await handleAuth(request('logout', {}), config, f.gateway);
  assert.equal(response.status, 503);
});

test('a verified deployment origin permits same-deployment forms without accepting arbitrary hosts', async () => {
  const f=fixture();
  const deployed={...config,deploymentOrigin:'https://eco-reviewed.vercel.app'};
  const good=await handleAuth(request('login',{email:user.email,password:'fixture'},{origin:deployed.deploymentOrigin}),deployed,f.gateway);
  assert.equal(good.status,200);
  const bad=await handleAuth(request('login',{email:user.email,password:'fixture'},{origin:'https://eco-other.vercel.app'}),deployed,f.gateway);
  assert.equal(bad.status,403);
});

test('new passwords require eight characters, uppercase, lowercase and a number', () => {
  for (const value of ['Abcdef1', 'abcdefgh8', 'ABCDEFGH', '12345678', 'ABCDEF12']) assert.throws(() => password(value, true));
  for (const value of ['Abcdef12', ' With SPACES 8 ']) assert.equal(password(value, true), value);
});
test('any authenticated user can skip the password invitation without changing credentials or access', async () => {
  const f = fixture();
  const response = await handleAuth(request('password-prompt', { isAdmin: true }), config, f.gateway);
  assert.equal(response.status, 200); assert.deepEqual(f.calls, ['dismiss']);
  const result = await response.json() as { user: AccessUser };
  assert.equal(result.user.passwordChangeSuggested, false); assert.equal(result.user.isAdmin, false);
});
test('password changes use the authenticated identity and throttle before reauthentication', async () => {
  const f = fixture();
  f.gateway.changePassword = async (actor, oldValue, newValue) => {
    assert.equal(actor.id, user.id); assert.equal(actor.email, user.email);
    assert.equal(oldValue, 'Current 9'); assert.equal(newValue, 'Changed 8');
    f.calls.push('password'); return { ...user, passwordChangeSuggested: false };
  };
  const response = await handleAuth(request('password', { currentPassword: 'Current 9', newPassword: 'Changed 8', email: 'other@example.test', id: 'other' }), config, f.gateway);
  assert.equal(response.status, 200); assert.deepEqual(f.calls, ['limit', 'password']);
  assert.doesNotMatch(await response.text(), /Current 9|Changed 8/);
});
test('password and prompt actions reject signed-out or cross-origin requests without mutation', async () => {
  for (const path of ['password', 'password-prompt']) {
    const missing = fixture(null);
    assert.equal((await handleAuth(request(path, {}), config, missing.gateway)).status, 401);
    assert.deepEqual(missing.calls, []);
    const foreign = fixture();
    assert.equal((await handleAuth(request(path, {}, { origin: 'https://other.example.test' }), config, foreign.gateway)).status, 403);
    assert.deepEqual(foreign.calls, []);
  }
});
test('password actions return refreshed SQL capabilities and cannot copy an unverified mutation profile', async () => {
  for (const path of ['password','password-prompt']) {
    const owner={...user,isAdmin:true,capabilities:{appearancePreview:true,testWorkspace:true}};
    const f=fixture(owner); let reads=0;
    const refreshed={...owner,passwordChangeSuggested:false,capabilities:{appearancePreview:false,testWorkspace:false}};
    f.gateway.currentUser=async()=>++reads===1?owner:refreshed;
    f.gateway.dismissPasswordPrompt=async()=>owner;
    f.gateway.changePassword=async()=>owner;
    const response=await handleAuth(request(path,{currentPassword:'Current 9',newPassword:'Changed 8',capabilities:owner.capabilities}),config,f.gateway);
    assert.equal(response.status,200);
    assert.deepEqual((await response.json() as {user:AccessUser}).user,refreshed);
    assert.equal(reads,2);
    f.gateway.currentUser=async()=>++reads===3?owner:null;
    const denied=await handleAuth(request(path,{currentPassword:'Current 9',newPassword:'Changed 8'}),config,f.gateway);
    assert.equal(denied.status,401);
  }
});
test('weak, unchanged or missing passwords never reach the provider', async () => {
  for (const body of [{currentPassword:'Old 8',newPassword:'weak'}, {currentPassword:'Sameval8',newPassword:'Sameval8'}, {newPassword:'Different8'}]) {
    const f=fixture();
    assert.equal((await handleAuth(request('password', body), config, f.gateway)).status,400);
    assert.deepEqual(f.calls,[]);
  }
});
test('password-change rate limit denial prevents reauthentication', async () => {
  const f = fixture(); f.gateway.consumeLoginAttempt = async () => { throw new ApiError(429, 'Too many attempts.'); };
  assert.equal((await handleAuth(request('password',{currentPassword:'Current 8',newPassword:'Changed 9'}),config,f.gateway)).status,429);
  assert.deepEqual(f.calls,[]);
});

const adminCreate = {requestId:'44444444-4444-4444-8444-444444444444',email:'new@example.test',displayName:'New Trader',phone:'+85261234567',officeId:'hk',isAdmin:false,isManager:false,isSpcTrader:false,isActive:true,administratorPassword:'Synthetic Admin 9'};
const adminReset = {requestId:adminCreate.requestId,id:'22222222-2222-4222-8222-222222222222',expectedRevision:1,newPassword:'Synthetic New 8',administratorPassword:'Synthetic Admin 9'};
test('administrator create/reset require admin membership, same-origin and fresh-password gateway path',async()=>{
  for(const [path,body,operation] of [['users/create',adminCreate,'create-user'],['users/reset-password',adminReset,'reset-password'],['users/delete',adminReset,'delete-user']] as const){
    for(const member of [null,user,{...user,isManager:true}]){
      const f=fixture(member);assert.equal((await handleAuth(request(path,body),config,f.gateway)).status,member?403:401);assert.deepEqual(f.calls,[]);
    }
    const f=fixture({...user,isAdmin:true});
    assert.equal((await handleAuth(request(path,body),config,f.gateway)).status,200);assert.deepEqual(f.calls,['limit',operation]);
    const denied=fixture({...user,isAdmin:true});
    assert.equal((await handleAuth(request(path,body,{origin:'https://foreign.test'}),config,denied.gateway)).status,403);assert.deepEqual(denied.calls,[]);
  }
});
test('admin mutations validate password policy, request ID, phone and revision before provider access',async()=>{
  const invalidCreates=[{administratorPassword:''},{requestId:'bad'},{phone:'85261234567'},{phone:'+01234567'},{phone:'+852 61234567 ext 2'},{phone:'+85261234567#2'},{phone:'+85261234567,2'},{phone:'+85261234567/2'},{isAdmin:'false'},{email:'bad'}];
  for(const patch of invalidCreates){const f=fixture({...user,isAdmin:true});assert.equal((await handleAuth(request('users/create',{...adminCreate,...patch}),config,f.gateway)).status,400);assert.deepEqual(f.calls,[]);}
  for(const patch of [{id:user.id},{expectedRevision:0},{requestId:'bad'},{newPassword:'weak'},{administratorPassword:''}]){const f=fixture({...user,isAdmin:true});assert.equal((await handleAuth(request('users/reset-password',{...adminReset,...patch}),config,f.gateway)).status,400);assert.deepEqual(f.calls,[]);}
});
test('contact phone edit can clear or omit the field without changing Auth phone or identity',async()=>{
  const f=fixture({...user,isAdmin:true});let received:unknown;
  f.gateway.updateUser=async input=>{received=input;return {...user,...input};};
  const body={id:user.id,expectedRevision:1,displayName:'Trader',officeId:'hk',isAdmin:false,isSpcTrader:false,isManager:false,isActive:true};
  assert.equal((await handleAuth(request('users',body),config,f.gateway)).status,200);assert.equal(Object.hasOwn(received as object,'phone'),false);
  assert.equal((await handleAuth(request('users',{...body,phone:''}),config,f.gateway)).status,200);assert.equal((received as {phone:string}).phone,'');
  assert.equal((await handleAuth(request('users',{...body,phone:'+85261234567'}),config,f.gateway)).status,200);assert.equal((received as {phone:string}).phone,'+85261234567');
});
test('admin password attempts share durable throttle and expose only safe provider errors',async()=>{
  for(const [path,body] of [['users/create',adminCreate],['users/reset-password',adminReset],['users/delete',adminReset]] as const){
    const f=fixture({...user,isAdmin:true});f.gateway.consumeLoginAttempt=async()=>{throw new ApiError(429,'Try later.');};
    assert.equal((await handleAuth(request(path,body),config,f.gateway)).status,429);assert.deepEqual(f.calls,[]);
  }
});

test('only durable admin operation failure is marked safe for starting a new request',async()=>{
  const f=fixture({...user,isAdmin:true});
  f.gateway.resetUserPassword=async()=>{const error=new ApiError(400,'Provider rejected password.');error.operationState='failed';throw error;};
  const failed=await handleAuth(request('users/reset-password',adminReset),config,f.gateway);assert.equal((await failed.json() as {operationState:string}).operationState,'failed');
  f.gateway.resetUserPassword=async()=>{throw new ApiError(400,'Your administrator password is incorrect.');};
  const retry=await handleAuth(request('users/reset-password',adminReset),config,f.gateway);assert.equal(Object.hasOwn(await retry.json() as object,'operationState'),false);
});

test('preview preserves real identity and projects only the selected role and office', async () => {
  const admin={...user,isAdmin:true,isManager:true,isSpcTrader:true};const f=fixture(admin);
  const response=await handleAuth(request('preview',{role:'credit',officeId:'CREDIT'}),config,f.gateway);
  assert.equal(response.status,200);const result=await response.json() as AccessSession;
  assert.deepEqual(result.user,admin);assert.equal(result.effectiveUser.id,admin.id);assert.equal(result.effectiveUser.email,admin.email);
  assert.equal(result.effectiveUser.isAdmin,false);assert.equal(result.effectiveUser.isManager,false);assert.equal(result.effectiveUser.isSpcTrader,false);assert.equal(result.effectiveUser.officeId,'CREDIT');
  assert.equal(result.preview!.readOnly,true);
});
test('preview rejects trader access, unknown roles, identity injection and invalid credit office', async () => {
  for(const path of ['preview','preview/options']){
    const f=fixture();assert.equal((await handleAuth(request(path,path==='preview'?{role:'admin',officeId:'hk'}:undefined),config,f.gateway)).status,403);
  }
  for(const body of [{role:'root',officeId:'hk'},{role:'admin',officeId:'hk',id:user.id},{role:'credit',officeId:'hk'},{role:'trader',officeId:''}]){
    const f=fixture({...user,isAdmin:true});assert.equal((await handleAuth(request('preview',body),config,f.gateway)).status,400);
  }
});
test('all mutation routes reject preview before throttling or provider calls, including ADMIN preview',async()=>{
  for(const role of ['admin','trader','spc-trader','manager','credit'] as const)for(const path of ['password','password-prompt','users','users/create','users/reset-password','users/delete','login','activate','future-write']){
    const f=fixture({...user,isAdmin:true});f.gateway.getPreview=async()=>({role,officeId:role==='credit'?'CREDIT':'hk',officeName:'Office',readOnly:true});
    const req=request(path,{}, {cookie:'eco-auth=synthetic-cookie'});
    const result=await handleAuth(req,config,f.gateway);assert.equal(result.status,403,`${role}/${path}`);assert.match((await result.json() as {message:string}).message,/read only/i);assert.deepEqual(f.calls,[]);
  }
});
test('preview sessions expose real and effective user separately, hide admin directory and allow end/logout',async()=>{
  const admin={...user,isAdmin:true};const f=fixture(admin);
  f.gateway.getPreview=async()=>({role:'trader',officeId:'hk',officeName:'Hong Kong',readOnly:true});
  const session=await handleAuth(request('session'),config,f.gateway);const body=await session.json() as AccessSession;
  assert.deepEqual(body.user,admin);assert.equal(body.effectiveUser.isAdmin,false);
  assert.equal((await handleAuth(request('users'),config,f.gateway)).status,403);
  assert.equal((await handleAuth(request('preview/options'),config,f.gateway)).status,200);
  const end=await handleAuth(request('preview/end',{}),config,f.gateway);assert.deepEqual(await end.json(),{user:admin,effectiveUser:admin,preview:null});
  assert.equal((await handleAuth(request('logout',{}),config,f.gateway)).status,200);assert.deepEqual(f.calls,['logout']);
});
test('a signed-in cookie cannot be replaced by login or activation during a preview race',async()=>{
  for(const path of ['login','activate']){
    const f=fixture({...user,isAdmin:true});const res=await handleAuth(request(path,{}, {cookie:'eco-auth=synthetic'}),config,f.gateway);
    assert.equal(res.status,409);assert.deepEqual(f.calls,[]);
  }
});

test('creation ignores caller password overrides and normalizes phone formatting',async()=>{
  const f=fixture({...user,isAdmin:true});let received:unknown;
  f.gateway.createUser=async(_actor,input)=>{received=input;return {...user,phone:input.phone};};
  const response=await handleAuth(request('users/create',{...adminCreate,password:'caller override',phone:'+65–(9181) 5902'}),config,f.gateway);
  assert.equal(response.status,200);assert.equal((received as {phone:string}).phone,'+6591815902');
  assert.equal(Object.hasOwn(received as object,'password'),false);
  assert.doesNotMatch(await response.text(),/caller override|Synthetic Admin/);
});
test('delete rejects self, invalid identity, stale-shaped revision and missing password before gateway',async()=>{
  for(const patch of [{id:user.id},{id:'bad'},{requestId:'bad'},{expectedRevision:0},{administratorPassword:''}]) {
    const f=fixture({...user,isAdmin:true});
    const response=await handleAuth(request('users/delete',{...adminReset,...patch}),config,f.gateway);
    assert.equal(response.status,400);assert.deepEqual(f.calls,[]);
  }
});

const phoneRequestId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
test('active members can read and request a normalized phone change without editing access or needing an admin password',async()=>{
  for(const isAdmin of [false,true]){
    const f=fixture({...user,isAdmin});
    assert.equal((await handleAuth(request('phone-requests'),config,f.gateway)).status,200);
    const response=await handleAuth(request('phone-requests',{requestId:phoneRequestId,phone:' +65 (9181)-5902 '}),config,f.gateway);
    assert.equal(response.status,200);
    const result=await response.json() as {request:{requestedPhone:string;status:string;userId:string}};
    assert.equal(result.request.requestedPhone,'+6591815902');assert.equal(result.request.status,'pending');assert.equal(result.request.userId,user.id);
    assert.deepEqual(f.calls,['list-phone','request-phone']);
    assert.match(response.headers.get('cache-control')!,/no-store/);
  }
});
test('phone request rejects identity overrides, malformed numbers and missing request identity before RPC',async()=>{
  for(const input of [{requestId:phoneRequestId,phone:''},{requestId:phoneRequestId,phone:'+65x91815902'},
    {requestId:phoneRequestId,phone:'+6591815902',userId:'someone-else'}, {requestId:'invalid',phone:'+6591815902'}]){
    const f=fixture();assert.equal((await handleAuth(request('phone-requests',input),config,f.gateway)).status,400);assert.deepEqual(f.calls,[]);
  }
});
test('phone request and review are denied without authentication and while previewing',async()=>{
  for(const path of ['phone-requests','phone-requests/review']){
    const body=path.endsWith('review')?{id:phoneRequestId,decision:'approve'}:{requestId:phoneRequestId,phone:'+6591815902'};
    const unauth=fixture(null);assert.equal((await handleAuth(request(path,body),config,unauth.gateway)).status,401);assert.deepEqual(unauth.calls,[]);
    const preview=fixture({...user,isAdmin:true});preview.gateway.getPreview=async()=>({role:'admin',officeId:'hk',officeName:'Hong Kong',readOnly:true});
    assert.equal((await handleAuth(request(path,body),config,preview.gateway)).status,403);assert.deepEqual(preview.calls,[]);
  }
});
test('only actual administrators can review phone requests; actions are strict',async()=>{
  for(const isManager of [false,true]){
    const f=fixture({...user,isManager});assert.equal((await handleAuth(request('phone-requests/review',{id:phoneRequestId,decision:'approve'}),config,f.gateway)).status,403);assert.deepEqual(f.calls,[]);
  }
  for(const input of [{id:phoneRequestId,decision:'approved'},{id:phoneRequestId,decision:'approve',userId:user.id}]){
    const f=fixture({...user,isAdmin:true});assert.equal((await handleAuth(request('phone-requests/review',input),config,f.gateway)).status,400);assert.deepEqual(f.calls,[]);
  }
  const f=fixture({...user,isAdmin:true});assert.equal((await handleAuth(request('phone-requests/review',{id:phoneRequestId,decision:'approve'}),config,f.gateway)).status,200);assert.deepEqual(f.calls,['review-phone']);
});
