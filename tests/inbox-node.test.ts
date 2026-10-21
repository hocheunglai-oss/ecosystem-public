import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { inboxNodeRequest } from '../server/inbox/node.ts';
import { handleInbox } from '../server/inbox/handler.ts';
import type { AdministrationGateway } from '../server/admin/handler.ts';
import type { AuthConfig } from '../server/auth/config.ts';
const origin='https://eco.example.test';
function req(body:unknown,chunks:string[]=[],method='POST'){
 return Object.assign(Readable.from(chunks),{url:'/api/enquiries/inbox',method,headers:{origin,'content-type':'application/json','x-eco-request':'1','x-eco-data-mode':'live'},...(body===undefined?{}:{body})}) as IncomingMessage&{body?:unknown};
}
test('Vercel parsed JSON, raw string, buffer and streamed JSON reach the same authenticated mutation',async()=>{
 const body={requestId:'11111111-1111-4111-8111-111111111111',action:'dismiss-all'};
 for(const r of [req(body),req(JSON.stringify(body)),req(Buffer.from(JSON.stringify(body))),req(undefined,[JSON.stringify(body)])]){
  const calls:unknown[]=[];
  const gateway={cookies:[],currentUser:async()=>({id:'owner',isActive:true,activated:true}),getPreview:async()=>null,authenticatedRpc:async(name:string,args:unknown)=>{calls.push({name,args});return {};}} as unknown as AdministrationGateway;
  const response=await handleInbox(await inboxNodeRequest(r,origin),{origin} as AuthConfig,gateway);
  assert.equal(response.status,200);assert.deepEqual(calls,[{name:'eco_mutate_enquiry_inbox',args:{p_input:{dataMode:'live',...body}}}]);
 }
});
test('body size limits apply to parsed and streamed UTF8 inputs, while GET stays bodyless',async()=>{
 for(const r of [req({value:'x'.repeat(4097)}),req('x'.repeat(4097)),req(Buffer.from('x'.repeat(4097))),req(undefined,['x'.repeat(2000),'x'.repeat(2097)]),req({value:'港'.repeat(1400)})])await assert.rejects(inboxNodeRequest(r,origin),{status:413});
 const get=await inboxNodeRequest(req({ignored:true},[],'GET'),origin);assert.equal(await get.text(),'');assert.equal(get.headers.get('x-eco-data-mode'),'live');
});
