import { demoKnowledgeSections } from "./knowledgeDemo.ts";
import type { DemoState } from "./model.ts";
import { emptyIntelligenceKeyInfo, type IntelligenceKeyInfo } from "./intelligenceFields.ts";
import { canonicalLocationTarget, locationCountries, legacyLocationGroup } from './locations.ts';

/** `area` remains solely for immutable legacy documents, audit and attachment references. */
export type KnowledgeTarget = {
  kind: "port" | "country" | "area" | "company" | "supplier";
  id: string;
};
export interface KnowledgeProvenance { source: string; evidence: string; date?: string }
export interface KnowledgeEntryUpdate { updatedBy: string; updatedAt: string }
export type KnowledgeBlock = { id: string; title: string; provenance?: KnowledgeProvenance; update?: KnowledgeEntryUpdate } & (
  | { type: "text"; text: string }
  | {
      type: "table";
      columns: { id: string; name: string; width?: number }[];
      rows: { id: string; cells: string[]; update?: KnowledgeEntryUpdate }[];
    }
  | { type: "file"; url: string }
);
export type KnowledgeSectionRole = "supplier-information" | "supplier-fixtures" | "port-information" | "suppliers" | "refineries" | "grades-delivery" | "tax-regulations" | "trader-remarks" | "uploaded-documents" | "price-history";
export const KNOWLEDGE_LAYOUT_VERSION = 2 as const;
export interface KnowledgeSection {
  id: string;
  title: string;
  role?: KnowledgeSectionRole;
  blocks: KnowledgeBlock[];
}
export interface KnowledgeDocument {
  version: number;
  layoutVersion?: typeof KNOWLEDGE_LAYOUT_VERSION;
  /** Once added, the Fixtures tab may be renamed or removed without regeneration. */
  supplierFixturesVersion?: 1;
  sections: KnowledgeSection[];
}
export interface KnowledgeChange {
  target: KnowledgeTarget;
  baseVersion: number;
  baseDocument: KnowledgeDocument;
  document: KnowledgeDocument;
}
export interface KnowledgeRevision {
  target: KnowledgeTarget;
  version: number;
  at: string;
  by: string;
  reason: string;
  source?: string;
  before: KnowledgeDocument;
  after: KnowledgeDocument;
}
export function canonicalTarget(
  state: DemoState,
  target: KnowledgeTarget,
): KnowledgeTarget {
  return canonicalLocationTarget(state, target);
}
export function knowledgeKey(state: DemoState, target: KnowledgeTarget) {
  const t = canonicalTarget(state, target);
  return `${t.kind}:${t.id}`;
}
export type KnowledgeReferences = { suppliers?: readonly { id: string; name: string }[] };

export function knowledgeName(
  state: DemoState,
  target: KnowledgeTarget,
  references: KnowledgeReferences = {},
): string {
  const t = canonicalTarget(state, target);
  const name =
    t.kind === "port"
      ? state.ports.find((p) => p.id === t.id)?.name
      : t.kind === "area"
        ? legacyLocationGroup(state, t.id)?.name
      : t.kind === "company"
        ? state.companies.find((c) => c.id === t.id)?.name
        : t.kind === "supplier"
          ? references.suppliers?.find(s => s.id === t.id)?.name
            ?? (state.knowledgeRecords?.[`supplier:${t.id}`] ? 'Supplier' : undefined)
          : locationCountries(state).find(country => country.id === t.id)?.name;
  if (!name) throw new Error("Select a valid information record.");
  return name;
}
export function knowledgeDocument(
  state: DemoState,
  target: KnowledgeTarget,
  references: KnowledgeReferences = {},
): KnowledgeDocument {
  const t = canonicalTarget(state, target),
    key = knowledgeKey(state, t);
  knowledgeName(state, t, references);
  if (state.knowledgeRecords?.[key]) return structuredClone(withRequiredKnowledgeTitles(state, t, withDefaultKnowledgeSections(state.knowledgeRecords[key], t.kind)));
  const port = t.kind === "port" ? state.ports.find((p) => p.id === t.id) : undefined;
  const company = t.kind === "company" ? state.companies.find((c) => c.id === t.id) : undefined;
  const contributions = state.contributions.filter(c => c.targetType === t.kind && c.targetId === t.id && c.status === "approved" && !c.knowledgeChange && !c.extractionBatch && !c.tabChanges && !c.proposedKeyInfo);
  const content = port ? [port.summary, ...port.notes] : company ? [company.notes] : contributions.map(c => c.body);
  const document: KnowledgeDocument = {
    version: 0,
    sections: [{
      id: "general", title: "General Information",
      blocks: content.filter(Boolean).map((value, i) => {
        const contribution = contributions.find(item => item.body === value);
        const update = contribution ? contributionUpdate(contribution) : undefined;
        return { id: `note-${i}`, type: "text", title: contribution?.title.trim() || "", text: value, ...(update ? { update } : {}) };
      }),
    }, ...(state.demoScenarioVersion && port && ['port-singapore', 'port-hong-kong', 'port-rotterdam', 'port-fujairah', 'port-busan', 'port-tokyo', 'port-ho-chi-minh', 'port-gibraltar'].includes(port.id) ? demoKnowledgeSections(state, port.id) : [])],
  };
  return withRequiredKnowledgeTitles(state, t, withDefaultKnowledgeSections(legacyDefaultKnowledgeSections(document, t.kind), t.kind));
}

