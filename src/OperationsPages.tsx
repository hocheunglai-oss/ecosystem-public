import { useState } from "react";
import { creditRequestType } from "./lib/credit";
import {
  ArrowUpRight,
  CheckCircle2,
  ClipboardCheck,
  Download,
  History,
  LockKeyhole,
  Plus,
  ShieldCheck,
} from "lucide-react";
import {
  actors,
  canTrade,
  isAdmin,
  availableCredit,
  currentMonth,
  outcomeProfit,
  isPendingOutcome,
  type CreditRequest,
} from "./lib/model";
import { ContributionPerformance } from "./ContributionPerformance";
import { useDemo } from "./store";
import {
  Badge,
  CardHeading,
  date,
  download,
  Empty,
  Field,
  money,
  number,
  PageHeading,
  Progress,
  SearchBox,
  Status,
  time,
} from "./ui";
import type { OpenModal } from "./types";

const actorName = (id: string) =>
  actors.find((actor) => actor.id === id)?.name ?? id;
const matches = (query: string, ...values: (string | undefined)[]) =>
  values.join(" ").toLowerCase().includes(query.trim().toLowerCase());

export function RequestCard({
  request,
  open,
}: {
  request: CreditRequest;
  open: OpenModal;
}) {
  const { state, actor } = useDemo();
  const company = state.companies.find((item) => item.id === request.companyId);
  const enquiry = state.enquiries.find((item) => item.id === request.enquiryId);
  const decision = request.decision;
  return (
    <article className="review-item credit-request">
      <div className="review-item-head">
        <div>
          <div className="eyebrow">
            {creditRequestType(request.type)}
          </div>
          <h3>{company?.name.toUpperCase() ?? "Company unavailable"}</h3>
        </div>
        <Status value={request.status} />
      </div>
      <div className="credit-request-amount">
        <strong>{money(request.amount)}</strong>
        <span>
          {" "}
          requested by {actorName(request.requestedBy)} ·{" "}
          {time(request.requestedAt)}
        </span>
      </div>
      <p>{request.reason}</p>
      {enquiry && (
        <button
          className="text-button"
          onClick={() => open({ type: "enquiry-detail", id: enquiry.id })}
        >
          {enquiry.vessel} · linked enquiry <ArrowUpRight size={15} />
        </button>
      )}
      {decision ? (
        <div
          className={`notice ${request.status === "approved" ? "green" : "amber"} decision-record`}
        >
          <strong>
            {request.status === "approved"
              ? `Approved ${money(decision.amount)}`
              : "Request declined"}{" "}
            · {actorName(decision.by)}
          </strong>
          <p>{decision.note}</p>
          <small>
            {time(decision.at)}
            {decision.terms ? ` · ${decision.terms}` : ""}
            {decision.expiresAt ? ` · Expiry ${time(decision.expiresAt)}` : ""}
            {request.status === "approved" && request.type === "increase"
              ? " · Added to approved limit"
              : ""}
          </small>
          <details>
            <summary>View recorded decision</summary>
            <dl className="detail-list">
              <div>
                <dt>Request ID</dt>
                <dd>{request.id}</dd>
              </div>
              <div>
                <dt>Requested</dt>
                <dd>{money(request.amount)}</dd>
              </div>
              <div>
                <dt>Approved</dt>
                <dd>{money(decision.amount)}</dd>
              </div>
              <div>
                <dt>Decision time</dt>
                <dd>
                  {date(decision.at)} · {time(decision.at)}
                </dd>
              </div>
              <div>
                <dt>Payment terms</dt>
                <dd>{decision.terms || "Unchanged"}</dd>
              </div>
            </dl>
          </details>
        </div>
      ) : (
        <div className="button-row">
          {actor.role === "credit" || isAdmin(actor) ? (
            <button
              className="button primary"
              onClick={() => open({ type: "decision", id: request.id })}
            >
              <ClipboardCheck size={16} />
              Review request
            </button>
          ) : (
            <Badge tone="amber">Awaiting credit review</Badge>
          )}
        </div>
      )}
    </article>
  );
}

