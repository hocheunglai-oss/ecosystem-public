import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState,upgradeDemoState} from '../src/lib/seed';
import {enrichDemoScenario} from '../src/lib/demoScenario';
import {buyerTrends,buyerPerformance,paymentDays} from '../src/lib/buyerProfile';
import {teamResources, type Outcome} from '../src/lib/model';

test('scenario upgrade is additive, idempotent, and preserves edited notes, policy, exposure and credit',()=>{
 const state=createSeedState();
 state.demoScenarioVersion=undefined;
 const buyer=state.companies[0];buyer.creditRemarks='User edited';buyer.limit=123456;buyer.exposure=87654;buyer.riskCategory='Custom';
 const port=state.ports[0];port.intelligenceKeyInfo={qualityClaim:'No',isoSpecs:'No',sampleLocation:'Barge manifold',debunkering:'No'};
 state.buyerPrivateRemarks={custom:{owner:'otto',buyerId:buyer.id,text:'Private',updatedAt:'2026-10-01'}};
 state.outcomes[0].supplierId='supplier-meridian';state.outcomes[0].supplierName='Original historical snapshot';
 const before=structuredClone(state);const upgraded=upgradeDemoState(state);
 assert.deepEqual(state,before);assert.deepEqual(upgraded.companies,state.companies);assert.deepEqual(upgraded.ports,state.ports);
 assert.deepEqual(upgraded.outcomes,state.outcomes);assert.deepEqual(upgraded.buyerPrivateRemarks,state.buyerPrivateRemarks);
 assert.strictEqual(upgradeDemoState(upgraded),upgraded);
});

test('scenario history links enquiries and payments without inventing current suppliers or approved credit',()=>{
 const state=createSeedState();
 const now=new Date();const performance=buyerPerformance(state,'company-meridian','12m',now);
 assert(performance.stems.length>=12);assert(performance.averagePaymentDays!>0);assert(performance.hitRate!>0&&performance.hitRate!<100);
 assert.equal(buyerPerformance(state,'company-novasea').stems.length,0);
 for(const outcome of state.outcomes.filter(item=>item.id.startsWith('outcome-demo-v1-'))){
  assert(state.enquiries.some(item=>item.id===outcome.enquiryId&&item.status===outcome.kind));
  if(outcome.kind==='fixture') {assert.equal(outcome.supplierId,undefined);assert.equal(outcome.supplierName,undefined);assert(paymentDays(outcome,performance.today).known);}
 }
 assert.equal(teamResources(state,'team-gianmichele').gold,2);
 const legacy=structuredClone(state);legacy.demoScenarioVersion=undefined;legacy.outcomes=legacy.outcomes.filter(item=>!item.id.startsWith('outcome-demo-v1-'));
 legacy.enquiries=legacy.enquiries.filter(item=>!item.id.startsWith('demo-v1-'));
 enrichDemoScenario(legacy,now);assert.equal(legacy.outcomes.length,state.outcomes.length);
});

test('recent monthly trends weight margins by volume, exclude lost/pending/duplicates/future, and use Hong Kong dates',()=>{
 const base=createSeedState().outcomes[0];
 const stem=(id:string,quantity:number,margin:number,bookedAt='2026-09-20'):Outcome=>({...base,id,enquiryId:id,quantity,margin,bookedAt});
 const a=stem('a',100,10);const b=stem('b',300,20);
 const data=[a,b,{...a,id:'duplicate'}, {...stem('lost',1000,999),kind:'lost' as const},{...stem('pending',1000,999),commercialStatus:'pending' as const},stem('future',999,999,'2026-10-03'),stem('edge',200,5,'2026-09-30T16:01:00Z')];
 const result=buyerTrends(data,new Date('2026-10-02T04:00:00Z'));
 assert.equal(result.length,6);assert.equal(result[4].volume,400);assert.equal(result[4].margin,17.5);assert.equal(result[5].volume,200);assert.equal(result[5].margin,5);assert.equal(result[0].margin,null);
 const multi=buyerTrends([{...a,products:[{grade:'VLSFO',quantity:100,price:500,margin:10},{grade:'LSMGO',quantity:50,price:700,margin:40}]}],new Date('2026-10-02'));
 assert.equal(multi[4].volume,150);assert.equal(multi[4].margin,20);
});


test('actual delivered volume is shown without inventing margin for pending pricing',()=>{
 const base=createSeedState().outcomes[0];
 const result=buyerTrends([{...base,bookedAt:'2026-09-20',commercialStatus:'pending',quantity:0,price:0,margin:0,actualVolume:{quantity:555,recordedAt:'2026-09-22',recordedBy:'otto'}}],new Date('2026-10-02'));
 assert.equal(result[4].volume,555);assert.equal(result[4].margin,null);
});
