import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthGateway } from '../server/auth/gateway.ts';
import type { AuthConfig } from '../server/auth/config.ts';
const config:AuthConfig={origin:'https://eco.example.test',supabaseUrl:'https://fixture.supabase.co',publishableKey:'fixture-publishable',secretKey:'fixture-secret',rateLimitSecret:'synthetic-rate-limit-key-at-least-32',secureCookies:true};
test('actual RPC gateway maps invisible inbox items to404 and sanitizes unknown provider failures',async()=>{
 const originalFetch=globalThis.fetch,originalError=console.error;const logged:unknown[][]=[];
 try{
  console.error=(...args:unknown[])=>{logged.push(args);};
  for(const [code,status,message] of [['PT404',404,'Record not found.'],['PT409',409,'This record or request changed. Refresh and try again.'],['XX000',503,'Administration service unavailable.']] as const){
   globalThis.fetch=async(input,init)=>{
    assert.equal(String(input),config.supabaseUrl+'/rest/v1/rpc/eco_mutate_enquiry_inbox');assert.notEqual(new Headers(init?.headers).get('apikey'),config.secretKey);
    return Response.json({code,message:'PRIVATE STAFF CONTENT',details:'PRIVATE INTERNAL VALUE',hint:'PRIVATE HINT'},{status});
   };
   const gateway=createAuthGateway(new Request(config.origin+'/api/enquiries/inbox'),config);
   await assert.rejects(gateway.authenticatedRpc('eco_mutate_enquiry_inbox',{p_input:{dataMode:'live'}}),error=>{assert.equal((error as {status:number}).status,status);assert.equal((error as Error).message,message);assert.doesNotMatch(String(error),/PRIVATE/);return true;});
  }
  assert.equal(logged.length,1);assert.doesNotMatch(JSON.stringify(logged),/PRIVATE/);
 }finally{globalThis.fetch=originalFetch;console.error=originalError;}
});