/** A neutral fallback uses the existing section name; it does not invent information. */
export function defaultKnowledgeTitle(sectionTitle: string, index: number): string {
  const suffix = ` ${index + 1}`;
  return `${(sectionTitle.trim() || "Information").slice(0, 150 - suffix.length)}${suffix}`;
}

export function needsKnowledgeTitles(document: KnowledgeDocument): boolean {
  return document.sections.some(section => section.blocks.some(block => !block.title.trim()));
}

/** Presentation migration only: preserve source, IDs, history, versions and the proven author. */
export function withRequiredKnowledgeTitles(state: DemoState, target: KnowledgeTarget, document: KnowledgeDocument): KnowledgeDocument {
  if (!needsKnowledgeTitles(document)) return document;
  const entryUpdate = knowledgeEntryUpdateLookup(state, target, document);
  return { ...document, sections: document.sections.map(section => ({ ...section, blocks: section.blocks.map((block, index) => {
    if (block.title.trim()) return block;
    const update = entryUpdate(block.id);
    return { ...block, title: defaultKnowledgeTitle(section.title, index), ...(update ? { update } : {}) };
  }) })) };
}

export const countryKnowledgeSections = [
  { id: "suppliers", title: "Suppliers", role: "suppliers" },
  { id: "refineries", title: "Refineries", role: "refineries" },
  { id: "grades-delivery", title: "Grades and delivery modes", role: "grades-delivery" },
  { id: "tax-regulations", title: "Tax and regulations", role: "tax-regulations" },
  { id: "trader-remarks", title: "Trader's Remarks", role: "trader-remarks" },
  { id: "uploaded-documents", title: "Uploaded Documents", role: "uploaded-documents" },
] as const;

const supplierFixturesSection = { id: "supplier-fixtures", title: "Fixtures", role: "supplier-fixtures" } as const;

function supplierFixturesTitle(sections: KnowledgeSection[]): string {
  const titles = new Set(sections.map(section => section.title.trim().toLocaleLowerCase("en-US")));
  if (!titles.has("fixtures")) return "Fixtures";
  const label = "Fixtures (records)";
  let title = label;
  for (let n = 2; titles.has(title.toLocaleLowerCase("en-US")); n++) title = `${label} ${n}`;
  return title;
}

export const supplierKnowledgeSections = [
  { id: "general", title: "Supplier Information", role: "supplier-information" },
  { id: "trader-remarks", title: "Trader's Remarks", role: "trader-remarks" },
  { id: "uploaded-documents", title: "Uploaded Documents", role: "uploaded-documents" },
  supplierFixturesSection,
] as const;

export function defaultKnowledgeSections(kind: KnowledgeTarget["kind"]): { id: string; title: string; role: KnowledgeSectionRole }[] {
  if (kind === "supplier") return [...supplierKnowledgeSections];
  return [...(kind === "port" ? [{ id: "general", title: "Port Information", role: "port-information" as const }] : []), ...countryKnowledgeSections,
    ...(kind === "port" ? [{ id: "price-history", title: "Price History", role: "price-history" as const }] : [])];
}

