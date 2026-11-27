import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Bell, Mail, MessageCircle, X } from "lucide-react";
import { useInbox, type IncomingEnquiry, type InboxChannel } from "./inbox";
import { useDemo } from "./store";
import { canTrade } from "./lib/model";
import { incomingScenarios } from "./lib/incomingScenarios";
import { PhoneChangeRequestQueue, usePhoneChangeRequests } from './PhoneChangeRequests';
import BackupAlert from './BackupAlert';
import "./demo-scenarios.css";
import './inbox-notifications.css';

function preview(item: IncomingEnquiry) {
  return item.rawText.match(/^Vessel:[ \t]*([^\r\n]+)$/im)?.[1]?.trim()
    || item.subject?.trim() || item.rawText.split(/\r?\n/).find(line => line.trim())?.trim() || "Enquiry";
}
const source = (item: IncomingEnquiry, test: boolean) =>
  `${item.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}${test ? ' (demo)' : ''}`;
const arrivalTime = (value: string) =>
  new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

export function InboxMenu({ onOpen, expanded, setExpanded, target }: {
  onOpen: () => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  target: HTMLElement | null;
}) {
  const { actor } = useDemo();
  const { notifications, select, receiveDemo, dismiss, clearNotifications, testAvailable, unreadCount, loading, busy, error, retry, hasMore, loadMore } =
    useInbox();
  const { pendingCount } = usePhoneChangeRequests();
  const [scenarioChannel, setScenarioChannel] = useState<InboxChannel | null>(null);
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!expanded) setScenarioChannel(null); }, [expanded]);
  const unread = unreadCount + pendingCount;
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [expanded, setExpanded]);
  const contents = (
    <section id={panelId} className="inbox-dropdown account-inline-panel" aria-label="Notifications">
      <div className="inbox-heading">
        <h2>Notifications</h2>
        <div className="inbox-heading-actions">
          <button type="button" className="ui-button ui-button--secondary inbox-clear-all"
            disabled={busy || (!notifications.length && !unreadCount && !hasMore)}
            title="Clear all enquiry notifications" onClick={clearNotifications}>Clear all</button>
          <button type="button" className="ui-button ui-button--icon inbox-inline-close" aria-label="Close notifications" onClick={() => {
            setExpanded(false);
            toggle.current?.focus({ preventScroll: true });
          }}><X size={16} /></button>
        </div>
      </div>
      <PhoneChangeRequestQueue compact />
      <BackupAlert enabled={!testAvailable} />
      {testAvailable && canTrade(actor) && <div className="inbox-arrivals">
        <button type="button" aria-expanded={scenarioChannel === "whatsapp"} onClick={() => setScenarioChannel(value => value === "whatsapp" ? null : "whatsapp")}>
          <MessageCircle size={15} />
          WhatsApp (demo)
        </button>
        <button type="button" aria-expanded={scenarioChannel === "email"} onClick={() => setScenarioChannel(value => value === "email" ? null : "email")}>
          <Mail size={15} />
          Email (demo)
        </button>
      </div>}
      {testAvailable && scenarioChannel && canTrade(actor) && <section className="inbox-scenarios" aria-label="Enquiry scenarios">
        <header><strong>{scenarioChannel === "whatsapp" ? "WhatsApp" : "Email"} · Demo scenarios</strong><button type="button" aria-label="Close scenarios" onClick={() => setScenarioChannel(null)}><X size={14} /></button></header>
        {incomingScenarios.map(scenario => <button key={scenario.id} type="button" onClick={() => {
          receiveDemo(scenarioChannel, scenario.id);
          setScenarioChannel(null);
          setExpanded(false);
          toggle.current?.focus({ preventScroll: true });
        }}>{scenario.label}<ArrowUpRight size={13} /></button>)}
      </section>}
      <div className="inbox-list" aria-busy={loading || busy}>
        {error && <div className="inbox-message" role="alert"><span>{error}</span><button type="button" className="ui-button ui-button--secondary" disabled={loading || busy} onClick={retry}>Retry</button></div>}
        {loading && !notifications.length && <p role="status">Loading enquiries…</p>}
        {!loading && !error && !notifications.length && !hasMore && <p className="inbox-empty" role="status">No enquiry notifications.</p>}
        {notifications.length > 0 && <ul className="inbox-notifications">{notifications.map((item) => (
          <li className={`inbox-notification-row${item.read ? '' : ' is-unread'}`} key={item.id}>
            <button
              type="button"
              className={`inbox-item${item.read ? "" : " is-unread"}`}
              onClick={() => {
                select(item.id);
                setExpanded(false);
                onOpen();
              }}
            >
              <span className="inbox-source">
                <span>{item.channel === "whatsapp" ? <MessageCircle size={13} aria-hidden="true" /> : <Mail size={13} aria-hidden="true" />}{source(item, testAvailable)}</span>
                <time dateTime={item.receivedAt}>
                  {arrivalTime(item.receivedAt)}
                </time>
              </span>
              <strong className="inbox-preview">{preview(item)}</strong>
              <span className="inbox-sender" data-preserve-case={item.channel === "email" ? "" : undefined}>{item.sender}</span>
              <ArrowUpRight size={15} aria-hidden="true" />
            </button>
            <button
              className="ui-button ui-button--icon inbox-item-clear"
              type="button"
              disabled={busy}
              aria-label={`Clear notification for ${preview(item)}`}
              onClick={() => {
                dismiss(item.id);
                requestAnimationFrame(() => {
                  const next = target?.querySelector<HTMLButtonElement>(".inbox-item-clear");
                  (next ?? toggle.current)?.focus();
                });
              }}
            >
              <X size={15} />
            </button>
          </li>
        ))}</ul>}
        {hasMore && <button type="button" className="ui-button ui-button--secondary" disabled={loading || busy} onClick={loadMore}>Load more</button>}
      </div>
    </section>
  );

  return (
    <div className="enquiry-inbox">
      <button
        ref={toggle}
        className="inbox-toggle"
        type="button"
        aria-label={pendingCount ? `Notifications, ${pendingCount} phone change ${pendingCount === 1 ? 'request' : 'requests'} awaiting approval` : 'Notifications'}
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        onClick={() => setExpanded(!expanded)}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="inbox-count" aria-label={`${unread} unread`}>
            {unread}
          </span>
        )}
      </button>
      {expanded && target && createPortal(contents, target)}
    </div>
  );
}

export function InboxBanner({ onOpen }: { onOpen: () => void }) {
  const { notifications, select, dismiss, testAvailable } = useInbox();
  const latest = notifications.find((item) => !item.read);
  if (!latest) return null;
  return (
    <aside className="inbox-banner" aria-label="New enquiry" aria-live="polite">
      <button
        type="button"
        className="inbox-banner-open"
        onClick={() => {
          select(latest.id);
          onOpen();
        }}
      >
        {latest.channel === "whatsapp" ? (
          <MessageCircle size={18} />
        ) : (
          <Mail size={18} />
        )}
        <span>
          <small>{source(latest, testAvailable)}</small>
          <strong>{preview(latest)}</strong>
        </span>
        <ArrowUpRight size={17} />
      </button>
      <button
        type="button"
        className="inbox-banner-close"
        aria-label="Dismiss enquiry notification"
        onClick={() => dismiss(latest.id)}
      >
        <X size={15} />
      </button>
    </aside>
  );
}
