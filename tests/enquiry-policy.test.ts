import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccessUser } from '../shared/access.ts';
import type { AdministrationGateway } from '../server/admin/handler.ts';
import { ApiError } from '../server/auth/validation.ts';
import { handleEnquiryPolicy } from '../server/enquiries/handler.ts';

const member: AccessUser = { id:'11111111-1111-4111-8111-111111111111', email:'fixture@example.test', displayName:'Fixture', officeId:'HONG KONG', officeName:'Hong Kong', isAdmin:false, isSpcTrader:false, isManager:false, isActive:true, activated:true, passwordChangeSuggested:false, revision:1 };
const url = 'https://eco.example.test/api/enquiries/test-policy';
function fixture(user: AccessUser | null = member, value: unknown = { enabled:false, generation:'' }) {
  let identities = 0;
  const calls: { name: string; args?: Record<string, unknown> }[] = [];
  const gateway: AdministrationGateway = {
    cookies:[], currentUser:async () => { identities++; return user; }, getPreview:async () => null,
    authenticatedRpc:async <T>(name: string, args?: Record<string, unknown>) => { calls.push({ name, args }); return value as T; },
  };
  return { gateway, calls, identities:() => identities };
}
function noStore(response: Response) {
  assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/);
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('test policy rejects unauthenticated, inactive and unactivated identities before SQL', async () => {
  for (const user of [null, { ...member,isActive:false }, { ...member,activated:false }]) {
    const f=fixture(user);const response=await handleEnquiryPolicy(new Request(url),f.gateway);
    assert.equal(response.status,401);noStore(response);assert.deepEqual(f.calls,[]);
  }
});

test('test policy accepts only its exact read endpoint without query overrides', async () => {
  for (const request of [new Request(url,{method:'POST'}),new Request(url,{method:'DELETE'}),new Request(url,{method:'HEAD'}),new Request(url+'?enabled=true'),new Request(url+'/other'),new Request('https://eco.example.test/api/enquiries/unknown')]) {
    const f=fixture();const response=await handleEnquiryPolicy(request,f.gateway);
    assert.equal(response.status,request.method==='GET'?404:405);noStore(response);assert.deepEqual(f.calls,[]);assert.equal(f.identities(),0);
  }
});

test('policy authority comes from authenticated SQL and refreshed cookies survive responses', async () => {
  for (const [user,value] of [[member,{enabled:false,generation:''}],[{...member,email:'owner@example.test',isAdmin:true},{enabled:true,generation:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}]] as const) {
    const f=fixture(user,value);f.gateway.cookies.push('eco-auth=synthetic; HttpOnly; Secure; SameSite=Lax');
    const response=await handleEnquiryPolicy(new Request(url),f.gateway);assert.equal(response.status,200);noStore(response);
    assert.deepEqual(await response.json(),value);assert.deepEqual(f.calls,[{name:'eco_test_workspace_policy',args:undefined}]);
    assert.match(response.headers.get('set-cookie') ?? '',/HttpOnly/);
  }
});

test('policy provider failures are uncached and never expose internal details', async () => {
  for (const error of [new Error('private-provider-sentinel'),new ApiError(401,'Sign in again.')]) {
    const f=fixture();f.gateway.authenticatedRpc=async () => {throw error;};
    const response=await handleEnquiryPolicy(new Request(url),f.gateway);assert.equal(response.status,error instanceof ApiError?401:503);noStore(response);
    assert.doesNotMatch(await response.text(),/private-provider-sentinel/);
  }
});
