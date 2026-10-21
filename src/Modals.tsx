import { useLocationContribution } from './lib/useLocationContribution';
import { supplierName } from './lib/supplierPresentation';
import { ReleaseNotice, useBuyerCreditAvailable } from './ReleaseGate';
import { isBuyerCreditModal } from '../shared/ecoRelease';
import KnowledgeUpdateButton from "./KnowledgeUpdateButton";
import { FeedbackPortal } from "./Administration";
import { CreditRequestForm, DecisionForm, CompanyForm } from "./CreditForms";
import "./credit-records.css";
import { KnowledgeComparison } from "./KnowledgeEditor";
import { knowledgeDocument } from "./lib/knowledge";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Plus,
  ShieldCheck,
  Download,
} from "lucide-react";
import { useDemo } from "./store";
import {
  actors,
  canTrade,
  isAdmin,
  parseProductQuantity,
  outcomeProfit,
  getOutcomePrivateNote,
  isPendingOutcome,
} from "./lib/model";
import {
  Field,
  Modal,
  Status,
  date,
  time,
  money,
  number,
  download,
} from "./ui";
import type { ModalSpec, OpenModal } from "./types";
import { ResourceWallet, type ContributionDestination } from "./ResourceWallet";
import SearchableSelect from "./SearchableSelect";
import { useSupplierCatalog } from "./lib/supplierApi";
import { productSupplierName } from "./lib/fixtureSuppliers";
import { lostReasonsFor } from "./lib/lostReasons";
import { useMobileInterface } from "./mobile";
import { IntelligenceAmendment } from "./IntelligenceEditor";
import { emptyIntelligenceKeyInfo } from "./lib/intelligenceFields";
type Close = () => void;
function Frame({
  title,
  kicker,
  close,
  children,
  wide = false,
}: {
  title: string;
  kicker?: string;
  close: Close;
  children: ReactNode;
  wide?: boolean;
}) {
  const { toast } = useDemo();
  return (
    <Modal title={title} kicker={kicker} onClose={close} wide={wide}>
      {toast?.error && (
        <div className="notice rose" role="alert">
          <AlertTriangle size={18} />
          {toast.message}
        </div>
      )}
      {children}
    </Modal>
  );
}
function OutcomeForm({
  spec,
  close,
}: {
  spec: Extract<ModalSpec, { type: "outcome" }>;
  close: Close;
}) {
  const { state, run } = useDemo();
  const enq = state.enquiries.find((enquiry) => enquiry.id === spec.id)!;
  const isFixture = spec.kind === "fixture";
  const supplierCatalog = useSupplierCatalog(isFixture);
  const suppliers = supplierCatalog.data?.items ?? [];
  const [rows, setRows] = useState(() => {
    const requested = enq.products?.length
      ? enq.products
      : [{ grade: enq.grade, quantityText: String(enq.quantity || "") }];
    return requested.map((product) => ({
      grade: product.grade,
      quantityText: product.quantityText,
      buyPrice: "",
      supplierId: "",
      supplierEdited: false,
    }));
  });
  const reasons = lostReasonsFor(state).filter((reason) => reason.active);
  const [reasonId, setReasonId] = useState(reasons[0]?.id ?? "");
  const [groupNote, setGroupNote] = useState("");
  const [privateNote, setPrivateNote] = useState("");
  const [complianceChecked, setComplianceChecked] = useState(false);
  const [creditChecked, setCreditChecked] = useState(false);
  const complete =
    rows.length > 0 &&
    rows.every(
      (row) =>
        suppliers.some((supplier) => supplier.id === row.supplierId) &&
        parseProductQuantity(row.quantityText) &&
        row.buyPrice.trim() &&
        Number.isFinite(Number(row.buyPrice)) &&
        Number(row.buyPrice) > 0,
    );
  const resetChecks = () => {
    setComplianceChecked(false);
    setCreditChecked(false);
  };
  const updateRow = (
    index: number,
    field: "quantityText" | "buyPrice",
    value: string,
  ) => {
    resetChecks();
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, [field]: value } : row,
      ),
    );
  };
  const updateSupplier = (index: number, supplierId: string) => {
    resetChecks();
    setRows((current) => current.map((row, rowIndex) => {
      if (rowIndex === index) return { ...row, supplierId, supplierEdited: index !== 0 };
      // Keep explicit choices, including a user choosing the current default again.
      if (index === 0 && supplierId && !row.supplierEdited) return { ...row, supplierId };
      return row;
    }));
  };
  const supplierOptions = suppliers.map((supplier) => ({
    value: supplier.id,
    label: supplierName(supplier).toUpperCase(),
    keywords: [supplier.shortName, ...supplier.aliases, supplier.countryName, supplier.portName].join(" "),
  }));
  return (
    <Frame title={isFixture ? "STEM" : "LOST"} close={close} wide={isFixture}>
      <form
        className="outcome-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (isFixture) {
            if (!complete || !complianceChecked || !creditChecked) return;
            if (
              run(
                {
                  type: "record-stem",
                  id: enq.id,
                  products: rows.map((row) => ({
                    grade: row.grade,
                    supplierId: row.supplierId,
                    quantityText: row.quantityText,
                    buyPrice: Number(row.buyPrice),
                  })),
                  privateNote,
                  complianceChecked,
                  creditChecked,
                },
                "STEM saved.",
                { suppliers: suppliers.map(supplier => ({ id: supplier.id, name: supplier.legalName })) },
              )
            )
              close();
          } else if (
            reasons.some((reason) => reason.id === reasonId) &&
            run(
              {
                type: "record-loss",
                id: enq.id,
                reasonId,
                groupNote,
                privateNote,
              },
              "Lost record saved.",
            )
          )
            close();
        }}
      >
        {isFixture ? (
          <>
            {supplierCatalog.loading ? <p role="status">Loading suppliers…</p> : supplierCatalog.error ? <div role="alert">{supplierCatalog.error}<button type="button" className="button secondary" onClick={supplierCatalog.refresh}>Retry</button></div> : !suppliers.length ? <p role="status">No suppliers available.</p> : null}
            {rows.map((row, index) => (
              <section key={row.grade} className="fixture-product">
                <h3>{row.grade}</h3>
                <div className="fixture-product__fields">
                  <Field label="Supplier">
                    <SearchableSelect
                      label={`${row.grade} supplier`}
                      disabled={supplierCatalog.loading || Boolean(supplierCatalog.error) || !suppliers.length}
                      value={row.supplierId}
                      options={supplierOptions}
                      onChange={(value) => updateSupplier(index, value)}
                    />
                  </Field>
                  <Field label="Quantity (MT)">
                    <input
                      type="text"
                      required
                      aria-label={`${row.grade} quantity (MT)`}
                      value={row.quantityText}
                      onChange={(event) =>
                        updateRow(index, "quantityText", event.target.value)
                      }
                    />
                  </Field>
                  <Field label="Buy price (USD / MT)">
                    <input
                      type="number"
                      min="0.01"
                      step="any"
                      required
                      aria-label={`${row.grade} buy price (USD / MT)`}
                      value={row.buyPrice}
                      onChange={(event) =>
                        updateRow(index, "buyPrice", event.target.value)
                      }
                    />
                  </Field>
                </div>
              </section>
            ))}
          </>
        ) : (
          <>
            <Field label="Reason">
              <select
                aria-label="Reason"
                value={reasonId}
                required
                onChange={(event) => setReasonId(event.target.value)}
              >
                {!reasons.length && <option value="">—</option>}
                {reasons.map((reason) => (
                  <option key={reason.id} value={reason.id}>
                    {reason.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Group note">
              <textarea
                rows={3}
                value={groupNote}
                onChange={(event) => setGroupNote(event.target.value)}
              />
            </Field>
          </>
        )}
        <Field label="Private note">
          <textarea
            rows={3}
            value={privateNote}
            onChange={(event) => setPrivateNote(event.target.value)}
          />
        </Field>
        {isFixture && (
          <div className="form-grid outcome-checks">
            <label className="check-label">
              <input
                type="checkbox"
                checked={complianceChecked}
                onChange={(event) => setComplianceChecked(event.target.checked)}
              />
              Compliance
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={creditChecked}
                onChange={(event) => setCreditChecked(event.target.checked)}
              />
              Credit
            </label>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={
              isFixture
                ? !complete || !complianceChecked || !creditChecked
                : !reasons.some((reason) => reason.id === reasonId)
            }
          >
            Save
          </button>
        </div>
      </form>
    </Frame>
  );
}

function ContributionForm({
  spec,
  close,
}: {
  spec: Extract<ModalSpec, { type: "contribute" }>;
  close: Close;
}) {
  const { state, runKnowledge } = useDemo();
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [source, setSource] = useState("");
  if (spec.targetType === "feedback") return <Frame title="Feedback for ecosystem" close={close}><FeedbackPortal /></Frame>;
  const target = spec.targetType === "port" ? state.ports.find(p => p.id === spec.targetId)?.name
    : spec.targetType === "company" ? state.companies.find(c => c.id === spec.targetId)?.name
    : spec.targetType === "country" ? spec.targetId : "Shared case study";
  return (
    <Frame
      title={spec.targetType === "country" ? "Contribute" : spec.targetType === "case-study" ? "Share a case study" : "Contribute your knowledge"}
      close={close}
    >
      <div className="contribution-reward">
        <span>{target}</span>
      </div>
      <form
        aria-busy={saving}
        inert={saving}
        onSubmit={async (e) => {
          e.preventDefault();
          if (saving) return;
          setSaving(true);
          try {
          if (
            await runKnowledge(
              {
                type: "submit-contribution",
                targetType: spec.targetType,
                targetId: spec.targetId,
                title,
                body: body + (source ? `\nSource: ${source}` : ""),
              },
              "Updated.",
            )
          )
            close();
          } finally { setSaving(false); }
        }}
      >
        <Field label="Title">
          <input
            required
            minLength={5}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Details">
          <textarea
            required
            minLength={30}
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        {<Field label="Source">
          <input value={source} onChange={(e) => setSource(e.target.value)} />
        </Field>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <KnowledgeUpdateButton type="submit" />
        </div>
      </form>
    </Frame>
  );
}
function ContributionReview({id,close}:{id:string;close:Close}) {
 const {state}=useDemo();const {item:c,error,refresh}=useLocationContribution(id,state.contributions.find(item=>item.id===id));
 if(!c)return <Frame title="Update details" close={close}>{error ? <p role="alert">{error} <button className="button secondary small" onClick={refresh}>Retry</button></p> : <p role="status">Loading update…</p>}</Frame>;
 return <Frame title="Update details" kicker={c.publication==='direct'?'UPDATED':c.status==='pending'?'PREVIOUS SUBMISSION':c.status.toUpperCase()} close={close}>
 <div className="request-summary"><strong>{c.title}</strong>{c.feedbackPage&&<p>Page: {c.feedbackPage.label}</p>}<p className="preserve">{c.body}</p>{c.source&&<p>Source: {c.source}</p>}<small>{actors.find(a=>a.id===c.author)?.name} · {time(c.publishedAt??c.createdAt)}</small></div>
 {c.knowledgeChange&&<KnowledgeComparison before={c.knowledgeChange.baseDocument} after={c.knowledgeChange.document}/>}
 {c.proposedKeyInfo&&<IntelligenceAmendment current={c.keyInfoBase} proposed={c.proposedKeyInfo}/>}
 </Frame>;
}

function ActualVolumeForm({ id, close }: { id: string; close: Close }) {
  const { state, actor, run } = useDemo();
  const outcome = state.outcomes.find((item) => item.id === id);
  const [quantity, setQuantity] = useState("");
  if (!outcome || outcome.owner !== actor.id || !isPendingOutcome(outcome))
    return null;
  return (
    <Frame title="Actual volume" close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (
            run(
              { type: "record-actual-volume", id, quantity: Number(quantity) },
              "Actual volume recorded.",
            )
          )
            close();
        }}
      >
        <Field label="Traded volume (MT)">
          <input
            type="number"
            min="0.000001"
            step="0.000001"
            required
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </Field>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Confirm
          </button>
        </div>
      </form>
    </Frame>
  );
}
function EnquiryDetail({
  id,
  close,
  open,
}: {
  id: string;
  close: Close;
  open: OpenModal;
}) {
  const { state, actor, run } = useDemo();
  const e = state.enquiries.find((e) => e.id === id)!;
  const outcome = state.outcomes.find((o) => o.enquiryId === id);
  const privateNote = outcome
    ? getOutcomePrivateNote(state, outcome.id, actor.id)
    : "";
  return (
    <Frame title={e.vessel} kicker="ENQUIRY RECORD" close={close} wide>
      <div className="button-row">
        <Status value={e.status} />
        <span className="muted">
          {state.companies.find((c) => c.id === e.buyerId)?.name.toUpperCase()}
        </span>
      </div>
      <dl className="detail-list">
        <div>
          <dt>Port / delivery</dt>
          <dd>
            {state.ports.find((p) => p.id === e.portId)?.name} · {e.eta}
          </dd>
        </div>
        <div>
          <dt>Product / quantity</dt>
          <dd>
            {e.products?.length
              ? e.products
                  .map(
                    (product) =>
                      `${product.grade} · ${product.quantityText} MT`,
                  )
                  .join(" / ")
              : `${e.grade} · ${number(e.quantity)} MT`}
          </dd>
        </div>
        {outcome?.kind === "fixture" &&
          !isPendingOutcome(outcome) &&
          !outcome.products?.length && (
            <div>
              <dt>Sale price (USD / MT)</dt>
              <dd>{money(outcome.price)}</dd>
            </div>
          )}
      </dl>
      <h3 className="section-title">Formatted enquiry</h3>
      <pre className="enquiry-preview">{e.formattedText}</pre>
      <details className="original-message">
        <summary>Original message</summary>
        <pre>{e.rawText}</pre>
      </details>
      {e.amendments?.length ? (
        <details className="original-message">
          <summary>Amendments</summary>
          {e.amendments.map((amendment, index) => (
            <div key={`${amendment.at}-${index}`}>
              <strong>
                {time(amendment.at)} ·{" "}
                {actors.find((actor) => actor.id === amendment.by)?.name ??
                  amendment.by}
              </strong>
              <pre>{amendment.before.formattedText}</pre>
            </div>
          ))}
        </details>
      ) : null}
      {outcome?.stemProducts?.length ? (
        <section className="stem-record">
          <h3 className="section-title">STEM</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Grade</th>
                  <th>Supplier</th>
                  <th>Quantity (MT)</th>
                  <th>Buy price (USD / MT)</th>
                </tr>
              </thead>
              <tbody>
                {outcome.stemProducts.map((product) => (
                  <tr key={product.grade}>
                    <td>{product.grade}</td>
                    <td>{productSupplierName(outcome, product) || "—"}</td>
                    <td>{product.quantityText}</td>
                    <td>{money(product.buyPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {outcome?.products?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Quantity</th>
                <th>Price</th>
                <th>Margin</th>
                <th>Profit</th>
              </tr>
            </thead>
            <tbody>
              {outcome.products.map((product) => (
                <tr key={product.grade}>
                  <td>{product.grade}</td>
                  <td>{number(product.quantity)} MT</td>
                  <td>{money(product.price)}</td>
                  <td>{money(product.margin)}</td>
                  <td>{money(product.quantity * product.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {outcome && (
        <div className="notice blue vertical">
          <strong>
            {outcome.kind === "fixture" ? "STEM" : "LOST"} ·{" "}
            {date(outcome.bookedAt)}
          </strong>
          {outcome.reason && <span>{outcome.reason}</span>}
          {outcome.groupNote && (
            <div className="outcome-note">
              <strong>Group note</strong>
              <p>{outcome.groupNote}</p>
            </div>
          )}
          {outcome.kind === "fixture" && !isPendingOutcome(outcome) && (
            <span>
              Profit: {money(outcomeProfit(outcome))} ·{" "}
              {number(outcome.quantity)} MT × {money(outcome.margin)}/MT
            </span>
          )}
        </div>
      )}
      {privateNote && (
        <section className="outcome-note private-note">
          <h3>Private note</h3>
          <p>{privateNote}</p>
        </section>
      )}
      <div className="modal-actions">
        {outcome &&
          isPendingOutcome(outcome) &&
          outcome.owner === actor.id &&
          !outcome.actualVolume && (
            <button
              className="button primary"
              onClick={() => open({ type: "actual-volume", id: outcome.id })}
            >
              Actual volume
            </button>
          )}
        <button
          className="button secondary"
          onClick={() =>
            download(`${e.vessel}-enquiry.json`, { enquiry: e, outcome })
          }
        >
          <Download size={16} /> Export record
        </button>
        {canTrade(actor) && e.owner === actor.id && e.status === "draft" && (
          <button
            className="button primary"
            onClick={() =>
              run({ type: "confirm-enquiry", id }, "Enquiry confirmed.")
            }
          >
            Confirm
          </button>
        )}
        {canTrade(actor) && e.owner === actor.id && e.status === "sent" && (
          <>
            <button
              className="button secondary"
              onClick={() => open({ type: "outcome", id, kind: "lost" })}
            >
              LOST
            </button>
            <button
              className="button primary"
              onClick={() => open({ type: "outcome", id, kind: "fixture" })}
            >
              STEM
            </button>
          </>
        )}
      </div>
    </Frame>
  );
}
export default function Modals({
  spec,
  close,
  open,
  onContribute,
}: {
  spec: ModalSpec;
  close: Close;
  open: OpenModal;
  onContribute?: (destination: ContributionDestination) => void;
}) {
  const buyerCreditAvailable = useBuyerCreditAvailable();
  if (!buyerCreditAvailable && isBuyerCreditModal(spec)) {
    return <Frame title={spec.type === 'company' || spec.type === 'contribute' ? 'Buyer Profiles' : 'Credit Requests'} close={close}><ReleaseNotice /></Frame>;
  }
  switch (spec.type) {
    case "credit":
      return <CreditRequestForm spec={spec} close={close} />;
    case "decision":
      return <DecisionForm id={spec.id} close={close} />;
    case "outcome":
      return <OutcomeForm spec={spec} close={close} />;
    case "company":
      return <CompanyForm name={spec.name} close={close} />;
    case "contribute":
      return <ContributionForm spec={spec} close={close} />;
    case "review-contribution":
      return <ContributionReview id={spec.id} close={close} />;
    case "actual-volume":
      return <ActualVolumeForm id={spec.id} close={close} />;
    case "resources":
      return (
        <Frame title="Contribution Activity" close={close} wide>
          <ResourceWallet onContribute={onContribute} />
        </Frame>
      );
    case "enquiry-detail":
      return <EnquiryDetail id={spec.id} close={close} open={open} />;
  }
}
