/** Versioned, shared browser/server contract. Actor identity and timestamps always come from ECO. */
export const adminContractVersion = 1 as const;
export const feedbackCategories = ['issue', 'idea', 'data'] as const;
export const feedbackStatuses = ['new', 'in-progress', 'resolved', 'closed'] as const;
export const feedbackPriorities = ['low', 'normal', 'high'] as const;
export type FeedbackCategory = typeof feedbackCategories[number];
export type FeedbackStatus = typeof feedbackStatuses[number];
export type FeedbackPriority = typeof feedbackPriorities[number];
export interface FeedbackItem {
  id: string; title: string; description: string; category: FeedbackCategory;
  status: FeedbackStatus; priority: FeedbackPriority; pagePath: string;
  submitterId: string; submitterName: string; officeName: string;
  assigneeId: string | null; assigneeName: string | null; resolution: string;
  createdAt: string; updatedAt: string; revision: number;
}
export interface FeedbackCreate { requestId: string; title: string; description: string; category: FeedbackCategory; pagePath?: string }
export interface FeedbackTriage { requestId: string; id: string; expectedRevision: number; status: FeedbackStatus; priority: FeedbackPriority; assigneeId: string | null; resolution: string }
export interface AdminPage<T> { items: T[]; nextCursor: string | null }
export interface AdminListQuery { scope?: 'mine' | 'all'; search?: string; status?: string; cursor?: string; limit?: number }
export interface AuditItem {
  id: string; occurredAt: string; actorId: string | null; actorName: string;
  action: string; targetId: string | null; source: 'access' | 'administration';
  details: Record<string, unknown>;
}
export const importKinds = ['document', 'enquiry', 'text', 'link'] as const;
export type ImportKind = typeof importKinds[number];
/** Awaiting-retry means the owner must reopen the source. There is no implicit background worker. */
export const importStatuses = ['processing', 'awaiting-review', 'failed', 'cancelled', 'awaiting-retry'] as const;
export const importOutcomeStatuses = ['awaiting-review', 'failed', 'cancelled'] as const;
export type ImportStatus = typeof importStatuses[number];
export interface ImportItem {
  id: string; kind: ImportKind | 'supplier'; sourceName: string; sourceType: string;
  status: ImportStatus | 'published'; provenance: 'client-reported' | 'server-published'; submitterId: string; submitterName: string;
  createdAt: string; updatedAt: string; attempt: number; revision: number;
  warningCount: number; errorCode: string | null; summary: string;
}
export interface ImportBegin { requestId: string; kind: ImportKind; sourceName: string; sourceType: string; retryOf?: string; expectedRevision?: number }
export interface ImportTransition { requestId: string; id: string; expectedRevision: number; status: typeof importOutcomeStatuses[number]; warningCount: number; errorCode?: string; summary?: string }
export interface ImportRetry { requestId: string; id: string; expectedRevision: number }
export type FeedbackContribution = { id: string; userId: string; feedbackId: string; createdAt: string; kind: 'feedback' }
  | { id: string; userId: string; supplierId: string; createdAt: string; kind: 'supplier' }
  | { id: string; userId: string; targetKind: string; targetId: string; createdAt: string; kind: 'profile-tab' };
export interface FeedbackContributionSummary { count: number; previousCount: number; periodStart: string; periodEnd: string; timeZone: 'Asia/Hong_Kong'; source: 'shared-feedback' | 'shared-contributions'; items: FeedbackContribution[] }
