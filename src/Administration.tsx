import KnowledgeUpdateButton from './KnowledgeUpdateButton';
import {
  useEffect,
  useCallback,
  Fragment,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  FileInput,
  Info,
  ListChecks,
  MessageSquare,
  RefreshCw,
  X,
} from "lucide-react";
import type { AccessUser } from "../shared/access";
import {
  feedbackCategories,
  feedbackStatuses,
  feedbackPriorities,
  importStatuses,
} from "../shared/admin";
import type {
  AdminPage,
  AuditItem,
  FeedbackCategory,
  FeedbackItem,
  FeedbackPriority,
  FeedbackStatus,
  ImportItem,
} from "../shared/admin";
import type { SystemHealth, SystemInformation } from "../shared/system";
import { accessRequest, useAccess } from "./auth";
import {
  adminApi,
  adminQuery,
  adminRequest,
  announceFeedbackUpdate,
} from "./lib/adminApi";
import FeedbackPageSelect from "./FeedbackPageSelect";
import { Field } from "./ui";
import { feedbackPages } from "./workspaceNavigation";
import "./administration.css";
import ParserReports from "./ParserReports";

const failureMessage = (failure: unknown) =>
  failure instanceof Error
    ? failure.message
    : "The request could not be completed.";
const formatTime = (value: string | null | undefined) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Hong_Kong",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "Not available";
const human = (value: string) =>
  value.replaceAll("-", " ").replaceAll("_", " ");