/** Keep block identities and custom sections while supplying the requested default tabs. */
function legacyDefaultKnowledgeSections(document: KnowledgeDocument, kind: KnowledgeTarget["kind"]): KnowledgeDocument {
  if (kind !== "country" && kind !== "port") return document;
  const defaults = defaultKnowledgeSections(kind);
  const sections: KnowledgeSection[] = defaults.map(section => ({ ...section, blocks: [] }));
  const aliases: Record<string, string> = {
    "general information": kind === "port" ? "general" : "trader-remarks",
    "supplier portfolio": "suppliers", "supplier introduction": "suppliers",
    "customer portfolio": "trader-remarks",
    "anchorage info": kind === "port" ? "general" : "trader-remarks",
    "debunkering": kind === "port" ? "general" : "trader-remarks",
    "sub-agent directory": kind === "port" ? "general" : "trader-remarks",
    "key info sources": kind === "port" ? "general" : "trader-remarks",
  };
  const custom: KnowledgeSection[] = [];
  for (const section of document.sections) {
    const normalized = section.title.trim().toLocaleLowerCase("en-US");
    const destination = defaults.find(item => item.title.toLocaleLowerCase("en-US") === normalized)?.id ?? aliases[normalized];
    const selected = sections.find(item => item.id === destination);
    const combined = selected ? [...selected.blocks, ...section.blocks] : [];
    const fits = selected?.title === "Uploaded Documents"
      ? combined.length <= 5100 && combined.filter(block => block.type !== "file").length <= 100
      : combined.length <= 100;
    if (selected && fits) selected.blocks.push(...section.blocks);
    else custom.push({ ...section, blocks: [...section.blocks] });
  }
  // Uploaded Documents replaces the former global Files button. Move, do not
  // duplicate, links while keeping their identities and any emptied custom tabs.
  const uploaded = sections.find(section => section.title === "Uploaded Documents")!;
  const files: KnowledgeBlock[] = [];
  for (const section of [...sections, ...custom]) {
    if (section === uploaded) continue;
    files.push(...section.blocks.filter(block => block.type === "file"));
    section.blocks = section.blocks.filter(block => block.type !== "file");
  }
  uploaded.blocks.push(...files);
  // A formerly built-in tab may have a user-defined name: preserve it without ID collisions.
  const used = new Set(custom.map(section => section.id));
  for (const section of document.sections) for (const block of section.blocks) {
    used.add(block.id);
    if (block.type === "table") {
      for (const column of block.columns) used.add(column.id);
      for (const row of block.rows) used.add(row.id);
    }
  }
  for (const section of sections) {
    if (used.has(section.id)) {
      const original = section.id;
      for (let n = 1; used.has(section.id); n++) section.id = `${original}-default-${n}`;
    }
    used.add(section.id);
  }
  return { ...document, sections: [...sections, ...custom] };
}

/** Special tab behavior follows its stable role, never a user-editable title. */
export function knowledgeSectionRole(section: KnowledgeSection): KnowledgeSectionRole | undefined {
  return section.role;
}

export function isReadOnlyKnowledgeSection(section: KnowledgeSection): boolean {
  return section.role === "price-history" || section.role === "supplier-fixtures";
}

const sectionRoles: KnowledgeSectionRole[] = ["supplier-information", "supplier-fixtures", "port-information", ...countryKnowledgeSections.map(section => section.role), "price-history"];
function legacySectionRole(section: KnowledgeSection, kind: KnowledgeTarget["kind"]): KnowledgeSectionRole | undefined {
  if (section.role) return section.role;
  const normalized = section.title.trim().toLocaleLowerCase("en-US");
  const named = defaultKnowledgeSections(kind).find(item => item.title.toLocaleLowerCase("en-US") === normalized)?.role;
  if ((named === "price-history" || named === "supplier-fixtures") && section.blocks.length) return undefined;
  if (named) return named;
  if (kind === "supplier") {
    if (normalized === "general information" || section.id.replace(/-default-\d+$/, "") === "general") return "supplier-information";
    const byId = defaultKnowledgeSections(kind).find(item => item.id === section.id.replace(/-default-\d+$/, ""))?.role;
    return byId === "supplier-fixtures" && section.blocks.length ? undefined : byId;
  }
  if (normalized === "port information") return kind === "port" ? "port-information" : undefined;
  if (["general information", "key info sources"].includes(normalized)) return kind === "port" ? "port-information" : "trader-remarks";
  if (["supplier portfolio", "supplier introduction"].includes(normalized)) return "suppliers";
  const stableId = section.id.replace(/-default-\d+$/, "");
  if (stableId === "general") return kind === "port" ? "port-information" : "trader-remarks";
  const byId = defaultKnowledgeSections(kind).find(item => item.id === stableId)?.role;
  return byId === "price-history" && section.blocks.length ? undefined : byId;
}

