import { useId, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  actors,
  isAdmin,
  offices,
  teamById,
  teamForActor,
  type Team,
} from "./lib/model";
import { ActivityPeriodFilter, ActivitySummary, ActivityWeeks, ResourceIcon, useActivityNow } from "./ResourceWallet";
import { useDemo } from "./store";
import { resourceNumber as number, SearchBox } from "./ui";
import { contributionActivity, type ContributionPeriod } from "./lib/contributionActivity";

export function TeamPerformance({ compact = false }: { compact?: boolean }) {
  const { state, actor } = useDemo();
  const ownOffice = teamForActor(actor);
  const officeManager = Boolean(actor.officeId && actor.isManager && !isAdmin(actor));
  const [view, setView] = useState<"own" | "compare">(
    ownOffice ? "own" : "compare",
  );
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<ContributionPeriod>("28d");
  const now = useActivityNow();
  const id = useId();
  if (actor.role === "credit" || (actor.officeId && !actor.isManager && !isAdmin(actor))) return null;
  const selected = selectedId ? teamById(selectedId) : undefined;
  const tabs = ownOffice
    ? [
        { id: "own" as const, label: ownOffice.name },
        ...(!officeManager ? [{ id: "compare" as const, label: "Compare offices" }] : []),
      ]
    : [{ id: "compare" as const, label: "Compare offices" }];
  const filtered = offices().filter((office) =>
    office.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <section className={`office-performance${compact ? " office-performance--compact" : ""}`} aria-label="Office performance">
      <div className="activity-toolbar"><ActivityPeriodFilter period={period} onChange={setPeriod} /></div>
      <div
        className="office-view-tabs"
        role="tablist"
        aria-label="Office views"
        onKeyDown={(event) => {
          const index = tabs.findIndex((tab) => tab.id === view);
          const next =
            event.key === "ArrowRight"
              ? (index + 1) % tabs.length
              : event.key === "ArrowLeft"
                ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : -1;
          if (next < 0) return;
          event.preventDefault();
          setView(tabs[next].id);
          event.currentTarget
            .querySelectorAll<HTMLButtonElement>('[role="tab"]')
            [next]?.focus();
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`${id}-${tab.id}-tab`}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            aria-controls={`${id}-${tab.id}-panel`}
            tabIndex={view === tab.id ? 0 : -1}
            onClick={() => setView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {ownOffice ? (
        <div
          id={`${id}-own-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-own-tab`}
          hidden={view !== "own"}
        >
          {view === "own" ? (
            <OfficeDetails key={ownOffice.id} team={ownOffice} period={period} now={now} />
          ) : null}
        </div>
      ) : null}
      <div
        id={`${id}-compare-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-compare-tab`}
        hidden={view !== "compare"}
      >
        <div className="office-compare-search">
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search offices"
          />
        </div>
        {compact ? <div className="office-comparison-list" aria-label="Office comparison">
          {filtered.map(office => {
            const activity = contributionActivity(state, office.memberIds, period, now);
            return <button type="button" key={office.id} data-office-id={office.id}
              aria-label={`${office.name} office performance`} aria-pressed={selectedId === office.id}
              onClick={() => setSelectedId(office.id)}>
              <strong>{office.name}</strong>
              <span aria-label={`${number(activity.total)} contributions`}><ResourceIcon kind="activity" size={15} /> {number(activity.total)}</span>
              <span aria-label={`${number(activity.hatsReceived)} hats received`}><ResourceIcon kind="hat" size={15} /> {number(activity.hatsReceived)}</span>
              <ArrowUpRight size={14} />
            </button>;
          })}
          {filtered.length === 0 && <p className="resource-empty">—</p>}
        </div> : <div className="office-comparison-scroll">
          <table
            className="office-comparison-table"
            aria-label="Office comparison"
          >
            <thead>
              <tr>
                <th scope="col">Office</th>
                <th scope="col">Contributions</th>
                <th scope="col">Hats received</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((office) => {
                const activity = contributionActivity(state, office.memberIds, period, now);
                return (
                  <tr
                    key={office.id}
                    className={selectedId === office.id ? "is-selected" : ""}
                  >
                    <th scope="row">
                      <button
                        type="button"
                        data-office-id={office.id}
                        aria-label={`${office.name} office performance`}
                        aria-pressed={selectedId === office.id}
                        onClick={() => setSelectedId(office.id)}
                      >
                        {office.name}
                        <ArrowUpRight size={15} />
                      </button>
                    </th>
                    <td>{number(activity.total)}</td>
                    <td>{number(activity.hatsReceived)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 ? <p className="resource-empty">—</p> : null}
        </div>}
        {view === "compare" && selected ? (
          <OfficeDetails key={selected.id} team={selected} period={period} now={now} />
        ) : null}
      </div>
    </section>
  );
}

function OfficeDetails({ team, period, now }: { team: Team; period: ContributionPeriod; now: number }) {
  const { state } = useDemo();
  const activity = contributionActivity(state, team.memberIds, period, now);
  const members = team.memberIds.flatMap((id) =>
    actors.filter((person) => person.id === id),
  );
  return (
    <section className="team-resources" aria-label="Team performance">
      <header className="economy-section-header">
        <h2>{team.name}</h2>
      </header>
      <div data-office-summary={team.id}>
        <ActivitySummary activity={activity} period={period} />
        <ActivityWeeks activity={activity} period={period} />
      </div>
      <div className="economy-team-table-scroll">
        <table className="economy-team-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Contributions</th>
              <th scope="col">Hats received</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const memberActivity = contributionActivity(state, member.id, period, now);
              return (
              <tr key={member.id} data-team-member={member.id}>
                <th scope="row">
                  <strong>{member.name.toUpperCase()}</strong>
                  <span>
                    {member.role === "manager"
                      ? "Manager"
                      : member.role === "admin"
                        ? "Admin"
                        : member.role === "credit"
                          ? "Credit"
                          : "Trader"}
                  </span>
                </th>
                <td>{number(memberActivity.total)}</td>
                <td>{number(memberActivity.hatsReceived)}</td>
              </tr>
            ); })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
