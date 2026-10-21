import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxHealthCheck, type InboxHealthEvidence } from '../server/admin/inbox-health.ts';
import { createHealthCollector } from '../server/admin/health.ts';
const now=Date.UTC(2026,9,15,12);
const evidence=(overrides:Partial<InboxHealthEvidence>={}):InboxHealthEvidence=>({observedAt:new Date(now).toISOString(),configuredSources:1,enabledSources:1,enabledEmailSources:1,lastSuccessfulCheckpoint:new Date(now-30_000).toISOString(),uncheckpointedEmailSources:0,staleEmailSources:0,staleLeaseCount:0,failedSources:0,quarantinedCount:0,...overrides});
test('email health requires enabled sources and fresh valid checkpoint evidence',()=>{
  for(const value of [null,{},evidence({enabledEmailSources:0}),evidence({uncheckpointedEmailSources:1}),evidence({lastSuccessfulCheckpoint:null}),evidence({observedAt:new Date(now-61_000).toISOString()}),evidence({lastSuccessfulCheckpoint:new Date(now+61_000).toISOString()}),evidence({enabledEmailSources:2}),evidence({quarantinedCount:-1})])assert.equal(inboxHealthCheck(value,now).status,'unknown');
  assert.equal(inboxHealthCheck(evidence(),now).status,'healthy');
  for(const change of [{lastSuccessfulCheckpoint:new Date(now-600_001).toISOString()},{staleEmailSources:1},{failedSources:1},{staleLeaseCount:1}])assert.equal(inboxHealthCheck(evidence(change),now).status,'degraded');
  const privateValue={...evidence(),sender:'never-leak',rawText:'private-body'};
  assert.ok(!JSON.stringify(inboxHealthCheck(privateValue,now)).includes('private-body'));
  assert.ok(!JSON.stringify(inboxHealthCheck(privateValue,now)).includes('never-leak'));
});
test('receiver failure cannot hide database health or show a green intake status',async()=>{
  const collect=createHealthCollector({now:()=>now,timeoutMs:5,bundledHead:'20261015112405'});
  const result=await collect(async()=>({observedAt:new Date(now).toISOString(),migrationHead:'20261015112405',pendingImports:0,failedImports:0,oldestPendingImportAt:null}),undefined,async()=>{throw new Error('private-provider-error')});
  assert.equal(result.checks.find(x=>x.id==='database')?.status,'healthy');
  assert.equal(result.checks.find(x=>x.id==='email-intake')?.status,'unknown');
  assert.ok(!JSON.stringify(result).includes('private-provider-error'));
});