/** Upgrade a legacy layout once. Managed layouts remain exactly as the user saved them. */
export function withDefaultKnowledgeSections(document: KnowledgeDocument, kind: KnowledgeTarget["kind"]): KnowledgeDocument {
  if (kind !== "country" && kind !== "port" && kind !== "supplier") return document;
  if (document.layoutVersion === KNOWLEDGE_LAYOUT_VERSION) return kind === "supplier" ? withSupplierFixtures(document) : document;
  const defaults = defaultKnowledgeSections(kind);
  const assigned = new Set<KnowledgeSectionRole>();
  const sections: KnowledgeSection[] = document.sections.map(section => {
    const role = legacySectionRole(section, kind);
    const uniqueRole = role && !assigned.has(role) ? role : undefined;
    if (uniqueRole) assigned.add(uniqueRole);
    const { role: _role, ...existing } = section;
    const title = kind === "supplier" && uniqueRole === "supplier-information" && section.title.trim().toLowerCase() === "general information"
      ? "Supplier Information" : section.title;
    return { ...existing, title, ...(uniqueRole ? { role: uniqueRole } : {}), blocks: [...section.blocks] };
  });
  const used = new Set<string>();
  for (const section of sections) {
    used.add(section.id);
    for (const block of section.blocks) {
      used.add(block.id);
      if (block.type === "table") {
        block.rows.forEach(row => used.add(row.id));
        block.columns.forEach(column => used.add(column.id));
      }
    }
  }
  for (const section of defaults) {
    if (assigned.has(section.role)) continue;
    let id = section.id;
    for (let n = 1; used.has(id); n++) id = `${section.id}-default-${n}`;
    used.add(id);
    sections.push({ ...section, id, ...(section.role === "supplier-fixtures" ? { title: supplierFixturesTitle(sections) } : {}), blocks: [] });
  }
  const uploaded = sections.find(section => section.role === "uploaded-documents")!;
  for (const section of sections) {
    if (section === uploaded) continue;
    uploaded.blocks.push(...section.blocks.filter(block => block.type === "file"));
    section.blocks = section.blocks.filter(block => block.type !== "file");
  }
  const migrated = { ...document, layoutVersion: KNOWLEDGE_LAYOUT_VERSION, sections };
  return kind === "supplier" ? withSupplierFixtures(migrated) : migrated;
}

/** Add only the newly introduced tab to managed supplier layouts; never restore removed defaults. */
function withSupplierFixtures(document: KnowledgeDocument): KnowledgeDocument {
  if (document.supplierFixturesVersion === 1) return document;
  if (document.sections.some(section => section.role === "supplier-fixtures")) return { ...document, supplierFixturesVersion: 1 };
  const used = new Set<string>();
  for (const section of document.sections) {
    used.add(section.id);
    for (const block of section.blocks) {
      used.add(block.id);
      if (block.type === "table") {
        block.rows.forEach(row => used.add(row.id));
        block.columns.forEach(column => used.add(column.id));
      }
    }
  }
  let id: string = supplierFixturesSection.id;
  for (let n = 1; used.has(id); n++) id = `${supplierFixturesSection.id}-default-${n}`;
  const sections = [...document.sections];
  const uploaded = sections.findIndex(section => section.role === "uploaded-documents");
  sections.splice(uploaded < 0 ? sections.length : uploaded + 1, 0, { ...supplierFixturesSection, id, title: supplierFixturesTitle(sections), blocks: [] });
  return { ...document, supplierFixturesVersion: 1, sections };
}

