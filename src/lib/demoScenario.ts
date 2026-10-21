import { reportingDate } from './reportingDate';
import type { DemoState, Enquiry, Outcome } from './model';
import { refreshBuyerProfiles, enrichCreditRecords, refreshLegacyDemoRecords } from './demoProfiles';
import { seedScenarioPeers } from './incomingScenarios';

export const DEMO_SCENARIO_VERSION = 2;
const DAY = 86_400_000;

/** Add fictional demonstration history once. Never replace user records or edited fields. */
export function enrichDemoScenario(state: DemoState, now = new Date()): DemoState {
  if ((state.demoScenarioVersion ?? 0) >= DEMO_SCENARIO_VERSION) return state;
  const today = reportingDate.format(now);
  const epoch = Date.parse(`${today}T00:00:00Z`);
  const day = (offset:number) => new Date(epoch + offset*DAY).toISOString().slice(0,10);
  const timestamp = (offset:number) => `${day(offset)}T02:00:00.000Z`;
  refreshBuyerProfiles(state, day);
  const owners = ['otto','filippo','gianmichele','silvia'];
  const known = new Set(['meridian','bluewater','harborlight','northern-star','pacific-orbit','coral-route','atlas-blue','cape-union','eastbridge','aurelia','delta-horizon','southwind','ocean-verde','straitlink','seabright','novasea'].map(slug=>`company-${slug}`));
  for (const [index,buyer] of state.companies.filter(item=>known.has(item.id)).entries()) {
    buyer.riskCategory ??= buyer.status === 'pending' ? 'Under review' : buyer.overdue ? 'Elevated' : index%3 === 0 ? 'Low' : 'Standard';
    if (buyer.status === 'approved') buyer.creditStatus ??= 'Active';
    buyer.creditRemarks ??= buyer.status === 'pending' ? 'Demo: onboarding documents and credit approval outstanding.' : buyer.overdue ? 'Demo: overdue balance included in used credit. Confirm collection before requesting additional exposure.' : 'Demo: approved terms apply to the named buying entity. Check available credit before confirming a stem.';
    if (['company-meridian','company-cape-union'].includes(buyer.id)) {
      buyer.accountGroupId ??= 'demo-meridian-group'; buyer.accountGroupName ??= 'MERIDIAN GROUP';
      buyer.approvedGroupCredit ??= 3000000;
    }
    if (buyer.status !== 'approved') continue;
    // Multiple ports, buyers and owners; 12 months of known payments and commercial outcomes.
    for (let month = 0; month < 12; month++) {
      const offset = -8 - month*29 - index%5;
      const port = state.ports[(index+month)%state.ports.length];
      if (!port) continue;
      const owner = index === 0 ? 'otto' : owners[index%owners.length];
      const quantity = 600 + (11-month)*45 + (index%4)*150;
      const margin = 11 + (11-month)*0.7 + index%5;
      const price = 530 + (month%4)*12 + index*2;
      const term = Number.parseInt(buyer.terms,10) || 30;
      const id = `demo-v1-${buyer.id}-${month}`;
      const vessel = `${buyer.name.split(' ')[0].toUpperCase()} ${['DAWN','QUEST','HORIZON'][month%3]}`;
      const makeEnquiry = (recordId:string,status:Enquiry['status'],when:number):Enquiry => ({
        id:recordId,buyerId:buyer.id,portId:port.id,vessel,imo:'',eta:day(when+2),grade:'VLSFO',quantity,price,margin,
        products:[{grade:'VLSFO',quantityText:String(quantity)}], status,createdAt:timestamp(when-2),sentAt:timestamp(when-1),owner,
        rawText:`Buyer: ${buyer.name}\nVessel: ${vessel}\nPort: ${port.name}\nETA: ${day(when+2)}\nVLSFO: ${quantity} MT`,
        formattedText:`${vessel} / ${port.name} / ${day(when+2)} / VLSFO ${quantity} MT`,
      });
      const enquiry = makeEnquiry(id,'fixture',offset);
      const paidOffset = offset+2+term+(month%4 === 0 ? 4 : -2);
      const outcome:Outcome = {
        id:`outcome-${id}`,enquiryId:id,kind:'fixture',buyerId:buyer.id,portId:port.id,vessel,grade:'VLSFO',quantity,price,margin,
        products:[{grade:'VLSFO',quantity,price,margin}],bookedAt:timestamp(offset),owner,reason:'Synthetic demo fixture.',
        stemNumber:`D-${String(index+1).padStart(2,'0')}-${String(12-month).padStart(2,'0')}`,
        payment:{invoiceDate:day(offset+2),dueDate:day(offset+2+term),...(paidOffset<=0 && !(buyer.overdue && month===1) ? {paidDate:day(paidOffset)} : {})},
      };
      if (!state.enquiries.some(item=>item.id===id)) state.enquiries.push(enquiry);
      if (!state.outcomes.some(item=>item.enquiryId===id)) state.outcomes.push(outcome);
      if (month%3===0) {
        const lostId=`${id}-lost`;
        if (!state.enquiries.some(item=>item.id===lostId)) state.enquiries.push(makeEnquiry(lostId,'lost',offset-3));
        if (!state.outcomes.some(item=>item.enquiryId===lostId)) state.outcomes.push({
          id:`outcome-${lostId}`,enquiryId:lostId,kind:'lost',buyerId:buyer.id,portId:port.id,vessel,grade:'VLSFO',quantity,price,margin,
          bookedAt:timestamp(offset-3),owner,reason:month%2 ? 'Schedule — vessel changed its port call.' : 'Price — competing quote was more competitive.',
          groupNote:month%2 ? 'Demo: revised voyage; follow up on the next port call.' : 'Demo: request an earlier indication for the next lifting.',
        });
      }
    }
  }
  // Live demo inbox: credit headroom, a multi-grade request, and a new customer.
  for (const [index,buyerId] of ['company-meridian','company-bluewater','company-novasea'].entries()) {
    const buyer = state.companies.find(item=>item.id===buyerId);
    const port = state.ports.find(item=>item.id === (index===1?'port-hong-kong':'port-singapore'));
    const id=`demo-v1-incoming-${index}`;
    if (!buyer || !port || state.enquiries.some(item=>item.id===id)) continue;
    const vessel=['ASTER HORIZON','BEACON STRAIT','NACRE PIONEER'][index];
    const products:Enquiry['products']=[{grade:'VLSFO',quantityText:'500–600'},{grade:'LSMGO',quantityText:'60'}];
    const rawText=`Buyer: ${buyer.name}\nVessel: ${vessel}\nPort: ${port.name}\nETA: ${day(3+index)}\nVLSFO: 500–600 MT\nLSMGO: 60 MT\nRemarks: COQ REQUIRED`;
    state.enquiries.push({id,buyerId,portId:port.id,vessel,imo:'',eta:day(3+index),grade:'VLSFO',quantity:0,price:0,margin:0,products,
      rawText,formattedText:rawText,status:'sent',createdAt:timestamp(-1),sentAt:timestamp(-1),owner:'otto',remarks:'COQ REQUIRED'});
  }
  // Explicitly labelled illustrative policies; reviewed/admin-entered values always win.
  for (const port of state.ports) {
    if (!['singapore','hong-kong','rotterdam','fujairah','busan','tokyo','ho-chi-minh','gibraltar'].some(slug=>port.id===`port-${slug}`) || port.intelligenceKeyInfo) continue;
    port.intelligenceKeyInfo={qualityClaim:'Possible',isoSpecs:'Subject enquiry',sampleLocation:"Vessel's manifold",debunkering:'Possible but Hard'};
    port.notes.push('Demo scenario: Key Info values are illustrative and require supplier confirmation.');
  }
  refreshBuyerProfiles(state, day);
  enrichCreditRecords(state, day, now);
  refreshLegacyDemoRecords(state, now);
  seedScenarioPeers(state, now);
  state.demoScenarioVersion = DEMO_SCENARIO_VERSION;
  return state;
}
