import type { DemoState } from "./model";
import type { KnowledgeSection, KnowledgeBlock } from "./knowledge";
import { singaporeRefineries } from "./intelligence";
/** Illustrative content only. No private FCUNO records are imported. */
export function demoKnowledgeSections(
  state: DemoState,
  portId: string,
): KnowledgeSection[] {
  const table = (
    id: string,
    title: string,
    headers: string[],
    rows: string[][],
  ): KnowledgeBlock => ({
    id,
    type: "table",
    title,
    columns: headers.map((name, i) => ({
      id: `${id}-c${i}`,
      name,
      width: ["HSFO", "VLSFO", "LSMGO"].includes(name)
        ? 100
        : name === "Remarks"
          ? 250
          : 160,
    })),
    rows: rows.map((cells, i) => ({ id: `${id}-r${i}`, cells })),
  });
  const prose = (id: string, title: string, text: string): KnowledgeBlock => ({
    id,
    type: "text",
    title,
    text,
  });
  const buyers = state.companies
    .filter(
      (c) =>
        state.enquiries.some(
          (e) => e.buyerId === c.id && e.portId === portId,
        ) ||
        state.outcomes.some((e) => e.buyerId === c.id && e.portId === portId),
    )
    .slice(0, 8);
  return [
    {
      id: "refineries",
      title: "Refineries",
      blocks: [
        table(
          "refinery-data",
          "Refineries",
          ["Name", "Location", "Capacity"],
          (portId === "port-singapore" ? singaporeRefineries : []).map((r) => [
            r.name,
            r.location,
            r.capacity,
          ]),
        ),
      ],
    },
    {
      id: "supplier-portfolio",
      title: "Supplier Portfolio",
      blocks: [
        table(
          "supplier-comparison",
          "Supplier comparison · Demo",
          ["Supplier", "HSFO", "VLSFO", "LSMGO", "Delivery", "Remarks"],
          [],
        ),
      ],
    },
    {
      id: "customer-portfolio",
      title: "Customer Portfolio",
      blocks: [
        table(
          "customer-comparison",
          "Customer requirements",
          ["Customer", "Contact", "Country", "Remarks"],
          buyers.map((c) => [c.name, c.contact, c.country, c.notes]),
        ),
      ],
    },
    {
      id: "anchorage",
      title: "Anchorage Info",
      blocks: [
        table(
          "anchorage-checklist",
          "Delivery arrangements",
          ["Item", "Information", "Source"],
          [
            [
              "Agent",
              "Confirm the appointed agent and contact before nomination.",
              "Demo",
            ],
            [
              "Receiving arrangement",
              "Record the receiving vessel and delivery arrangement for the enquiry.",
              "Demo",
            ],
            [
              "Delivery window",
              "Confirm the latest schedule with the agent and supplier.",
              "Demo",
            ],
          ],
        ),
      ],
    },
    {
      id: "debunkering",
      title: "Debunkering",
      blocks: [
        prose(
          "debunkering-arrangements",
          "Arrangements",
          "Record the reason, quantity, product and proposed receiving arrangement. Confirm supplier availability and applicable requirements for the specific enquiry.",
        ),
        table(
          "debunkering-checklist",
          "Enquiry checklist",
          ["Item", "Information"],
          [
            ["Product / quantity", "Record grade and estimated quantity."],
            [
              "Receiving party",
              "Confirm the receiving party and arrangements.",
            ],
            [
              "Cost / timing",
              "Obtain a written quotation and proposed schedule.",
            ],
          ],
        ),
      ],
    },
    {
      id: "supplier-introduction",
      title: "Supplier Introduction",
      blocks: [],
    },
    {
      id: "sub-agents",
      title: "Sub-agent Directory",
      blocks: [
        table(
          "agent-directory",
          "Contacts",
          ["Company", "Contact", "Service", "Remarks"],
          [],
        ),
      ],
    },
  ];
}

