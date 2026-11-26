import { ReleaseNotice, useBuyerCreditAvailable } from './ReleaseGate';
import { isBuyerCreditWorkspace } from '../shared/ecoRelease';
import LocationWorkspace from "./LocationWorkspace";
import { CreditWorkspace } from "./CreditRecords";
import SupplierWorkspace from "./SupplierWorkspace";
import { useCallback, useState } from "react";
import {
  ArrowLeft,
  History,
} from "lucide-react";
import EnquiryPage from "./EnquiryPage";
import RecordsPage from "./RecordsPage";
import { LiveLostRecords } from "./LiveLostRecords";
import { useTestWorkspace } from "./TestWorkspace";
import FixtureHistory from "./FixtureHistory";
import { BuyerProfileDirectory } from "./BuyerProfile";
import LostReasonSettings from "./LostReasonSettings";
import UsersAccess from './UsersAccess';
import Administration, { FeedbackWorkspace } from './Administration';
import { PasswordSettings } from './PasswordSettings';
import PrivacyDetails from './PrivacyDetails';
import { PersonalDetails } from './ProfileMenu';
import { useWaterBackground, type WaterBackground } from './backgroundPreference';
import { useAccess } from './auth';
import {
  ManagementPage,
} from "./OperationsPages";
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

export function WorkspaceModule({ id, open, onOpen, context, onAdminOperationPending }: Props) {
  const buyerCreditAvailable = useBuyerCreditAvailable();
  const { dataMode } = useTestWorkspace();
  if (isBuyerCreditWorkspace(id) && !buyerCreditAvailable) return <ReleaseNotice />;
  let content;
  switch (id) {
    case "enquiry":
      content = <EnquiryPage open={open} onOpen={onOpen} context={context} />;
      break;
    case "fixtures":
      content = <FixtureHistory open={open} />;
      break;
    case "lost":
      content = dataMode === "live" ? <LiveLostRecords onOpen={onOpen} /> : <RecordsPage open={open} kind="lost" />;
      break;
    case "ports":
      content = <LocationWorkspace open={open} onOpen={onOpen} context={context} />;
      break;
    case "counterparties":
      content = <BuyerProfileDirectory open={open} initialBuyerId={context?.buyerId} />;
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

function SettingsWorkspace({ open, onAdminOperationPending }: { open: OpenModal; onAdminOperationPending?: (reference: string | null) => void }) {
  const { user, preview } = useAccess();
  const { background, chooseBackground, canChooseBackground } = useWaterBackground();
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
      {tab === 'password' ? <div className="personal-settings"><div className="personal-display-settings"><PersonalDetails /><label className="background-choice">
        <span>Background</span>
        <select aria-label="Background" value={background} disabled={!canChooseBackground} onChange={event => chooseBackground(event.target.value as WaterBackground)}>
          <option value="watercolour">Watercolour</option>
          <option value="diffuse">Diffuse</option>
        </select>
      </label></div><section className="personal-password" aria-label="Change password"><h2>Change password</h2><PasswordSettings /></section></div> : tab === 'privacy' ? <PrivacyDetails /> : !user.isAdmin || preview ? null : tab === 'users' ? <UsersAccess onPendingChange={onPendingChange} /> : tab === "management" ? (
        <ManagementPage open={open} />
      ) : tab === "lost-reasons" ? (
        <LostReasonSettings />
      ) : (
        <Administration />
      )}
    </>
  );
}
