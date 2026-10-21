import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState, upgradeDemoState} from '../src/lib/seed';
import {actors, applyAction, personalResources, type Outcome} from '../src/lib/model';
import {buyerGroupKey,buyerPerformance,buyerPrivateRemark,paymentDays} from '../src/lib/buyerProfile';
const [trader,credit,admin]=actors;
const now='2026-10-02T04:00:00Z';
const buyerId='company-meridian';
const seed=createSeedState();
const base=seed.outcomes.find(row=>row.kind==='fixture')!;
const stem=(id:string,date:string,payment?:Outcome['payment']):Outcome=>({...base,id,enquiryId:id,buyerId,bookedAt:date,payment});

test('payment metrics distinguish missing data, paid dates, overdue unpaid and on-time payments',()=>{
 assert.equal(paymentDays(stem('unknown',now),'2026-10-02').known,false);
 assert.equal(paymentDays(stem('invalid',now,{invoiceDate:'2026-09-01',dueDate:'2026-09-31'}),'2026-10-02').known,false);
 assert.equal(paymentDays(stem('invalid-paid',now,{dueDate:'2026-09-30',paidDate:'bad'}),'2026-10-02').known,false);
 assert.deepEqual(paymentDays(stem('late',now,{invoiceDate:'2026-09-01',dueDate:'2026-09-21',paidDate:'2026-09-26'}),'2026-10-02'),{known:true,delayed:true,days:25,delay:5,status:'Paid late'});
 assert.equal(paymentDays(stem('overdue',now,{dueDate:'2026-10-01'}),'2026-10-02').status,'Overdue');
 assert.equal(paymentDays(stem('due-today',now,{dueDate:'2026-10-02'}),'2026-10-02').delayed,false);
 assert.equal(paymentDays(stem('future-paid',now,{dueDate:'2026-10-01',paidDate:'2026-10-03'}),'2026-10-02').known,false);
});

test('12-month buyer metrics deduplicate stems, exclude other buyers, and compare one enquiry cohort',()=>{
 const state=createSeedState();const enquiry=state.enquiries[0];
 state.outcomes=[stem('a','2026-09-12',{invoiceDate:'2026-08-20',dueDate:'2026-09-10',paidDate:'2026-09-15'}),stem('b','2026-09-15',{invoiceDate:'2026-08-20',dueDate:'2026-09-10',paidDate:'2026-09-09'}),stem('c','2026-09-15',{dueDate:'2026-09-20'}),stem('missing','2026-09-15'),stem('old','2025-10-02'),{...stem('other','2026-09-15'),buyerId:'company-bluewater'}];
 state.outcomes.push({...state.outcomes[0],id:'duplicate'});
 state.enquiries=['a','b','c','missing','lost'].map(id=>({...enquiry,id,buyerId,status:id==='lost'?'lost':'fixture',createdAt:'2026-09-01',sentAt:'2026-09-01'}));
 state.enquiries.push({...enquiry,id:'draft',buyerId,status:'draft',createdAt:'2026-09-01'});
 const result=buyerPerformance(state,buyerId,'12m',new Date(now));
 assert.equal(result.stems.length,4);assert.equal(result.stemDelayed,2);assert.equal(result.averagePaymentDays,23);assert.equal(result.averageDelay,2.5);assert.equal(result.hitRate,80);assert.equal(result.enquiryCount,5);assert.equal(result.paymentCoverage,3);
 const empty=buyerPerformance(state,'missing','12m',new Date(now));assert.equal(empty.hitRate,null);assert.equal(empty.stemDelayed,null);assert.equal(empty.averagePaymentDays,null);
});

test('reporting dates use Hong Kong midnight and keep former enquiry conversions out of the new cohort',()=>{
 const state=createSeedState();const enquiry=state.enquiries[0];
 state.outcomes=[stem('edge','2025-10-02T16:01:00Z'),stem('prior-cohort','2026-09-10')];
 state.enquiries=[{...enquiry,id:'prior-cohort',buyerId,status:'fixture',sentAt:'2025-09-01',createdAt:'2025-09-01'}];
 const result=buyerPerformance(state,buyerId,'12m',new Date(now));assert.equal(result.stems.length,2);assert.equal(result.hitRate,null);
});

test('private buyer remarks are owner-scoped, survive reload, and never enter shared audit or contributions',()=>{
 const state=createSeedState();const audit=structuredClone(state.audit);
 const one=applyAction(state,{type:'save-buyer-private-remark',buyerId,text:'Confidential personal note'},trader,now);
 const two=applyAction(one,{type:'save-buyer-private-remark',buyerId,text:'Admin own note'},admin,now);
 const restored=upgradeDemoState(JSON.parse(JSON.stringify(two)));
 assert.equal(buyerPrivateRemark(restored,buyerId,trader.id),'Confidential personal note');
 assert.equal(buyerPrivateRemark(restored,buyerId,admin.id),'Admin own note');
 assert.equal(buyerPrivateRemark(restored,buyerId,credit.id),'');assert.equal(buyerPrivateRemark(restored,'company-bluewater',trader.id),'');
 assert.deepEqual(restored.audit,audit);assert.deepEqual(restored.contributions,state.contributions);
 const cleared=applyAction(restored,{type:'save-buyer-private-remark',buyerId,text:''},trader,now);assert.equal(buyerPrivateRemark(cleared,buyerId,trader.id),'');assert.equal(buyerPrivateRemark(cleared,buyerId,admin.id),'Admin own note');
 assert.throws(()=>applyAction(state,{type:'save-buyer-private-remark',buyerId:'bad',text:'test'},trader,now));
});

test('credit remarks require a Credit or Admin role; group remarks publish immediately and reward once',()=>{
 const state=createSeedState();const buyer=state.companies.find(row=>row.id===buyerId)!;buyer.accountGroupId='shared';
 state.companies[1].accountGroupId='shared';assert.equal(buyerGroupKey(buyer),buyerGroupKey(state.companies[1]));
 assert.throws(()=>applyAction(state,{type:'save-buyer-credit-remarks',buyerId,text:'Finance note'},trader,now),/role/);
 const edited=applyAction(state,{type:'save-buyer-credit-remarks',buyerId,text:'Finance note'},credit,now);assert.equal(edited.companies.find(row=>row.id===buyerId)?.creditRemarks,'Finance note');
 const pending=applyAction(edited,{type:'submit-contribution',targetType:'buyer-group',targetId:'shared',title:'Group remarks',body:'Reviewed buyer group observations for the shared desk.'},trader,now);
 const id=pending.contributions[0].id;assert.equal(pending.contributions[0].status,'approved');
 assert.equal(personalResources(pending,trader.id).gold,personalResources(edited,trader.id).gold+1);
 const published=pending;assert.equal(published.contributions[0].status,'approved');assert.equal(personalResources(published,trader.id).gold,personalResources(edited,trader.id).gold+1);
 assert.deepEqual(published.companies,pending.companies);assert.throws(()=>applyAction(published,{type:'review-contribution',id,approve:true,note:'Again'},admin,now),/already/);
 assert.throws(()=>applyAction(state,{type:'submit-contribution',targetType:'buyer-group',targetId:'bad',title:'Group remarks',body:'Reviewed buyer group observations for the shared desk.'},trader,now),/valid buyer group/);
});