export function CreditPage({ open }: { open: OpenModal }) {
  const { state, actor } = useDemo();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"pending" | "all" | "decided">("pending");
  const companies = state.companies.filter((company) =>
    matches(search, company.name, company.country, ...company.aliases),
  );
  const requests = state.requests.filter(
    (request) =>
      (tab === "all" ||
        (tab === "pending"
          ? request.status === "pending"
          : request.status !== "pending")) &&
      matches(
        search,
        state.companies.find((company) => company.id === request.companyId)
          ?.name,
        request.reason,
        request.decision?.note,
      ),
  );
  const approved = state.companies.filter(
    (company) => company.status === "approved",
  );
  const limit = approved.reduce((sum, company) => sum + company.limit, 0);
  const exposure = approved.reduce((sum, company) => sum + company.exposure, 0);
  const pending = state.requests.filter(
    (request) => request.status === "pending",
  ).length;
  return (
    <>
      <PageHeading
        eyebrow="CONFIDENCE TO MOVE"
        title="Buyers and Credit"
        description="See the position. Make the decision. Keep the full record."
        action={
          <Badge tone="green">
            <ShieldCheck size={14} />
            Illustrative USD credit
          </Badge>
        }
      />
      <div className="stats-grid">
        <div className="stat-card">
          <span>Approved limits</span>
          <strong>{money(limit, true)}</strong>
          <small>{approved.length} approved customers</small>
        </div>
        <div className="stat-card">
          <span>Current exposure</span>
          <strong>{money(exposure, true)}</strong>
          <small>Includes overdue balances</small>
        </div>
        <div className="stat-card">
          <span>Available headroom</span>
          <strong>{money(limit - exposure, true)}</strong>
          <small>Across demo customer limits</small>
        </div>
        <div className="stat-card">
          <span>Awaiting a decision</span>
          <strong>{pending}</strong>
          <small>New customers & limit increases</small>
        </div>
      </div>
      <div className="notice amber">
        <ShieldCheck size={18} />
        <span>
          Sample credit positions. A fixture reserves price × booked quantity.
          Approved increases permanently add to the limit in this demo.
        </span>
      </div>
      <section className="card">
        <CardHeading
          title="Requests & decisions"
          sub="Approval reasons and terms stay with the original request."
          action={
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder="Search company or decision…"
            />
          }
        />
        <div className="tabs" aria-label="Credit request status">
          {(["pending", "all", "decided"] as const).map((value) => (
            <button
              key={value}
              className={tab === value ? "active" : ""}
              onClick={() => setTab(value)}
            >
              {value === "pending"
                ? `Pending (${pending})`
                : value === "all"
                  ? "All requests"
                  : "Decision history"}
            </button>
          ))}
        </div>
        {requests.length ? (
          <div className="review-list">
            {requests.map((request) => (
              <RequestCard key={request.id} request={request} open={open} />
            ))}
          </div>
        ) : (
          <Empty
            title={
              tab === "pending" ? "No pending requests" : "No matching requests"
            }
          >
            Every credit decision will remain available in All requests and the
            Audit page.
          </Empty>
        )}
      </section>
      <section className="card">
        <CardHeading
          title="Customer credit positions"
          sub="Limits belong to the named buyer and selling entity. All figures are in USD."
        />
        {companies.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Legal buyer</th>
                  <th>Limit</th>
                  <th>Exposure</th>
                  <th>Available</th>
                  <th>Terms</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {companies.map((company) => (
                  <tr key={company.id}>
                    <td>
                      <strong>{company.name.toUpperCase()}</strong>
                      <small>{company.sellingEntity}</small>
                    </td>
                    <td>{money(company.limit)}</td>
                    <td>
                      {money(company.exposure)}
                      {company.overdue > 0 && (
                        <small className="text-amber">
                          {money(company.overdue)} overdue, included
                        </small>
                      )}
                    </td>
                    <td>
                      <strong
                        className={
                          availableCredit(company) < company.limit * 0.2
                            ? "text-amber"
                            : "text-green"
                        }
                      >
                        {money(availableCredit(company))}
                      </strong>
                      <Progress
                        value={
                          company.limit
                            ? (company.exposure / company.limit) * 100
                            : 0
                        }
                        label={`${company.name.toUpperCase()} credit utilisation`}
                      />
                    </td>
                    <td>{company.terms}</td>
                    <td>
                      <Status value={company.status} />
                    </td>
                    <td>
                      {canTrade(actor) && (
                        <button
                          className="text-button"
                          onClick={() =>
                            open({ type: "credit", companyId: company.id })
                          }
                        >
                          <Plus size={15} />
                          {company.status === "pending"
                            ? "Request approval"
                            : "Request credit"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No companies found">
            Try a legal name, alias or country.
          </Empty>
        )}
      </section>
    </>
  );
}

export function AuditPage() {
  const { state, actor: viewer } = useDemo();
  const [search, setSearch] = useState("");
  const [actor, setActor] = useState("all");
  const [action, setAction] = useState("all");
  const privateGoalActions = [
    "Monthly goals updated",
    "Target achieved",
    "Target reward reconciled",
  ];
  const visible = state.audit.filter(
    (entry) =>
      !privateGoalActions.includes(entry.action) ||
      isAdmin(viewer) ||
      (canTrade(viewer) && [viewer.id, viewer.name].includes(entry.entity)),
  );
  const entries = visible.filter(
    (entry) =>
      (actor === "all" || entry.actor === actor) &&
      (action === "all" || entry.action === action) &&
      matches(search, entry.action, entry.actor, entry.entity, entry.detail),
  );
  const names = [...new Set(visible.map((entry) => entry.actor))].sort();
  const actions = [...new Set(visible.map((entry) => entry.action))].sort();
  return (
    <>
      <PageHeading
        eyebrow="A CLEAR TRAIL"
        title="Audit"
        description="Decisions, changes and approvals stay connected to the people who made them."
        action={
          <button
            className="button secondary"
            onClick={() =>
              download(`ecosystem-audit-${currentMonth()}.json`, entries)
            }
          >
            <Download size={16} />
            Export filtered log
          </button>
        }
      />
      <div className="notice">
        <History size={18} />
        <span>
          This demo records activity in your browser. Credit decisions retain
          the prior and resulting limit, approved amount, terms and reason.
        </span>
      </div>
      <section className="card">
        <CardHeading
          title="Activity history"
          sub={`${entries.length} matching ${entries.length === 1 ? "event" : "events"}`}
        />
        <div className="form-grid audit-filters">
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search actions, records or details…"
          />
          <Field label="Person">
            <select
              value={actor}
              onChange={(event) => setActor(event.target.value)}
            >
              <option value="all">All people</option>
              {names.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </Field>
          <Field label="Action">
            <select
              value={action}
              onChange={(event) => setAction(event.target.value)}
            >
              <option value="all">All actions</option>
              {actions.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </Field>
        </div>
        {entries.length ? (
          <div className="table-wrap">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>When / who</th>
                  <th>Action / record</th>
                  <th>Recorded details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      {time(entry.at)}
                      <small>
                        {entry.actor} · {entry.role}
                      </small>
                    </td>
                    <td>
                      <strong>{entry.action}</strong>
                      <small>{entry.entity}</small>
                    </td>
                    <td>{entry.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No matching activity">
            Change your filters to see other recorded events.
          </Empty>
        )}
      </section>
    </>
  );
}

export function ManagementPage({ open }: { open: OpenModal }) {
  const { state, actor } = useDemo();
  if (!isAdmin(actor)) return <>
    <PageHeading title="MANAGEMENT" />
    <section className="card"><Empty title="ADMIN ACCESS"><LockKeyhole size={20} /> ADMIN ACCESS REQUIRED</Empty></section>
  </>;
  const contributions = state.contributions.filter(item => item.status === "approved");
  const requests = state.requests.filter(request => request.status === "pending");
  return <>
    <PageHeading title="MANAGEMENT" />
    <ContributionPerformance />
    <details className="card management-demo-records">
      <summary>DEMO BUSINESS RECORDS</summary>
      <div className="stats-grid">
        <div className="stat-card"><span>UPDATES</span><strong>{contributions.length}</strong><small>PUBLISHED</small></div>
        <div className="stat-card"><span>CREDIT REQUESTS</span><strong>{requests.length}</strong><small>AWAITING A RECORDED DECISION</small></div>
        <div className="stat-card"><span>DEMO TEAM</span><strong>{actors.length}</strong><small>TRADER · MANAGER · CREDIT · ADMIN</small></div>
      </div>
      <section className="card"><CardHeading title="LOCAL UPDATE RECORDS" />
        <div className="table-wrap"><table><thead><tr><th>INFORMATION</th><th>AUTHOR</th><th>DATE</th></tr></thead><tbody>{contributions.slice(0, 50).map(item => <tr key={item.id}>
          <td><button className="text-button" onClick={() => open({ type: "review-contribution", id: item.id })}>{item.title}</button></td>
          <td>{item.author === actor.id ? actor.name : actorName(item.author)}</td><td>{time(item.publishedAt ?? item.reviewedAt ?? item.createdAt)}</td>
        </tr>)}</tbody></table></div>
      </section>
      {requests.length > 0 && <section className="card"><CardHeading title="CREDIT APPROVAL INBOX" />
        <div className="review-list">{requests.map(request => <RequestCard key={request.id} request={request} open={open} />)}</div>
      </section>}
    </details>
  </>;
}
