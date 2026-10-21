/** Page metadata is shared by navigation, window titles and feedback. Add new
 * workspaces here so they automatically become available in the page selector. */
export const workspacePages = {
  enquiry: { label: "Enquiries", group: "Trading" },
  fixtures: { label: "Fixtures", group: "Trading" },
  lost: { label: "Lost Records", group: "Trading" },
  ports: { label: "Countries & Ports", group: "Ports & Suppliers" },
  suppliers: { label: "Supplier Profiles", group: "Ports & Suppliers" },
  "singapore-suppliers": { label: "Supplier Profiles", aliasOf: "suppliers" },
  counterparties: { label: "Buyer Profiles", group: "Buyers and Credit" },
  "credit-request": { label: "Credit Requests", group: "Buyers and Credit" },
  contribute: { label: "Ports and countries" },
  feedback: { label: "Feedback for ecosystem" },
  settings: { label: "Settings" },
  countries: { label: "Countries & Ports", aliasOf: "ports" },
} as const;

export type WorkspaceId = keyof typeof workspacePages;
const workspaceEntries = Object.entries(workspacePages) as [WorkspaceId, {
  label: string; group?: string; aliasOf?: WorkspaceId;
}][];
export const workspaceTitles = Object.fromEntries(
  workspaceEntries.map(([id, page]) => [id, page.label]),
) as Record<WorkspaceId, string>;

export const workspaceGroups = [...new Set(workspaceEntries.flatMap(([, page]) => page.group ? [page.group] : []))]
  .map((name) => ({ name, items: workspaceEntries.filter(([, page]) => page.group === name)
    .map(([id, page]) => ({ id, label: page.label })) }));

export interface FeedbackPage { id: string; label: string }
export const feedbackPages: readonly FeedbackPage[] = [
  { id: "home", label: "Home" },
  ...workspaceEntries.filter(([, page]) => !page.aliasOf)
    .map(([id, page]) => ({ id, label: page.label })),
];

/** Select an existing intelligence record without replacing the enquiry draft. */
export interface WorkspaceNavigationContext {
  enquiryId?: string;
  unreadOnly?: boolean;
  attentionOnly?: boolean;
  fromSearch?: boolean;
  buyerId?: string;
  portId?: string;
  /** Old saved navigation only; resolves to its owning country. */
  areaId?: string;
  country?: string;
  supplierId?: string;
  supplierTab?: "information" | "bdn" | "contacts" | "barges" | "sources";
  combinedLocation?: boolean;
  returnTo?: "enquiry" | "ports" | "countries";
}

export type OpenWorkspace = (id: WorkspaceId, context?: WorkspaceNavigationContext) => void;
