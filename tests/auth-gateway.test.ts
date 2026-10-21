import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthGateway } from '../server/auth/gateway';
import { handleAuth } from '../server/auth/handler';
import type { AuthConfig } from '../server/auth/config';

test('the actual Supabase SDK adapter keeps provider tokens in secure HttpOnly cookies', async () => {
  const config: AuthConfig = { origin:'https://eco.example.test',supabaseUrl:'https://fixture.supabase.co',publishableKey:'fixture-publishable',
    secretKey:'fixture-server-only-key',rateLimitSecret:'fixture-limit-key-at-least-32-characters',secureCookies:true };
  const id='11111111-1111-4111-8111-111111111111';
  const providerUser={id,email:'person@example.test',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{capabilities:{appearancePreview:true,testWorkspace:true},isAdmin:true},created_at:new Date().toISOString()};
  const member={id,email:providerUser.email,displayName:'Person',officeId:'hk',officeName:'Hong Kong',isAdmin:false,isSpcTrader:false,isManager:false,isActive:true,activated:true,passwordChangeSuggested:true,revision:1,capabilities:{appearancePreview:false,testWorkspace:false}};
  const now=Math.floor(Date.now()/1000);
  const token=[{alg:'HS256',typ:'JWT'},{iss:config.supabaseUrl+'/auth/v1',sub:id,aud:'authenticated',role:'authenticated',iat:now,exp:now+3600,
    session_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},'synthetic-signature'].map(part=>Buffer.from(typeof part==='string'?part:JSON.stringify(part)).toString('base64url')).join('.');
  const original=globalThis.fetch; const calls:string[]=[];
  try {
    globalThis.fetch=async(input,init)=>{
      const url=String(input);
      if(url.endsWith('/rest/v1/rpc/eco_preview_state')) return Response.json({preview:null,sessionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});calls.push(url);
      if(url.includes('eco_consume_login_attempt')) {
        assert.equal(new Headers(init?.headers).get('apikey'),config.secretKey);
        const body=JSON.parse(String(init?.body));assert.match(body.p_bucket,/^[a-f0-9]{64}$/);assert.doesNotMatch(String(init?.body),/person@example/);
        return Response.json(true);
      }
      if(url.includes('/auth/v1/logout?scope=local')) return new Response(null,{status:204});
        if(url.includes('/token?grant_type=password')) {
        const body=JSON.parse(String(init?.body));assert.equal(body.password,'Case-preserved Fixture Secret');
        return Response.json({access_token:token,refresh_token:'synthetic-refresh-token',expires_in:3600,expires_at:now+3600,token_type:'bearer',user:providerUser});
      }
      if(url.endsWith('/auth/v1/user')) return Response.json(providerUser);
      if(url.endsWith('/rest/v1/rpc/eco_current_user')) return Response.json(member);
      throw new Error('Unexpected fixture URL: '+url);
    };
    const request=new Request(config.origin+'/api/access/login',{method:'POST',headers:{origin:config.origin,'content-type':'application/json','x-eco-request':'1'},
      body:JSON.stringify({email:providerUser.email,password:'Case-preserved Fixture Secret'})});
    const gateway=createAuthGateway(request,config);
    const response=await handleAuth(request,config,gateway);
    assert.equal(response.status,200);
    const cookies=response.headers.getSetCookie();assert.ok(cookies.length>0);
    for(const cookie of cookies) { assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/i);assert.doesNotMatch(cookie,/Domain=/i); }
    const body=await response.text();assert.doesNotMatch(body,/access_token|refresh_token|synthetic-refresh|fixture-server/);
    assert.deepEqual(JSON.parse(body),{user:member});assert.equal(calls.length,4);
  } finally { globalThis.fetch=original; }
});