function withoutUpdates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUpdates);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "update").sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => [key, withoutUpdates(entry)]));
  return value;
}
function sameEntry(a: unknown, b: unknown): boolean {
  return JSON.stringify(withoutUpdates(a)) === JSON.stringify(withoutUpdates(b));
}
function validUpdate(update?: KnowledgeEntryUpdate): KnowledgeEntryUpdate | undefined {
  return update && typeof update.updatedBy === "string" && update.updatedBy.trim() && typeof update.updatedAt === "string" && Number.isFinite(Date.parse(update.updatedAt))
    ? { updatedBy: update.updatedBy, updatedAt: update.updatedAt } : undefined;
}
function contributionUpdate(item: DemoState["contributions"][number]): KnowledgeEntryUpdate {
  return { updatedBy: item.reviewer ?? item.author, updatedAt: item.publishedAt ?? item.reviewedAt ?? item.createdAt };
}
function findBlock(document: KnowledgeDocument, id: string) {
  return document.sections.flatMap(section => section.blocks).find(block => block.id === id);
}
function rowValue(block: KnowledgeBlock | undefined, id: string) {
  if (block?.type !== "table") return undefined;
  const row = block.rows.find(item => item.id === id);
  return row ? { cells: row.cells, columns: block.columns.map(column => ({ id: column.id, name: column.name })) } : undefined;
}

/** Existing history is evidence; missing legacy attribution stays unknown. */
export function knowledgeEntryUpdate(state: DemoState, target: KnowledgeTarget, blockId: string, rowId?: string): KnowledgeEntryUpdate | undefined {
  return knowledgeEntryUpdateLookup(state, target)(blockId, rowId);
}

/** Build one lookup per document so large tables do not rebuild records for every row. */
export function knowledgeEntryUpdateLookup(state: DemoState, target: KnowledgeTarget, document = knowledgeDocument(state, target)) {
  const blockMap = (doc: KnowledgeDocument) => new Map(doc.sections.flatMap(section => section.blocks).map(block => [block.id, block]));
  const blocks = blockMap(document);
  const key = knowledgeKey(state, target);
  const revisions = (state.knowledgeHistory ?? []).filter(item => knowledgeKey(state, item.target) === key)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map(item => ({ revision: item, before: blockMap(item.before), after: blockMap(item.after) }));
  const contributions = state.contributions.filter(item => item.status === "approved" && item.targetType === target.kind && item.targetId === target.id && !item.knowledgeChange && !item.extractionBatch && !item.tabChanges && !item.proposedKeyInfo)
    .sort((a, b) => Date.parse(contributionUpdate(b).updatedAt) - Date.parse(contributionUpdate(a).updatedAt));
  return (blockId: string, rowId?: string): KnowledgeEntryUpdate | undefined => {
    const current = blocks.get(blockId);
    if (!current) return undefined;
    const recorded = validUpdate(rowId && current.type === "table" ? current.rows.find(row => row.id === rowId)?.update : current.update);
    if (recorded) return recorded;
    const currentValue = rowId ? rowValue(current, rowId) : current;
    for (const { revision, before, after } of revisions) {
      const afterBlock = after.get(blockId), beforeBlock = before.get(blockId);
      const afterValue = rowId ? rowValue(afterBlock, rowId) : afterBlock;
      const beforeValue = rowId ? rowValue(beforeBlock, rowId) : beforeBlock;
      if (sameEntry(currentValue, afterValue) && !sameEntry(beforeValue, afterValue)) return { updatedBy: revision.by, updatedAt: revision.at };
    }
    if (current.type === "text") {
      const contribution = contributions.find(item => item.body === current.text);
      if (contribution) return contributionUpdate(contribution);
    }
    return undefined;
  };
}

