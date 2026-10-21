import { ReleaseNotice, useBuyerCreditAvailable } from './ReleaseGate';
import { isBuyerCreditWorkspace } from '../shared/ecoRelease';
import LocationWorkspace from "./LocationWorkspace";
import { CreditWorkspace } from "./CreditRecords";
import SupplierWorkspace from "./SupplierWorkspace";
import { useCallback, useState } from "react";
import {
  ArrowLeft,
  History,
  Plus,
} from "lucide-react";
import EnquiryPage from "./EnquiryPage";
import RecordsPage from "./RecordsPage";
import { BuyerProfileDirectory } from "./BuyerProfile";
import LostReasonSettings from "./LostReasonSettings";
import UsersAccess from './UsersAccess';
import Administration, { FeedbackWorkspace } from './Administration';
import { PasswordSettings } from './PasswordSettings';
import PrivacyDetails from './PrivacyDetails';
import { PersonalDetails } from './ProfileMenu';
import { useAccess } from './auth';
import {
  ManagementPage,
} from "./OperationsPages";
import { useDemo } from "./store";
import {
  actors,
  isAdmin,
  type Contribution,
} from "./lib/model";
import {
  Empty,
  Field,
  SearchBox,
  Status,
  time,
} from "./ui";
import type { OpenModal } from "./types";
import type { OpenWorkspace, WorkspaceId, WorkspaceNavigationContext } from "./workspaceNavigation";
export type { WorkspaceId } from "./workspaceNavigation";

export { workspaceTitles } from "./workspaceNavigation";

type Props = {
  id: WorkspaceId;
  open: OpenModal;
  onOpen: OpenWorkspace;
  context?: WorkspaceNavigationContext;
  onAdminOperationPending?: (reference: string | null) => void;
};

const actorName = (id: string) =>
  actors.find((person) => person.id === id)?.name ?? id;
const includes = (query: string, ...values: (string | undefined)[]) =>
  values.join(" ").toLowerCase().includes(query.trim().toLowerCase());

export function WorkspaceModule({ id, open, onOpen, context, onAdminOperationPending }: Props) {
  const buyerCreditAvailable = useBuyerCreditAvailable();
  if (isBuyerCreditWorkspace(id) && !buyerCreditAvailable) return <ReleaseNotice />;
  let content;
  switch (id) {
    case "enquiry":
      content = <EnquiryPage open={open} onOpen={onOpen} context={context} />;
      break;
    case "fixtures":
      content = <RecordsPage open={open} kind="fixture" />;
      break;
    case "lost":
      content = <RecordsPage open={open} kind="lost" />;
      break;
    case "ports":
      content = <LocationWorkspace open={open} onOpen={onOpen} context={context} />;
      break;
    case "counterparties":
      content = <BuyerProfileDirectory open={open} initialBuyerId={context?.buyerId} />;
      break;
    case "contribute":
      content = <ContributionLibrary open={open} />;
      break;
    case "feedback":
      content = <FeedbackWorkspace />;
      break;
    case "countries":
      content = <LocationWorkspace open={open} onOpen={onOpen} context={context} />;
      break;
    case "singapore-suppliers":
      content = <SupplierWorkspace open={open} onOpen={onOpen} context={context} singapore />;
      break;
    case "suppliers":
      content = <SupplierWorkspace open={open} onOpen={onOpen} context={context} />;
      break;
    case "credit-request":
      content = <CreditWorkspace open={open} onOpen={onOpen} initialAttentionOnly={context?.attentionOnly} navigationContext={context} />;
      break;
    case "settings":
      content = <SettingsWorkspace open={open} onAdminOperationPending={onAdminOperationPending} />;
      break;
  }
  return (
    <div className={`workspace-module workspace-module-${id}`}>
      {context?.returnTo && context.returnTo !== id && ["ports", "countries"].includes(id) && (
        <button className="button secondary workspace-return" onClick={() => onOpen(context.returnTo!, context.returnTo !== "enquiry" ? { portId: context.portId, returnTo: context.returnTo } : undefined)}>
          <ArrowLeft size={16} /> {context.returnTo !== "enquiry" ? "Countries & Ports" : "Enquiries"}
        </button>
      )}
      {content}
    </div>
  );
}

