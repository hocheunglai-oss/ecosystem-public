import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createServer, request as httpRequest, type IncomingMessage, type ServerResponse} from 'node:http';
import {Readable, PassThrough} from 'node:stream';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {whatsappNodeRequest, serveWhatsApp, whatsappStore} from '../server/inbox-whatsapp/node.ts';
import {MAX_WEBHOOK_BYTES, type WhatsAppGetDiagnostic, type WhatsAppDependencies} from '../server/inbox-whatsapp/handler.ts';
const raw=Buffer.from('{ "object": "whatsapp_business_account", "entry": [] }\n');
function nodeRequest(chunks:unknown[]=[raw],extra:Record<string,unknown>={}) {return Object.assign(Readable.from(chunks),{method:'POST',url:'/api/enquiries/whatsapp',headers:{'content-type':'application/json'},rawHeaders:['Content-Type','application/json'],...extra}) as unknown as IncomingMessage;}

test('raw stream and pre-preserved Buffer retain exact bytes; parsed JSON/string cannot reconstruct signed evidence',async()=>{
 for(const r of [nodeRequest([raw.subarray(0,11),raw.subarray(11)]),nodeRequest([],{body:raw}),nodeRequest([],{body:{parsed:true},rawBody:raw})])assert.deepEqual((await whatsappNodeRequest(r)).body,raw);
 for(const body of [{object:'whatsapp_business_account'},raw.toString()])await assert.rejects(whatsappNodeRequest(nodeRequest([],{body})),{status:400});
 const lazy=nodeRequest();Object.defineProperty(lazy,'body',{get(){throw new Error('must not access runtime parsed-body getter');}});assert.deepEqual((await whatsappNodeRequest(lazy)).body,raw);
});
test('duplicate signature/framing headers and ambiguous content-length fail closed',async()=>{
 for(const name of ['X-Hub-Signature-256','Content-Type','Content-Length','Transfer-Encoding','Content-Encoding','Host'])await assert.rejects(whatsappNodeRequest(nodeRequest([],{rawHeaders:[name,'one',name.toLowerCase(),'two']})),{status:400});
 for(const headers of [{'x-hub-signature-256':['one','two']},{'content-length':'2, 2'},{'content-length':'-1'},{'content-length':'01'},{'content-length':'10','transfer-encoding':'chunked'}])await assert.rejects(whatsappNodeRequest(nodeRequest([],{headers})),{status:400});
 await assert.rejects(whatsappNodeRequest(nodeRequest([raw],{headers:{'content-length':'1'}})),{status:400});
});
test('body bytes, declared size, streamed size, non-byte chunks and stream time are bounded',async()=>{
 for(const r of [nodeRequest([],{headers:{'content-length':String(MAX_WEBHOOK_BYTES+1)}}),nodeRequest([Buffer.alloc(MAX_WEBHOOK_BYTES),Buffer.from('x')]),nodeRequest([],{rawBody:Buffer.alloc(MAX_WEBHOOK_BYTES+1)})])await assert.rejects(whatsappNodeRequest(r),{status:413});
 await assert.rejects(whatsappNodeRequest(nodeRequest(['text-already-decoded'])),{status:400});
 const waiting=Object.assign(new Readable({read(){}}),{method:'POST',url:'/api/enquiries/whatsapp',headers:{},rawHeaders:[]}) as IncomingMessage;
 await assert.rejects(whatsappNodeRequest(waiting,15),{status:503});waiting.destroy();
});
test('real Node HTTP adapter verifies the original wire bytes, rejects duplicate security headers, and never reserializes',async()=>{
 const secret='a'.repeat(32);let stores=0;
 const deps:WhatsAppDependencies={configure:()=>({accountId:'900000000000003',phoneNumberId:'900000000000004',displayPhoneNumber:'+85290000001',sourceId:'11111111-1111-4111-8111-111111111111',verifyToken:'v'.repeat(32),appSecret:secret,supabaseUrl:'unused',supabaseKey:'unused'}),store:()=>{stores++;throw new Error('status-only should not construct database');}};
 const server=createServer((req,res)=>{void serveWhatsApp(req,res,{},deps);});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const send=(body:Buffer,headers:string[])=>new Promise<{status:number,text:string}>((resolve,reject)=>{const req=httpRequest({hostname:'127.0.0.1',port:address.port,path:'/api/enquiries/whatsapp',method:'POST',headers},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode!,text}));});req.on('error',reject);req.end(body);});
 try {
  const sig=`sha256=${createHmac('sha256',secret).update(raw).digest('hex')}`;const headers=['Host','127.0.0.1','Content-Type','application/json','Content-Length',String(raw.length),'X-Hub-Signature-256',sig];
  assert.deepEqual(await send(raw,headers),{status:200,text:'{"received":true}'});
  const changed=Buffer.from(raw);changed[1]=10;assert.equal((await send(changed,headers)).status,401);
  assert.equal((await send(raw,[...headers,'x-hub-signature-256',sig])).status,400);assert.equal(stores,0);
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('a disconnected body returns safely without leaking later stream errors',async()=>{
 const req=Object.assign(new Readable({read(){}}),{method:'POST',url:'/api/enquiries/whatsapp',headers:{},rawHeaders:[]}) as IncomingMessage;
 const pending=whatsappNodeRequest(req,100);req.emit('aborted');req.emit('error',new Error('synthetic disconnect'));
 await assert.rejects(pending,{status:400});req.destroy();
});
test('database gateway calls only the narrow RPC, with deadline signal and no provider fetch',async()=>{
 const config={accountId:'900000000000003',phoneNumberId:'900000000000004',displayPhoneNumber:'+85290000001',sourceId:'11111111-1111-4111-8111-111111111111',verifyToken:'v'.repeat(32),appSecret:'a'.repeat(32),supabaseUrl:'https://database.example.test',supabaseKey:'synthetic-database-key'};
 const input={sourceId:config.sourceId,provider:'meta-whatsapp-cloud' as const,accountId:config.accountId,destinationId:config.phoneNumberId,messageId:'wamid.synthetic',senderIdentity:'85290000002',identityNamespace:'meta-whatsapp-signed-v1' as const,rawText:'MV SYNTHETIC / 500 MT VLSFO',receivedAt:'2026-10-20T08:00:00.000Z'};
 let calls=0;const controller=new AbortController();let signal:AbortSignal|undefined;
 const store=whatsappStore(config,async(url,init)=>{calls++;assert.equal(String(url),'https://database.example.test/rest/v1/rpc/eco_ingest_whatsapp_enquiry');assert.deepEqual(JSON.parse(String(init?.body)),{p_input:input});assert.equal(init?.redirect,'error');signal=init?.signal??undefined;return new Response(JSON.stringify({id:'22222222-2222-4222-8222-222222222222',status:'accepted',duplicate:false}),{headers:{'content-type':'application/json'}});});
 assert.equal((await store.ingest(input,controller.signal)).status,'accepted');assert.equal(calls,1);assert.ok(signal);controller.abort();assert.equal(signal.aborted,true);
 const unavailable=whatsappStore(config,async()=>new Response(JSON.stringify({code:'42501',message:'PRIVATE SQL diagnostic'}),{status:403,headers:{'content-type':'application/json'}}));
 await assert.rejects(unavailable.ingest(input,new AbortController().signal),error=>error instanceof Error&&error.message==='unavailable');
});

test('Vercel restored body is consumed from its returned stream even when the original request has ended',async()=>{
 const req=nodeRequest();for await(const _chunk of req) { /* Vercel helper already buffered these bytes. */ }
 assert.equal(req.readableEnded,true);
 const restored=new PassThrough();const originalOn=req.on.bind(req);
 // Match Vercel's addHelpers/restoreBody contract: data/end listeners attach to a new stream.
 req.on=((event:string,listener:(...args:unknown[])=>void)=>event==='data'||event==='end'?restored.on(event,listener):originalOn(event,listener)) as typeof req.on;
 Object.defineProperty(req,'body',{configurable:true,get(){throw new Error('do not parse or reserialize signed evidence');}});
 restored.end(raw);
 assert.deepEqual((await whatsappNodeRequest(req)).body,raw);
 assert.equal(restored.listenerCount('data'),0);assert.equal(restored.listenerCount('end'),0);
});

test('the webhook route imports under native Node 24 without a development TypeScript loader',()=>{
 const url=new URL('../api/enquiries/whatsapp.ts',import.meta.url).href;
 assert.equal(execFileSync(process.execPath,['--input-type=module','-e',`const module = await import(${JSON.stringify(url)}); if (typeof module.default !== 'function') process.exit(1);`],{encoding:'utf8'}),'');
});

test('GET pre-handler framing diagnostics contain only bounded shapes and POST emits none',async()=>{
 const diagnostics:WhatsAppGetDiagnostic[]=[];let configured=0;
 const deps:WhatsAppDependencies={configure:()=>{configured++;throw new Error('should not configure');},store:()=>{throw new Error('should not store');},diagnoseGetRejection:value=>diagnostics.push(value)};
 const privateValue='SYNTHETIC_PRIVATE_VALUE';
 const query=new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':privateValue,'hub.challenge':privateValue});
 const cases=[{extra:{rawHeaders:['Content-Type',privateValue,'content-type',privateValue]},reason:'duplicate_header'},{extra:{headers:{'content-length':'invalid-'+privateValue}},reason:'invalid_content_length'},{extra:{headers:{'content-length':'0','transfer-encoding':'chunked'}},reason:'conflicting_framing'},{extra:{body:{privateValue}},reason:'preparsed_body'},{extra:{headers:{'content-length':'1'}},reason:'body_length_mismatch'}];
 for(const {extra,reason} of cases){
  let body='';const res={statusCode:0,setHeader(){},end(value:string){body=value;}} as unknown as ServerResponse;
  await serveWhatsApp(nodeRequest([],{method:'GET',url:'/api/enquiries/whatsapp?'+query,...extra}),res,{},deps);
  assert.equal(res.statusCode,400);assert.equal(body,'{"error":"invalid_request"}');assert.equal(diagnostics.at(-1)?.reason,reason);
 }
 assert.equal(configured,0);assert.equal(diagnostics.length,cases.length);
 assert.doesNotMatch(JSON.stringify(diagnostics),new RegExp(`${privateValue}|hub\\.|/api/|Content-Type|content-length`));
 const res={statusCode:0,setHeader(){},end(){}} as unknown as ServerResponse;
 await serveWhatsApp(nodeRequest([],{body:{privateValue}}),res,{},deps);assert.equal(res.statusCode,400);assert.equal(diagnostics.length,cases.length);
});
test('real Node GET returns exact opaque challenge and leaves the database unopened',async()=>{
 let stores=0;const diagnostics:WhatsAppGetDiagnostic[]=[];
 const deps:WhatsAppDependencies={configure:()=>({accountId:'900000000000003',phoneNumberId:'900000000000004',displayPhoneNumber:'+85290000001',sourceId:'11111111-1111-4111-8111-111111111111',verifyToken:'v'.repeat(32),appSecret:'',supabaseUrl:'',supabaseKey:''}),store:()=>{stores++;throw new Error('challenge must not construct database');},diagnoseGetRejection:value=>diagnostics.push(value)};
 const server=createServer((req,res)=>{void serveWhatsApp(req,res,{},deps);});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 try{
  const challenge='opaque/Challenge+_-=港';const query=new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':'v'.repeat(32),'hub.challenge':challenge});
  const response=await fetch(`http://127.0.0.1:${address.port}/api/enquiries/whatsapp?${query}`);assert.equal(response.status,200);assert.equal(await response.text(),challenge);assert.equal(response.headers.get('content-type'),'text/plain; charset=utf-8');assert.equal(stores,0);assert.deepEqual(diagnostics,[]);
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