export function knowledgeKeyInfoUpdate(state: DemoState, portId: string, field: keyof IntelligenceKeyInfo): KnowledgeEntryUpdate | undefined {
  const port = state.ports.find(item => item.id === portId);
  const recorded = validUpdate(port?.intelligenceEntryUpdates?.[field]);
  if (recorded) return recorded;
  const current = port?.intelligenceKeyInfo ?? emptyIntelligenceKeyInfo();
  const contributions = state.contributions.filter(item => item.status === "approved").sort((a, b) => Date.parse(contributionUpdate(b).updatedAt) - Date.parse(contributionUpdate(a).updatedAt));
  for (const item of contributions) {
    const change = item.extractionBatch?.intelligenceChanges.find(change => change.portId === portId);
    const before = change?.baseKeyInfo ?? (item.targetType === "port" && item.targetId === portId ? item.keyInfoBase : undefined);
    const after = change?.keyInfo ?? (item.targetType === "port" && item.targetId === portId ? item.proposedKeyInfo : undefined);
    if (before && after && after[field] === current[field] && before[field] !== after[field]) return contributionUpdate(item);
  }
  return undefined;
}

/** Actor/time are assigned by publication, never by the submitted editor document. */
function stampKnowledgeEntries(state: DemoState, target: KnowledgeTarget, before: KnowledgeDocument, document: KnowledgeDocument, by: string, at: string): KnowledgeDocument {
  const stamp = { updatedBy: by, updatedAt: at };
  const previousUpdate = knowledgeEntryUpdateLookup(state, target, before);
  return { ...document, sections: document.sections.map(section => ({ ...section, blocks: section.blocks.map(block => {
    const previous = findBlock(before, block.id);
    const update = sameEntry(previous, block) ? previousUpdate(block.id) : stamp;
    const { update: _submitted, ...content } = block;
    if (content.type !== "table") return { ...content, ...(update ? { update } : {}) };
    return { ...content, ...(update ? { update } : {}), rows: content.rows.map(row => {
      const rowUpdate = sameEntry(rowValue(previous, row.id), rowValue(block, row.id)) ? previousUpdate(block.id, row.id) : stamp;
      return { id: row.id, cells: row.cells, ...(rowUpdate ? { update: rowUpdate } : {}) };
    }) };
  }) })) };
}

