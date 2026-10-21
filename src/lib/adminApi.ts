import { assertLiveDataWritable } from './testWorkspaceGuard';
import type {
  AdminListQuery,
  AdminPage,
  AuditItem,
  FeedbackCreate,
  FeedbackItem,
  FeedbackTriage,
  FeedbackContributionSummary,
  ImportBegin,
  ImportItem,
  ImportRetry,
  ImportTransition,
} from "../../shared/admin";
import type { SystemHealth, SystemInformation } from "../../shared/system";
import { assertPreviewWritable } from "./previewGuard";

/** Browser adapter only; server authentication, attribution and access rules are authoritative. */
export async function adminRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (body !== undefined) { assertPreviewWritable(); assertLiveDataWritable(); }
  const response = await fetch(`/api/admin/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Eco-Request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  });
  const result = await response
    .json()
    .catch(() => ({ message: "Administration service unavailable." }));
  if (!response.ok)
    throw Object.assign(
      new Error(result.message ?? "The request could not be completed."),
      { status: response.status },
    );
  return result as T;
}
export function adminQuery(query: AdminListQuery = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.size ? `?${params}` : "";
}
export const adminApi = {
  feedback: (query?: AdminListQuery, signal?: AbortSignal) =>
    adminRequest<AdminPage<FeedbackItem>>(
      `feedback${adminQuery(query)}`,
      undefined,
      signal,
    ),
  createFeedback: (input: FeedbackCreate) =>
    adminRequest<{ item: FeedbackItem }>("feedback", input),
  triageFeedback: (input: FeedbackTriage) =>
    adminRequest<{ item: FeedbackItem }>("feedback/triage", input),
  feedbackContributions: (signal?: AbortSignal) =>
    adminRequest<FeedbackContributionSummary>(
      "feedback/contributions",
      undefined,
      signal,
    ),
  audit: (query?: AdminListQuery, signal?: AbortSignal) =>
    adminRequest<AdminPage<AuditItem>>(
      `audit${adminQuery(query)}`,
      undefined,
      signal,
    ),
  imports: (query?: AdminListQuery, signal?: AbortSignal) =>
    adminRequest<AdminPage<ImportItem>>(
      `imports${adminQuery(query)}`,
      undefined,
      signal,
    ),
  beginImport: (input: ImportBegin) =>
    adminRequest<{ item: ImportItem }>("imports/begin", input),
  transitionImport: (input: ImportTransition) =>
    adminRequest<{ item: ImportItem }>("imports/transition", input),
  retryImport: (input: ImportRetry) =>
    adminRequest<{ item: ImportItem }>("imports/retry", input),
  health: (signal?: AbortSignal) =>
    adminRequest<SystemHealth>("system-health", undefined, signal),
  system: (signal?: AbortSignal) =>
    adminRequest<SystemInformation>("system-information", undefined, signal),
};

export function announceFeedbackUpdate(): void {
  window.dispatchEvent(new Event("eco-feedback-updated"));
}
