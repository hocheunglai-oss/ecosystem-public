import { ProfileTabs } from './ProfileTabs';
import KnowledgeUpdateButton from './KnowledgeUpdateButton';
import { useAccess } from './auth';
import { usePrivateProfileTabs, PrivateProfileTabPanel, PrivateProfileTabsManager, PrivateProfileTabsStatus } from './PrivateProfileTabs';
import { CreditUsage } from './CreditUsage';
import AttachmentsButton from './AttachmentsButton';
import RiskRating from './RiskRating';
import BuyerSharedList from './BuyerSharedList';
import { buyerPrivateEntries, buyerTeamEntries } from './lib/buyerSharedLists';
import { KnowledgePanel } from './KnowledgeWorkspace';
import { BuyerCompetition } from './BuyerCompetition';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronDown, FileText, LockKeyhole, Plus, Search } from 'lucide-react';
import { useDemo } from './store';
import { actors, availableCredit, canTrade, outcomeQuantityText, type Company, type Outcome } from './lib/model';
import { creditHistoryFor, effectiveCreditLimit } from './lib/credit';
import { companyLifecycle } from './lib/creditWorkflow';
import { buyerTrends, buyerPerformance, paymentDays, type BuyerPeriod } from './lib/buyerProfile';
import { CreditHistoryTable, CreditRequestsTable } from './CreditRecords';
import { money, date } from './ui';
import SearchableSelect from './SearchableSelect';
import type { OpenModal } from './types';

const days = (value: number | null) => value === null ? '—' : `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })} days`;
const person = (id?: string, current?: { id: string; name: string }) => current && id === current.id ? current.name : actors.find(actor => actor.id === id)?.name || id || '';
const present = (value: unknown) => value !== undefined && value !== null && value !== '';
const tabs = ['Overview', 'Stem Records', 'Credit Requests', 'Credit History', 'Company Information'] as const;
type BuyerTab = typeof tabs[number];

