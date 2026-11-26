/** Durable LIVE intake metadata, including a verified owned enquiry link when available. */
export interface IncomingEnquiry {
  id: string;
  providerMessageId: string;
  channel: 'whatsapp' | 'email';
  sender: string;
  owner: string;
  rawText: string;
  receivedAt: string;
  read: boolean;
  dismissed: boolean;
  subject?: string;
  enquiryId?: string;
}
export interface InboxPage { items: IncomingEnquiry[]; nextCursor: string | null; unreadCount: number }
export type InboxAction = 'read' | 'dismiss' | 'dismiss-all';
export interface InboxMutation { requestId: string; action: InboxAction; id?: string }
export interface InboxMutationResult {
  requestId: string;
  action: InboxAction;
  item: IncomingEnquiry | null;
  changedCount: number;
  unreadCount: number;
}
export const INBOX_PAGE_LIMIT = 50;
export const INBOX_TEXT_BYTES = 20_000;
