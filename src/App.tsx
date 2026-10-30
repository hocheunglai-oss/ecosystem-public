import { useLocationActivity } from './lib/useLocationActivity';
import KnowledgeUpdateButton from './KnowledgeUpdateButton';
import { useBuyerCreditAvailable } from './ReleaseGate';
import { ECO_2_RELEASE_NOTICE, isBuyerCreditWorkspace } from '../shared/ecoRelease';
import { useSharedFeedback } from './lib/useSharedFeedback';
import {
  useEffect,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  ArrowUpRight,
  ArrowRight,
  X,
  Settings2,
  CheckCircle2,
  AlertCircle,
  Maximize2,
  Minimize2,
  MessageSquare,
} from "lucide-react";
import { DemoProvider, useDemo } from "./store";
import "./test-workspace.css";
import { TestWorkspaceControl, TestWorkspaceProvider, useTestWorkspace } from "./TestWorkspace";
import { InboxProvider, useInbox } from "./inbox";
import { GlobalSearch } from "./GlobalSearch";
import { creditAttentionRequestIds } from "./lib/creditWorkflow";
import { InboxBanner, InboxMenu } from "./InboxMenu";
import {
  teamForActor,
  canTrade,
  isAdmin,
} from "./lib/model";
import { resourceNumber as number } from "./ui";
import { ResourceIcon, ResourceWallet, useActivityNow } from "./ResourceWallet";
import { HatsOffPanel, hatsPreviewCounts, type HatsAppearancePreview } from "./HatsOffPanel";
import { canPreviewAppearance } from "../shared/appearancePreview";
import { hatCount } from "./lib/hats";
import { contributionActivity, contributionPreviewCounts, contributionStatus, type ContributionStatusKey } from "./lib/contributionActivity";
import { ProfileMenu } from "./ProfileMenu";
import { FlowingWaterBackground } from "./FlowingWaterBackground";
import { useWaterBackground, type WaterBackgroundControl } from './backgroundPreference';
import { useMobileInterface } from "./mobile";
import {
  WorkspaceModule,
  type WorkspaceId,
} from "./WorkspaceModules";
import { IntelligenceProvider } from "./Intelligence";
import { AccessProvider, useAccess } from './auth';
import { PhoneChangeRequestsProvider } from './PhoneChangeRequests';
import { AccessLogin } from './AccessLogin';
import { PasswordSuggestion } from './PasswordSettings';
import { RolePreview, RolePreviewBanner } from './RolePreview';
import Modals from "./Modals";
import type { ModalSpec, OpenModal } from "./types";
import { trapDialogFocus } from "./dialogFocus";
import { useTheme } from "./theme";
import { ThemeToggle } from './ThemeToggle';
import { workspaceGroups as groups, workspaceTitles, type OpenWorkspace, type WorkspaceNavigationContext } from "./workspaceNavigation";

const roleLabel = (role: string) =>
  role === "admin"
    ? "Admin"
    : role === "manager"
      ? "Manager"
      : role === "credit"
        ? "Credit"
        : "Trader";

function Logo() {
  return (
    <span className="ecosystem-logo">
      <svg
        viewBox="0 0 1712 222"
        width={1712}
        height={222}
        role="img"
        aria-label="ECOSYSTEM"
        focusable="false"
        style={{ display: "block", width: "100%", height: "auto" }}
      >
        <image href="/logo-transparent.png" width="1712" height="222" />
      </svg>
    </span>
  );
}

function Brand() {
  return (
    <div className="brand-lockup">
      <Logo />
      <svg
        className="brand-tagline"
        viewBox="0 0 600 28"
        role="img"
        aria-label="FRATELLI COSULICH MARINE ENERGY"
      >
        <text x="0" y="21" textLength="600" lengthAdjust="spacing">
          FRATELLI COSULICH MARINE ENERGY
        </text>
      </svg>
    </div>
  );
}

function Login() {
  return (
    <main className="entry-screen">
      <header className="entry-brand">
        <Brand />
      </header>
      <AccessLogin />
    </main>
  );
}