function BuyerSection({ title, action, children, className = '' }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return <section className={`buyer-profile__section ${className}`} aria-labelledby={id}>
    <header className="buyer-profile__section-header"><h3 id={id}>{title}</h3>{action}</header>{children}
  </section>;
}
function BuyerFacts({ items, className = '' }: { items: [string, ReactNode][]; className?: string }) {
  return <dl className={`buyer-facts ${className}`}>{items.filter(([,value]) => present(value)).map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export function BuyerProfile({ buyer, open, enquiryId }: { buyer: Company; open: OpenModal; enquiryId?: string }) {
  const { state, actor } = useDemo();
  const { preview } = useAccess();
  const [overviewEditors, setOverviewEditors] = useState<string[]>([]);
  const overview = useRef<HTMLDivElement>(null);
  useEffect(() => { setOverviewEditors([]); }, [buyer.id, actor.id, preview]);
  useEffect(() => {
    if (!overviewEditors.length) return;
    const frame = requestAnimationFrame(() => { if (overview.current && !overview.current.hidden && !overview.current.contains(document.activeElement)) overview.current.querySelector<HTMLTextAreaElement>('textarea')?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [overviewEditors]);
  const closeOverviewEditor = (name: string) => setOverviewEditors(current => current.filter(value => value !== name));
  const id = useId();
  const [tab, setTab] = useState<string>('Overview');
  const [inlineEditorTab, setInlineEditorTab] = useState<string | null>(null);
  useEffect(() => { setInlineEditorTab(null); }, [tab]);
  const privateTabs = usePrivateProfileTabs({ kind: 'buyer', id: buyer.id });
  const activePrivate = privateTabs.tabs.find(item => `private:${item.id}` === tab);
  const activeTab = activePrivate ? tab : tabs.includes(tab as BuyerTab) ? tab : 'Overview';
  const selectTab = (next: string) => privateTabs.leave(() => setTab(next));
  const [period, setPeriod] = useState<BuyerPeriod>('12m');
  const [showGroup, setShowGroup] = useState(false);
  const performance = useMemo(() => buyerPerformance(state, buyer.id, period), [state, buyer.id, period]);
  const trends = useMemo(() => buyerTrends(performance.stems), [performance.stems]);
  const maximumVolume = Math.max(1, ...trends.map(point => point.volume));
  const available = availableCredit(buyer), effectiveLimit = effectiveCreditLimit(buyer);
  const status = buyer.creditStatus || (buyer.status === 'approved' ? 'Active' : 'Pending approval');
  const group = buyer.accountGroupId ? state.companies.filter(item => item.accountGroupId === buyer.accountGroupId) : [];
  const groupUsed = group.reduce((total, item) => total + item.exposure, 0);
  const panel = (name: BuyerTab) => ({ role: 'tabpanel', id: activeTab === name ? `${id}-panel` : undefined, 'aria-labelledby': `${id}-shared:${tabs.indexOf(name)}`, hidden: activeTab !== name });
  return <section className="buyer-profile" aria-label="Buyers and Credit">
    <header className="buyer-profile__header">
      <div className="buyer-profile__title"><h2>{buyer.name}</h2>{companyLifecycle(buyer) === 'lead' && <span className="buyer-status" data-status="Lead">Lead</span>}<span className="buyer-status" data-status={status}>{status}</span></div>
      <BuyerFacts className="buyer-profile__identity" items={[
        ['Credit manager', person(buyer.creditManagerId)], ['Customer ID', buyer.customerId], ['Group', buyer.accountGroupName && group.length > 0 ? <button className="buyer-inline-link" aria-expanded={showGroup} onClick={() => { privateTabs.leave(() => { setShowGroup(value => !value); setTab('Overview'); }); }}>{buyer.accountGroupName}<ChevronDown size={12}/></button> : buyer.accountGroupName],
      ]}/>
      <AttachmentsButton scope={{ target: { kind: 'company', id: buyer.id } }} />
      {canTrade(actor) && <button className="button primary" onClick={() => open({ type: 'credit', companyId: buyer.id, enquiryId })}>Credit request <ArrowUpRight size={13} /></button>}
    </header>
    <ProfileTabs tabs={[...tabs.map((name, index) => ({ id: `shared:${index}`, title: name, visibility: 'shared' as const })), ...privateTabs.tabs.map(item => ({ ...item, id: `private:${item.id}` }))]}
      activeId={activePrivate ? `private:${activePrivate.id}` : `shared:${tabs.indexOf(activeTab as BuyerTab)}`} idPrefix={id} label="Buyer profile sections"
      onSelect={next => selectTab(next.startsWith('shared:') ? tabs[Number(next.slice(7))] : next)} onManage={privateTabs.allowed && privateTabs.data ? privateTabs.openManager : undefined} />
    <PrivateProfileTabsStatus controller={privateTabs} />
    {activePrivate && privateTabs.data && !privateTabs.manager && <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-private:${activePrivate.id}`}><PrivateProfileTabPanel key={`${privateTabs.scopeKey}:${activePrivate.id}:${privateTabs.data.private.revision}`} controller={privateTabs} tab={activePrivate} editorTabs={[...tabs.map((title, index) => ({ id: `shared:${index}`, title, visibility: 'shared' as const })), ...privateTabs.tabs.map(item => ({ ...item, id: `private:${item.id}` }))]} editorTabId={`private:${activePrivate.id}`} initialEditing={inlineEditorTab === `private:${activePrivate.id}`} onSelectEditorTab={next => { setInlineEditorTab(next.startsWith('private:') ? next : null); setTab(next.startsWith('shared:') ? tabs[Number(next.slice(7))] : next); }} onManageTabs={privateTabs.openManagerAfterDiscard} /></div>}
    <PrivateProfileTabsManager controller={privateTabs} sharedTabs={tabs.map((title, index) => ({ id: `shared:${index}`, title, visibility: 'shared' as const }))} onSaved={saved => { if (activePrivate && !saved.some(item => item.id === activePrivate.id)) setTab('Overview'); else if (!activePrivate && saved.length) setTab(`private:${saved[0].id}`); }} />
    <div {...panel('Overview')} ref={overview} className="buyer-overview-grid">
      {!preview && !overviewEditors.length && <div className="buyer-profile__form-actions" style={{ gridColumn: '1 / -1' }}><KnowledgeUpdateButton onClick={() => setOverviewEditors(['team', 'private', ...(canTrade(actor) ? ['competition'] : []), ...(['credit', 'admin'].includes(actor.role) ? ['credit'] : [])])} /></div>}
      <div className="buyer-overview-column buyer-overview-credit">
      <BuyerSection title="Credit Information" className="buyer-profile__credit" action={<><AttachmentsButton scope={{ target: { kind: 'credit', id: buyer.id } }} />{(buyer.creditUpdatedAt || buyer.reviewDate) && <small>Last review {date(buyer.creditUpdatedAt || buyer.reviewDate)}</small>}</>}>
        <div className="buyer-credit-visual"><CreditUsage limit={effectiveLimit} used={buyer.exposure} available={available} label="Credit limit used" /></div>
        <BuyerFacts className="buyer-credit-approval" items={[
          ['Approved payment terms', buyer.status === 'approved' ? buyer.terms : undefined],
          ['Overdue', <span data-overdue={buyer.overdue > 0}>{money(buyer.overdue)}</span>],
          ['Approved Credit', effectiveLimit > buyer.limit ? money(buyer.limit) : undefined],
          ['Temporary credit', effectiveLimit > buyer.limit ? money(effectiveLimit - buyer.limit) : undefined],
        ]}/>
        <BuyerFacts className="buyer-credit-facts" items={[
          ['Group Credit', present(buyer.approvedGroupCredit) ? money(buyer.approvedGroupCredit!) : undefined],
          ['Group available', group.length > 0 && present(buyer.approvedGroupCredit) ? money(buyer.approvedGroupCredit! - groupUsed) : undefined],
          ['Insured Credit', present(buyer.insuredCredit) ? money(buyer.insuredCredit!) : undefined],
          ['PCG', present(buyer.parentCompanyGuarantee) ? buyer.parentCompanyGuarantee ? 'Yes' : 'No' : undefined],
          ['Risk Rating', <RiskRating value={buyer.riskRating} />],
        ]}/>
        {buyer.temporaryCredits?.filter(item => Date.parse(item.startsAt) <= Date.now() && Date.parse(item.expiresAt) > Date.now()).map(item => <div className="buyer-credit-condition" key={item.id}>Temporary credit {money(item.amount)} · expires {date(item.expiresAt)}</div>)}
        {(buyer.overdue > 0 || ['Suspended','On hold','Closed'].includes(status)) && <div className="buyer-credit-alert" role="status">{['Suspended','On hold','Closed'].includes(status) ? `CREDIT ${status} · CREDIT CLEARANCE REQUIRED BEFORE STEM.` : `OVERDUE ${money(buyer.overdue)} · CONFIRM COLLECTION WITH CREDIT.`}</div>}
      </BuyerSection>
      {showGroup && group.length > 0 && <BuyerSection title={buyer.accountGroupName || 'Group'}><div className="buyer-profile__table-wrap"><table><thead><tr><th>Customer ID</th><th>Buyer</th><th>Person in charge</th><th>Office</th><th className="numeric">Credit used</th></tr></thead><tbody>{group.map(item => <tr key={item.id}><td>{item.customerId || '—'}</td><td>{item.name}</td><td>{person(item.personInChargeId, actor) || '—'}</td><td>{item.office || '—'}</td><td className="numeric">{money(item.exposure)}</td></tr>)}</tbody></table></div></BuyerSection>}
      </div>
      <div className="buyer-overview-column buyer-overview-performance">
      <BuyerCompetition key={`competition:${actor.id}:${buyer.id}`} buyerId={buyer.id} editing={overviewEditors.includes('competition')} onEditingChange={() => closeOverviewEditor('competition')} />
      <BuyerSection title="Performance" className="buyer-profile__performance" action={<select aria-label="Performance period" value={period} onChange={event=>setPeriod(event.target.value as BuyerPeriod)}><option value="12m">Last 12 months</option><option value="year">This year</option><option value="all">All records</option></select>}>
        <BuyerFacts className="buyer-profile__metrics" items={[
          ['Number of stem', performance.stems.length], ['Stem delayed', performance.stemDelayed ?? '—'], ['Average Payment day', days(performance.averagePaymentDays)], ['Average Delay', days(performance.averageDelay)],
          ['Hit Rate', <>{performance.hitRate===null?'—':`${performance.hitRate.toFixed(1)}%`}<small>{performance.convertedEnquiries} / {performance.enquiryCount} enquiries</small></>],
        ]}/><p className="buyer-profile__coverage">Payment data: {performance.paymentCoverage} / {performance.stems.length} stems</p>
      </BuyerSection>
      <BuyerSection title="Recent margin and volume trends" action={<small>MT · USD/MT</small>} className="buyer-profile__trends">
        <div className="buyer-profile__trend-grid">{trends.map(point=><div key={point.month} className="buyer-profile__trend-month" title={`${point.volume.toLocaleString('en-US')} MT; ${point.margin===null?'—':point.margin.toFixed(2)} USD/MT`}>
          <strong>{point.volume.toLocaleString('en-US')} <span className="buyer-trend-unit">MT</span></strong><div className="buyer-profile__trend-bar"><i style={{height:`${point.volume/maximumVolume*100}%`}}/></div><b>{point.margin===null?'—':`$${point.margin.toFixed(2)}`}</b><small>{new Date(`${point.month}-01T00:00:00Z`).toLocaleDateString('en-GB',{month:'short',year:'2-digit',timeZone:'UTC'})}</small>
        </div>)}</div>
      </BuyerSection>
      </div>
      <div className="buyer-overview-column buyer-overview-notes">
        <BuyerCreditHistory key={`credit:${actor.id}:${buyer.id}`} buyer={buyer} editing={overviewEditors.includes('credit')} onEditingChange={() => closeOverviewEditor('credit')} onAllHistory={() => { selectTab('Credit History'); document.getElementById(`${id}-shared:${tabs.indexOf('Credit History')}`)?.focus(); }} />
        <BuyerRemarks key={`remarks:${actor.id}:${buyer.id}`} buyer={buyer} editors={overviewEditors} onCloseEditor={closeOverviewEditor} />
      </div>
    </div>
    {activeTab==='Stem Records' && <div {...panel('Stem Records')}><BuyerStems key={buyer.id} stems={buyerPerformance(state,buyer.id,'all').stems} today={performance.today}/></div>}
    {activeTab==='Credit Requests' && <div {...panel('Credit Requests')}><CreditRequestsTable buyerId={buyer.id} open={open}/></div>}
    {activeTab==='Credit History' && <div {...panel('Credit History')}><CreditHistoryTable buyerId={buyer.id}/></div>}
    {activeTab==='Company Information' && <div {...panel('Company Information')}><BuyerCompanyInformation buyer={buyer} open={open}/></div>}
  </section>;
}

function BuyerStems({stems,today}:{stems:Outcome[];today:string}) {
  const {state}=useDemo();
  const [query,setQuery]=useState(''),[page,setPage]=useState(0),[expanded,setExpanded]=useState<string>();
  const portName=(id:string)=>state.ports.find(port=>port.id===id)?.name || '—';
  const filtered=useMemo(()=>stems.filter(stem=>[stem.stemNumber,stem.vessel,portName(stem.portId),stem.grade,paymentDays(stem,today).status].join(' ').toLowerCase().includes(query.trim().toLowerCase())),[stems,query,state.ports,today]);
  const size=25, pages=Math.max(1,Math.ceil(filtered.length/size)),current=Math.min(page,pages-1);
  return <BuyerSection title="Stem Records" action={<span className="buyer-profile__coverage">{filtered.length} records</span>}>
    <div className="buyer-table-toolbar"><label className="buyer-search"><Search size={14}/><input aria-label="Search stem records" placeholder="Search stem records" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/></label></div>
    <div className="buyer-profile__table-wrap" role="region" tabIndex={0} aria-label="Stem Records table"><table><thead><tr><th>Stem / Date</th><th>Vessel / Port</th><th>Grade</th><th className="numeric">Volume (MT)</th><th>Payment due</th><th>Payment received</th><th>Status</th></tr></thead><tbody>{filtered.slice(current*size,(current+1)*size).map(stem=><BuyerStemRow key={stem.id} stem={stem} today={today} portName={portName(stem.portId)} expanded={expanded===stem.id} onToggle={()=>setExpanded(expanded===stem.id?undefined:stem.id)}/>)}</tbody></table>{!filtered.length&&<p className="buyer-profile__empty">No stem records.</p>}</div>
    {pages>1&&<div className="buyer-table-footer"><span>{current*size+1}–{Math.min((current+1)*size,filtered.length)} / {filtered.length}</span><div className="buyer-profile__pages"><button aria-label="Previous stems" disabled={current===0} onClick={()=>setPage(current-1)}>‹</button><span>{current+1} / {pages}</span><button aria-label="Next stems" disabled={current+1>=pages} onClick={()=>setPage(current+1)}>›</button></div></div>}
  </BuyerSection>;
}
function BuyerStemRow({stem,today,portName,expanded,onToggle}:{stem:Outcome;today:string;portName:string;expanded:boolean;onToggle:()=>void}) {
  const products=stem.stemProducts || stem.products;
  return <><tr><td><strong>{stem.stemNumber || '—'}</strong><span>{date(stem.bookedAt)}</span></td><td><button className="buyer-table-link" aria-expanded={expanded} onClick={onToggle}>{stem.vessel}<ChevronDown size={12}/></button><span>{portName}</span></td><td>{products?.map(item=>item.grade).join(' / ') || stem.grade}</td><td className="numeric">{outcomeQuantityText(stem)}</td><td>{stem.payment?.dueDate?date(stem.payment.dueDate):'—'}</td><td>{stem.payment?.paidDate?date(stem.payment.paidDate):'—'}</td><td><span className="buyer-status-text" data-status={paymentDays(stem,today).status}>{paymentDays(stem,today).status}</span></td></tr>{expanded&&<tr className="buyer-expanded-row"><td colSpan={7}><BuyerFacts items={[
    ['Trader',person(stem.owner)],['IMO',stem.imo],['Invoice date',stem.payment?.invoiceDate?date(stem.payment.invoiceDate):undefined],['Supplier',stem.stemProducts?.map(item=>`${item.grade}: ${item.supplierName || '—'}`).join(' / ') || stem.supplierName],['Margin (USD/MT)',stem.commercialStatus==='pending'?undefined:money(stem.margin)],['Remarks',stem.reason],
  ]}/></td></tr>}</>;
}

function BuyerCompanyInformation({buyer,open}:{buyer:Company;open:OpenModal}) {
  const { actor } = useDemo();
  return <div className="buyer-company-information">
    <BuyerSection title="Company Information"><BuyerFacts items={[
      ['Customer ID',buyer.customerId],['Record type',companyLifecycle(buyer)],['Standard name',buyer.name],['Group',buyer.accountGroupName],['Person in charge',person(buyer.personInChargeId, actor)],['Office',buyer.office],
      ['Category',buyer.category],['Sectors',buyer.sectors?.join(' / ')],['Company types',buyer.companyTypes?.join(' / ')],['Counterparty roles',buyer.counterpartyRoles?.join(' / ')],
      ['Contact',buyer.contact],['Email',buyer.email?<span data-email-value="true">{buyer.email}</span>:undefined],['Country',buyer.country],['City',buyer.city],['Registration address',buyer.registrationAddress],['Trading address',buyer.tradingAddress],['Trading country',buyer.tradingCountry],['Selling entity',buyer.sellingEntity],['Next contact',buyer.nextContact?date(buyer.nextContact):undefined],
    ]}/></BuyerSection>
    {buyer.inChargeHistory?.length ? <BuyerSection title="In Charge History"><div className="buyer-profile__table-wrap"><table><thead><tr><th>Person in charge</th><th>Office</th><th>From</th><th>To</th></tr></thead><tbody>{[...buyer.inChargeHistory].sort((a,b)=>b.from.localeCompare(a.from)).map(item=><tr key={item.id}><td>{person(item.personId, actor)}</td><td>{item.office}</td><td>{date(item.from)}</td><td>{item.to?date(item.to):'Current'}</td></tr>)}</tbody></table></div></BuyerSection>:null}
    {buyer.files?.length ? <BuyerSection title="Files"><ul className="buyer-file-list">{buyer.files.filter(file=>/^(https?:\/\/|\/demo\/)/i.test(file.url)).map(file=><li key={file.id}><FileText size={14}/><a href={file.url} target="_blank" rel="noopener noreferrer">{file.title}<ArrowUpRight size={12}/></a></li>)}</ul></BuyerSection>:null}
    <KnowledgePanel key={buyer.id} target={{kind:'company',id:buyer.id}} open={open}/>
  </div>;
}
function BuyerCreditHistory({ buyer, onAllHistory, editing, onEditingChange }: { buyer: Company; onAllHistory: () => void; editing: boolean; onEditingChange: () => void }) {
  const { state, actor, run } = useDemo();
  const [creditText, setCreditText] = useState(buyer.creditRemarks || '');
  useEffect(() => { if (editing) setCreditText(buyer.creditRemarks || ''); }, [editing]);
  const recent = creditHistoryFor(state, buyer.id).slice(0, 3);
  const canEdit = actor.role === 'credit' || actor.role === 'admin';
  const active = state.creditHistory?.find(entry => entry.id === buyer.activeCreditRemarkId && entry.companyId === buyer.id && entry.type === 'remark');
  return <BuyerSection title="Credit History" className="buyer-credit-history" action={<div className="buyer-remark-actions">
    <button type="button" className="button secondary buyer-history-link" onClick={onAllHistory}>All history <ArrowUpRight size={13}/></button>
  </div>}>
    <div className="buyer-credit-history__current">
      {editing && canEdit ? <form onSubmit={event => {event.preventDefault();if(run({type:'save-buyer-credit-remarks',buyerId:buyer.id,text:creditText},'Credit History saved.'))onEditingChange();}}>
        <textarea aria-label="Credit History" value={creditText} maxLength={10000} rows={4} onChange={event=>setCreditText(event.target.value)}/>
        <div className="buyer-profile__form-actions"><button type="button" className="button secondary" onClick={onEditingChange}>Cancel</button><KnowledgeUpdateButton type="submit" contribution={false} disabled={creditText === (buyer.creditRemarks || '')} /></div>
      </form> : <div className="buyer-credit-history__recent">{recent.length ? recent.map(entry => <article key={entry.id}>
        <p className="buyer-profile__remark-text">{entry.summary || '—'}</p>
        <footer>{entry.id === active?.id && <strong>Active · </strong>}{[person(entry.by), entry.effectiveDateUnknown ? '—' : date(entry.effectiveAt)].filter(Boolean).join(' · ')}</footer>
      </article>) : <p className="buyer-profile__remark-text">{buyer.creditRemarks || '—'}</p>}</div>}
    </div>
  </BuyerSection>;
}

function BuyerRemarks({ buyer, editors, onCloseEditor }: { buyer: Company; editors: string[]; onCloseEditor: (name: string) => void }) {
  const { state, actor } = useDemo();
  return <BuyerSection title="Remarks">
    <div className="buyer-profile__remarks">
      <section aria-label="Team Remarks">
        <BuyerSharedList buyerId={buyer.id} kind="team" label="Team Remarks" entries={buyerTeamEntries(state, buyer)} editing={editors.includes('team')} onEditingChange={() => onCloseEditor('team')} />
      </section>
      <section aria-label="Private Remarks">
        <BuyerSharedList buyerId={buyer.id} kind="private" label="Private Remarks" headingIcon={<LockKeyhole size={14} aria-hidden="true"/>} entries={buyerPrivateEntries(state, buyer.id, actor.id)} editing={editors.includes('private')} onEditingChange={() => onCloseEditor('private')} />
      </section>
    </div>
  </BuyerSection>;
}

export function BuyerProfileDirectory({open,initialBuyerId}:{open:OpenModal;initialBuyerId?:string}) {
  const {state,actor}=useDemo();
  const [selected,setSelected]=useState(initialBuyerId || ''),[query,setQuery]=useState(''),[mine,setMine]=useState(false),[office,setOffice]=useState(''),[page,setPage]=useState(0);
  const [sort,setSort]=useState<'name'|'customerId'>('name');
  useEffect(()=>{if(initialBuyerId)setSelected(initialBuyerId);},[initialBuyerId]);
  const buyer=state.companies.find(item=>item.id===selected);
  const offices=[...new Set(state.companies.map(item=>item.office).filter(Boolean))].sort();
  const filtered=useMemo(()=>state.companies.filter(item=>(!mine || item.personInChargeId===actor.id)&&(!office||item.office===office)&&[item.name,item.customerId,item.accountGroupName,person(item.personInChargeId, actor),item.office,...item.aliases].join(' ').toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>(a[sort]||'').localeCompare(b[sort]||'',undefined,{numeric:true})),[state.companies,mine,office,query,sort,actor.id,actor.name]);
  const pages=Math.max(1,Math.ceil(filtered.length/25)),current=Math.min(page,pages-1);
  return <div className="buyer-profile-directory">
    {buyer ? <><div className="buyer-profile-directory__selector"><button className="button secondary" onClick={()=>setSelected('')}><ArrowLeft size={14}/>Buyer Profiles</button><SearchableSelect label="Buyer" value={buyer.id} options={state.companies.map(item=>({value:item.id,label:`${item.customerId?`${item.customerId} · `:''}${item.name}`,keywords:[item.accountGroupName,person(item.personInChargeId, actor),item.office,...item.aliases].join(' ')}))} onChange={value=>{if(value)setSelected(value);}}/></div><BuyerProfile key={`${actor.id}:${buyer.id}`} buyer={buyer} open={open}/></> : <section className="buyer-directory-card">
      <header className="buyer-directory-head"><h2>Buyer Profiles</h2>{canTrade(actor)&&<button className="button primary" onClick={()=>open({type:'company'})}><Plus size={13}/>New lead</button>}</header>
      <div className="buyer-table-toolbar"><label className="buyer-search"><Search size={15}/><input aria-label="Search buyer profiles" placeholder="Search name, ID, group or person in charge" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/></label><select aria-label="Buyer office" value={office} onChange={event=>{setOffice(event.target.value);setPage(0);}}><option value="">All offices</option>{offices.map(value=><option key={value}>{value}</option>)}</select><button className="button secondary" aria-pressed={mine} onClick={()=>{setMine(!mine);setPage(0);}}>My portfolio</button><span>{filtered.length} buyers</span></div>
      <div className="buyer-directory-table" role="region" tabIndex={0} aria-label="Buyer profiles table"><table><thead><tr><th aria-sort={sort==='customerId'?'ascending':'none'}><button onClick={()=>setSort('customerId')}>Customer ID</button></th><th aria-sort={sort==='name'?'ascending':'none'}><button onClick={()=>setSort('name')}>Standard name</button></th><th>Group</th><th>Person in charge</th><th>Office</th><th>Record type</th><th className="numeric">Available credit</th><th>Status</th></tr></thead><tbody>{filtered.slice(current*25,(current+1)*25).map(item=><tr key={item.id}><td>{item.customerId || '—'}</td><td><button className="buyer-table-link" onClick={()=>setSelected(item.id)}>{item.name}<ArrowUpRight size={12}/></button></td><td>{item.accountGroupName || '—'}</td><td>{person(item.personInChargeId, actor) || '—'}</td><td>{item.office || '—'}</td><td><span className="buyer-status" data-status={companyLifecycle(item) === 'lead' ? 'Lead' : 'Buyer'}>{companyLifecycle(item)}</span></td><td className="numeric">{money(availableCredit(item))}</td><td><span className="buyer-status" data-status={item.creditStatus || (item.status==='approved'?'Active':'Pending approval')}>{item.creditStatus || (item.status==='approved'?'Active':'Pending approval')}</span></td></tr>)}</tbody></table>{!filtered.length&&<p className="buyer-profile__empty">No buyers found.</p>}</div>
      {pages>1&&<div className="buyer-table-footer"><span>{current*25+1}–{Math.min((current+1)*25,filtered.length)} / {filtered.length}</span><div className="buyer-profile__pages"><button aria-label="Previous buyers" disabled={current===0} onClick={()=>setPage(current-1)}>‹</button><span>{current+1} / {pages}</span><button aria-label="Next buyers" disabled={current+1>=pages} onClick={()=>setPage(current+1)}>›</button></div></div>}
    </section>}
  </div>;
}
