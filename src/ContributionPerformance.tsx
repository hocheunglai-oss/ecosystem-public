import { useEffect, useMemo, useState } from "react";
import type { AccessOffice, AccessUser } from "../shared/access";
import { accessRequest, useAccess } from "./auth";
import { contributionActivity, mergeLocationActivity, contributionStatus, type ContributionPeriod, type ContributionStatusKey } from "./lib/contributionActivity";
import { ActivityHistory, ActivityPeriodFilter, ActivityStatus, ActivitySummary, ActivityWeeks, useActivityNow } from "./ResourceWallet";
import { useLocationActivity } from './lib/useLocationActivity';
import { useDemo } from "./store";
import { resourceNumber as number } from "./ui";
import "./contribution-performance.css";

/** The directory is shared; prototype publications are still isolated to this account/browser. */
export function ContributionPerformance() {
  const { user } = useAccess();
  const { state, actor, locations } = useDemo();
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [offices, setOffices] = useState<AccessOffice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [officeId, setOfficeId] = useState("");
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState<ContributionPeriod>("7d");
  const [statusFilter, setStatusFilter] = useState<ContributionStatusKey | "" | "unavailable">("");
  const [selectedId, setSelectedId] = useState(actor.id);
  const now = useActivityNow();
  useEffect(() => {
    if (!user?.isAdmin) return;
    const controller = new AbortController();
    setLoading(true); setError("");
    void accessRequest<{ users: AccessUser[]; offices: AccessOffice[] }>("users", undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setUsers(result.users); setOffices(result.offices); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "DIRECTORY UNAVAILABLE"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [user?.id, user?.isAdmin, retry]);
  const directory = users.length ? users : user ? [user] : [];
  const knownIds = directory.map(person => person.id);
  const shared = useLocationActivity(knownIds, period, now, knownIds, Boolean(user?.isAdmin));
  const selectedShared = useLocationActivity(selectedId, period, now, knownIds, Boolean(user?.isAdmin && selectedId));
  const rows = useMemo(() => directory.map(person => {
    const observed = person.id === actor.id || state.contributions.some(item => item.author === person.id)
      || (state.hats ?? []).some(item => item.recipientId === person.id);
    const projection = shared.byActor?.[person.id];
    const local = contributionActivity(state, person.id, period, now, knownIds);
    const activity = projection && shared.status === 'ready' ? mergeLocationActivity(local, projection) : !locations.enabled && observed ? local : null;
    return { person, activity, status: activity ? contributionStatus(activity.total) : null };
  }), [users, user, state, actor.id, period, now, shared.byActor, shared.status, locations.enabled]);
  if (!user?.isAdmin) return null;
  const search = query.trim().toLocaleLowerCase();
  const filtered = rows.filter(({ person, status }) => (!officeId || person.officeId === officeId)
    && `${person.displayName} ${person.email}`.toLocaleLowerCase().includes(search)
    && (!statusFilter || (statusFilter === "unavailable" ? !status : status?.key === statusFilter)));
  const selectedRow = filtered.find(row => row.person.id === selectedId);
  const selected = selectedRow ? { ...selectedRow, activity: selectedShared.status === 'ready' ? selectedShared.activity : null } : undefined;
  return <section className="card contribution-performance contribution-activity" aria-label="User contribution performance">
    <header className="contribution-performance-heading"><h2>USER CONTRIBUTION PERFORMANCE</h2><ActivityPeriodFilter period={period} onChange={setPeriod} /></header>
    <p className="contribution-data-scope" role="note"><strong>COUNTRY &amp; PORT CONTRIBUTIONS ARE SHARED.</strong> OTHER LOCAL RECORDS REMAIN LIMITED TO THIS ACCOUNT AND BROWSER. UNAVAILABLE RECORDS ARE NOT ZERO CONTRIBUTIONS.</p>
    {shared.error && <p role="alert">{shared.error} <button className="button secondary small" onClick={shared.refresh}>RETRY</button></p>}
    {error && <div className="contribution-directory-error" role="alert"><span>{error}</span><button type="button" className="button secondary small" onClick={() => setRetry(value => value + 1)}>RETRY DIRECTORY</button></div>}
    <div className="contribution-performance-filters">
      <label>OFFICE<select aria-label="Contribution office" value={officeId} onChange={event => setOfficeId(event.target.value)}>
        <option value="">ALL OFFICES</option>{offices.map(office => <option key={office.id} value={office.id}>{office.name}</option>)}
      </select></label>
      <label>USER<input type="search" autoComplete="off" name="contribution-user-filter" aria-label="Search contribution users" placeholder="SEARCH USERS" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>STATUS<select aria-label="Contribution status filter" value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}>
        <option value="">ALL STATUSES</option><option value="inactive">INACTIVE</option><option value="active">ACTIVE</option><option value="outstanding">OUTSTANDING</option><option value="unavailable">RECORDS UNAVAILABLE</option>
      </select></label>
    </div>
    {loading && <p className="activity-empty" role="status">LOADING USER DIRECTORY…</p>}
    <div className="contribution-performance-table-scroll"><table className="contribution-performance-table" aria-label="User contribution performance records">
      <thead><tr><th scope="col">USER / OFFICE</th><th scope="col">STATUS</th><th scope="col">CONTRIBUTIONS</th><th scope="col">HATS RECEIVED</th><th scope="col">LAST CONTRIBUTION</th><th scope="col">RECORDS</th></tr></thead>
      <tbody>{filtered.map(({ person, activity, status }) => <tr key={person.id} data-performance-user={person.id} className={selected?.person.id === person.id ? "is-selected" : undefined}>
        <th scope="row"><strong>{person.displayName}</strong><span>{person.officeName}{!person.isActive && " · INACTIVE ACCOUNT"}</span></th>
        <td data-label="STATUS"><span className="contribution-performance-status" data-status={status?.key ?? "unavailable"}>{status?.label ?? "RECORDS UNAVAILABLE"}</span></td>
        <td data-label="CONTRIBUTIONS">{activity ? number(activity.total) : "—"}</td>
        <td data-label="HATS RECEIVED">{activity ? number(activity.hatsReceived) : "—"}</td>
        <td data-label="LAST CONTRIBUTION">{activity?.entries[0] ? <time dateTime={activity.entries[0].at}>{new Date(activity.entries[0].at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Hong_Kong" })}</time> : "—"}</td>
        <td data-label="RECORDS"><button type="button" className="text-button" aria-label={`View contribution records for ${person.displayName}`} aria-pressed={selected?.person.id === person.id}
          onClick={() => setSelectedId(person.id)} disabled={!activity}>VIEW RECORDS</button></td>
      </tr>)}</tbody>
    </table></div>
    {!loading && filtered.length === 0 && <p className="activity-empty">NO MATCHING USERS</p>}
    {selected?.activity && <section className="contribution-performance-detail" aria-label={`Contribution records for ${selected.person.displayName}`}>
      <header className="activity-section-heading"><h3>{selected.person.displayName} · {selected.person.officeName}</h3></header>
      <div className="contribution-performance-summary"><ActivityStatus activity={selected.activity} /><div><ActivitySummary activity={selected.activity} period={period} /><ActivityWeeks activity={selected.activity} period={period} /></div></div>
      <header className="activity-section-heading"><h3>CONTRIBUTION RECORDS · {selected.activity.periodLabel}</h3></header>
      <ActivityHistory key={`${selected.person.id}:${period}`} period={period} entries={selected.activity.entries} publications={state.contributions} hasMore={selectedShared.hasMore} loading={selectedShared.loading} onLoadMore={selectedShared.loadMore} />
      {selectedShared.error && <p role="alert">{selectedShared.error} <button className="button secondary small" onClick={selectedShared.refresh}>RETRY</button></p>}
    </section>}
  </section>;
}