const pageName = (value: string) =>
  feedbackPages.find((page) => page.id === value.replace(/^\//, ""))?.label ??
  (value || "Not specified");

function StatusLabel({ value }: { value: string }) {
  const tone = ["healthy", "resolved", "closed", "awaiting-review"].includes(
    value,
  )
    ? "good"
    : [
          "degraded",
          "in-progress",
          "processing",
          "high",
          "awaiting-retry",
        ].includes(value)
      ? "warning"
      : ["unavailable", "failed"].includes(value)
        ? "bad"
        : "neutral";
  return (
    <span className="admin-status" data-tone={tone}>
      {human(value)}
    </span>
  );
}
function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="admin-empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
function ErrorNotice({ error }: { error: string }) {
  return error ? (
    <div className="admin-error" role="alert">
      {error}
    </div>
  ) : null;
}
function Facts({ values }: { values: [string, ReactNode][] }) {
  return (
    <dl className="admin-facts">
      {values.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value ?? "Not available"}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
function Refresh({ busy, onClick }: { busy: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      className="ui-button"
      disabled={busy}
      onClick={onClick}
    >
      <RefreshCw size={16} className={busy ? "admin-spinner" : ""} />
      Refresh
    </button>
  );
}
function useResource<T>(path: string, poll = false) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    void adminRequest<T>(path, undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failureMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision]);
  useEffect(() => {
    const update = () => {
      if (!document.hidden) setRevision((value) => value + 1);
    };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    const timer = poll ? window.setInterval(update, 60_000) : undefined;
    return () => {
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
      if (timer) window.clearInterval(timer);
    };
  }, [poll]);
  return { data, loading, error, refresh };
}
function useList<T>(endpoint: string, initialStatus = "", mine = false) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [cursors, setCursors] = useState<string[]>([]);
  useEffect(() => {
    const nextQuery = search.trim();
    // Clear applies its query immediately. An equal query must not leave a
    // delayed reset that can send a subsequent page navigation back to page 1.
    if (nextQuery === query) return;
    const timer = window.setTimeout(() => {
      setQuery(nextQuery);
      setCursors([]);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, query]);
  const resource = useResource<AdminPage<T>>(
    `${endpoint}${adminQuery({ search: query, status, cursor: cursors.at(-1), limit: 25, ...(mine ? { scope: "mine" } : {}) })}`,
  );
  return {
    ...resource,
    search,
    status,
    page: cursors.length + 1,
    setSearch,
    setStatus: (value: string) => {
      setStatus(value);
      setCursors([]);
    },
    clear: () => {
      setSearch("");
      setQuery("");
      setStatus("");
      setCursors([]);
    },
    next: () => {
      if (resource.data?.nextCursor)
        setCursors((previous) => [...previous, resource.data!.nextCursor!]);
    },
    previous: () => setCursors((previous) => previous.slice(0, -1)),
  };
}
function ListToolbar({
  list,
  statuses,
  label,
}: {
  list: {
    search: string;
    status: string;
    setSearch(value: string): void;
    setStatus(value: string): void;
    clear(): void;
  };
  statuses?: readonly string[];
  label: string;
}) {
  return (
    <div className="admin-toolbar">
      <div className="field admin-search">
        <label htmlFor={`${label}-search`}>Search {label}</label>
        <input
          id={`${label}-search`}
          value={list.search}
          maxLength={120}
          onChange={(event) => list.setSearch(event.target.value)}
          placeholder="Search"
        />
      </div>
      {statuses && (
        <Field label="Status">
          <select
            aria-label={`${label} status`}
            value={list.status}
            onChange={(event) => list.setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {human(status)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <button
        className="ui-button"
        type="button"
        onClick={list.clear}
        disabled={!list.search && !list.status}
      >
        Clear
      </button>
    </div>
  );
}
function Pagination({
  list,
}: {
  list: {
    page: number;
    data: AdminPage<unknown> | null;
    loading: boolean;
    next(): void;
    previous(): void;
  };
}) {
  return (
    <div className="admin-pagination">
      <small>
        Page {list.page} · {list.data?.items.length ?? 0} records
      </small>
      <div>
        <button
          type="button"
          className="ui-button"
          disabled={list.loading || list.page === 1}
          onClick={list.previous}
        >
          <ChevronLeft size={16} />
          Previous
        </button>
        <button
          type="button"
          className="ui-button"
          disabled={list.loading || !list.data?.nextCursor}
          onClick={list.next}
        >
          Next
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

export function FeedbackComposer({
  onSubmitted,
}: {
  onSubmitted?(item: FeedbackItem): void;
}) {
  const { preview } = useAccess();
  const [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [pagePath, setPagePath] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("issue");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const requestId = useRef(crypto.randomUUID()),
    sending = useRef(false);
  const inputId = useId();
  function edit(action: () => void) {
    if (busy) return;
    action();
    requestId.current = crypto.randomUUID();
    setNotice("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || preview) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { item } = await adminApi.createFeedback({
        requestId: requestId.current,
        title: title.trim(),
        description: description.trim(),
        category,
        pagePath: pagePath ? `/${pagePath}` : "",
      });
      setTitle("");
      setDescription("");
      setPagePath("");
      requestId.current = crypto.randomUUID();
      setNotice("Feedback submitted.");
      announceFeedbackUpdate();
      onSubmitted?.(item);
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="admin-feedback-form"
      aria-label="Submit feedback"
      onSubmit={(event) => void submit(event)}
    >
      <ErrorNotice error={error} />
      {notice && (
        <p className="admin-notice" role="status">
          {notice}
        </p>
      )}
      {preview && <p className="admin-notice">Preview is read only.</p>}
      <fieldset
        disabled={busy || Boolean(preview)}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <Field label="Title">
          <input
            id={`${inputId}-title`}
            required
            minLength={3}
            maxLength={160}
            value={title}
            onChange={(event) => edit(() => setTitle(event.target.value))}
          />
        </Field>
        <div className="admin-form-pair">
          <Field label="Category">
            <select
              aria-label="Category"
              value={category}
              onChange={(event) =>
                edit(() => setCategory(event.target.value as FeedbackCategory))
              }
            >
              {feedbackCategories.map((value) => (
                <option key={value} value={value}>
                  {value === "data" ? "Data correction" : human(value)}
                </option>
              ))}
            </select>
          </Field>
          <FeedbackPageSelect
            value={pagePath}
            onChange={(value) => edit(() => setPagePath(value))}
          />
        </div>
        <Field label="Details">
          <textarea
            required
            minLength={30}
            maxLength={6000}
            rows={6}
            value={description}
            onChange={(event) => edit(() => setDescription(event.target.value))}
          />
        </Field>
        <KnowledgeUpdateButton type="submit">
          {busy ? "Submitting…" : "Submit feedback"}
        </KnowledgeUpdateButton>
      </fieldset>
    </form>
  );
}

export function FeedbackWorkspace() {
  return (
    <div className="eco-feedback-workspace">
      <section>
        <div className="admin-heading">
          <h2>Submit feedback</h2>
        </div>
        <FeedbackComposer />
      </section>
      <MyFeedback />
    </div>
  );
}

/** Modal entry point: preserve an unsent draft while checking existing submissions. */
export function FeedbackPortal() {
  const [section, setSection] = useState<"submit" | "mine">("submit");
  const [historyOpened, setHistoryOpened] = useState(false);
  return (
    <div className="eco-feedback-portal">
      <div className="tabs" aria-label="Feedback sections">
        <button
          type="button"
          className={section === "submit" ? "active" : ""}
          aria-pressed={section === "submit"}
          onClick={() => setSection("submit")}
        >
          Submit feedback
        </button>
        <button
          type="button"
          className={section === "mine" ? "active" : ""}
          aria-pressed={section === "mine"}
          onClick={() => {
            setSection("mine");
            setHistoryOpened(true);
          }}
        >
          My feedback
        </button>
      </div>
      <div hidden={section !== "submit"}>
        <FeedbackComposer />
      </div>
      <div hidden={section !== "mine"}>{historyOpened && <MyFeedback />}</div>
    </div>
  );
}

function MyFeedback() {
  const list = useList<FeedbackItem>("feedback", "", true);
  useEffect(() => {
    const handler = () => list.refresh();
    window.addEventListener("eco-feedback-updated", handler);
    return () => window.removeEventListener("eco-feedback-updated", handler);
  }, []);
  return (
    <section aria-label="My feedback">
      <div className="admin-heading">
        <h2>My feedback</h2>
        <Refresh busy={list.loading} onClick={list.refresh} />
      </div>
      <ListToolbar
        list={list}
        statuses={feedbackStatuses}
        label="My feedback"
      />
      <ErrorNotice error={list.error} />
      {list.loading ? (
        <p role="status">Loading feedback…</p>
      ) : list.data?.items.length ? (
        <div className="admin-records">
          {list.data.items.map((item) => (
            <article className="admin-record" key={item.id}>
              <div className="admin-record-top">
                <strong>{item.title}</strong>
                <StatusLabel value={item.status} />
              </div>
              <p className="admin-preserve">{item.description}</p>
              <div className="admin-meta">
                <span>{formatTime(item.createdAt)} HKT</span>
                <span>{pageName(item.pagePath)}</span>
              </div>
              {item.resolution && (
                <div className="admin-description">
                  <strong>Resolution</strong>
                  <p>{item.resolution}</p>
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        !list.error && <EmptyState title="No feedback yet" />
      )}
      <Pagination list={list} />
    </section>
  );
}

function FeedbackEditor({
  item,
  onClose,
  onSaved,
}: {
  item: FeedbackItem;
  onClose(): void;
  onSaved(item: FeedbackItem): void;
}) {
  const { preview } = useAccess();
  const [status, setStatus] = useState(item.status),
    [priority, setPriority] = useState(item.priority),
    [assigneeId, setAssigneeId] = useState(item.assigneeId ?? ""),
    [resolution, setResolution] = useState(item.resolution);
  const [admins, setAdmins] = useState<AccessUser[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [conflict, setConflict] = useState(false);
  const requestId = useRef(crypto.randomUUID()),
    inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void accessRequest<{ users: AccessUser[] }>(
      "users",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted)
          setAdmins(
            result.users.filter((user) => user.isAdmin && user.isActive),
          );
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(`Assignees unavailable: ${failureMessage(failure)}`);
      });
    return () => controller.abort();
  }, []);
  function edit(action: () => void) {
    if (busy) return;
    action();
    requestId.current = crypto.randomUUID();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || preview || conflict) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await adminApi.triageFeedback({
        requestId: requestId.current,
        id: item.id,
        expectedRevision: item.revision,
        status,
        priority,
        assigneeId: assigneeId || null,
        resolution: resolution.trim(),
      });
      onSaved(result.item);
    } catch (failure) {
      setError(failureMessage(failure));
      if ((failure as { status?: number }).status === 409) setConflict(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <aside className="admin-detail" aria-label="Feedback details">
      <header>
        <h3>{item.title}</h3>
        <button
          type="button"
          aria-label="Close feedback details"
          className="ui-button ui-button--icon"
          disabled={busy}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <Facts
        values={[
          ["Submitted by", item.submitterName],
          ["Office", item.officeName],
          ["Page", pageName(item.pagePath)],
          ["Category", human(item.category)],
          ["Submitted", `${formatTime(item.createdAt)} HKT`],
        ]}
      />
      <p className="admin-description">{item.description}</p>
      <form onSubmit={(event) => void save(event)}>
        <ErrorNotice error={error} />
        {conflict && (
          <p className="admin-notice">
            This record has changed. Close and refresh to load the latest
            version.
          </p>
        )}
        <fieldset
          disabled={busy || conflict || Boolean(preview)}
          style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
        >
          <Field label="Status">
            <select
              aria-label="Status"
              value={status}
              onChange={(event) =>
                edit(() => setStatus(event.target.value as FeedbackStatus))
              }
            >
              {feedbackStatuses.map((value) => (
                <option value={value} key={value}>
                  {human(value)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select
              aria-label="Priority"
              value={priority}
              onChange={(event) =>
                edit(() => setPriority(event.target.value as FeedbackPriority))
              }
            >
              {feedbackPriorities.map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assigned to">
            <select
              aria-label="Assigned to"
              value={assigneeId}
              onChange={(event) =>
                edit(() => setAssigneeId(event.target.value))
              }
            >
              <option value="">Unassigned</option>
              {item.assigneeId &&
                !admins.some((user) => user.id === item.assigneeId) && (
                  <option value={item.assigneeId}>
                    {item.assigneeName ?? "Current assignee"}
                  </option>
                )}
              {admins.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Resolution">
            <textarea
              rows={4}
              maxLength={2000}
              value={resolution}
              onChange={(event) =>
                edit(() => setResolution(event.target.value))
              }
            />
          </Field>
          <button className="ui-button ui-button--primary" type="submit">
            {busy ? "Saving…" : "Save changes"}
          </button>
        </fieldset>
      </form>
      <p className="admin-reference">
        Reference {item.id} · Revision {item.revision}
      </p>
    </aside>
  );
}

function FeedbackAdmin() {
  const list = useList<FeedbackItem>("feedback");
  const [selected, setSelected] = useState<FeedbackItem | null>(null),
    [notice, setNotice] = useState("");
  return (
    <>
      <div className="admin-heading">
        <div>
          <h2>Feedback &amp; Issues</h2>
        </div>
        <Refresh
          busy={list.loading}
          onClick={() => {
            setSelected(null);
            list.refresh();
          }}
        />
      </div>
      <ListToolbar list={list} statuses={feedbackStatuses} label="Feedback" />
      {notice && (
        <p role="status" className="admin-notice">
          {notice}
        </p>
      )}
      <ErrorNotice error={list.error} />
      <div className={`admin-results ${selected ? "has-selection" : ""}`}>
        <div>
          {list.loading ? (
            <p role="status">Loading feedback…</p>
          ) : list.data?.items.length ? (
            <div className="admin-records">
              {list.data.items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="admin-record"
                  aria-pressed={selected?.id === item.id}
                  onClick={() => {
                    setSelected(item);
                    setNotice("");
                  }}
                >
                  <div className="admin-record-top">
                    <strong>{item.title}</strong>
                    <StatusLabel value={item.status} />
                  </div>
                  <div className="admin-meta">
                    <span>{item.submitterName}</span>
                    <span>{item.officeName}</span>
                    <span>{formatTime(item.createdAt)} HKT</span>
                  </div>
                  <div className="admin-meta">
                    <span>{human(item.category)}</span>
                    <span>{item.priority} priority</span>
                    <span>{item.assigneeName ?? "Unassigned"}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            !list.error && <EmptyState title="No matching feedback" />
          )}
          <Pagination list={list} />
        </div>
        {selected && (
          <FeedbackEditor
            key={`${selected.id}-${selected.revision}`}
            item={selected}
            onClose={() => setSelected(null)}
            onSaved={() => {
              setSelected(null);
              setNotice("Feedback updated.");
              list.refresh();
              announceFeedbackUpdate();
            }}
          />
        )}
      </div>
    </>
  );
}

export function AuditLog() {
  const list = useList<AuditItem>("audit");
  const [selected, setSelected] = useState<AuditItem | null>(null);
  return (
    <>
      <div className="admin-heading">
        <h2>Audit Log</h2>
        <Refresh
          busy={list.loading}
          onClick={() => {
            setSelected(null);
            list.refresh();
          }}
        />
      </div>
      <ListToolbar list={list} label="Audit" />
      <p className="admin-meta">
        Server-recorded access and administration events · Hong Kong time
      </p>
      <ErrorNotice error={list.error} />
      <div className={`admin-results ${selected ? "has-selection" : ""}`}>
        <div>
          {list.loading ? (
            <p role="status">Loading audit log…</p>
          ) : list.data?.items.length ? (
            <div className="admin-records">
              {list.data.items.map((item) => (
                <button
                  type="button"
                  className="admin-record"
                  key={`${item.source}-${item.id}`}
                  aria-pressed={
                    selected?.id === item.id && selected.source === item.source
                  }
                  onClick={() => setSelected(item)}
                >
                  <div className="admin-record-top">
                    <strong>{human(item.action)}</strong>
                    <span className="admin-status">{item.source}</span>
                  </div>
                  <div className="admin-meta">
                    <span>{item.actorName || "System"}</span>
                    <span>{formatTime(item.occurredAt)} HKT</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            !list.error && <EmptyState title="No matching audit events" />
          )}
          <Pagination list={list} />
        </div>
        {selected && (
          <aside className="admin-detail" aria-label="Audit event details">
            <header>
              <h3>{human(selected.action)}</h3>
              <button
                type="button"
                className="ui-button ui-button--icon"
                aria-label="Close audit details"
                onClick={() => setSelected(null)}
              >
                <X size={16} />
              </button>
            </header>
            <Facts
              values={[
                ["Actor", selected.actorName || "System"],
                ["Time", `${formatTime(selected.occurredAt)} HKT`],
                ["Source", selected.source],
                ["Target", selected.targetId ?? "Not applicable"],
                ["Event", selected.id],
              ]}
            />
            <h4>Details</h4>
            <pre className="admin-code" data-preserve-case>
              {JSON.stringify(selected.details, null, 2)}
            </pre>
          </aside>
        )}
      </div>
    </>
  );
}

function ImportActivity() {
  const list = useList<ImportItem>("imports");
  const [selected, setSelected] = useState<ImportItem | null>(null);
  return (
    <>
      <div className="admin-heading">
        <h2>Import Activity</h2>
        <Refresh
          busy={list.loading}
          onClick={() => {
            setSelected(null);
            list.refresh();
          }}
        />
      </div>
      <ListToolbar list={list} statuses={[...importStatuses, "published"]} label="Imports" />
      <p className="admin-meta">
        Processing results and server-published imports.
      </p>
      <ErrorNotice error={list.error} />
      <div className={`admin-results ${selected ? "has-selection" : ""}`}>
        <div>
          {list.loading ? (
            <p role="status">Loading import activity…</p>
          ) : list.data?.items.length ? (
            <div className="admin-records">
              {list.data.items.map((item) => (
                <button
                  type="button"
                  className="admin-record"
                  key={item.id}
                  aria-pressed={selected?.id === item.id}
                  onClick={() => setSelected(item)}
                >
                  <div className="admin-record-top">
                    <strong>{item.sourceName}</strong>
                    <StatusLabel value={item.status} />
                  </div>
                  <div className="admin-meta">
                    <span>{item.submitterName}</span>
                    <span>{human(item.kind)}</span>
                    <span>{formatTime(item.updatedAt)} HKT</span>
                  </div>
                  <div className="admin-meta">
                    <span>Attempt {item.attempt}</span>
                    <span>{item.warningCount} warnings</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            !list.error && <EmptyState title="No matching imports" />
          )}
          <Pagination list={list} />
        </div>
        {selected && (
          <aside className="admin-detail" aria-label="Import details">
            <header>
              <h3>{selected.sourceName}</h3>
              <button
                type="button"
                className="ui-button ui-button--icon"
                aria-label="Close import details"
                onClick={() => setSelected(null)}
              >
                <X size={16} />
              </button>
            </header>
            <Facts
              values={[
                ["Status", <StatusLabel value={selected.status} />],
                ["Submitted by", selected.submitterName],
                ["Source type", selected.sourceType],
                ["Kind", selected.kind],
                ["Attempt", selected.attempt],
                ["Warnings", selected.warningCount],
                ["Created", `${formatTime(selected.createdAt)} HKT`],
                ["Updated", `${formatTime(selected.updatedAt)} HKT`],
                ["Evidence", selected.provenance === "server-published" ? "Server-published" : "Browser-reported"],
                ["Error", selected.errorCode ?? "None recorded"],
              ]}
            />
            {selected.summary && (
              <p className="admin-description">{selected.summary}</p>
            )}
            {["failed", "cancelled", "awaiting-retry"].includes(
              selected.status,
            ) && <p>Reopen the original source to retry.</p>}
            <p className="admin-reference">
              Reference {selected.id} · Revision {selected.revision}
            </p>
          </aside>
        )}
      </div>
    </>
  );
}

function SystemHealthPanel() {
  const resource = useResource<SystemHealth>("system-health");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!resource.data) return;
    // Refresh just after the server cache expires; polling before expiry can
    // repeatedly fetch the same snapshot and leave a stale gap.
    const expires = Date.parse(resource.data.expiresAt);
    const delay = Number.isFinite(expires)
      ? Math.max(1000, Math.min(120_000, expires - Date.now() + 250))
      : 30_000;
    const timer = window.setTimeout(() => {
      if (!document.hidden) resource.refresh();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [resource.data, resource.refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const stale = Boolean(
    resource.data && Date.parse(resource.data.expiresAt) <= now,
  );
  return (
    <>
      <div className="admin-heading">
        <div>
          <h2>System Health</h2>
          {resource.data && (
            <div className="admin-meta">
              <span>Checked {formatTime(resource.data.observedAt)} HKT</span>
              <StatusLabel value={stale ? "unknown" : resource.data.status} />
            </div>
          )}
        </div>
        <Refresh busy={resource.loading} onClick={resource.refresh} />
      </div>
      <ErrorNotice error={resource.error} />
      {resource.loading && <p role="status">Checking system health…</p>}
      {stale && (
        <p role="status" className="admin-notice">
          These checks have expired. Refresh for current status.
        </p>
      )}
      {resource.data && (
        <div className="admin-panels">
          {resource.data.checks.map((check) => (
            <section className="admin-panel" key={check.id}>
              <header>
                <h3>{check.label}</h3>
                <StatusLabel value={stale ? "unknown" : check.status} />
              </header>
              <p>{check.detail}</p>
              {check.metrics && (
                <Facts
                  values={Object.entries(check.metrics).map(([key, value]) => [
                    human(key),
                    value === null ? "Not available" : String(value),
                  ])}
                />
              )}
              <div className="admin-meta admin-check-time">
                <span>
                  {check.checkedAt
                    ? `${formatTime(check.checkedAt)} HKT`
                    : "No verified check"}
                </span>
                {check.latencyMs !== undefined && (
                  <span>{check.latencyMs} ms</span>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function SystemInformationPanel() {
  const resource = useResource<SystemInformation>("system-information");
  const info = resource.data;
  return (
    <>
      <div className="admin-heading">
        <h2>System Information</h2>
        <Refresh busy={resource.loading} onClick={resource.refresh} />
      </div>
      <ErrorNotice error={resource.error} />
      {resource.loading && <p role="status">Loading system information…</p>}
      {info && (
        <div className="admin-panels">
          <section className="admin-panel">
            <h3>Release</h3>
            <Facts
              values={[
                [
                  "Application",
                  `${info.application.name} ${info.application.version}`,
                ],
                ["Release", info.build.releaseId],
                ["Built", `${formatTime(info.build.builtAt)} HKT`],
                ["Environment", info.runtime.environment],
                ["Deployment", info.runtime.deploymentId ?? "Not available"],
                ["Source commit", info.build.gitCommit ?? "Not available"],
                ["Source state", info.build.gitWorktree],
              ]}
            />
          </section>
          <section className="admin-panel">
            <h3>Infrastructure</h3>
            <Facts
              values={[
                ["Node.js", info.runtime.node],
                ["Required Node.js", info.runtime.requiredNode],
                ["Runtime region", info.runtime.region ?? "Not available"],
                [
                  "Compute regions",
                  info.targets.computeRegions.join(", ") || "Not available",
                ],
                ["Database region", info.targets.databaseRegion],
                ["Identity", human(info.targets.identityMode)],
                ["Bundled migration", info.migrations.bundledHead ?? "None"],
                ["Migration files", info.migrations.count],
              ]}
            />
          </section>
          <section className="admin-panel full">
            <h3>Technology versions</h3>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Dependency</th>
                    <th>Version</th>
                    <th className="admin-scope-column">Scope</th>
                  </tr>
                </thead>
                <tbody>
                  {info.dependencies.map((dependency) => (
                    <tr key={`${dependency.scope}-${dependency.name}`}>
                      <td>
                        {dependency.name}
                        <small className="admin-dependency-scope">
                          {dependency.scope}
                        </small>
                      </td>
                      <td>{dependency.version}</td>
                      <td className="admin-scope-column">{dependency.scope}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="admin-panel full">
            <details>
              <summary>Build verification</summary>
              <Facts
                values={[
                  [
                    "Source SHA-256",
                    <span data-preserve-case>{info.build.sourceSha256}</span>,
                  ],
                  [
                    "Lockfile SHA-256",
                    <span data-preserve-case>{info.build.lockfileSha256}</span>,
                  ],
                  [
                    "Migrations SHA-256",
                    <span data-preserve-case>{info.migrations.sha256}</span>,
                  ],
                  ["Source files", info.build.sourceFileCount],
                  ["Metadata schema", info.schemaVersion],
                ]}
              />
            </details>
          </section>
        </div>
      )}
    </>
  );
}

const sections = [
  { id: "feedback", label: "Feedback & Issues", icon: MessageSquare },
  { id: "audit", label: "Audit Log", icon: ListChecks },
  { id: "imports", label: "Import Activity", icon: FileInput },
  { id: "health", label: "System Health", icon: Activity },
  { id: "system", label: "System Information", icon: Info },
] as const;
type Section = (typeof sections)[number]["id"];
export default function Administration() {
  const { user, preview } = useAccess();
  const [section, setSection] = useState<Section>("feedback");
  if (!user?.isAdmin || preview) return null;
  return (
    <div className="eco-administration">
      <nav className="admin-navigation" aria-label="Administration">
        {sections.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            className="ui-button"
            aria-current={section === id ? "page" : undefined}
            onClick={() => setSection(id)}
            key={id}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>
      <section
        className="admin-content"
        aria-label={sections.find((item) => item.id === section)!.label}
        key={section}
      >
        {section === "feedback" ? (
          <FeedbackAdmin />
        ) : section === "audit" ? (
          <AuditLog />
        ) : section === "imports" ? (
          <><ImportActivity /><ParserReports /></>
        ) : section === "health" ? (
          <SystemHealthPanel />
        ) : (
          <SystemInformationPanel />
        )}
      </section>
    </div>
  );
}
