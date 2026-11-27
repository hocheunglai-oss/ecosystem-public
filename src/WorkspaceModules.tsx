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
import { useAccess } from './auth';
import { ContributionPage } from "./OperationsPages";
import type { OpenModal } from "./types";
import type { OpenWorkspace, WorkspaceId, WorkspaceNavigationContext } from "./workspaceNavigation";
export type { WorkspaceId } from "./workspaceNavigation";

export { workspaceTitles } from "./workspaceNavigation";

type Props = {
  id: WorkspaceId;
  visible: boolean;
  open: OpenModal;
  onOpen: OpenWorkspace;
  context?: WorkspaceNavigationContext;
  onAdminOperationPending?: (reference: string | null) => void;
};

export function WorkspaceModule({ id, visible, open, onOpen, context, onAdminOperationPending }: Props) {
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

    case "counterparties":
      content = <BuyerProfileDirectory open={open} initialBuyerId={context?.buyerId} />;
      break;
    case "feedback":
      content = <FeedbackWorkspace />;
      break;
    case "ports":
    case "countries":
      content = <LocationWorkspace visible={visible} open={open} onOpen={onOpen} context={context} />;
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
  const { developerMode } = useTestWorkspace();
  const [tab, setTab] = useState<
    'personal' | 'privacy' | 'users' | 'lost-reasons' | 'administration' | 'contribution'
  >('personal');
  const [pendingReference, setPendingReference] = useState<string | null>(null);
  const onPendingChange = useCallback((reference: string | null) => {
    setPendingReference(reference); onAdminOperationPending?.(reference);
  }, [onAdminOperationPending]);
  if (!user) return null;
  const accountTabs = [['personal', 'Personal details'], ['privacy', 'Privacy']] as const;
  const adminTabs = [['users', 'User Management'], ['lost-reasons', 'Lost reasons'], ['administration', 'Administration'], ['contribution', 'Contribution']] as const;
  const visibleAdminTabs = user.isAdmin && !preview ? adminTabs.filter(([id]) => id !== 'contribution' || developerMode) : [];
  const selectedTab = [...accountTabs, ...visibleAdminTabs].some(([id]) => id === tab) ? tab : 'personal';
  function tabButton([id, label]: (typeof accountTabs | typeof adminTabs)[number]) {
    return <button key={id} type="button" disabled={Boolean(pendingReference)} className={selectedTab === id ? 'active' : ''}
      aria-current={selectedTab === id ? 'page' : undefined} onClick={() => setTab(id)}>
      {id === 'administration' && <History size={15} aria-hidden="true" />}{label}
    </button>;
  }
  return (
    <>
      <div className="module-settings-toolbar">
        <nav className="tabs settings-nav" aria-label="Settings">
          <div className="settings-nav-group">{accountTabs.map(tabButton)}</div>
          {visibleAdminTabs.length > 0 && <div className="settings-nav-group">{visibleAdminTabs.map(tabButton)}</div>}
        </nav>
      </div>
      {selectedTab === 'personal' && <div className="personal-settings">
        <PersonalDetails />
        <section className="personal-password" aria-labelledby="password-heading"><h2 id="password-heading">Change password</h2><PasswordSettings /></section>
      </div>}
      {selectedTab === 'privacy' && <PrivacyDetails />}
      {selectedTab === 'users' && <UsersAccess onPendingChange={onPendingChange} />}
      {selectedTab === 'lost-reasons' && <LostReasonSettings />}
      {selectedTab === 'administration' && <Administration />}
      {selectedTab === 'contribution' && <ContributionPage open={open} />}
    </>
  );
}
