import { parseEnquiryWorksheetGuess } from '../vendor/fcuno/lib/enquiryWorksheetParser.ts'
import { normalizeIndexedEnquiryPort, normalizePortKey } from '../vendor/fcuno/lib/enquiryPortIndex.ts'
import { buildSpcStandardEnquiry, parseSpcEnquiryText, spcFuelInputValue } from '../vendor/fcuno/lib/spcEnquiryText.ts'
import { detectAttentionTerms, detectSpcCautionTerms, formatSpcCautionWarning, replaceHsfoWithRmk, type VlsfoMaxRemark } from '../vendor/fcuno/lib/enquiryShortener.ts'
import { parseProductQuantity } from '../../shared/productQuantity.ts'
import type { EnquiryProduct } from './model.ts'

export type ParserCompany = { id: string; name: string; aliases: string[] }
export type ParserPort = { id: string; name: string; code: string }
export type ProductFields = { hsfo?: string; vlsfo?: string; lsmgo?: string }
export type ParsedEnquiry = {
  vessel: string
  imo: string
  buyerText: string
  buyerId: string
  portId: string
  eta: string
  hsfo: string
  vlsfo: string
  lsmgo: string
  remarks: string
  rmk: boolean
  vlsfoMaxRemarks: string[]
  products: EnquiryProduct[]
  grade: string
  quantity: number
  price: number
  margin: number
  warnings: string[]
  confidence: 'high' | 'medium' | 'low'
}

const fuelKeys = ['hsfo', 'vlsfo', 'lsmgo'] as const
const cleanKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const gradePattern = /\b(VLSFO|VSLFO|LSMFO|LSFO|HSFO|HFO|IFO|RMK|LSMGO|MGO|DMA|DMB|MDO|LSGO)\b/gi
const canonicalGrade = (value: string) => /^(?:VLSFO|VSLFO|LSMFO|LSFO)$/i.test(value)
  ? 'VLSFO' : /^(?:HSFO|HFO|IFO|RMK)$/i.test(value) ? 'HSFO' : 'LSMGO'
const unsupportedUnitPattern = /(?<![A-Za-z])(?:c\s*\.?\s*b\s*\.?\s*m|m3|m³|k\s*\.?\s*l|kg|kilograms?|lit(?:er|re)s?|bbls?|barrels?|gallons?)(?![A-Za-z0-9])/i

/** Preserve the pinned SPC/FCUNO source cautions without selecting or converting a specification. */
export function enquirySourceWarnings(raw: string, nonMtQuantity = false): string[] {
  const source = String(raw || '')
    .replace(/\b(rmk)(?=\d{2,3}\b)/gi, '$1 ')
    .replace(/(\d)(?=[A-Za-z])/g, '$1 ')
  const caution = detectSpcCautionTerms(source)
  const units = detectAttentionTerms(source).filter(term => term !== 'RMK')
  const unitWarning = nonMtQuantity
    ? 'A non-MT quantity unit was found. Convert and confirm the quantity in MT.'
    : 'Check remarks and quantity unit before sending.'
  return [
    ...(caution.length ? [formatSpcCautionWarning(caution)] : []),
    ...(units.length ? [`WARNING: ${units.join(' / ')} spotted. ${unitWarning}`] : nonMtQuantity ? [`WARNING: ${unitWarning}`] : []),
  ]
}

function standaloneNonMtQuantity(line: string): boolean {
  const unit = line.trim().replace(/^(?:quantity|qty|units?)\s*[:=]?\s*/i, '')
    .replace(/^[+-]?\d[\d,.]*(?:\s*(?:-|\/|to|~)\s*\d[\d,.]*)?\s*/i, '')
  return new RegExp(`^(?:${unsupportedUnitPattern.source})\\.?$`, 'i').test(unit)
}

export function productsFromFields(fields: ProductFields): EnquiryProduct[] {
  return fuelKeys.flatMap(key => fields[key]?.trim()
    ? [{ grade: key.toUpperCase() as EnquiryProduct['grade'], quantityText: fields[key]!.trim() }]
    : [])
}

