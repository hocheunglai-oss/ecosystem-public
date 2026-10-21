import { useSharedFeedback, type SharedFeedbackStatus } from './lib/useSharedFeedback';
import { useEffect, useId, useState } from "react";
import { contributionActivity, contributionPreviewCounts, contributionStatus, contributionStatusRules, type ContributionActivityEntry, type ContributionPeriod, type ContributionStatusKey } from "./lib/contributionActivity";
import type { Contribution } from "./lib/model";
import type { KnowledgeChange } from "./lib/knowledge";
import { intelligenceFields } from "./lib/intelligenceFields";
import { useDemo } from "./store";
import { useAccess } from "./auth";
import { canPreviewAppearance } from "../shared/appearancePreview";
import { resourceNumber as number } from "./ui";
import "./contribution-activity.css";

type Activity = ReturnType<typeof contributionActivity>;
const date = (value: string) => new Date(value).toLocaleDateString("en-GB", {
  day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Hong_Kong",
});

/** Period counts follow the calendar while an existing dashboard remains open. */
export function useActivityNow() {
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    const refresh = () => { if (!document.hidden) setNow(Date.now()); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  // New publications trigger a state render before the next clock tick.
  return Date.now();
}

export function ResourceIcon({ kind, size = 24 }: {
  kind: "activity" | "hat";
  size?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32"
      className={`resource-icon resource-icon-${kind}`} aria-hidden="true" focusable="false">
      {kind === "activity" ? (
        <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 25.5h22" opacity=".6" />
          <path d="M8 20v-6M16 20V7M24 20v-9" strokeWidth="4" />
        </g>
      ) : (
        <g transform="rotate(-12 16 16)" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
          <path d="M9 21 7.8 7.5Q16 4 24.2 7.5L23 21" fill="currentColor" fillOpacity=".13" />
          <path d="m8.8 17.4 14.4 0" strokeWidth="3.3" />
          <path d="M9 20.5C1 21.7 1.7 25.8 16 25.8s15-4.1 7-5.3" />
          <path d="M9 20.5c3 1.2 11 1.2 14 0" />
        </g>
      )}
    </svg>
  );
}

export function ActivityPeriodFilter({ period, onChange }: {
  period: ContributionPeriod;
  onChange: (period: ContributionPeriod) => void;
}) {
  return <label className="activity-period-filter">
    <span>Period</span>
    <select aria-label="Contribution period" value={period}
      onChange={event => onChange(event.target.value as ContributionPeriod)}>
      <option value="28d">Last 28 days</option>
      <option value="7d">Last 7 days</option>
      <option value="month">This month</option>
      <option value="all">All time</option>
    </select>
  </label>;
}

export function ActivitySummary({ activity, period, incomplete = false }: { activity: Activity; period: ContributionPeriod; incomplete?: boolean }) {
  return <div className="activity-summary" data-activity-summary>
    <div className="activity-summary-main">
      <span className="activity-metric-label"><ResourceIcon kind="activity" size={17} />{incomplete ? "Local contributions" : "Contributions"}</span>
      <strong data-activity-total>{number(activity.total)}</strong>
      <span className="activity-period-label">{activity.periodLabel}</span>
      {!incomplete && period !== "all" && <span className="activity-comparison" data-trend={activity.delta > 0 ? "up" : activity.delta < 0 ? "down" : "same"}>
        <b>{activity.delta > 0 ? "+" : ""}{number(activity.delta)}</b> vs previous period
      </span>}
    </div>
    <div className="activity-summary-recognition">
      <span className="activity-metric-label"><ResourceIcon kind="hat" size={17} />Hats received</span>
      <strong data-activity-hats>{number(activity.hatsReceived)}</strong>
      <span className="activity-period-label">{activity.periodLabel}</span>
    </div>
  </div>;
}

export function ActivityWeeks({ activity, period }: { activity: Activity; period: ContributionPeriod }) {
  const maximum = Math.max(1, ...activity.weeks.map(week => week.count));
  return <section className="activity-chart" aria-label={period === "all" ? "Last four weeks" : "Contribution activity chart"}>
    <h3>{period === "all" ? "Last 4 weeks" : period === "7d" ? "Daily activity" : "Weekly activity"}</h3>
    <ol className="activity-weeks">
      {activity.weeks.map(week => <li key={week.start} aria-label={`${week.label}: ${number(week.count)} contributions`}>
        <strong>{number(week.count)}</strong>
        <div className="activity-week-track" aria-hidden="true">
          <span style={{ height: `${week.count / maximum * 100}%` }} />
        </div>
        <span>{week.label}</span>
      </li>)}
    </ol>
  </section>;
}

export type ContributionDestination = "ports" | "suppliers" | "counterparties" | "feedback";

export function ActivityStatus({ activity, onContribute, initialGuideOpen = activity.total === 0, sharedStatus = "ready" }: {
  activity: Activity;
  initialGuideOpen?: boolean;
  sharedStatus?: SharedFeedbackStatus;
  onContribute?: (destination: ContributionDestination) => void;
}) {
  const status = contributionStatus(activity.total);
  const incomplete = sharedStatus !== "ready";
  const [guideOpen, setGuideOpen] = useState(initialGuideOpen);
  const guideId = useId();
  return <section className="activity-status" data-activity-status={incomplete ? sharedStatus : status.key} aria-label="Contribution status">
    <header className="activity-status-heading">
      <span className="activity-metric-label">CONTRIBUTION STATUS</span>
      <strong>{incomplete ? sharedStatus === "loading" ? "CHECKING" : "UNAVAILABLE" : status.label}</strong>
      <div className="activity-status-counts" data-activity-current-counts>
        <span><b>{number(activity.total)}</b> {incomplete ? "LOCAL CONTRIBUTIONS" : activity.total === 1 ? "CONTRIBUTION" : "CONTRIBUTIONS"}</span>
        <span><b>{number(activity.hatsReceived)}</b> {activity.hatsReceived === 1 ? "HAT RECEIVED" : "HATS RECEIVED"}</span>
      </div>
      <span className="activity-period-label">{activity.periodLabel}</span>
    </header>
    {onContribute && <>
      <button className="activity-guide-toggle" aria-expanded={guideOpen} aria-controls={guideId} onClick={() => setGuideOpen(value => !value)}>HOW TO CONTRIBUTE</button>
      {guideOpen && <div id={guideId} className="activity-contribution-guide" aria-label="How to contribute">
        <h3>MAKE A CONTRIBUTION</h3>
        <p>CHOOSE A PROFILE, THEN USE CONTRIBUTE +1 TO PUBLISH USEFUL INFORMATION.</p>
        <button onClick={() => onContribute("ports")}><strong>COUNTRIES &amp; PORTS</strong><span>KEY INFO, DELIVERY NOTES AND LOCAL KNOWLEDGE ↗</span></button>
        <button onClick={() => onContribute("suppliers")}><strong>SUPPLIER PROFILES</strong><span>SUPPLIER INFORMATION AND DELIVERY DETAILS ↗</span></button>
        <button onClick={() => onContribute("counterparties")}><strong>BUYER PROFILES</strong><span>BUYER INFORMATION AND ACCOUNT KNOWLEDGE ↗</span></button>
        <button onClick={() => onContribute("feedback")}><strong>FEEDBACK FOR ECOSYSTEM</strong><span>REPORT AN ISSUE OR SUGGEST AN IMPROVEMENT ↗</span></button>
      </div>}
    </>}
    <dl className="activity-status-rules" aria-label="How contribution status is measured">
      {contributionStatusRules.map(rule => <div key={rule.key} className={!incomplete && rule.key === status.key ? "is-current" : undefined}>
        <dt>{rule.label}{!incomplete && rule.key === status.key && <span className="sr-only"> · CURRENT STATUS</span>}</dt>
        <dd>{rule.criteria}</dd>
      </div>)}
    </dl>
    <details className="activity-counting-rules"><summary>WHAT COUNTS</summary>
      <p>PUBLISHED UPDATES IN THE SELECTED PERIOD. REPEAT EDITS TO THE SAME ENTRY ON THE SAME HONG KONG CALENDAR DAY COUNT ONCE. ONE AI IMPORT COUNTS AS ONE CONTRIBUTION.</p>
      <p>UNCHANGED SAVES AND FORMATTING-ONLY EDITS DO NOT COUNT. HATS DO NOT CHANGE YOUR TIER.</p>
    </details>

  </section>;
}

export function ResourceWallet({ compact = false, onContribute, initialGuideOpen, statusPreview = null, onStatusPreviewChange }: {
  compact?: boolean;
  initialGuideOpen?: boolean;
  onContribute?: (destination: ContributionDestination) => void;
  statusPreview?: ContributionStatusKey | null;
  onStatusPreviewChange?: (status: ContributionStatusKey | null) => void;
}) {
  const { state, actor } = useDemo();
  const { realUser } = useAccess();
  const canPreview = canPreviewAppearance(realUser);
  const visiblePreview = canPreview ? statusPreview : null;
  const [period, setPeriod] = useState<ContributionPeriod>("7d");
  const now = useActivityNow();
  const localActivity = contributionActivity(state, actor.id, compact ? "7d" : period, now);
  const { summary: sharedFeedback, error: feedbackError, status: sharedStatus } = useSharedFeedback(compact ? '7d' : period);
  const activity = { ...localActivity, total: localActivity.total + (sharedFeedback?.count ?? 0), previousTotal: localActivity.previousTotal + (sharedFeedback?.previousCount ?? 0),
    delta: period === 'all' && !compact ? 0 : localActivity.delta + (sharedFeedback?.count ?? 0) - (sharedFeedback?.previousCount ?? 0) };
  const displayedTotal = compact && visiblePreview ? contributionPreviewCounts[visiblePreview] : activity.total;
  const status = contributionStatus(displayedTotal);
  const incomplete = !visiblePreview && sharedStatus !== 'ready';
  const statusLabel = incomplete ? sharedStatus === 'loading' ? 'CHECKING' : 'UNAVAILABLE' : status.label;
  const availabilityMessage = sharedStatus === 'loading' ? 'CHECKING SHARED FEEDBACK. LOCAL CONTRIBUTIONS SHOWN.' : 'SHARED FEEDBACK COUNT UNAVAILABLE. LOCAL CONTRIBUTIONS SHOWN.';
  if (compact) return <section className="resource-wallet contribution-activity contribution-activity--compact" aria-label="Contribution activity">
    <div className="activity-tier-summary" data-activity-status={incomplete ? sharedStatus : status.key} data-appearance-preview={Boolean(visiblePreview)}>
      <div className="activity-tier-hero">
        <svg className="activity-tier-emblem" width="76" height="84" viewBox="0 0 76 84" fill="none" aria-hidden="true" focusable="false">
          <path className="activity-emblem-face" d="m38 4 31 18v39L38 79 7 61V22Z" />
          <path className="activity-emblem-outline" d="m38 11 24 14v32L38 71 14 57V25Z" />
          {!incomplete && status.key === "outstanding" ? <>
            <path className="activity-emblem-star" d="m38 23 5.7 11.6 12.8 1.9-9.3 9.1 2.2 12.8L38 52.3l-11.4 6.1 2.2-12.8-9.3-9.1 12.8-1.9Z" />
            <path className="activity-emblem-mark" d="m32 41 4 4 8-9" />
          </> : <>
            <path className="activity-emblem-mark" d="M25 51V41m13 10V30m13 21V36" />
            <path className="activity-emblem-base" d="M23 57h30" />
            {!incomplete && status.key === "active" && <path className="activity-emblem-spark" d="M53 21v8m-4-4h8" />}
          </>}
        </svg>
        <div className="activity-tier-identity">
          <div className="activity-tier-heading"><strong className="contribution-tier" data-tier={incomplete ? sharedStatus : status.key}>{statusLabel}</strong>
            {visiblePreview && <span className="activity-preview-label">PREVIEW</span>}</div>
          <p className="activity-tier-count"><b data-activity-total>{number(displayedTotal)}</b><span>{incomplete ? "LOCAL CONTRIBUTIONS" : displayedTotal === 1 ? "CONTRIBUTION" : "CONTRIBUTIONS"}<small>LAST 7 DAYS</small></span></p>
        </div>
      </div>
      {!incomplete && <div className="activity-tier-journey">
        <div className="activity-tier-progress" role="progressbar" aria-label="Contribution progress"
          aria-valuemin={0} aria-valuemax={11} aria-valuenow={Math.min(displayedTotal, 11)}
          aria-valuetext={`${number(displayedTotal)} contributions in the last 7 days. ${status.label}.${status.next ? ` ${status.next.contributionsNeeded} more to ${status.next.label}.` : " Outstanding reached."}`}>
          {Array.from({ length: 11 }, (_, index) => <span key={index} data-complete={displayedTotal > index} aria-hidden="true" />)}
        </div>
        <div className="activity-tier-milestones" aria-hidden="true"><span><b>ACTIVE</b>1 CONTRIBUTION</span><span><b>OUTSTANDING</b>11 CONTRIBUTIONS</span></div>
      </div>}
      {!incomplete && <p className="activity-tier-next" data-activity-next-tier>{status.next
        ? <><b>{status.next.contributionsNeeded}</b><span>MORE TO <strong>{status.next.label}</strong></span></>
        : <><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg><strong>OUTSTANDING REACHED</strong></>}</p>}
      <p className="activity-tier-encouragement" role={incomplete ? "status" : undefined}>{incomplete ? availabilityMessage : status.key === "inactive"
        ? "ONE USEFUL UPDATE CAN HELP THE WHOLE TEAM. START WITH WHAT YOU KNOW."
        : status.key === "active"
          ? "YOU’RE KEEPING THE TEAM INFORMED. EVERY USEFUL UPDATE ADDS VALUE."
          : "YOUR KNOWLEDGE MAKES A DIFFERENCE. THANK YOU FOR SHARING IT."}</p>
      {onContribute && <div className="activity-tier-actions">
        <button type="button" className="ui-button ui-button--primary" onClick={() => onContribute("ports")}>CONTRIBUTE +1 <span aria-hidden="true">↗</span></button>
        <button type="button" className="ui-button ui-button--secondary" onClick={() => onContribute("feedback")}>FEEDBACK</button>
      </div>}
    </div>
    <details className="activity-tier-details"><summary>HOW IT COUNTS</summary>
      <dl className="activity-tier-rules" aria-label="Contribution tier calculation">
        {contributionStatusRules.map(rule => <div key={rule.key} className={!incomplete && rule.key === status.key ? "is-current" : undefined}>
          <dt>{rule.label}{!incomplete && rule.key === status.key && <span className="sr-only"> · CURRENT STATUS</span>}</dt><dd>{rule.criteria}</dd>
        </div>)}
      </dl>
      <p className="activity-tier-calculation">PUBLISHED DATABASE UPDATES AND FEEDBACK FROM TODAY AND THE PREVIOUS SIX DAYS, IN HONG KONG TIME.</p>
      <p className="activity-tier-calculation">REPEAT EDITS TO THE SAME ENTRY ON ONE DAY COUNT ONCE. UNCHANGED OR FORMATTING-ONLY SAVES DO NOT COUNT. ONE AI IMPORT COUNTS ONCE. HATS DO NOT CHANGE YOUR TIER.</p>
    </details>
    {canPreview && onStatusPreviewChange && <label className="activity-appearance-preview">APPEARANCE PREVIEW
      <select aria-label="Contribution appearance preview" value={visiblePreview ?? "actual"}
        onChange={event => onStatusPreviewChange(event.target.value === "actual" ? null : event.target.value as ContributionStatusKey)}>
        <option value="actual">ACTUAL STATUS</option>
        {contributionStatusRules.map(rule => <option key={rule.key} value={rule.key}>{rule.label}</option>)}
      </select>
      {visiblePreview && <span>PREVIEW ONLY · YOUR CONTRIBUTIONS ARE UNCHANGED.</span>}
    </label>}
  </section>;
  return (
    <section className={`resource-wallet contribution-activity${compact ? " contribution-activity--compact" : ""}`}
      aria-label="Contribution activity">
      <div className="activity-toolbar"><ActivityPeriodFilter period={period} onChange={setPeriod} /></div>
      <ActivityStatus activity={activity} onContribute={onContribute} initialGuideOpen={initialGuideOpen} sharedStatus={sharedStatus} />
      <ActivitySummary activity={activity} period={period} incomplete={incomplete} />
      <ActivityWeeks activity={localActivity} period={period} />
      {sharedFeedback && <p>{sharedFeedback.count} SHARED CONTRIBUTIONS INCLUDED. THE CHART AND HISTORY BELOW SHOW LOCAL DATABASE UPDATES.</p>}
      {incomplete && <p role="status">{feedbackError || availabilityMessage}</p>}
      <header className="activity-section-heading"><h3>CONTRIBUTION HISTORY</h3></header>
      <ActivityHistory key={period} entries={activity.entries} publications={state.contributions} pageSize={compact ? 10 : 30} />
    </section>
  );
}

export function ActivityHistory({ entries, publications, pageSize = 30 }: {
  entries: ContributionActivityEntry[];
  publications: Contribution[];
  pageSize?: number;
}) {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const publicationsById = new Map(publications.map(item => [item.id, item]));
  return <>
    <ol className="activity-history" aria-label="Contribution history">
      {entries.slice(0, visibleCount).map(entry => {
        const originals = entry.contributionIds.flatMap(id => {
          const item = publicationsById.get(id);
          return item ? [item] : [];
        });
        return <li key={entry.id}>
          <ResourceIcon kind="activity" size={20} />
          <div>
            <strong>{entry.title}</strong>
            <span><time dateTime={entry.at}>{date(entry.at)}</time>
              <span>{activityKind(entry.kind)}</span>
              {entry.recordCount > 1 && <span className="activity-record-count">{number(entry.recordCount)} RECORDS</span>}
            </span>
            {originals.length > 0 && <ActivityEntryDetails publications={originals} />}
          </div>
        </li>;
      })}
    </ol>
    {entries.length > visibleCount && <button className="button secondary small resource-load-more"
      onClick={() => setVisibleCount(count => count + pageSize)}>LOAD MORE</button>}
    {entries.length === 0 && <p className="activity-empty">NO CONTRIBUTIONS IN THIS PERIOD</p>}
  </>;
}

function activityKind(kind: string) {
  return ({ "ai-import": "AI import", "case-study": "Case study", "buyer-group": "Buyer group", "buyer-team": "Buyer team", "buyer-competition": "Buyer competition", company: "Buyer", "key-info": "Key info", legacy: "Contribution" } as Record<string, string>)[kind] ?? kind;
}

function ActivityEntryDetails({ publications }: { publications: Contribution[] }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="activity-entry-details" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>View update{publications.length > 1 ? "s" : ""}</summary>
    {expanded && publications.map(publication => <ContributionDetails key={publication.id} contribution={publication} />)}
  </details>;
}

function ContributionDetails({ contribution }: { contribution: Contribution }) {
  const changes = contribution.extractionBatch?.changes ?? (contribution.knowledgeChange ? [contribution.knowledgeChange] : []);
  const keyInfoChanges = contribution.extractionBatch?.intelligenceChanges ?? (contribution.proposedKeyInfo ? [{
    baseKeyInfo: contribution.keyInfoBase, keyInfo: contribution.proposedKeyInfo,
  }] : []);
  return <article className="activity-publication">
    <time dateTime={contribution.publishedAt ?? contribution.createdAt}>{new Date(contribution.publishedAt ?? contribution.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Hong_Kong" })} HKT</time>
    {contribution.body && <p>{contribution.body}</p>}
    {changes.map((change, index) => <ActivityChange key={`${change.target.kind}-${change.target.id}-${index}`} change={change} />)}
    {keyInfoChanges.map((change, index) => <dl key={index}>
      {intelligenceFields.filter(field => change.baseKeyInfo?.[field.key] !== change.keyInfo[field.key]).map(field =>
        <div key={field.key}><dt>{field.label}</dt><dd>{change.baseKeyInfo?.[field.key] ?? "—"} → {change.keyInfo[field.key] ?? "—"}</dd></div>)}
    </dl>)}
    {contribution.source && <p className="activity-publication-source"><b>Source</b> {contribution.source}</p>}
  </article>;
}

function ActivityChange({ change }: { change: KnowledgeChange }) {
  const previous = new Map(change.baseDocument.sections.flatMap(section => section.blocks).map(block => [block.id, block]));
  const current = change.document.sections.flatMap(section => section.blocks);
  const changed = current.filter(block => JSON.stringify(block) !== JSON.stringify(previous.get(block.id)));
  const removed = [...previous.values()].filter(block => !current.some(item => item.id === block.id));
  return <div className="activity-updated-fields">
    {changed.map(block => <section key={block.id}>
      <h4>{block.title}</h4>
      {block.type === "text" ? <p>{block.text}</p> : block.type === "file" ? <p>{block.url}</p> :
        <div className="activity-table-scroll"><table><thead><tr>{block.columns.map(column => <th key={column.id}>{column.name}</th>)}</tr></thead>
          <tbody>{block.rows.map(row => <tr key={row.id}>{row.cells.map((cell, index) => <td key={block.columns[index]?.id ?? index}>{cell}</td>)}</tr>)}</tbody></table></div>}
    </section>)}
    {removed.map(block => <p key={block.id}>{block.title} · Removed</p>)}
  </div>;
}