function TraderHud({
  onOpen,
  onSignOut,
  mobile,
}: {
  mobile: boolean;
  onOpen: (id: WorkspaceId) => void;
  onSignOut: () => void;
}) {
  const { actor, state } = useDemo();
  const { user, realUser, previewPerson } = useAccess();
  const [accountPanel, setAccountPanel] = useState<"inbox" | "hats" | "activity" | null>(null);
  const [contributionPreview, setContributionPreview] = useState<ContributionStatusKey | null>(null);
  const [hatsPreview, setHatsPreview] = useState<HatsAppearancePreview | null>(null);
  const canPreview = canPreviewAppearance(realUser);
  const [panelTarget, setPanelTarget] = useState<HTMLDivElement | null>(null);
  const panelToggle = useRef<HTMLButtonElement | null>(null);
  const activityPanel = useRef<HTMLElement | null>(null);
  const closePanel = useCallback(() => { setAccountPanel(null); setContributionPreview(null); setHatsPreview(null); panelToggle.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (accountPanel !== "hats" && accountPanel !== "activity") return;
    // Safari does not necessarily focus clicked buttons. Escape must also work
    // after opening the panel with a mouse or touch, when focus remains outside it.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closePanel();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [accountPanel, closePanel]);
  const togglePanel = (panel: NonNullable<typeof accountPanel>, button: HTMLButtonElement) => {
    panelToggle.current = button;
    setContributionPreview(null); setHatsPreview(null);
    setAccountPanel(current => current === panel ? null : panel);
  };
  const activityNow = useActivityNow();
  const sharedLocations = useLocationActivity(actor.id, "7d", activityNow);
  const localActivity = sharedLocations.activity;
  const { summary: sharedFeedback, status: feedbackStatus } = useSharedFeedback();
  const sharedFeedbackStatus = feedbackStatus === 'unavailable' || sharedLocations.status === 'unavailable' ? 'unavailable' : feedbackStatus === 'loading' || sharedLocations.status === 'loading' ? 'loading' : 'ready';
  const activity = { ...localActivity, total: localActivity.total + (sharedFeedback?.count ?? 0) };
  const showContribution = user?.officeId !== "CREDIT";
  const visiblePreview = canPreview && accountPanel === "activity" ? contributionPreview : null;
  const visibleHatsPreview = canPreview && !previewPerson && accountPanel === "hats" ? hatsPreview : null;
  const contributionTier = contributionStatus(visiblePreview ? contributionPreviewCounts[visiblePreview] : activity.total);
  const contributionIncomplete = !visiblePreview && (sharedFeedbackStatus !== 'ready' || sharedLocations.status !== 'ready');
  const contributionLabel = contributionIncomplete ? sharedFeedbackStatus === 'loading' ? 'CHECKING' : 'UNAVAILABLE' : contributionTier.label;
  const hats = visibleHatsPreview ? hatsPreviewCounts[visibleHatsPreview] : hatCount(state, previewPerson?.id ?? actor.id);
  const team = teamForActor(actor);
  const admin = isAdmin(actor);
  const utilityActions = <>
    <InboxMenu onOpen={() => onOpen("enquiry")} presentation={{
      inline: true, target: panelTarget, expanded: accountPanel === "inbox",
      onExpandedChange: (expanded) => setAccountPanel(expanded ? "inbox" : null),
    }} />
    {<button
      className="hud-settings"
      aria-label="Settings"
      onClick={() => { setAccountPanel(null); onOpen("settings"); }}
    >
      <Settings2 size={18} />
    </button>}
  </>;
  return (
    <aside
      className="trader-hud"
      data-trader-hud
      aria-label="Your dashboard"
      data-role={actor.role}
      onKeyDown={event => {
        if (event.key === "Escape" && accountPanel && accountPanel !== "inbox") {
          event.stopPropagation();
          closePanel();
        }
      }}
    >
      <header className="hud-header">
        <div className="hud-identity">
          <strong>{actor.name.toUpperCase()}</strong>
          <span>{roleLabel(admin ? 'admin' : actor.role)}{team ? ` · ${team.name}` : ""}</span>
        </div>
        <div className="hud-header-actions">
          <ProfileMenu key={actor.id} onSignOut={onSignOut} />
          {!mobile && utilityActions}
        </div>
      </header>
      <div className="hud-points-row">
        {showContribution && <button
          className="hud-resource hud-resource-activity"
          data-resource="activity"
          aria-label={`Contribution: ${contributionLabel}${visiblePreview ? ". Appearance preview" : contributionIncomplete ? `. ${number(localActivity.total)} local contributions in the last 7 days. Shared contribution count ${sharedFeedbackStatus === 'loading' ? 'pending' : 'unavailable'}` : `. ${number(activity.total)} in the last 7 days`}`}
          title="CONTRIBUTION ACTIVITY"
          aria-expanded={accountPanel === "activity"}
          aria-controls={accountPanel === "activity" ? "hud-contribution-activity" : undefined}
          onClick={event => togglePanel("activity", event.currentTarget)}
        >
          <span>Contribution</span>
          <strong className="contribution-tier" data-tier={contributionIncomplete ? sharedFeedbackStatus : contributionTier.key}>{contributionLabel}</strong>
        </button>}
        <button
          type="button"
          className="hud-resource hud-resource-hats"
          data-resource="hat"
          aria-label={`Hats off: ${number(hats)} hats received${visibleHatsPreview ? ". Appearance preview" : ""}`}
          title="HATS OFF"
          aria-expanded={accountPanel === "hats"}
          aria-controls={accountPanel === "hats" ? "hud-hats-off" : undefined}
          onClick={event => togglePanel("hats", event.currentTarget)}
          onKeyDown={(event) => { if (event.key === "Escape") closePanel(); }}
        >
          <ResourceIcon kind="hat" size={21} />
          <strong>{number(hats)}</strong>
        </button>
        {mobile && utilityActions}
      </div>
      <div className="account-inline-slot" ref={setPanelTarget}>
        {accountPanel === "hats" && <section id="hud-hats-off" className="hud-hat-panel hud-inline-section" aria-label="Hats off"
          onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closePanel(); } }}>
          <header className="hud-inline-heading"><h2>Hats off</h2><button aria-label="Close hats off" onClick={closePanel}><X size={16} /></button></header>
          <div className="hud-inline-scroll"><HatsOffPanel preview={visibleHatsPreview} canPreview={canPreview}
            onPreviewChange={canPreview ? setHatsPreview : undefined} /></div>
        </section>}
        {showContribution && accountPanel === "activity" && <section ref={activityPanel} tabIndex={-1} id="hud-contribution-activity" className="hud-inline-section" aria-label="Contribution activity panel"
          onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closePanel(); } }}>
          <header className="hud-inline-heading"><h2>Contribution</h2><button aria-label="Close contribution activity" onClick={closePanel}><X size={16} /></button></header>
          <div className="hud-inline-scroll"><ResourceWallet statusPreview={visiblePreview}
            onStatusPreviewChange={canPreview ? setContributionPreview : undefined} /></div>
        </section>}
      </div>
    </aside>
  );
}