for (const scenario of ['success','wrong-current-password','wrong-identity','membership-denied','begin-fails','provider-update-fails','finalization-fails'] as const) {
  test(`password change uses provider reauthentication and guarded finalization: ${scenario}`, async () => {
    const config: AuthConfig={origin:'https://eco.example.test',supabaseUrl:'https://fixture.supabase.co',publishableKey:'fixture-publishable',secretKey:'fixture-server-key',rateLimitSecret:'fixture-limit-key-at-least-32-characters',secureCookies:true};
    const id='11111111-1111-4111-8111-111111111111', sid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const providerUser={id:scenario==='wrong-identity'?'22222222-2222-4222-8222-222222222222':id,email:'person@example.test',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()};
    const member={id,email:providerUser.email,displayName:'Person',officeId:'hk',officeName:'Hong Kong',isAdmin:false,isSpcTrader:false,isManager:false,isActive:true,activated:true,passwordChangeSuggested:true,revision:1};
    const changed={...member,passwordChangeSuggested:false,revision:2};
    const now=Math.floor(Date.now()/1000);
    const token=[{alg:'HS256',typ:'JWT'},{iss:config.supabaseUrl+'/auth/v1',sub:providerUser.id,aud:'authenticated',role:'authenticated',iat:now,exp:now+3600,session_id:sid},'synthetic-signature'].map(p=>Buffer.from(typeof p==='string'?p:JSON.stringify(p)).toString('base64url')).join('.');
    const original=globalThis.fetch,calls:string[]=[];let providerPasswordUpdated=false;
    const newSid='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const replacementToken=[{alg:'HS256',typ:'JWT'},{sub:id,aud:'authenticated',role:'authenticated',iat:now,exp:now+3600,session_id:newSid},'synthetic-signature'].map(p=>Buffer.from(typeof p==='string'?p:JSON.stringify(p)).toString('base64url')).join('.');
    try {
      globalThis.fetch=async(input,init)=>{
        const url=String(input);
      if(url.endsWith('/rest/v1/rpc/eco_preview_state')) return Response.json({preview:null,sessionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
        if(url.includes('/auth/v1/logout?scope=local')) return new Response(null,{status:204});
        if(url.includes('/token?grant_type=password')) {
          calls.push(providerPasswordUpdated?'replacement-login':'reauthenticate');
          if(providerPasswordUpdated){assert.equal(JSON.parse(String(init?.body)).password,'Different8');return Response.json({access_token:replacementToken,refresh_token:'synthetic-replacement-refresh',expires_in:3600,expires_at:now+3600,token_type:'bearer',user:providerUser});}
          assert.deepEqual(JSON.parse(String(init?.body)),{email:member.email,password:'Current 8',gotrue_meta_security:{}});
          if(scenario==='wrong-current-password') return Response.json({code:'invalid_credentials',msg:'Rejected'}, {status:400});
          return Response.json({access_token:token,refresh_token:'synthetic-refresh',expires_in:3600,expires_at:now+3600,token_type:'bearer',user:providerUser});
        }
        if(url.endsWith('/rest/v1/rpc/eco_current_user')) {
          calls.push('membership');
          return scenario==='membership-denied'?Response.json({code:'28000',message:'Unauthorized'},{status:401}):Response.json(member);
        }
        if(url.endsWith('/rest/v1/rpc/eco_begin_password_change_v3')) {
          calls.push('begin'); assert.equal(new Headers(init?.headers).get('apikey'),config.secretKey);
          assert.deepEqual(JSON.parse(String(init?.body)),{p_user_id:id,p_session_id:sid,p_origin_session_id:sid});
          return scenario==='begin-fails'?Response.json({code:'28000',message:'Revoked'},{status:401}):Response.json(null);
        }
        if(url.endsWith('/auth/v1/admin/users/'+id) && init?.method==='PUT') {
          calls.push('update-password');
          assert.equal(new Headers(init?.headers).get('apikey'),config.secretKey);
          assert.deepEqual(JSON.parse(String(init?.body)),{password:'Different8',app_metadata:{eco_access_change_request:sid}});
          providerPasswordUpdated=scenario!=='provider-update-fails';
          return scenario==='provider-update-fails'?Response.json({code:'weak_password',msg:'Rejected'},{status:400}):Response.json(providerUser);
        }
        if(url.endsWith('/rest/v1/rpc/eco_fail_password_change')) {calls.push('fail-password');return Response.json(null);}
        if(url.endsWith('/rest/v1/rpc/eco_complete_password_change_v2')) {
          calls.push('finalize'); assert.equal(new Headers(init?.headers).get('apikey'),config.secretKey);
          assert.deepEqual(JSON.parse(String(init?.body)),{p_user_id:id,p_request_id:sid,p_session_id:newSid});
          if(scenario==='finalization-forbidden')return Response.json({code:'42501',message:'Demoted'},{status:403});
          if(scenario==='finalization-conflict')return Response.json({code:'PT409',message:'Conflict'},{status:409});
          return scenario==='finalization-fails'?Response.json({code:'XX000',message:'Unavailable'},{status:500}):Response.json(changed);
        }
        if(url.includes('/auth/v1/logout?scope=others')) {calls.push('revoke-others');return new Response(null,{status:204});}
        throw new Error('Unexpected fixture operation');
      };
      const gateway=createAuthGateway(new Request(config.origin+'/api/access/password'),config);
      if(scenario==='success') {
        assert.deepEqual(await gateway.changePassword(member,'Current 8','Different8'),changed);
        assert.deepEqual(calls,['reauthenticate','membership','begin','update-password','replacement-login','finalize','revoke-others']);
        assert.ok(gateway.cookies.length>0);
        assert.ok(gateway.cookies.every(cookie=>/HttpOnly/.test(cookie)&&/Secure/.test(cookie)));
      } else {
        await assert.rejects(gateway.changePassword(member,'Current 8','Different8'));
        const expected={
          'wrong-current-password':['reauthenticate'],
          'wrong-identity':['reauthenticate'],
          'membership-denied':['reauthenticate','membership'],
          'begin-fails':['reauthenticate','membership','begin'],
          'provider-update-fails':['reauthenticate','membership','begin','update-password','fail-password'],
          'finalization-fails':['reauthenticate','membership','begin','update-password','replacement-login','finalize'],
        };
        assert.deepEqual(calls,expected[scenario]);
      }
    } finally {globalThis.fetch=original;}
  });
}

for (const scenario of ['user-503', 'user-network', 'refresh-429', 'refresh-503', 'refresh-invalid', 'user-revoked'] as const) {
  test(`session checks distinguish retryable provider failures from revoked credentials: ${scenario}`, async () => {
    const config: AuthConfig = { origin: 'https://eco.example.test', supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'fixture-publishable', secretKey: 'fixture-server-key', rateLimitSecret: 'fixture-limit-key-at-least-32-characters', secureCookies: true };
    const id = '11111111-1111-4111-8111-111111111111', sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const providerUser = { id, email: 'person@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    const member = { id, email: providerUser.email, displayName: 'Person', officeId: 'hk', officeName: 'Hong Kong', isAdmin: false, isSpcTrader: false, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
    const now = Math.floor(Date.now() / 1000), expired = scenario.startsWith('refresh');
    const makeSession = (expiry: number) => ({ access_token: [{ alg: 'HS256', typ: 'JWT' }, { sub: id, aud: 'authenticated', role: 'authenticated', iat: expiry - 900, exp: expiry, session_id: sid }, 'synthetic-signature'].map(value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')).join('.'), refresh_token: 'synthetic-persistent-refresh', expires_in: 900, expires_at: expiry, token_type: 'bearer', user: providerUser });
    const cookie = 'eco-auth=base64-' + Buffer.from(JSON.stringify(makeSession(expired ? now - 3600 : now + 900))).toString('base64url');
    const request = () => new Request(config.origin + '/api/access/session', { headers: { cookie } });
    const original = globalThis.fetch;
    let recovering = false, membershipReads = 0;
    try {
      globalThis.fetch = async input => {
        const url = String(input);
        if (url.endsWith('/rest/v1/rpc/eco_preview_state')) return Response.json({ preview: null, sessionId: sid });
        if (url.endsWith('/rest/v1/rpc/eco_current_user')) { membershipReads++; return Response.json(member); }
        if (url.includes('/token?grant_type=refresh_token')) {
          if (recovering) return Response.json(makeSession(now + 900));
          return Response.json({ code: scenario === 'refresh-invalid' ? 'refresh_token_not_found' : 'over_request_rate_limit', msg: 'Fixture provider response' }, { status: scenario === 'refresh-invalid' ? 400 : scenario === 'refresh-503' ? 503 : 429, headers: { 'x-supabase-api-version': '2024-01-01' } });
        }
        if (url.endsWith('/auth/v1/user')) {
          if (recovering) return Response.json(providerUser);
          if (scenario === 'user-network') throw new TypeError('Synthetic network failure');
          return Response.json({ code: scenario === 'user-revoked' ? 'session_not_found' : 'unexpected_failure', msg: 'Fixture provider response' }, { status: scenario === 'user-revoked' ? 401 : 503 });
        }
        throw new Error('Unexpected fixture URL');
      };
      const gateway = createAuthGateway(request(), config);
      const response = await handleAuth(request(), config, gateway);
      const definitive = scenario === 'refresh-invalid' || scenario === 'user-revoked';
      assert.equal(response.status, definitive ? 401 : 503);
      assert.equal(membershipReads, 0, 'failed provider authentication cannot fall back to cached member identity');
      if (!definitive) {
        assert.equal(response.headers.getSetCookie().length, 0, 'temporary failure must not erase the persistent refresh credential');
        recovering = true;
        const recovered = await handleAuth(request(), config, createAuthGateway(request(), config));
        assert.equal(recovered.status, 200);
        assert.equal((await recovered.json()).user.id, id);
        assert.equal(membershipReads, 1);
      }
      assert.doesNotMatch(await response.text(), /synthetic-persistent-refresh|access_token|refresh_token/);
    } finally { globalThis.fetch = original; }
  });
}

test('persistent cookies reopen, refresh for 400 days, and still honor logout and revocation', async () => {
  const config: AuthConfig={origin:'https://eco.example.test',supabaseUrl:'https://fixture.supabase.co',publishableKey:'fixture-publishable',secretKey:'fixture-server-key',rateLimitSecret:'fixture-limit-key-at-least-32-characters',secureCookies:true};
  const id='11111111-1111-4111-8111-111111111111',sid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const providerUser={id,email:'person@example.test',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()};
  const member={id,email:providerUser.email,displayName:'Person',officeId:'hk',officeName:'Hong Kong',isAdmin:false,isSpcTrader:false,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1};
  const now=Math.floor(Date.now()/1000);
  const token=(expiry:number)=>[{alg:'HS256',typ:'JWT'},{iss:config.supabaseUrl+'/auth/v1',sub:id,aud:'authenticated',role:'authenticated',iat:expiry-900,exp:expiry,session_id:sid},'synthetic-signature'].map(p=>Buffer.from(typeof p==='string'?p:JSON.stringify(p)).toString('base64url')).join('.');
  const result=(expiry:number,refresh:string)=>({access_token:token(expiry),refresh_token:refresh,expires_in:900,expires_at:expiry,token_type:'bearer',user:providerUser});
  const cookieHeader=(cookies:string[])=>cookies.map(cookie=>cookie.split(';')[0]).join('; ');
  const request=(cookies:string[])=>new Request(config.origin+'/api/access/session',{headers:{cookie:cookieHeader(cookies)}});
  const original=globalThis.fetch;let revoked=false;let refreshes=0;let loggedOut=false;
  try {
    globalThis.fetch=async(input,init)=>{
      const url=String(input);
      if(url.endsWith('/rest/v1/rpc/eco_preview_state')) return Response.json({preview:null,sessionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
      if(url.includes('/token?grant_type=password')) return Response.json(result(now+900,'synthetic-initial-refresh'));
      if(url.includes('/token?grant_type=refresh_token')) {refreshes++;return Response.json(result(now+900,'synthetic-refreshed-value'));}
      if(url.endsWith('/auth/v1/user')) return Response.json(providerUser);
      if(url.endsWith('/rest/v1/rpc/eco_current_user')) return revoked?Response.json({code:'28000',message:'Unauthorized'},{status:401}):Response.json(member);
      if(url.includes('/auth/v1/logout?scope=local')) {loggedOut=true;return new Response(null,{status:204});}
      throw new Error('Unexpected persistence fixture operation');
    };
    const login=createAuthGateway(new Request(config.origin+'/api/access/login'),config);
    await login.signIn(member.email,'Synthetic Fixture 8');
    assert.ok(login.cookies.length>0);
    for(const cookie of login.cookies) {assert.match(cookie,/Max-Age=34560000/i);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/i);}
    // A fresh request/client carries only cookies, as after closing and reopening a browser.
    const reopened=createAuthGateway(request(login.cookies),config);
    assert.deepEqual(await reopened.currentUser(),member);
    assert.equal(refreshes,0);
    // Simulate returning after the 15-minute JWT expires: the persistent refresh cookie
    // obtains a new short-lived JWT and a new persistent cookie without password entry.
    const expired=result(now-3600,'synthetic-expired-session-refresh');
    const expiredCookie='eco-auth=base64-'+Buffer.from(JSON.stringify(expired)).toString('base64url');
    const refreshed=createAuthGateway(request([expiredCookie]),config);
    assert.deepEqual(await refreshed.currentUser(),member);
    assert.equal(refreshes,1);assert.ok(refreshed.cookies.length>0);
    for(const cookie of refreshed.cookies.filter(value=>!value.includes('Max-Age=0'))) assert.match(cookie,/Max-Age=34560000/i);
    revoked=true;
    const denied=createAuthGateway(request(refreshed.cookies),config);
    assert.equal(await denied.currentUser(),null);
    revoked=false;
    const logout=createAuthGateway(request(refreshed.cookies),config);
    await logout.signOut();
    assert.equal(loggedOut,true);assert.ok(logout.cookies.length>0);
    for(const cookie of logout.cookies) {assert.match(cookie,/Max-Age=0(?:;|$)/i);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);}
  } finally {globalThis.fetch=original;}
});

for (const kind of ['create-user','reset-password'] as const) for (const scenario of ['success','wrong-admin-password','demoted-admin','begin-conflict','provider-rejected','provider-unknown','lost-response-confirmed','finalization-fails','finalization-forbidden','finalization-conflict','retry-failed','retry-complete','retry-pending-confirmed','retry-pending-unknown'] as const) {
  test(`admin ${kind} authenticates and reconciles without duplicate provider side effects: ${scenario}`,async()=>{
    const config:AuthConfig={origin:'https://eco.example.test',supabaseUrl:'https://fixture.supabase.co',publishableKey:'fixture-publishable',secretKey:'fixture-server-only',rateLimitSecret:'fixture-rate-secret-32-characters-long',newUserPassword:'Synthetic New 8',secureCookies:true};
    const actorId='11111111-1111-4111-8111-111111111111',targetId='22222222-2222-4222-8222-222222222222',sid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',requestId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const actor={id:actorId,email:'admin@example.test',displayName:'Administrator',officeId:'hk',officeName:'Hong Kong',isAdmin:true,isSpcTrader:false,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1};
    const changed={...actor,id:targetId,email:'new@example.test',displayName:'New User',phone:'+85261234567',isAdmin:false,passwordChangeSuggested:true,revision:2};
    const marker=kind==='create-user'?'eco_access_create_request':'eco_access_reset_request';
    const providerUser={id:actorId,email:actor.email,aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()};
    const targetProvider={...providerUser,id:targetId,email:changed.email,app_metadata:{provider:'email',[marker]:requestId}};
    const now=Math.floor(Date.now()/1000);
    const token=[{alg:'HS256',typ:'JWT'},{sub:actorId,session_id:sid,aud:'authenticated',role:'authenticated',iat:now,exp:now+900},'synthetic-signature'].map(p=>Buffer.from(typeof p==='string'?p:JSON.stringify(p)).toString('base64url')).join('.');
    const original=globalThis.fetch,calls:string[]=[];
    let fingerprint='';
    try {
      globalThis.fetch=async(input,init)=>{
        const url=String(input),headers=new Headers(init?.headers),body=init?.body?JSON.parse(String(init.body)):null;
        if(url.endsWith('/rest/v1/rpc/eco_preview_state')) return Response.json({preview:null,sessionId:sid});
        if(url.includes('/auth/v1/logout?scope=local')) return new Response(null,{status:204});
        if(url.includes('/token?grant_type=password')){
          calls.push('reauthenticate');assert.equal(body.email,actor.email);assert.equal(body.password,'Synthetic Admin 9');
          return scenario==='wrong-admin-password'?Response.json({code:'invalid_credentials',msg:'Rejected'},{status:400}):Response.json({access_token:token,refresh_token:'synthetic-refresh',expires_in:900,token_type:'bearer',user:providerUser});
        }
        if(url.endsWith('/rest/v1/rpc/eco_current_user')){calls.push('membership');return Response.json({...actor,isAdmin:scenario!=='demoted-admin'});}
        if(url.endsWith('/rest/v1/rpc/eco_begin_admin_operation_v2')){
          calls.push('begin');assert.equal(headers.get('apikey'),config.secretKey);assert.equal(body.p_actor_id,actorId);assert.equal(body.p_session_id,sid);assert.equal(body.p_origin_session_id,sid);assert.equal(body.p_kind,kind);assert.equal(body.p_request_id,requestId);
          assert.doesNotMatch(JSON.stringify(body.p_input),/Synthetic|password"|administratorPassword/);assert.match(body.p_fingerprint,/^[a-f0-9]{64}$/);fingerprint=body.p_fingerprint;
          if(scenario==='begin-conflict')return Response.json({code:'PT409',message:'Conflict'},{status:409});
          return Response.json({state:scenario==='retry-complete'?'complete':scenario==='retry-failed'?'failed':'pending',targetId,runProvider:!scenario.startsWith('retry-'),user:scenario==='retry-complete'?changed:undefined});
        }
        if((url.endsWith('/auth/v1/admin/users')&&init?.method==='POST')||(url.endsWith('/auth/v1/admin/users/'+targetId)&&init?.method==='PUT')){
          calls.push('provider-write');assert.equal(headers.get('apikey'),config.secretKey);assert.equal(body.password,'Synthetic New 8');assert.deepEqual(body.app_metadata,{[marker]:requestId});
          assert.equal(body.phone,undefined);assert.equal(body.role,undefined);assert.equal(body.administratorPassword,undefined);
          if(kind==='create-user'){assert.equal(body.id,targetId);assert.equal(body.email,changed.email);assert.equal(body.email_confirm,true);}else{assert.equal(body.email,undefined);assert.equal(body.email_confirm,undefined);}
          if(scenario==='provider-rejected')return Response.json({code:'weak_password',msg:'Rejected'},{status:422});
          if(scenario==='provider-unknown'||scenario==='lost-response-confirmed')return Response.json({code:'unexpected_failure',msg:'Ambiguous'},{status:500});
          return Response.json(targetProvider);
        }
        if(url.endsWith('/auth/v1/admin/users/'+targetId)&&init?.method==='GET'){
          calls.push('provider-read');assert.equal(headers.get('apikey'),config.secretKey);
          return Response.json(['lost-response-confirmed','retry-pending-confirmed'].includes(scenario)?targetProvider:{...targetProvider,app_metadata:{provider:'email'}});
        }
        if(url.endsWith('/rest/v1/rpc/eco_fail_admin_operation')){calls.push('fail');assert.equal(headers.get('apikey'),config.secretKey);return Response.json(null);}
        if(url.endsWith('/rest/v1/rpc/eco_complete_admin_operation')){
          calls.push('complete');assert.equal(headers.get('apikey'),config.secretKey);assert.deepEqual(body,{p_actor_id:actorId,p_session_id:sid,p_request_id:requestId});
          if(scenario==='finalization-forbidden')return Response.json({code:'42501',message:'Demoted'},{status:403});
          if(scenario==='finalization-conflict')return Response.json({code:'PT409',message:'Conflict'},{status:409});
          return scenario==='finalization-fails'?Response.json({code:'XX000',message:'Unavailable'},{status:500}):Response.json(changed);
        }
        throw new Error('Unexpected synthetic request: '+url);
      };
      const gateway=createAuthGateway(new Request(config.origin+'/api/access/users'),config);
      const promise=kind==='create-user'?gateway.createUser(actor,{requestId,email:changed.email,displayName:changed.displayName,phone:changed.phone,officeId:'hk',isAdmin:false,isManager:false,isSpcTrader:false,isActive:true,administratorPassword:'Synthetic Admin 9'}):gateway.resetUserPassword(actor,{requestId,id:targetId,expectedRevision:1,newPassword:'Synthetic New 8',administratorPassword:'Synthetic Admin 9'});
      if(['success','lost-response-confirmed','retry-complete','retry-pending-confirmed'].includes(scenario))assert.deepEqual(await promise,changed);else await assert.rejects(promise,(error:unknown)=>{
        const state=(error as {operationState?:string}).operationState;
        assert.equal(state,['provider-rejected','retry-failed'].includes(scenario)?'failed':['wrong-admin-password','demoted-admin','begin-conflict'].includes(scenario)?undefined:'pending');return true;
      });
      if(scenario.startsWith('retry-'))assert.equal(calls.includes('provider-write'),false);
      if(scenario==='provider-rejected')assert.equal(calls.includes('fail'),true);else assert.equal(calls.includes('fail'),false);
      if(['provider-unknown','retry-pending-unknown'].includes(scenario))assert.equal(calls.includes('complete'),false);
      if(['wrong-admin-password','demoted-admin','begin-conflict'].includes(scenario))assert.equal(calls.includes('provider-write'),false);
      if(fingerprint)assert.equal(fingerprint.length,64);
    }finally{globalThis.fetch=original;}
  });
}

for(const type of ['invite','recovery'] as const)for(const scenario of ['success','begin-denied','provider-rejected','provider-unknown','provider-lost-response-confirmed','replacement-login-fails'] as const){
  test(`${type} activation fences provider writes and restores a new live session: ${scenario}`,async()=>{
    const config:AuthConfig={origin:'https://eco.example.test',supabaseUrl:'https://fixture.supabase.co',publishableKey:'fixture-publishable',secretKey:'fixture-server-only',rateLimitSecret:'fixture-rate-secret-at-least-32-characters',secureCookies:true};
    const id='11111111-1111-4111-8111-111111111111',requestId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',newSession='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const providerUser={id,email:'activated@example.test',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()};
    const now=Math.floor(Date.now()/1000);
    const token=(sid:string)=>[{alg:'HS256',typ:'JWT'},{sub:id,session_id:sid,aud:'authenticated',role:'authenticated',iat:now,exp:now+900},'synthetic-signature'].map(p=>Buffer.from(typeof p==='string'?p:JSON.stringify(p)).toString('base64url')).join('.');
    const original=globalThis.fetch,calls:string[]=[];
    try{
      globalThis.fetch=async(input,init)=>{
        const url=String(input),body=init?.body?JSON.parse(String(init.body)):null;
        if(url.endsWith('/auth/v1/verify')){
          calls.push('verify-link');assert.equal(body.type,type);assert.equal(body.token_hash,'a'.repeat(64));
          return Response.json({user:providerUser,access_token:token(requestId),refresh_token:'synthetic-first-refresh',expires_in:900,token_type:'bearer'});
        }
        if(url.endsWith('/rest/v1/rpc/eco_begin_password_activation')){
          calls.push('begin');assert.equal(new Headers(init?.headers).get('apikey'),config.secretKey);assert.deepEqual(body,{p_user_id:id,p_session_id:requestId});
          return scenario==='begin-denied'?Response.json({code:'28000',message:'Held'},{status:401}):Response.json(null);
        }
        if(url.endsWith('/auth/v1/admin/users/'+id)&&init?.method==='PUT'){
          calls.push('provider-write');assert.deepEqual(body,{password:'Synthetic New 8',app_metadata:{eco_access_change_request:requestId}});
          if(scenario==='provider-rejected')return Response.json({code:'weak_password',msg:'Rejected'},{status:422});
          if(scenario==='provider-unknown'||scenario==='provider-lost-response-confirmed')return Response.json({code:'unexpected_failure',msg:'Unknown'},{status:500});
          return Response.json({...providerUser,app_metadata:{...providerUser.app_metadata,eco_access_change_request:requestId}});
        }
        if(url.endsWith('/auth/v1/admin/users/'+id)&&init?.method==='GET'){
          calls.push('provider-read');return Response.json({...providerUser,app_metadata:scenario==='provider-lost-response-confirmed'?{eco_access_change_request:requestId}:{}});
        }
        if(url.endsWith('/rest/v1/rpc/eco_fail_password_change')){calls.push('fail');return Response.json(null);}
        if(url.includes('/auth/v1/logout?scope=local')) return new Response(null,{status:204});
        if(url.includes('/token?grant_type=password')){
          calls.push('replacement-login');assert.equal(body.email,providerUser.email);assert.equal(body.password,'Synthetic New 8');
          return scenario==='replacement-login-fails'?Response.json({code:'invalid_credentials',msg:'Rejected'},{status:400}):Response.json({user:providerUser,access_token:token(newSession),refresh_token:'synthetic-replacement-refresh',expires_in:900,token_type:'bearer'});
        }
        if(url.endsWith('/rest/v1/rpc/eco_complete_password_change_v2')){
          calls.push('complete');assert.deepEqual(body,{p_user_id:id,p_request_id:requestId,p_session_id:newSession});return Response.json({id,activated:true,passwordChangeSuggested:false});
        }
        throw new Error('Unexpected synthetic activation request');
      };
      const gateway=createAuthGateway(new Request(config.origin+'/api/access/activate'),config);
      const promise=gateway.activate('a'.repeat(64),'Synthetic New 8',type);
      if(scenario==='success'||scenario==='provider-lost-response-confirmed'){
        await promise;assert.equal(calls.at(-1),'complete');assert.ok(calls.indexOf('begin')<calls.indexOf('provider-write'));assert.ok(calls.indexOf('replacement-login')<calls.indexOf('complete'));
        assert.ok(gateway.cookies.some(c=>c.includes('Max-Age=34560000')));
      }else{await assert.rejects(promise);assert.equal(calls.includes('complete'),false);}
      if(scenario==='begin-denied')assert.equal(calls.includes('provider-write'),false);
      if(scenario==='provider-rejected')assert.equal(calls.includes('fail'),true);
      if(scenario==='provider-unknown')assert.equal(calls.includes('fail'),false);
    }finally{globalThis.fetch=original;}
  });
}

test('administrator proof uses a separate session; a racing preview rejects approval without replacing browser cookies',async()=>{
  const config:AuthConfig={origin:'https://eco.example.test',supabaseUrl:'https://fixture.supabase.co',publishableKey:'fixture-publishable',secretKey:'fixture-server',rateLimitSecret:'fixture-rate-secret-at-least-32-characters',secureCookies:true};
  const id='11111111-1111-4111-8111-111111111111',originalSid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',proofSid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const member={id,email:'admin@example.test',displayName:'Admin',officeId:'hk',officeName:'Hong Kong',isAdmin:true,isManager:false,isSpcTrader:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1};
  const now=Math.floor(Date.now()/1000),token=[{alg:'HS256'},{sub:id,session_id:proofSid,exp:now+900,iat:now,aud:'authenticated',role:'authenticated'},'fixture-signature'].map(p=>Buffer.from(typeof p==='string'?p:JSON.stringify(p)).toString('base64url')).join('.');
  const original=globalThis.fetch;let cleaned=false,denied=false;
  try{
    globalThis.fetch=async(input,init)=>{
      const url=String(input),body=init?.body?JSON.parse(String(init.body)):null;
      if(url.endsWith('/rpc/eco_preview_state'))return Response.json({preview:null,sessionId:originalSid});
      if(url.includes('/token?grant_type=password'))return Response.json({access_token:token,refresh_token:'fixture-proof-refresh',expires_in:900,token_type:'bearer',user:{id,email:member.email,app_metadata:{},user_metadata:{},aud:'authenticated',created_at:new Date().toISOString()}});
      if(url.endsWith('/rpc/eco_current_user')){assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+token);return Response.json(member);}
      if(url.endsWith('/rpc/eco_begin_admin_operation_v2')){
        assert.equal(body.p_origin_session_id,originalSid);assert.equal(body.p_session_id,proofSid);denied=true;
        return Response.json({code:'42501',message:'Preview is read only'},{status:403});
      }
      if(url.includes('/auth/v1/logout?scope=local')){assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+token);cleaned=true;return new Response(null,{status:204});}
      throw new Error('Unexpected request including forbidden provider password update: '+url);
    };
    const gateway=createAuthGateway(new Request(config.origin+'/api/access/users'),config);
    await assert.rejects(gateway.resetUserPassword(member,{requestId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',expectedRevision:1,newPassword:'Synthetic New 8',administratorPassword:'Synthetic Admin 9'}),{status:403});
    assert.equal(denied,true);assert.equal(cleaned,true);assert.deepEqual(gateway.cookies,[]);
  }finally{globalThis.fetch=original;}
});

for (const scenario of ['success','wrong-password','demoted','preview-denied','stale','last-admin','uncertain'] as const) {
  test(`delete uses separate administrator proof, original session and atomic SQL: ${scenario}`, async () => {
    const config:AuthConfig={origin:'https://eco.example.test',supabaseUrl:'https://fixture.supabase.co',publishableKey:'fixture-publishable',secretKey:'fixture-server-only',rateLimitSecret:'fixture-rate-secret-32-characters-long',secureCookies:true};
    const actorId='11111111-1111-4111-8111-111111111111',targetId='22222222-2222-4222-8222-222222222222';
    const originSid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',proofSid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const actor={id:actorId,email:'admin@example.test',displayName:'Admin',officeId:'hk',officeName:'Hong Kong',isAdmin:true,isManager:false,isSpcTrader:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1};
    const provider={id:actorId,email:actor.email,aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()};
    const now=Math.floor(Date.now()/1000);
    const token=[{alg:'HS256',typ:'JWT'},{sub:actorId,session_id:proofSid,aud:'authenticated',role:'authenticated',iat:now,exp:now+900},'synthetic-signature'].map(p=>Buffer.from(typeof p==='string'?p:JSON.stringify(p)).toString('base64url')).join('.');
    const original=globalThis.fetch;const calls:string[]=[];
    try {
      globalThis.fetch=async(input,init)=>{
        const url=String(input),body=init?.body?JSON.parse(String(init.body)):null;
        if(url.endsWith('/rest/v1/rpc/eco_preview_state'))return Response.json({preview:null,sessionId:originSid});
        if(url.includes('/token?grant_type=password')) {
          calls.push('proof');assert.equal(body.email,actor.email);assert.equal(body.password,'Synthetic Admin 9');
          return scenario==='wrong-password'?Response.json({code:'invalid_credentials',msg:'Rejected'},{status:400}):Response.json({access_token:token,refresh_token:'synthetic-refresh',expires_in:900,token_type:'bearer',user:provider});
        }
        if(url.endsWith('/rest/v1/rpc/eco_current_user'))return Response.json({...actor,isAdmin:scenario!=='demoted'});
        if(url.endsWith('/rest/v1/rpc/eco_delete_user')) {
          calls.push('delete');assert.equal(new Headers(init?.headers).get('apikey'),config.secretKey);
          assert.deepEqual(body,{p_actor_id:actorId,p_session_id:proofSid,p_origin_session_id:originSid,p_request_id:requestId,p_target_id:targetId,p_expected_revision:3});
          const code=scenario==='preview-denied'?'42501':scenario==='stale'?'PT409':scenario==='last-admin'?'23514':scenario==='uncertain'?'XX000':null;
          return code?Response.json({code,message:'Synthetic rejection'},{status:400}):Response.json({deletedUserId:targetId});
        }
        if(url.includes('/logout?scope=local')){calls.push('release-proof');return new Response(null,{status:204});}
        throw new Error('Unexpected synthetic request '+url);
      };
      const gateway=createAuthGateway(new Request(config.origin+'/api/access/users/delete'),config);
      const promise=gateway.deleteUser(actor,{requestId,id:targetId,expectedRevision:3,administratorPassword:'Synthetic Admin 9'});
      if(scenario==='success')assert.deepEqual(await promise,{deletedUserId:targetId});
      else await assert.rejects(promise,(error:unknown)=>{
        const result=error as {status:number;operationState?:string};
        assert.equal(result.status,scenario==='demoted'||scenario==='preview-denied'?403:scenario==='stale'?409:scenario==='uncertain'?503:400);
        assert.equal(result.operationState,scenario==='uncertain'?'pending':undefined);return true;
      });
      assert.deepEqual(gateway.cookies,[]);
      if(scenario==='wrong-password'||scenario==='demoted')assert.equal(calls.includes('delete'),false);
      if(scenario!=='wrong-password')assert.equal(calls.at(-1),'release-proof');
    } finally {globalThis.fetch=original;}
  });
}

test('missing server default password prevents new-user provisioning without affecting login setup',async()=>{
  const config:AuthConfig={origin:'https://eco.example.test',supabaseUrl:'https://fixture.supabase.co',publishableKey:'fixture-publishable',secretKey:'fixture-server-only',rateLimitSecret:'fixture-rate-secret-32-characters-long',secureCookies:true};
  const gateway=createAuthGateway(new Request(config.origin+'/api/access/users/create'),config);
  const actor={id:'11111111-1111-4111-8111-111111111111',email:'admin@example.test',displayName:'Admin',officeId:'hk',officeName:'Hong Kong',isAdmin:true,isManager:false,isSpcTrader:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1};
  await assert.rejects(gateway.createUser(actor,{requestId:'22222222-2222-4222-8222-222222222222',email:'new@example.test',displayName:'New',phone:'',officeId:'hk',isAdmin:true,isManager:false,isSpcTrader:false,isActive:true,administratorPassword:'Synthetic Admin 9'}),{status:503,message:'New user provisioning is not configured.'});
});

test('phone change gateway uses only authenticated guarded RPCs with narrow payloads and safe conflict responses',async()=>{
  const config:AuthConfig={origin:'https://eco.example.test',supabaseUrl:'https://fixture.supabase.co',publishableKey:'fixture-publishable',secretKey:'fixture-server-key',rateLimitSecret:'fixture-limit-key-at-least-32-characters',secureCookies:true};
  const original=globalThis.fetch;const calls:{name:string;body:unknown}[]=[];
  const id='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';let conflict=false;
  const result={id,userId:'11111111-1111-4111-8111-111111111111',displayName:'Person',email:'person@example.test',officeName:'Hong Kong',currentPhone:'',requestedPhone:'+6591815902',status:'pending',requestedAt:'2026-10-14T08:00:00Z',reviewedAt:null,reviewedBy:null};
  try{
    globalThis.fetch=async(input,init)=>{
      const name=String(input).split('/').at(-1)!;assert.match(name,/^eco_(list_phone_requests|request_phone_change|review_phone_change)$/);
      assert.equal(new Headers(init?.headers).get('apikey'),config.publishableKey);
      calls.push({name,body:JSON.parse(String(init?.body))});
      if(conflict)return Response.json({code:'PT409',message:'Private internal details must not escape'}, {status:409});
      return Response.json(name==='eco_list_phone_requests'?{requests:[result]}:result);
    };
    const gateway=createAuthGateway(new Request(config.origin+'/api/access/phone-requests'),config);
    assert.equal((await gateway.listPhoneRequests()).requests[0].id,id);
    assert.equal((await gateway.requestPhoneChange({requestId:id,phone:'+6591815902'})).id,id);
    assert.equal((await gateway.reviewPhoneChange({id,decision:'approve'})).id,id);
    assert.deepEqual(calls,[{name:'eco_list_phone_requests',body:{}},{name:'eco_request_phone_change',body:{p_request_id:id,p_phone:'+6591815902'}},{name:'eco_review_phone_change',body:{p_request_id:id,p_decision:'approve'}}]);
    conflict=true;await assert.rejects(gateway.reviewPhoneChange({id,decision:'approve'}),error=>error instanceof Error && !error.message.includes('Private internal') && error.message.includes('Refresh'));
  }finally{globalThis.fetch=original;}
});
