import type { ParserFields, ParserSnapshot } from '../../shared/parserService';
import { formatEnquiry, type ParsedEnquiry, type ParserCompany, type ParserPort } from './parser';
import { parseEnquiryWorksheetGuess } from '../vendor/fcuno/lib/enquiryWorksheetParser';

/** Copy evidence at parse time, before any manual edits or AI application. */
export function captureParserSnapshot(raw: string, parsed: ParsedEnquiry, companies: ParserCompany[], ports: ParserPort[]): ParserSnapshot {
  const buyerText = companies.find(item => item.id === parsed.buyerId)?.name || parsed.buyerText;
  const portText = ports.find(item => item.id === parsed.portId)?.name || parseEnquiryWorksheetGuess(raw, { detectBuyer: true, portNames: ports.map(item => item.name) }).port;
  const fields: ParserFields = { vessel: parsed.vessel, imo: parsed.imo, buyerText, portText, eta: parsed.eta, hsfo: parsed.hsfo, vlsfo: parsed.vlsfo, lsmgo: parsed.lsmgo, remarks: parsed.remarks };
  return { fields, standardText: formatEnquiry({ ...parsed, buyerName: buyerText, portName: portText }), warnings: [...parsed.warnings], rmk: parsed.rmk, viscosity: [...parsed.vlsfoMaxRemarks] };
}
