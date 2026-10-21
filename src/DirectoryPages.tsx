import KnowledgeUpdateButton from "./KnowledgeUpdateButton";
import { useState } from "react";
import {
  ArrowUpRight,
  Building2,
  CheckCircle2,
  Clock3,
  Mail,
  MapPin,
  Plus,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { useDemo } from "./store";
import { actors, availableCredit, canTrade } from "./lib/model";
import {
  Badge,
  CardHeading,
  date,
  Empty,
  money,
  PageHeading,
  Progress,
  SearchBox,
  Status,
} from "./ui";
import type { OpenModal } from "./types";

export function CompaniesPage({ open }: { open: OpenModal }) {
  const { state, actor } = useDemo();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState(state.companies[0]?.id || "");
  const filtered = state.companies.filter(
    (company) =>
      (status === "all" || company.status === status) &&
      [
        company.name,
        company.country,
        company.city,
        company.contact,
        ...company.aliases,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const company =
    filtered.find((item) => item.id === selectedId) || filtered[0];
  const pendingRequest =
    company &&
    state.requests.find(
      (request) =>
        request.companyId === company.id && request.status === "pending",
    );
  const accepted = company
    ? state.contributions.filter(
        (item) =>
          item.targetType === "company" &&
          item.targetId === company.id &&
          item.status === "approved",
      )
    : [];
  const headroom = company ? availableCredit(company) : 0;
  const approvedCount = state.companies.filter(
    (item) => item.status === "approved",
  ).length;

  return (
    <>
      <PageHeading
        eyebrow="YOUR CUSTOMER NETWORK"
        title="Know who you’re trading with."
        description="Legal entities, shared context and credit, in one customer record."
        action={
          <button
            className="button primary"
            disabled={!canTrade(actor)}
            title={
              !canTrade(actor)
                ? "Switch to Trader to request a new customer."
                : undefined
            }
            onClick={() => open({ type: "company" })}
          >
            <Plus size={17} /> New customer
          </button>
        }
      />
      <div className="directory-summary">
        <span>
          <Users size={17} /> {state.companies.length} demo customers
        </span>
        <span>
          <CheckCircle2 size={17} /> {approvedCount} approved
        </span>
        <span>
          <Clock3 size={17} /> {state.companies.length - approvedCount} pending
        </span>
      </div>
      <div className="directory-toolbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search companies, aliases or countries"
        />
        <label className="filter-select">
          <span className="sr-only">Customer status</span>
          <select
            aria-label="Customer status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="approved">Approved</option>
            <option value="pending">Pending approval</option>
          </select>
        </label>
      </div>
      <div className="directory-layout">
        <section className="card directory-list" aria-label="Company results">
          <div className="directory-list-heading">
            <span className="section-label">COMPANY DIRECTORY</span>
            <span>{filtered.length} results</span>
          </div>
          {filtered.length ? (
            filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`directory-item ${item.id === company?.id ? "active" : ""}`}
                aria-pressed={item.id === company?.id}
                aria-controls="company-detail"
                onClick={() => setSelectedId(item.id)}
              >
                <span className="directory-avatar">
                  <Building2 size={19} />
                </span>
                <span className="directory-item-copy">
                  <strong>{item.name.toUpperCase()}</strong>
                  <span>
                    {item.country} · {item.city}
                  </span>
                  <small>
                    {item.status === "approved"
                      ? `${money(availableCredit(item), true)} available`
                      : "Awaiting credit approval"}
                  </small>
                </span>
                <ArrowUpRight size={16} />
              </button>
            ))
          ) : (
            <Empty title="No companies found">
              Try a different name or country, or start a new customer request.
            </Empty>
          )}
        </section>
        {company ? (
          <section
            className="card directory-detail"
            id="company-detail"
            aria-label={`${company.name.toUpperCase()} details`}
          >
            <div className="detail-hero">
              <span className="square-icon mint">
                <Building2 size={25} />
              </span>
              <div>
                <div className="section-label">LEGAL BUYER ENTITY</div>
                <h2>{company.name.toUpperCase()}</h2>
                <p>
                  <MapPin size={15} /> {company.city}, {company.country}
                </p>
              </div>
              <Status value={company.status} />
            </div>
            <div className="customer-credit-strip">
              <div>
                <span>Available credit · USD</span>
                <strong className={headroom < 0 ? "negative" : ""}>
                  {money(headroom)}
                </strong>
              </div>
              <div>
                <span>Approved limit</span>
                <strong>{money(company.limit)}</strong>
              </div>
            </div>
            <Progress
              value={
                company.limit > 0 ? (company.exposure / company.limit) * 100 : 0
              }
              label="Customer credit utilization"
            />
            <div className="credit-pair">
              <span>{money(company.exposure)} used</span>
              <span>
                {company.limit > 0
                  ? `${Math.round((company.exposure / company.limit) * 100)}% utilized`
                  : "No approved limit"}
              </span>
            </div>
            <dl className="detail-list">
              <div>
                <dt>Selling entity</dt>
                <dd>{company.sellingEntity}</dd>
              </div>
              <div>
                <dt>Payment terms</dt>
                <dd>{company.terms}</dd>
              </div>
              <div>
                <dt>
                  Overdue <small>(included in exposure)</small>
                </dt>
                <dd className={company.overdue > 0 ? "negative" : ""}>
                  {money(company.overdue)}
                </dd>
              </div>
              <div>
                <dt>Credit review date</dt>
                <dd>
                  {company.reviewDate
                    ? date(company.reviewDate)
                    : "Awaiting review"}
                </dd>
              </div>
              <div>
                <dt>Purchasing contact</dt>
                <dd>{company.contact || "Not yet recorded"}</dd>
              </div>
              <div>
                <dt>
                  <Mail size={14} /> Email
                </dt>
                <dd data-preserve-case={company.email ? true : undefined}>{company.email || "Not yet recorded"}</dd>
              </div>
            </dl>
            {company.aliases.length > 0 && (
              <div className="detail-section">
                <h3>Also known as</h3>
                <div className="tag-list">
                  {company.aliases.map((alias) => (
                    <Badge key={alias}>{alias}</Badge>
                  ))}
                </div>
                <small className="source-note">
                  Aliases help find a match. Confirm the legal buyer for every
                  enquiry.
                </small>
              </div>
            )}
            <div className="detail-section">
              <CardHeading
                title="Shared customer knowledge"
                action={
                  <KnowledgeUpdateButton
                    onClick={() =>
                      open({
                        type: "contribute",
                        targetType: "company",
                        targetId: company.id,
                      })
                    }
                  >
                    EDIT
                  </KnowledgeUpdateButton>
                }
              />
              <div className="knowledge-copy">
                {company.notes
                  .split("\n\n")
                  .filter(Boolean)
                  .map((note, index) => (
                    <p key={index}>{note}</p>
                  ))}
              </div>
              {accepted.length > 0 && (
                <div className="source-note">
                  <CheckCircle2 size={14} /> {accepted.length} accepted{" "}
                  {accepted.length === 1 ? "contribution" : "contributions"}{" "}
                  published to this record.
                </div>
              )}
            </div>
            {pendingRequest && (
              <div className="notice amber">
                <Clock3 size={17} />
                <span>
                  <strong>Credit review in progress.</strong>{" "}
                  {money(pendingRequest.amount)}{" "}
                  {pendingRequest.type === "increase"
                    ? "additional credit requested"
                    : "initial limit requested"}
                  . The decision will be retained in Buyers and Credit and Audit.
                </span>
              </div>
            )}
            <div className="detail-footer">
              <button
                className="button secondary"
                disabled={!canTrade(actor) || Boolean(pendingRequest)}
                title={
                  !canTrade(actor)
                    ? "Switch to Trader to submit a credit request."
                    : pendingRequest
                      ? "A credit request is already awaiting a decision."
                      : undefined
                }
                onClick={() => open({ type: "credit", companyId: company.id })}
              >
                <ShieldCheck size={17} />{" "}
                {pendingRequest
                  ? "Credit request pending"
                  : company.status === "pending"
                    ? "Request initial credit"
                    : "Request additional credit"}
              </button>
              <span className="source-note">
                Sample customer and credit data · USD
              </span>
            </div>
          </section>
        ) : (
          <section className="card directory-detail">
            <Empty title="Your customer context appears here">
              Select a company or change the filters.
            </Empty>
          </section>
        )}
      </div>
    </>
  );
}
