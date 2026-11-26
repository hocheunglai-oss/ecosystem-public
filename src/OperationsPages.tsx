import { creditRequestType } from "./lib/credit";
import {
  ArrowUpRight,
  ClipboardCheck,
  LockKeyhole,
} from "lucide-react";
import {
  actors,
  isAdmin,
  type CreditRequest,
} from "./lib/model";
import { ContributionPerformance } from "./ContributionPerformance";
import { useTestWorkspace } from "./TestWorkspace";
import { useDemo } from "./store";
import {
  Badge,
  CardHeading,
  date,
  Empty,
  money,
  PageHeading,
  Status,
  time,
} from "./ui";
import type { OpenModal } from "./types";

const actorName = (id: string) =>
  actors.find((actor) => actor.id === id)?.name ?? id;
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

export function ManagementPage({ open }: { open: OpenModal }) {
  const { state, actor } = useDemo();
  const { dataMode } = useTestWorkspace();
  if (!isAdmin(actor)) return <>
    <PageHeading title="MANAGEMENT" />
    <section className="card"><Empty title="ADMIN ACCESS"><LockKeyhole size={20} /> ADMIN ACCESS REQUIRED</Empty></section>
  </>;
  const contributions = state.contributions.filter(item => item.status === "approved");
  const requests = state.requests.filter(request => request.status === "pending");
  return <>
    <PageHeading title="MANAGEMENT" />
    <ContributionPerformance />
    {dataMode === 'test' && <details className="card management-demo-records">
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
    </details>}
  </>;
}