/** Buyer identity and commercial terms stay in the internal record. */
export function stripCommercialDetails(value: string): string {
  const financial = /\b(?:estimated\s+)?(?:price|pricing|margin|profit)\b\s*(?::|=|(?:USD\s*|\$\s*)?[-+]?\d)|\bUSD\s*[-+]?\d|\$\s*[-+]?\d/i
  const text = String(value || '').replace(/\b(?:estimated\s+)?(?:price|pricing|margin|profit)\b\s*\([^\n)]{0,40}\)\s*[:=]?\s*(?:USD\s*|\$\s*)?[-+]?\d[\d,.]*(?:\s*USD)?(?:\s*\/\s*MT)?/gi, '')
  return text.split(/\r?\n/).map(line => line.split(/\s*\/\s*/)
    .map(part => {
      if (/^\s*(?:buyer|client|for\s+account(?:\s+of)?|account(?:\s+name)?)\s*[:=]/i.test(part)) return ''
      const start = part.search(financial)
      return (start < 0 ? part : part.slice(0, start)).replace(/[\s,;:–—-]+$/, '').trim()
    })
    .filter(part => part && !/^MT$/i.test(part)).join(' / '))
    .filter(Boolean).join('\n')
}

const buyerLabelPattern = /^\s*(?:\d+\s*[).:-]\s*)?(?:buyer|client|for\s+account(?:\s+of)?|account(?:\s+name)?|for\s+a\/?c(?:\s+of)?|a\/?c|acct|for\s+acct(?:\s+of)?)\b/i
const portLabelPattern = /^\s*(?:[-•*=]\s*\.?\s*)?(?:\d+\s*[).:-]\s*)?(?:port|position|location|bunker(?:ing)?\s*(?:port|location|place)|refuell?ing\s*(?:port|location|place)|port\s+of\s+(?:call|delivery|supply)|delivery\s+(?:port|place|location)|place\s+of\s+(?:supply|delivery)|loading\s+port|discharging\s+port|加油港口|港口|地点|地點)/i
const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const monthToken = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'

