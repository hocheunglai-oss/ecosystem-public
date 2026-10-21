import KnowledgeUpdateButton from "./KnowledgeUpdateButton";
import { useEffect, useState } from "react";
import PortBuyPrices from "./PortBuyPrices";
import {
  Anchor,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  Clock3,
  Globe2,
  Mail,
  MapPin,
  Plus,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { useDemo } from "./store";
import { actors, availableCredit, canTrade, type Port } from "./lib/model";
import { getLocationIntelligence } from "./lib/intelligence";
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
import type { WorkspaceNavigationContext } from "./workspaceNavigation";

/** Port and country details read the same facts as the enquiry briefing. */
export function LocationIntelligenceDetails({ port, open, showPortName = false }: { port: Port; open: OpenModal; showPortName?: boolean }) {
  const { actor } = useDemo();
  const { keyInfo, refineries } = getLocationIntelligence(port);
  const facts = [
    ["30 days quality claim period", keyInfo.qualityClaim],
    ["ISO Specs", keyInfo.isoSpecs],
    ["Sample Location", keyInfo.sampleLocation],
    ["Debunkering", keyInfo.debunkering],
  ];
  return <>
    <div className="detail-section">
      <div className="review-item-head">
        <h3>Key Info{showPortName && ` · ${port.name}`}</h3>
        <KnowledgeUpdateButton onClick={() => open({ type: "intelligence-edit", portId: port.id })} />
      </div>
      <dl className="detail-list">
        {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}
      </dl>
    </div>
    <div className="detail-section">
      <h3>Refineries</h3>
      {refineries.length ? <div className="table-wrap"><table>
        <thead><tr><th scope="col">Name</th><th scope="col">Location</th><th scope="col">Capacity</th></tr></thead>
        <tbody>{refineries.map((refinery) => <tr key={`${refinery.name}-${refinery.location}`}>
          <th scope="row">{refinery.name}</th>
          <td>{refinery.location}</td><td>{refinery.capacity}</td>
        </tr>)}</tbody>
      </table></div> : <p>—</p>}
    </div>
  </>;
}

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
                    CONTRIBUTE +1
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

export function PortsPage({ open, context }: { open: OpenModal; context?: WorkspaceNavigationContext }) {
  const { state } = useDemo();
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("all");
  const [selectedId, setSelectedId] = useState(() => {
    const requested = context?.portId ?? new URLSearchParams(
      location.hash.split("?")[1] || "",
    ).get("port");
    return state.ports.some((port) => port.id === requested)
      ? requested!
      : state.ports[0]?.id || "";
  });
  useEffect(() => {
    if (!context?.portId) return;
    setQuery("");
    setCountry("all");
    if (state.ports.some((port) => port.id === context.portId)) setSelectedId(context.portId);
  }, [context, state.ports]);
  const contextual = Boolean(context?.portId);
  const countries = [
    ...new Set(state.ports.map((port) => port.country)),
  ].sort();
  const filtered = state.ports.filter(
    (port) =>
      (country === "all" || port.country === country) &&
      [port.name, port.code, port.country, ...port.tags]
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const port = contextual
    ? state.ports.find((item) => item.id === context?.portId)
    : filtered.find((item) => item.id === selectedId) || filtered[0];
  const combinedLocation = Boolean(context?.combinedLocation && context.portId === port?.id);
  const countryName = combinedLocation && port ? getLocationIntelligence(port).countryName : port?.country;
  const countryUpdates = combinedLocation ? state.contributions.filter((item) => item.targetType === "country" && item.targetId === countryName && item.status === "approved") : [];
  const accepted = port
    ? state.contributions.filter(
        (item) =>
          item.targetType === "port" &&
          item.targetId === port.id &&
          item.status === "approved",
      )
    : [];
  const pending = port
    ? state.contributions.filter(
        (item) =>
          item.targetType === "port" &&
          item.targetId === port.id &&
          item.status === "pending",
      ).length
    : 0;
  const introductorySummary = (value: string) =>
    value.replace(
      " Illustrative demo information; not verified operational or navigation guidance.",
      "",
    );

  return (
    <>
      {!contextual && <PageHeading
        eyebrow="LOCAL KNOWLEDGE. SHARED ADVANTAGE."
        title="A better view of every port."
        description="Useful context from across the desks, ready for your next enquiry."
        action={
          <Badge tone="green">
            <Globe2 size={15} /> {state.ports.length} demo ports
          </Badge>
        }
      />}
      <div className="knowledge-banner" hidden={contextual}>
        <span className="square-icon mint">
          <Sparkles size={22} />
        </span>
        <div>
          <strong>Your local insight travels further.</strong>
          <p>
            Publish an update. It becomes
            shared knowledge.
          </p>
        </div>
      </div>
      <div className="directory-toolbar" hidden={contextual}>
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search port, country, code or tag"
        />
        <label className="filter-select">
          <span className="sr-only">Filter by country</span>
          <select
            aria-label="Filter ports by country"
            value={country}
            onChange={(event) => setCountry(event.target.value)}
          >
            <option value="all">All countries</option>
            {countries.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <span className="results-count">
          {filtered.length} {filtered.length === 1 ? "port" : "ports"}
        </span>
      </div>
      <div className="port-directory-layout" style={contextual ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}>
        <section className="port-grid" aria-label="Port results" hidden={contextual}>
          {filtered.length ? (
            filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`card port-card ${item.id === port?.id ? "active" : ""}`}
                aria-pressed={item.id === port?.id}
                aria-controls="port-detail"
                onClick={() => setSelectedId(item.id)}
              >
                <span className="port-card-top">
                  <span className="square-icon blue">
                    <Anchor size={21} />
                  </span>
                  <Badge>{item.code}</Badge>
                  <ArrowUpRight size={16} />
                </span>
                <strong className="port-card-name">{item.name}</strong>
                <span className="port-card-country">
                  <MapPin size={14} /> {item.country}
                </span>
                <span className="port-card-summary">
                  {introductorySummary(item.summary)}
                </span>
                <span className="tag-list">
                  {item.tags.map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </span>
                <span className="port-card-bottom">
                  <Clock3 size={14} /> {item.leadTime}
                </span>
              </button>
            ))
          ) : (
            <div className="card">
              <Empty title="No ports match your search">
                Try a port code, another country or a shorter search.
              </Empty>
            </div>
          )}
        </section>
        {port ? (
          <section
            className="card directory-detail port-detail"
            id="port-detail"
            aria-label={`${port.name} port details`}
          >
            <div className="detail-hero">
              <span className="square-icon blue">
                <Anchor size={25} />
              </span>
              <div>
                <div className="section-label">PORT KNOWLEDGE</div>
                <h2>{port.name}</h2>
                <p>
                  {countryName} <Badge>{port.code}</Badge>
                </p>
              </div>
            </div>
            <p className="port-description">
              {introductorySummary(port.summary)}
            </p>
            <dl className="detail-list">
              <div>
                <dt>Country / territory</dt>
                <dd>{countryName}</dd>
              </div>
              <div>
                <dt>Port code</dt>
                <dd>{port.code}</dd>
              </div>
              <div>
                <dt>Time zone</dt>
                <dd>{port.timezone}</dd>
              </div>
              <div>
                <dt>Illustrative lead time</dt>
                <dd>{port.leadTime}</dd>
              </div>
              <div>
                <dt>Record updated</dt>
                <dd>{date(port.updatedAt)}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>
                  {accepted.length
                    ? "Demo library + reviewed contributions"
                    : "Illustrative demo library"}
                </dd>
              </div>
            </dl>
            <LocationIntelligenceDetails port={port} open={open} />
            {combinedLocation && countryUpdates.length > 0 && <div className="detail-section">
              <h3>Country data</h3>
              <div className="review-list country-updates">{countryUpdates.map((item) => <article className="review-item" key={item.id}>
                <h3>{item.title}</h3><p className="module-preserve-lines">{item.body}</p>
                <small>{actors.find((actor) => actor.id === item.author)?.name ?? item.author} · {date(item.reviewedAt ?? item.createdAt)}</small>
              </article>)}</div>
            </div>}
            <PortBuyPrices portId={port.id} />
            <div className="detail-section">
              <h3>Desk notes</h3>
              <ul className="port-notes">
                {port.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </div>
            {accepted.length > 0 && (
              <div className="detail-section">
                <h3>Recently accepted insights</h3>
                <div className="accepted-insights">
                  {accepted
                    .slice()
                    .reverse()
                    .slice(0, 3)
                    .map((item) => (
                      <div key={item.id}>
                        <CheckCircle2 size={16} />
                        <span>
                          <strong>{item.title}</strong>
                          <small>
                            {actors.find((actor) => actor.id === item.author)
                              ?.name || "Contributor"}{" "}
                            · {date(item.reviewedAt || item.createdAt)}
                          </small>
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}
            {pending > 0 && (
              <div className="notice amber">
                <Clock3 size={16} />
                <span>
                  {pending} {pending === 1 ? "update is" : "updates are"}{" "}
                  awaiting review. Accepted updates are published here.
                </span>
              </div>
            )}
            <div className="notice">
              <ShieldCheck size={17} />
              <span>
                Illustrative information for this demo. Confirm operational
                details with the relevant source before real use.
              </span>
            </div>
            <KnowledgeUpdateButton
              className="full"
              onClick={() =>
                open({
                  type: "contribute",
                  targetType: "port",
                  targetId: port.id,
                })
              }
            >
              CONTRIBUTE +1
            </KnowledgeUpdateButton>
            <small className="source-note">
              Changes are recorded in History.
            </small>
          </section>
        ) : (
          <section className="card directory-detail">
            <Empty title="Port knowledge appears here">
              Choose another country or search to see a port.
            </Empty>
          </section>
        )}
      </div>
    </>
  );
}