function WorkspaceWindow({
  active,
  contexts,
  open,
  onOpen,
  onClose,
  themeControl,
  backgroundControl,
  pendingAdminRequest,
  onAdminOperationPending,
}: {
  themeControl: { requested: 'light' | 'dark'; pending: boolean; error: string; toggle: () => void };
  backgroundControl: WaterBackgroundControl;
  active: WorkspaceId | null;
  contexts: Partial<Record<WorkspaceId, WorkspaceNavigationContext | undefined>>;
  open: OpenModal;
  onOpen: OpenWorkspace;
  onClose: () => void;
  pendingAdminRequest: string | null;
  onAdminOperationPending: (reference: string | null) => void;
}) {
  const title = active ? workspaceTitles[active] : "Workspace";
  const ref = useRef<HTMLDialogElement>(null);
  const [visited, setVisited] = useState<WorkspaceId[]>([]);
  const [windowSizes, setWindowSizes] = useState<Partial<Record<WorkspaceId, boolean>>>({});
  const expanded = active ? windowSizes[active] ?? true : true;
  const contentRef = useRef<HTMLDivElement>(null);
  const backdropPress = useRef(false);
  const titleRef = useRef<HTMLElement>(null);
  const activeContext = active ? contexts[active] : undefined;
  useEffect(() => {
    const dialog = ref.current;
    if (active) {
      setVisited((ids) => (ids.includes(active) ? ids : [...ids, active]));
      if (!dialog?.open) dialog?.showModal();
      if (contentRef.current) contentRef.current.scrollTop = 0;
      titleRef.current?.focus({ preventScroll: true });
    } else dialog?.close();
  }, [active, activeContext]);
  useEffect(() => {
    const dialog = ref.current;
    return () => dialog?.close();
  }, []);
  useEffect(() => {
    if (!pendingAdminRequest || active !== "settings") return;
    // Disabled submit controls may move focus to BODY. Keep Escape from closing
    // the pending settings dialog even when the key does not bubble through it.
    const guardPendingEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const openDialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
      if (openDialogs.at(-1) !== ref.current) return;
      event.preventDefault(); event.stopPropagation();
    };
    document.addEventListener("keydown", guardPendingEscape, true);
    return () => document.removeEventListener("keydown", guardPendingEscape, true);
  }, [active, pendingAdminRequest]);
  return (
    <dialog
      ref={ref}
      onKeyDown={event => {
        if (pendingAdminRequest && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); return; }
        trapDialogFocus(event);
      }}
      className={`workspace-window${expanded ? " is-expanded" : ""}`}
      data-window-size={expanded ? "expanded" : "compact"}
      aria-label={title}
      data-workspace={active}
      onPointerDown={event => {
        const box = event.currentTarget.getBoundingClientRect();
        backdropPress.current = event.target === event.currentTarget && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
      }}
      onPointerCancel={() => { backdropPress.current = false; }}
      onClick={event => {
        const box = event.currentTarget.getBoundingClientRect();
        const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
        if (backdropPress.current && event.target === event.currentTarget && outside) onClose();
        backdropPress.current = false;
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="window-toolbar">
        <div>
          <i className="live-dot" />
          <span>
            ECOSYSTEM <b>/</b>
          </span>
          <strong ref={titleRef} tabIndex={-1}>
            {title}
          </strong>
        </div>
        <div>
          <button
            type="button"
            className="window-tool"
            aria-label={expanded ? "Shrink window" : "Expand window"}
            title={expanded ? "Shrink window" : "Expand window"}
            onClick={() => { if (active) setWindowSizes(sizes => ({ ...sizes, [active]: !expanded })); }}
          >
            {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          <button
            type="button"
            className="window-tool window-close"
            aria-label="Close workspace"
            disabled={Boolean(pendingAdminRequest)}
            onClick={onClose}
          >
            <X size={23} />
          </button>
        </div>
      </header>
      <div className="workspace-preview-banner"><RolePreviewBanner /></div>
      <div ref={contentRef} className="window-content">
        {visited.map((id) => (
          <section className="workspace-module" key={id} hidden={active !== id}>
            <WorkspaceModule id={id} open={open} onOpen={onOpen} context={contexts[id]} backgroundControl={backgroundControl} onAdminOperationPending={onAdminOperationPending} />
          </section>
        ))}
      </div>
      <div className="window-foot"><span>ECOSYSTEM | FRATELLI COSULICH</span>
        <div className="window-foot-actions">
        <KnowledgeUpdateButton className="window-theme-toggle ecosystem-feedback" aria-label="Feedback for ecosystem" onClick={() => open({ type: "contribute", targetType: "feedback", targetId: "ecosystem" })}>
          <MessageSquare size={13} aria-hidden="true" /> Feedback for ecosystem
        </KnowledgeUpdateButton>
        <ThemeToggle className="window-theme-toggle" theme={themeControl.requested} onToggle={themeControl.toggle} pending={themeControl.pending} error={themeControl.error} />
        <TestWorkspaceControl pending={Boolean(pendingAdminRequest)} /><RolePreview pending={Boolean(pendingAdminRequest)} />
        </div>
      </div>
    </dialog>
  );
}

function Workspace() {
  const mobile = useMobileInterface();
  const { background, chooseBackground } = useWaterBackground();
  const { requested, toggleTheme, pending: themePending, error: themeError } = useTheme({ marine: false, background: 'flowing' });
  const { actor, state, toast, storageWarning, notify } = useDemo();
  const { user: session, signOut: logOut } = useAccess();
  const { unreadCount: inboxUnreadCount } = useInbox();
  const unreadCount = canTrade(actor) ? inboxUnreadCount : 0;
  const buyerCreditAvailable = useBuyerCreditAvailable();
  const creditCount = buyerCreditAvailable ? creditAttentionRequestIds(state, actor).length : 0;
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [active, setActive] = useState<WorkspaceId | null>(null);
  const [workspaceContexts, setWorkspaceContexts] = useState<Partial<Record<WorkspaceId, WorkspaceNavigationContext | undefined>>>({});
  const [modal, setModal] = useState<ModalSpec | null>(null);
  const [pendingAdminRequest, setPendingAdminRequest] = useState<string | null>(null);
  const [motionEnabled, setMotionEnabled] = useState(
    () => !matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotionEnabled(!preference.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  function closeModal() {
    setModal(null);
  }
  async function signOut() {
    try { await logOut(); }
    catch (error) { notify(error instanceof Error ? error.message : 'Sign-out failed.', true); return; }
    setActive(null);
    setWorkspaceContexts({});
    setModal(null);
    setExpandedGroup(null);
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }
  function openWorkspace(id: WorkspaceId, context?: WorkspaceNavigationContext) {
    if (pendingAdminRequest && id !== "settings") { notify("Resolve the pending account request in Users & Access first.", true); return; }
    if (id === "countries") { id = "ports"; if (context?.country) context = { country: context.country }; }
    // Clone each request so even a previously visited detail follows the new link.
    setWorkspaceContexts((previous) => ({ ...previous, [id]: context ? { ...context } : undefined }));
    setActive(id);
  }
  // Existing detail actions keep their semantics while opening in the same workspace shell.
  function interceptLegacyLink(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>(
      'a[href^="#/"]',
    );
    if (!anchor) return;
    const [route, search] = anchor.getAttribute("href")!.replace(/^#\//, "").split("?");
    const destinations: Record<string, WorkspaceId> = {
      enquiry: "enquiry",
      companies: "counterparties",
      ports: "ports",
      credit: "credit-request",
      records: "fixtures",
      management: "settings",
      audit: "settings",
    };
    if (route && destinations[route]) {
      event.preventDefault();
      setModal(null);
      const portId = route === "ports" ? new URLSearchParams(search).get("port") : null;
      openWorkspace(destinations[route], portId ? { portId } : undefined);
    }
  }
  return (
    <div
      className={`immersive-app ${session ? "is-signed-in" : "is-entry"}`}
      data-design="flowing-water"
      data-motion={motionEnabled ? "on" : "off"}
      data-interface={mobile ? "mobile" : "desktop"}
      onClickCapture={interceptLegacyLink}
    >
      <FlowingWaterBackground background={background} paused={!motionEnabled || Boolean(active || modal)} />
      {!session ? (
        <Login />
      ) : (
        <main className="world-interface" aria-label="ECOSYSTEM workspace">
          {!active && <div className="home-preview-banner"><RolePreviewBanner /></div>}
          <div className="world-left">
            <header className="world-identity">
              <Brand />
            </header>
            <nav className="world-launcher" aria-label="Workspace navigation">
              <GlobalSearch open={setModal} onOpen={openWorkspace}/>
              {groups.map((group) => {
                const menuId = `menu-${group.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
                const deferred = group.items.some(item => isBuyerCreditWorkspace(item.id)) && !buyerCreditAvailable;
                if (deferred) return <div className="launcher-group launcher-group--deferred" data-group={group.name} key={group.name}>
                  <div className="lime-control launcher-toggle launcher-heading" role="heading" aria-level={2} aria-describedby={`${menuId}-release`}><span>{group.name}</span></div>
                  <p className="launcher-release-remark" id={`${menuId}-release`}>{ECO_2_RELEASE_NOTICE}</p>
                </div>;
                const expanded = expandedGroup === group.name;
                return (
                  <div
                    className={`launcher-group${expanded ? " is-open" : ""}`}
                    data-group={group.name}
                    key={group.name}
                  >
                    <button
                      className="lime-control launcher-toggle ui-button--entry"
                      aria-label={group.name}
                      aria-expanded={expanded}
                      aria-controls={menuId}
                      onClick={() =>
                        setExpandedGroup(expanded ? null : group.name)
                      }
                    >
                      <span>{group.name}</span>
                      <ArrowUpRight size={24} />
                    </button>
                    <div
                      className="launcher-expansion"
                      id={menuId}
                      inert={!expanded}
                      aria-hidden={!expanded}
                    >
                      <div className="launcher-menu">
                        {group.items.map((item, index) => {
                          const count = item.id === 'enquiry' ? unreadCount : item.id === 'credit-request' ? creditCount : 0;
                          return <div key={item.id} className="launcher-menu-row" style={{ "--item": index } as CSSProperties}>
                            <button className="launcher-link" aria-label={item.label} onClick={() => openWorkspace(item.id)}><span>{item.label}</span><ArrowRight size={17}/></button>
                            {count > 0 && <button className="launcher-count" title={item.id === 'enquiry' ? `${count} unread enquiries` : `${count} credit requests needing attention`} aria-label={item.id === 'enquiry' ? `${count} unread enquiries` : `${count} credit requests needing attention`} onClick={() => openWorkspace(item.id, item.id === 'enquiry' ? { unreadOnly: true } : { attentionOnly: true })}>{count > 99 ? '99+' : count}</button>}
                          </div>;
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </nav>
          </div>
          <div className="home-hud-stack">
            <TraderHud
              key={actor.id}
              mobile={mobile}
              onOpen={openWorkspace}
              onSignOut={signOut}
            />
            <InboxBanner onOpen={() => openWorkspace("enquiry")} />
          </div>
          <WorkspaceWindow
            key={actor.id}
            active={active}
            themeControl={{requested, pending: themePending, error: themeError, toggle: toggleTheme}}
            backgroundControl={{background, chooseBackground}}
            contexts={workspaceContexts}
            open={setModal}
            onOpen={openWorkspace}
            pendingAdminRequest={pendingAdminRequest}
            onAdminOperationPending={setPendingAdminRequest}
            onClose={() => { if (!pendingAdminRequest) setActive(null); }}
          />
          {modal && (
            <Modals spec={modal} close={closeModal} open={setModal} />
          )}
        </main>
      )}
      <footer className="flowing-footer">
      <span className="world-controls">ECOSYSTEM | FRATELLI COSULICH</span>
      <div className="home-display-controls">
        {session && <KnowledgeUpdateButton className="theme-toggle ecosystem-feedback" aria-label="Feedback for ecosystem" onClick={() => setModal({ type: "contribute", targetType: "feedback", targetId: "ecosystem" })}>
          <MessageSquare size={15} aria-hidden="true" /> Feedback for ecosystem
        </KnowledgeUpdateButton>}
        <ThemeToggle className="theme-toggle" theme={requested} onToggle={toggleTheme} pending={themePending} error={themeError} />
        {session && <><TestWorkspaceControl pending={Boolean(pendingAdminRequest)} /><RolePreview pending={Boolean(pendingAdminRequest)} /></>}
      </div>
      </footer>
      {storageWarning && (
        <div className="storage-warning" role="status">
          Browser storage is unavailable. Changes will last for this visit only.
        </div>
      )}
      {session && toast && (
        <div
          className={`toast${toast.error ? " error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
          {toast.message}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return <AccessProvider><TestWorkspaceProvider><AuthenticatedWorkspace /></TestWorkspaceProvider></AccessProvider>;
}

function AuthenticatedWorkspace() {
  const { namespace } = useTestWorkspace();
  const { user, realUser, preview, previewPerson } = useAccess();
  // Drop mounted dialogs, cached administrator tables, selections and in-flight
  // effects whenever the effective view or real access authority changes.
  const viewKey = realUser ? [realUser.id, realUser.isAdmin, realUser.isManager, realUser.isSpcTrader, realUser.officeId,
    preview?.role ?? 'real', preview?.officeId ?? '', previewPerson?.id ?? ''].join(':') : 'signed-out';
  return (
    <DemoProvider key={namespace} user={user}>
      <IntelligenceProvider>
      <PhoneChangeRequestsProvider key={viewKey}>
      <InboxProvider>
        <Workspace />
        {user && <PasswordSuggestion key={user.id} />}
      </InboxProvider>
      </PhoneChangeRequestsProvider>
      </IntelligenceProvider>
    </DemoProvider>
  );
}