/** Keep date assumptions out of the reusable upstream modules. */
function reviewedEta(source: string, parsedEta: string): { eta: string; warnings: string[] } {
  const parts = source.split(/\n|\s+\/\s+/).map(part => part.trim()).filter(Boolean)
  const labels = parts.filter(part => /^\s*(?:e\.?t\.?[abds]\.?|a\.?t\.?a\.?|delivery\s+(?:date|window)|laycan|date)\b\s*[:=]?/i.test(part))
  const context = (labels.length ? labels : parts.filter(part =>
    !/^(?:remarks?|notes?|buyer|client|a\/?c|acct|account|from|sent|subject|iso)\b/i.test(part) &&
    (new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s*[-./ ]*${monthToken}\\b|\\b${monthToken}\\s+\\d{1,2}`, 'i').test(part) || /\b\d{1,4}[./-]\d{1,2}[./-]\d{1,4}\b|\d\s*[月日号월일]/.test(part)))).join('\n')
  const warnings: string[] = []
  const namedMonth = new RegExp(`\\b${monthToken}\\b`, 'i').test(context)
  const explicitMonth = namedMonth || /\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b|\b\d{1,2}[./]\d{1,2}\b|\b\d{1,2}-\d{1,2}-\d{4}\b|\d\s*[月월]/.test(context)
  if ((parsedEta || /\d/.test(context)) && !explicitMonth) warnings.push('The delivery month is missing. Confirm the full delivery dates.')
  // Date punctuation does not establish a sender's day/month convention.
  const numeric = /(?<![\d./-])(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}))?(?![\d./])/g
  for (const match of context.matchAll(numeric)) {
    const after = context.slice((match.index ?? 0) + match[0].length)
    if (new RegExp(`^\\s*(?:of\\s+)?${monthToken}\\b`, 'i').test(after)) continue // 1/5 AUG is a range.
    const first = Number(match[1]), second = Number(match[2])
    if (first !== second && first >= 1 && first <= 12 && second >= 1 && second <= 12) {
      warnings.push('The numeric delivery date is ambiguous. Use a month name and confirm the dates.')
      break
    }
  }
  const dates: { day: number; month: number; year?: number }[] = []
  const named = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${monthToken})(?:\\s*,?\\s*([1-9]\\d{3}))?\\b`, 'gi')
  for (const match of context.matchAll(named)) dates.push({ day: Number(match[1]), month: monthNames.indexOf(match[2].slice(0, 3).toLowerCase()) + 1, year: match[3] ? Number(match[3]) : undefined })
  const namedRange = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|/|to|~)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthToken})(?:\\s*,?\\s*([1-9]\\d{3}))?\\b`, 'gi')
  for (const match of context.matchAll(namedRange)) dates.push({ day: Number(match[1]), month: monthNames.indexOf(match[3].slice(0, 3).toLowerCase()) + 1, year: match[4] ? Number(match[4]) : undefined })
  const monthFirst = new RegExp(`\\b(${monthToken})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*([1-9]\\d{3}))?\\b`, 'gi')
  for (const match of context.matchAll(monthFirst)) dates.push({ day: Number(match[2]), month: monthNames.indexOf(match[1].slice(0, 3).toLowerCase()) + 1, year: match[3] ? Number(match[3]) : undefined })
  const monthFirstRange = new RegExp(`\\b(${monthToken})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|/|to|~)\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*([1-9]\\d{3}))?\\b`, 'gi')
  for (const match of context.matchAll(monthFirstRange)) dates.push({ day: Number(match[3]), month: monthNames.indexOf(match[1].slice(0, 3).toLowerCase()) + 1, year: match[4] ? Number(match[4]) : undefined })
  for (const match of context.matchAll(/\b([1-9]\d{3})[./-](\d{1,2})[./-](\d{1,2})\b/g)) dates.push({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) })
  for (const match of context.matchAll(/(?<![\d./-])(\d{1,2})[./-](\d{1,2})[./-]([1-9]\d{3})\b/g)) {
    const first = Number(match[1]), second = Number(match[2])
    dates.push({ day: first > 12 || second <= 12 ? first : second, month: first > 12 || second <= 12 ? second : first, year: Number(match[3]) })
  }
  for (const match of context.matchAll(/(?:([1-9]\d{3})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g)) dates.push({ year: match[1] ? Number(match[1]) : undefined, month: Number(match[2]), day: Number(match[3]) })
  const years = [...new Set(dates.flatMap(date => date.year ? [date.year] : []))]
  const namedEndpoints = Array.from(context.matchAll(named), match => ({
    day: Number(match[1]), month: monthNames.indexOf(match[2].slice(0, 3).toLowerCase()) + 1, year: match[3] ? Number(match[3]) : undefined,
  }))
  if (namedEndpoints.length === 2 && !/\bor\b/i.test(context)) {
    const [first, last] = namedEndpoints
    if (first.year && last.year && Date.UTC(last.year, last.month - 1, last.day) < Date.UTC(first.year, first.month - 1, first.day)) {
      warnings.push('The delivery window ends before it starts. Confirm the full delivery dates.')
    } else if (years.length && (!first.year || !last.year) && (last.month < first.month || last.month === first.month && last.day < first.day)) {
      warnings.push('The delivery window crosses a year boundary. Confirm the year at both ends.')
    }
  }
  const invalid = dates.some(date => {
    const year = date.year ?? (years.length === 1 ? years[0] : undefined)
    if (!year && date.month === 2 && date.day === 29) return true
    const maxDay = date.month >= 1 && date.month <= 12 ? new Date(Date.UTC(year ?? 2000, date.month, 0)).getUTCDate() : 0
    return date.day < 1 || date.day > maxDay
  })
  if (invalid) warnings.push('The delivery date is invalid or needs a year. Confirm the full delivery dates.')
  if (warnings.length) return { eta: '', warnings }
  if (!parsedEta) return { eta: '', warnings }
  if (years.length > 1) {
    // Preserve explicit years in a cross-year schedule instead of rebuilding from a yearless shortener result.
    const explicitWindow = context.replace(/^\s*(?:e\.?t\.?[abds]\.?|a\.?t\.?a\.?|delivery\s+(?:date|window)|laycan|date)\s*[:=]?\s*/i, '').trim()
    return { eta: explicitWindow, warnings }
  }
  return { eta: years.length === 1 && !new RegExp(`\\b${years[0]}\\b`).test(parsedEta) ? `${parsedEta} ${years[0]}` : parsedEta, warnings }
}

/** Uses the FCUNO/SPC parsers locally; it never sends enquiries or fetches credit. */
export function parseEnquiry(raw: string, companies: ParserCompany[], ports: ParserPort[]): ParsedEnquiry {
  const source = String(raw || '').replace(/[–—−]/g, '-').replace(/\r\n?/g, '\n')
  const guess = parseEnquiryWorksheetGuess(source, { detectBuyer: true, portNames: ports.map(port => port.name) })
  const spc = parseSpcEnquiryText(source)
  const warnings = [...guess.warnings]
  const lines = source.split('\n')
  const explicitBuyers = [...new Set(lines.flatMap((line, index) => buyerLabelPattern.test(line)
    ? [parseEnquiryWorksheetGuess([line, lines[index + 1] || ''].join('\n'), { detectBuyer: true }).buyer].filter(Boolean) : []).map(cleanKey))]
  const buyerKey = cleanKey(guess.buyer)
  const matchBuyer = (key: string) => companies.filter(company => [company.name, ...company.aliases].some(alias => cleanKey(alias) === key))
  // A company name in a signature, vessel name or forwarded address is not buyer evidence.
  const candidates = buyerKey && explicitBuyers.length ? matchBuyer(buyerKey) : []
  const resolvedBuyerKeys = explicitBuyers.map(key => { const matches = matchBuyer(key); return matches.length === 1 ? `id:${matches[0].id}` : `text:${key}` })
  const conflictingBuyer = new Set(resolvedBuyerKeys).size > 1
  const buyer = candidates.length === 1 && !conflictingBuyer ? candidates[0] : undefined
  if (candidates.length > 1 || conflictingBuyer) warnings.push('Several companies match this buyer. Select the legal entity manually.')
  else if (!buyer) warnings.push('Buyer is not matched. Select an entity or request a new customer.')

  const canonicalPortKey = (value: string) => normalizeIndexedEnquiryPort(value, {
    portNames: ports.map(port => port.name), includeShortAliases: true,
  }) || normalizePortKey(value)
  const portKey = canonicalPortKey(guess.port)
  const portMatches = portKey ? ports.filter(port => [port.name, port.code].some(value => canonicalPortKey(value) === portKey)) : []
  const explicitPorts = lines.flatMap((line, index) => portLabelPattern.test(line)
    ? [parseEnquiryWorksheetGuess([line, lines[index + 1] || ''].join('\n'), { detectBuyer: false, portNames: ports.map(item => item.name) }).port].filter(Boolean) : [])
  const conflictingPort = new Set(explicitPorts.map(value => {
    const key = canonicalPortKey(value)
    const matches = ports.filter(item => [item.name, item.code].some(alias => canonicalPortKey(alias) === key))
    return matches.length === 1 ? `id:${matches[0].id}` : `text:${key}`
  })).size > 1
  const port = portMatches.length === 1 && !conflictingPort ? portMatches[0] : undefined
  if (conflictingPort) warnings.push('Several delivery ports are specified. Select the delivery port manually.')
  if (!port) warnings.push(guess.port ? `Port “${guess.port}” needs manual selection.` : 'Select the delivery port.')

  const fields = { hsfo: '', vlsfo: '', lsmgo: '' }
  const mentionedGrades = [...new Set(Array.from(source.matchAll(gradePattern), match => canonicalGrade(match[1])))]
  const quantitySource = source.replace(/(\d[\d,.]*)\s+\/\s+(?=\d)/g, (match, value: string, index: number) =>
    (new RegExp(`${monthToken}\\s*$`, 'i').test(source.slice(0, index)) || /\b\d{4}[./-]\d{1,2}[./-]$/.test(source.slice(0, index))) ? match : `${value}-`)
  const quantitySegments = quantitySource.split(/\n|\s+\/\s+/)
  const quantityLines = quantitySegments.filter(line => /\b(?:quantity|qty|VLSFO|VSLFO|LSMFO|LSFO|HSFO|HFO|IFO|RMK(?:\s*\d{2,3})?|LSMGO|MGO|DMA|DMB|MDO|LSGO)\b/i.test(line))
  const unsupportedUnits = unsupportedUnitPattern.test(quantityLines.join('\n')) || quantitySegments.some(standaloneNonMtQuantity)
  warnings.unshift(...enquirySourceWarnings(source, unsupportedUnits))

  for (const key of fuelKeys) {
    const grade = key.toUpperCase()
    const related = quantityLines.filter(line => Array.from(line.matchAll(gradePattern), match => canonicalGrade(match[1])).includes(grade as EnquiryProduct['grade']))
    // SPC normalizes units and signs, so validate original quantities before accepting its result.
    const negative = related.some(line => Array.from(line.matchAll(/-\s*\d[\d,.]*/g)).some(match => {
      const prefix = line.slice(0, match.index).trim()
      // A dash after a number belongs to a range, including SPC's spaced ranges.
      if (/\d$/.test(prefix)) return false
      const suffix = line.slice(match.index! + match[0].length).trim()
      return !prefix || /[:=]$/.test(prefix) || /\b(?:HSFO|HFO|IFO|RMK|VLSFO|VSLFO|LSFO|LSMGO|MGO|DMA|DMB|MDO|LSGO)(?:\s*\(?\d+(?:\.\d+)?%\)?)?$/i.test(prefix) || /^(?:MT|MTS)\b/i.test(suffix)
    })) || quantityLines.some(line => /^\s*(?:quantity|qty)\s*[:=]\s*-\s*\d/i.test(line))
    const perLineValues = [...new Set(related.map(line => spcFuelInputValue(parseSpcEnquiryText(line)[key], key)).filter(Boolean))]
    const conflicting = perLineValues.length > 1
    // Explicit product segments take precedence: a viscosity suffix in a full SPC
    // string can otherwise make the vendor parser borrow the next grade's amount.
    const value = perLineValues.length === 1 ? perLineValues[0] : spcFuelInputValue(spc[key], key)
    const parsed = parseProductQuantity(value)
    if (unsupportedUnits) continue
    if (negative) warnings.push(`${grade} quantity must be positive.`)
    else if (conflicting) warnings.push(`Conflicting ${grade} quantities. Confirm the quantity.`)
    else if (parsed) fields[key] = parsed.min === parsed.max ? String(parsed.min) : `${parsed.min}-${parsed.max}`
    else if (value || mentionedGrades.includes(grade as EnquiryProduct['grade'])) warnings.push(`Confirm the ${grade} quantity in MT.`)
  }
  const products = productsFromFields(fields)
  const onlyQuantity = products.length === 1 ? parseProductQuantity(products[0].quantityText) : null
  const quantity = onlyQuantity?.min === onlyQuantity?.max ? onlyQuantity?.min ?? 0 : 0
  const grade = products[0]?.grade || mentionedGrades[0] || ''
  if (!products.length && !warnings.some(warning => /quantity/i.test(warning))) warnings.push('Confirm a product and quantity in MT.')
  const schedule = reviewedEta(source, spc.eta)
  warnings.push(...schedule.warnings)
  if (!schedule.eta && !schedule.warnings.length) warnings.push('Add the delivery window.')
  const explicitRemarks = Array.from(source.matchAll(/^\s*(?:remarks?|notes?)\s*[:=]\s*(.+)$/gim), match => match[1])
  for (const term of ['COQ REQUIRED', '30D QUALITY TIME BAR', 'BIMCO TERMS']) {
    if (source.toUpperCase().includes(term) && !explicitRemarks.join(' / ').toUpperCase().includes(term)) explicitRemarks.push(term)
  }
  const remarks = stripCommercialDetails(explicitRemarks.join(' / '))
  const rmk = quantityLines.some(line => /\brmk(?:\s*\d{2,3})?\b/i.test(line) &&
    (/^\s*(?:(?:product|grade)\s*[:=]\s*)?rmk(?:\s*\d{2,3})?\s*(?:[:=]|\d|$)/i.test(line) ||
      Boolean(parseProductQuantity(spcFuelInputValue(parseSpcEnquiryText(line).hsfo, 'hsfo')))))
  const vlsfoMaxRemarks = ['80cst min', '120cst max', '180cst max'].filter(remark => {
    const [viscosity, bound] = remark.split(' ')
    return new RegExp(`\\b${viscosity.replace('cst', '\\s*cst')}\\s*${bound}\\b`, 'i').test(source)
  })
  const complete = Boolean(guess.vesselName && guess.imo && buyer && port && products.length && schedule.eta)
  return {
    vessel: guess.vesselName,
    imo: guess.imo,
    buyerText: guess.buyer || buyer?.name || '',
    buyerId: buyer?.id || '',
    portId: port?.id || '',
    eta: schedule.eta,
    ...fields,
    remarks,
    rmk,
    vlsfoMaxRemarks,
    products,
    grade,
    quantity,
    price: 0,
    margin: 0,
    warnings: [...new Set(warnings)],
    confidence: complete && !warnings.length ? 'high' : guess.vesselName || guess.imo ? 'medium' : 'low',
  }
}

/** A custom preview may change wording, but must describe the stored enquiry. */
export function compareEnquiryPreview(
  preview: string,
  expected: { vessel: string; imo: string; buyerId: string; portId: string; products: EnquiryProduct[]; eta?: string; rmk?: boolean; vlsfoMaxRemarks?: string[] },
  companies: ParserCompany[],
  ports: ParserPort[],
): { matches: boolean; differences: string[] } {
  const actual = parseEnquiry(stripCommercialDetails(preview), companies, ports)
  const differences: string[] = []
  const vesselKey = (value: string) => cleanKey(value.replace(/^\s*(?:M\s*[./]?\s*[VT])\s+/i, ''))
  if (vesselKey(actual.vessel) !== vesselKey(expected.vessel)) differences.push('Vessel')
  if (actual.imo !== expected.imo.trim()) differences.push('IMO')
  if (!actual.portId || actual.portId !== expected.portId) differences.push('Port')
  const quantities = (products: EnquiryProduct[]) => products.map(product => {
    const quantity = parseProductQuantity(product.quantityText)
    return `${product.grade}:${quantity?.min ?? 'invalid'}:${quantity?.max ?? 'invalid'}`
  }).sort().join('|')
  if (quantities(actual.products) !== quantities(expected.products)) differences.push('Products')
  if ((expected.rmk !== undefined && actual.rmk !== expected.rmk) ||
    (expected.vlsfoMaxRemarks !== undefined && [...actual.vlsfoMaxRemarks].sort().join('|') !== [...expected.vlsfoMaxRemarks].sort().join('|'))) differences.push('Specs')
  if (expected.eta !== undefined) {
    const expectedSource = `Vessel: DATE CHECK\nETA: ${stripCommercialDetails(expected.eta)}`
    const expectedDate = reviewedEta(expectedSource, parseSpcEnquiryText(expectedSource).eta).eta
    if (!actual.eta || !expectedDate || cleanKey(actual.eta) !== cleanKey(expectedDate)) differences.push('ETA')
  }
  return { matches: differences.length === 0, differences }
}

export function formatEnquiry(fields: ProductFields & {
  vessel: string; imo: string; buyerName: string; portName: string; eta: string
  grade?: string; quantity?: number; products?: EnquiryProduct[]; remarks?: string
  vlsfoMaxRemarks?: string[]; rmk?: boolean; bimco?: boolean
}) {
  const products = fields.products ?? productsFromFields(fields)
  const quantities: ProductFields = {}
  if (products.length) {
    for (const product of products) {
      const quantity = parseProductQuantity(product.quantityText)
      if (quantity) quantities[product.grade.toLowerCase() as keyof ProductFields] = quantity.min === quantity.max ? String(quantity.min) : `${quantity.min}-${quantity.max}`
    }
  } else if (fields.grade && fields.quantity !== undefined && Number.isFinite(fields.quantity) && fields.quantity > 0) {
    const match = fields.grade.match(gradePattern)?.[0]
    if (match) quantities[canonicalGrade(match).toLowerCase() as keyof ProductFields] = String(fields.quantity)
  }
  const remarks = stripCommercialDetails(fields.remarks || '')
  const options = (fields.vlsfoMaxRemarks || []).filter((value): value is VlsfoMaxRemark => ['80cst min', '80cst max', '120cst max', '180cst max'].includes(value))
  const enteredEta = stripCommercialDetails(fields.eta)
  const etaSource = `Vessel: DATE CHECK\nETA: ${enteredEta}`
  const reviewed = reviewedEta(etaSource, parseSpcEnquiryText(etaSource).eta)
  // The upstream formatter spaces every dash; normalize ISO dates first so the
  // outgoing day cannot be mistaken for the following product's quantity.
  const eta = reviewed.eta ? (/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/.test(enteredEta) ? reviewed.eta : enteredEta) : ''
  let standard = buildSpcStandardEnquiry({
    vesselName: stripCommercialDetails(fields.vessel) || '[CONFIRM VESSEL]',
    imo: stripCommercialDetails(fields.imo),
    port: stripCommercialDetails(fields.portName) || '[CONFIRM PORT]',
    eta: eta || '[CONFIRM DATES]',
    ...quantities,
    remarks: [remarks, fields.bimco && !/BIMCO TERMS/i.test(remarks) ? 'BIMCO TERMS' : ''].filter(Boolean).join(' / '),
    vlsfoMaxRemarks: options,
  })
  if (fields.rmk) standard = replaceHsfoWithRmk(standard).replace(/\bRMK\s+RMG380\s*\(3\.5%\)/gi, 'RMK')
  if (!Object.values(quantities).some(Boolean)) standard += ' / [CONFIRM QUANTITY]'
  return standard
}

/** Fictional enquiries contain no commercial price or margin assumptions. */
export const samples = [
  {
    id: 'normal', title: 'Meridian · Singapore', description: 'Meridian · Singapore · 450 MT',
    text: 'Please quote the following bunker enquiry.\nBuyer: Meridian Shipping Pte Ltd\nVessel: PACIFIC HORIZON\nIMO: 9319466\nPort: Singapore\nETA: 15-17 October\nVLSFO: 450 MT',
  },
  {
    id: 'shortfall', title: 'Bluewater · Fujairah', description: 'Bluewater · Fujairah · 700 MT',
    text: 'Please advise best offer and availability.\nBuyer: Bluewater Navigation Ltd\nVessel: OCEAN PATHFINDER\nIMO: 9319466\nPort: Fujairah\nETA: 18-20 October\nVLSFO: 700 MT',
  },
  {
    id: 'new-buyer', title: 'Aurora · Rotterdam', description: 'Aurora · Rotterdam · 300 MT',
    text: 'New enquiry for your consideration.\nBuyer: Aurora Maritime Holdings\nVessel: NORTHERN VOYAGER\nIMO: 9319466\nPort: Rotterdam\nETA: 21-23 October\nVLSFO: 300 MT',
  },
]