function ContributionLibrary({ open }: { open: OpenModal }) {
  const { state } = useDemo();
  const [targetType, setTargetType] = useState<"port" | "country">("port");
  const [portId, setPortId] = useState(state.ports[0]?.id ?? "");
  const countries = [
    ...new Set(state.ports.map((port) => port.country)),
  ].sort();
  const [country, setCountry] = useState(countries[0] ?? "");
  return (
    <>
      <section className="card module-compose">
        <div className="form-grid">
          <Field label="Type">
            <select
              value={targetType}
              onChange={(event) =>
                setTargetType(event.target.value as "port" | "country")
              }
            >
              <option value="port">Port</option>
              <option value="country">Country</option>
            </select>
          </Field>
          {targetType === "port" ? (
            <Field label="Port">
              <select
                value={portId}
                onChange={(event) => setPortId(event.target.value)}
              >
                {state.ports.map((port) => (
                  <option key={port.id} value={port.id}>
                    {port.name} · {port.country}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Country">
              <select
                value={country}
                onChange={(event) => setCountry(event.target.value)}
              >
                {countries.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <button
          className="button primary"
          onClick={() =>
            open({
              type: "contribute",
              targetType,
              targetId: targetType === "port" ? portId : country,
            })
          }
        >
          <Plus size={17} /> Contribute
        </button>
      </section>
      <ContributionRecords open={open} feedback={false} />
    </>
  );
}

function ContributionRecords({
  open,
  feedback,
}: {
  open: OpenModal;
  feedback: boolean;
}) {
  const { state, actor } = useDemo();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("all");
  const items = state.contributions.filter(
    (item) =>
      (feedback
        ? item.targetType === "feedback"
        : item.targetType === "port" || item.targetType === "country") &&
      (scope === "all" || item.author === actor.id) &&
      (status === "all" || item.status === status) &&
      includes(query, item.title, item.body, item.feedbackPage?.label, actorName(item.author)),
  );
  const targetName = (item: Contribution) =>
    item.targetType === "port"
      ? state.ports.find((port) => port.id === item.targetId)?.name
      : item.targetType === "country"
        ? item.targetId
        : item.targetType === "feedback" ? item.feedbackPage?.label : null;
  return (
    <section className="card">
      <div className="directory-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="Search" />
        <select
          aria-label="Contribution author"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="all">Everyone</option>
          <option value="mine">Mine</option>
        </select>
        <select
          aria-label="Contribution status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="all">All statuses</option>
          <option value="approved">Published</option>
          <option value="pending">Previous submissions</option>
          <option value="declined">Declined</option>
        </select>
      </div>
      {items.length ? (
        <div className="review-list">
          {items.map((item) => (
            <article className="review-item" key={item.id}>
              <div className="review-item-head">
                <div>
                  {targetName(item) && (
                    <div className="eyebrow">{targetName(item)}</div>
                  )}
                  <h3>{item.title}</h3>
                </div>
                <Status value={item.publication === "direct" ? "updated" : item.status} />
              </div>
              <p className="module-preserve-lines">{item.body}</p>
              <div className="review-meta">
                <small>
                  {actorName(item.author)} · {time(item.createdAt)}
                </small>
              </div>
              {item.reviewedAt && (
                <p className="source-note">
                  {actorName(item.reviewer ?? "")} · {time(item.reviewedAt)}
                </p>
              )}

            </article>
          ))}
        </div>
      ) : (
        <Empty title="No records" />
      )}
    </section>
  );
}

function SettingsWorkspace({ open, onAdminOperationPending }: { open: OpenModal; onAdminOperationPending?: (reference: string | null) => void }) {
  const { user, preview } = useAccess();
  const [tab, setTab] = useState<
    "users" | "management" | "administration" | "lost-reasons" | "password" | "privacy"
  >(user?.isAdmin ? "users" : "password");
  const [pendingReference, setPendingReference] = useState<string | null>(null);
  const onPendingChange = useCallback((reference: string | null) => {
    setPendingReference(reference); onAdminOperationPending?.(reference);
  }, [onAdminOperationPending]);
  if (!user) return null;
  return (
    <>
      <div className="module-settings-toolbar">
        <div className="tabs" aria-label="Settings">
          <button disabled={Boolean(pendingReference)} className={tab === "password" ? "active" : ""} onClick={() => setTab("password")}>Personal details</button>
          <button disabled={Boolean(pendingReference)} className={tab === 'privacy' ? 'active' : ''} onClick={() => setTab('privacy')}>Privacy</button>
          {user.isAdmin && !preview && <>
          <button disabled={Boolean(pendingReference)} className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Users &amp; Access</button>
          <button
            disabled={Boolean(pendingReference)}
            className={tab === "management" ? "active" : ""}
            onClick={() => setTab("management")}
          >
            Management
          </button>
          <button
            disabled={Boolean(pendingReference)}
            className={tab === "lost-reasons" ? "active" : ""}
            onClick={() => setTab("lost-reasons")}
          >
            Lost reasons
          </button>
          <button
            disabled={Boolean(pendingReference)}
            className={tab === "administration" ? "active" : ""}
            onClick={() => setTab("administration")}
          >
            <History size={15} /> Administration
          </button>
          </>}
        </div>
      </div>
      {tab === 'password' ? <div className="personal-settings"><PersonalDetails /><section className="personal-password" aria-label="Change password"><h2>Change password</h2><PasswordSettings /></section></div> : tab === 'privacy' ? <PrivacyDetails /> : !user.isAdmin || preview ? null : tab === 'users' ? <UsersAccess onPendingChange={onPendingChange} /> : tab === "management" ? (
        <ManagementPage open={open} />
      ) : tab === "lost-reasons" ? (
        <LostReasonSettings />
      ) : (
        <Administration />
      )}
    </>
  );
}