/** Add rich, titled sample profiles only where no edited document or contribution exists. */
export function enrichDemoKnowledge(state: DemoState, now = new Date()) {
  state.knowledgeRecords ??= {};
  const stamp = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const text = (id: string, title: string, value: string, author = 'gianmichele'): KnowledgeBlock => ({ id, type: 'text', title, text: value, update: { updatedBy: author, updatedAt: stamp }, provenance: { source: 'FICTIONAL DEMO SCENARIO', evidence: 'SYNTHETIC COMMERCIAL EXAMPLE' } });
  const grid = (id: string, title: string, columns: string[], cells: string[][]): KnowledgeBlock => ({ id, type: 'table', title, columns: columns.map((name, i) => ({ id: `${id}-c${i}`, name, width: i === 0 ? 170 : 230 })), rows: cells.map((row, i) => ({ id: `${id}-r${i}`, cells: row })), update: { updatedBy: 'silvia', updatedAt: stamp }, provenance: { source: 'FICTIONAL DEMO SCENARIO', evidence: 'SYNTHETIC COMMERCIAL EXAMPLE' } });
  const put = (kind: 'port' | 'country' | 'supplier', id: string, sections: KnowledgeSection[]) => {
    const key = `${kind}:${id}`;
    if (state.knowledgeRecords![key] || state.knowledgeHistory?.some(item => item.target.kind === kind && item.target.id === id) || state.contributions.some(item => item.targetType === kind && item.targetId === id && item.status === 'approved')) return;
    state.knowledgeRecords![key] = { version: 0, layoutVersion: 2, ...(kind === 'supplier' ? { supplierFixturesVersion: 1 as const } : {}), sections };
  };
  for (const port of state.ports) {
    if (!/^port-(singapore|hong-kong|rotterdam|fujairah|busan|tokyo|chiba|yokohama|osaka|ho-chi-minh|gibraltar)$/.test(port.id)) continue;
    const original = [port.summary, ...port.notes].filter(Boolean).join('\n');
    put('port', port.id, [
      { id: 'general', title: 'Port Information', role: 'port-information', blocks: [
        text('demo-v2-port-planning', 'Delivery planning', `DEMO: ${port.name.toUpperCase()} DELIVERY WINDOW TO BE CONFIRMED WITH THE AGENT BEFORE NOMINATION. SEND VESSEL IMO, ARRIVAL / DEPARTURE WINDOW, QUANTITY BY GRADE AND RECEIVING RATE TOGETHER.`, 'gianmichele'),
        text('demo-v2-port-quality', 'Specification and claims', 'DEMO: RECORD THE AGREED ISO EDITION, SAMPLE LOCATION AND QUALITY CLAIM PERIOD ON THE QUOTE. REQUEST COQ BEFORE CONFIRMING THE STEM. KEEP WRITTEN SUPPLIER ACCEPTANCE WITH THE FIXTURE.', 'otto'),
        ...(original ? [{ id: 'demo-v2-port-existing', type: 'text' as const, title: 'Desk reference', text: original }] : []),
      ] },
      { id: 'suppliers', title: 'Suppliers', role: 'suppliers', blocks: [] },
      { id: 'refineries', title: 'Refineries', role: 'refineries', blocks: port.id === 'port-singapore' ? [grid('demo-v2-refinery', 'Refineries', ['Name', 'Location', 'Capacity'], singaporeRefineries.map(item => [item.name, item.location, item.capacity]))] : [] },
      { id: 'grades-delivery', title: 'Grades and delivery modes', role: 'grades-delivery', blocks: [grid('demo-v2-grade-planning', 'Nomination requirements', ['Grade', 'Quantity', 'Information required'], [['VLSFO', 'PER ENQUIRY', 'ISO EDITION / VISCOSITY / COQ'], ['LSMGO', 'PER ENQUIRY', 'FLASH POINT / SULPHUR / CONNECTION'], ['HSFO', 'PER ENQUIRY', 'VESSEL SUITABILITY / RECEIVING CAPACITY']])] },
      { id: 'tax-regulations', title: 'Tax and regulations', role: 'tax-regulations', blocks: [text('demo-v2-port-documents', 'Delivery documentation', 'DEMO: CONFIRM THE REQUIRED DECLARATIONS AND INVOICE BUYER WITH THE AGENT. TAX TREATMENT MUST BE AGREED FOR THE SPECIFIC DELIVERY; NO ASSUMPTION IS INCLUDED IN THESE SAMPLE PRICES.')] },
      { id: 'trader-remarks', title: "Trader's Remarks", role: 'trader-remarks', blocks: [text('demo-v2-port-handover', 'Desk handover', 'DEMO: SHARE THE LATEST SUPPLIER QUOTE VALIDITY, DELIVERY WINDOW AND OPEN CREDIT REQUEST WITH THE NEXT DESK. USE THE SAME ENQUIRY RECORD WHEN ANOTHER TRADER IS ALREADY WORKING THIS ACCOUNT.')] },
      { id: 'uploaded-documents', title: 'Uploaded Documents', role: 'uploaded-documents', blocks: [] },
      { id: 'price-history', title: 'Price History', role: 'price-history', blocks: [] },
    ]);
  }
  for (const country of state.locationCountries ?? []) {
    if (!['Japan', 'Netherlands', 'United Arab Emirates'].includes(country.name)) continue;
    put('country', country.id, [{ id: 'general', title: 'Country Information', blocks: [
      text('demo-v2-country-entity', 'Buyer and invoicing', `DEMO: ${country.name.toUpperCase()} ENQUIRIES MUST IDENTIFY THE LEGAL BUYING ENTITY AND DELIVERY PORT. KEEP THE APPROVED PAYMENT TERMS WITH THE BUYER PROFILE.`),
      grid('demo-v2-country-ports', 'Port coverage', ['Port', 'Code', 'Desk lead time'], state.ports.filter(port => port.country === country.name).map(port => [port.name, port.code || 'CONFIRM', port.leadTime || 'CONFIRM WITH SUPPLIER'])),
    ] }]);
  }
}