export function sameKnowledge(a: KnowledgeDocument, b: KnowledgeDocument) {
  return sameEntry(a.sections, b.sections);
}
function text(value: unknown, max: number) {
  if (typeof value !== "string" || value.length > max)
    throw new Error(
      `Text must be ${max.toLocaleString()} characters or fewer.`,
    );
  return value;
}
export function validateKnowledge(
  document: KnowledgeDocument,
): KnowledgeDocument {
  if (
    !document ||
    !Array.isArray(document.sections) ||
    (document.sections.length < 1 && document.layoutVersion !== KNOWLEDGE_LAYOUT_VERSION) ||
    document.sections.length > 58
  )
    throw new Error("Use up to 50 additional sections alongside the default tabs.");
  // The seven fixed location tabs must not consume the capacity of a valid
  // legacy document containing fifty custom sections. Duplicate headings count
  // as additional sections, so the bound cannot grow through repeated aliases.
  if (document.layoutVersion !== undefined && document.layoutVersion !== KNOWLEDGE_LAYOUT_VERSION) throw new Error("The tab layout is invalid.");
  if (document.supplierFixturesVersion !== undefined && document.supplierFixturesVersion !== 1) throw new Error("The supplier tab layout is invalid.");
  const defaultTitles = new Set<string>(["Port Information", ...countryKnowledgeSections.map(section => section.title)]);
  const fixedCount = new Set(document.sections.flatMap(section => section.role ? [section.role] : document.layoutVersion === undefined && defaultTitles.has(section.title) ? [section.title] : [])).size;
  const roles = new Set<KnowledgeSectionRole>();
  if (document.sections.length - fixedCount > 50) throw new Error("Use up to 50 additional sections alongside the default tabs.");
  const ids = new Set<string>();
  const id = (value: string) => {
    text(value, 100);
    if (!value || ids.has(value))
      throw new Error("Each item must have a unique ID.");
    ids.add(value);
    return value;
  };
  const title = (value: string) => {
    text(value, 150);
    if (!value.trim()) throw new Error("Enter a title.");
    return value.trim();
  };
  let fileCount = 0;
  const sections = document.sections.map((s) => {
    if (s.role !== undefined && (!sectionRoles.includes(s.role) || roles.has(s.role))) throw new Error("Each tab type must be unique.");
    if (s.role) roles.add(s.role);
    const uploaded = s.role === "uploaded-documents" || (document.layoutVersion === undefined && s.title === "Uploaded Documents");
    if (!Array.isArray(s.blocks) || s.blocks.length > (uploaded ? 5100 : 100) || (uploaded && s.blocks.filter(block => block.type !== "file").length > 100))
      throw new Error("Use up to 100 information blocks per section.");
    if (s.role === "price-history" && s.blocks.length) throw new Error("Price History uses recorded prices. Choose another tab for information.");
    if (s.role === "supplier-fixtures" && s.blocks.length) throw new Error("Fixtures uses recorded fixtures. Choose another tab for information.");
    return {
      id: id(s.id),
      title: title(s.title),
      ...(s.role ? { role: s.role } : {}),
      blocks: s.blocks.map((b): KnowledgeBlock => {
        const common = { id: id(b.id), title: title(b.title), ...(validUpdate(b.update) ? { update: validUpdate(b.update) } : {}), ...(b.provenance ? { provenance: validateKnowledgeProvenance(b.provenance) } : {}) };
        if (b.type === "text")
          return { ...common, type: "text", text: text(b.text, 30000) };
        if (b.type === "file") {
          if (++fileCount > 5000) throw new Error("Use up to 5,000 file links per information record.");
          const url = text(b.url, 2048);
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            throw new Error("Enter a valid HTTPS file link.");
          }
          if (
            parsed.protocol !== "https:" ||
            parsed.username ||
            parsed.password
          )
            throw new Error("Use an HTTPS file link without credentials.");
          return { ...common, title: title(b.title), type: "file", url };
        }
        if (
          b.type !== "table" ||
          !Array.isArray(b.columns) ||
          b.columns.length < 1 ||
          b.columns.length > 30 ||
          !Array.isArray(b.rows) ||
          b.rows.length > 1000
        )
          throw new Error("Tables support 1–30 columns and up to 1,000 rows.");
        const columns = b.columns.map((c) => {
          if (
            c.width !== undefined &&
            (!Number.isFinite(c.width) || c.width < 100 || c.width > 600)
          )
            throw new Error("Column width must be between 100 and 600 pixels.");
          return {
            id: id(c.id),
            name: title(c.name),
            ...(c.width !== undefined ? { width: c.width } : {}),
          };
        });
        const rows = b.rows.map((r) => {
          if (!Array.isArray(r.cells) || r.cells.length !== columns.length)
            throw new Error("Each table row must match its columns.");
          return { id: id(r.id), cells: r.cells.map((v) => text(v, 5000)), ...(validUpdate(r.update) ? { update: validUpdate(r.update) } : {}) };
        });
        return { ...common, type: "table", columns, rows };
      }),
    };
  });
  if (JSON.stringify(sections).length > 500000)
    throw new Error("Keep each information record below 500 KB.");
  return { version: document.version, ...(document.layoutVersion ? { layoutVersion: document.layoutVersion } : {}), ...(document.supplierFixturesVersion ? { supplierFixturesVersion: document.supplierFixturesVersion } : {}), sections };
}
export function validateKnowledgeProvenance(value: KnowledgeProvenance): KnowledgeProvenance {
  const source = text(value.source, 2048).trim();
  const evidence = text(value.evidence, 6000).trim();
  if (!evidence) throw new Error('Keep the source excerpt for extracted information.');
  const date = value.date === undefined ? undefined : text(value.date, 10);
  if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('Enter a valid source date.');
  return { source, evidence, ...(date ? { date } : {}) };
}
export function checkKnowledgeChange(
  state: DemoState,
  change: KnowledgeChange,
  allowEmpty = false,
): KnowledgeChange {
  if (change.target.kind === "area") throw new Error("This information record is archived. Select its country or port.");
  const target = canonicalTarget(state, change.target), before = knowledgeDocument(state, target);
  const baseDocument = change.baseDocument ? withRequiredKnowledgeTitles(state, target, withDefaultKnowledgeSections(change.baseDocument, target.kind)) : undefined;
  const proposed = change.document?.layoutVersion === undefined && Array.isArray(change.document?.sections)
    ? { ...change.document, sections: change.document.sections.map(section => {
      const baseRole = baseDocument?.sections.find(item => item.id === section.id)?.role;
      return baseRole ? { ...section, role: baseRole } : section;
    }) } : change.document;
  // A draft opened before compulsory titles may still contain legacy blanks.
  // Backfill only IDs already blank in that draft's base; clearing a current title
  // or submitting a new untitled block must continue to fail validation.
  const legacyUntitled = new Set(change.baseDocument?.sections.flatMap(section => section.blocks.filter(block => !block.title.trim()).map(block => block.id)));
  const titledProposal = legacyUntitled.size && Array.isArray(proposed?.sections) ? { ...proposed, sections: proposed.sections.map(section => ({ ...section, blocks: section.blocks.map(block => {
    const original = legacyUntitled.has(block.id) ? findBlock(baseDocument!, block.id) : undefined;
    return !block.title.trim() && original ? { ...block, title: original.title } : block;
  }) })) } : proposed;
  const document = validateKnowledge(withDefaultKnowledgeSections(titledProposal, target.kind));
  if (!allowEmpty && !document.sections.length) throw new Error("Keep at least one tab.");
  if (target.kind !== "port" && document.sections.some(section => section.role === "port-information" || section.role === "price-history")) throw new Error("Port Information and Price History belong to a port.");
  if (target.kind !== "supplier" && document.sections.some(section => section.role === "supplier-information" || section.role === "supplier-fixtures")) throw new Error("Supplier Information and Fixtures belong to a supplier.");
  if (target.kind === "supplier" && document.sections.some(section => section.role && !supplierKnowledgeSections.some(item => item.role === section.role))) throw new Error("Choose a supplier tab type.");
  if (
    !Number.isInteger(change.baseVersion) ||
    before.version !== change.baseVersion ||
    !change.baseDocument ||
    !sameKnowledge(before, baseDocument!)
  )
    throw new Error(
      "Information changed. Reopen the editor and reconcile this update before publishing.",
    );
  for (const section of document.sections) {
    const previous = before.sections.find(item => item.id === section.id);
    if (previous && previous.role !== section.role) throw new Error("Keep each tab's type unchanged.");
  }
  if (sameKnowledge(before, document)) throw new Error("No changes to save.");
  return {
    target,
    baseVersion: before.version,
    baseDocument: structuredClone(before),
    document: { ...document, version: before.version },
  };
}
export function publishKnowledge(
  state: DemoState,
  change: KnowledgeChange,
  by: string,
  at: string,
  reason: string,
  source?: string,
  allowEmpty = false,
) {
  const checked = checkKnowledgeChange(state, change, allowEmpty),
    before = knowledgeDocument(state, checked.target);
  const after = { ...stampKnowledgeEntries(state, checked.target, before, checked.document, by, at), version: before.version + 1 };
  state.knowledgeRecords ??= {};
  state.knowledgeRecords[knowledgeKey(state, checked.target)] = after;
  state.knowledgeHistory ??= [];
  state.knowledgeHistory.unshift({
    target: checked.target,
    version: after.version,
    at,
    by,
    reason,
    source,
    before: structuredClone(before),
    after: structuredClone(after),
  });
}
/** Excel clipboard paste, starting at the focused cell. Stable IDs survive edits. */
export function pasteKnowledgeTable(
  table: Extract<KnowledgeBlock, { type: "table" }>,
  row: number,
  col: number,
  clipboard: string,
  makeId: () => string,
) {
  const lines = clipboard
    .replace(/\r\n?/g, "\n")
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.split("\t"));
  const width = Math.max(
      table.columns.length,
      col + Math.max(...lines.map((l) => l.length)),
    ),
    height = Math.max(table.rows.length, row + lines.length);
  if (width > 30 || height > 1000)
    throw new Error("Tables support up to 30 columns and 1,000 rows.");
  const next = structuredClone(table);
  while (next.columns.length < width)
    next.columns.push({
      id: makeId(),
      name: `Column ${next.columns.length + 1}`,
    });
  while (next.rows.length < height) next.rows.push({ id: makeId(), cells: [] });
  next.rows.forEach((r) => {
    while (r.cells.length < width) r.cells.push("");
  });
  lines.forEach((line, r) =>
    line.forEach((value, c) => (next.rows[row + r].cells[col + c] = value)),
  );
  return next;
}
