import assert from 'node:assert/strict'
import test from 'node:test'
import { compareEnquiryPreview, formatEnquiry, parseEnquiry, productsFromFields, samples, stripCommercialDetails } from '../src/lib/parser'

const companies = [
  { id: 'meridian', name: 'Meridian Shipping Pte Ltd', aliases: ['Meridian Shipping'] },
  { id: 'bluewater', name: 'Bluewater Navigation Ltd', aliases: ['Bluewater'] },
]
const ports = [
  { id: 'singapore', name: 'Singapore', code: 'SGSIN' },
  { id: 'fujairah', name: 'Fujairah', code: 'AEFJR' },
  { id: 'rotterdam', name: 'Rotterdam', code: 'NLRTM' },
]
const parse = (raw: string) => parseEnquiry(raw, companies, ports)

test('normal sample extracts all required fields using the reused FCUNO/SPC parser', () => {
  const parsed = parse(samples[0].text)
  assert.equal(parsed.vessel, 'PACIFIC HORIZON')
  assert.equal(parsed.imo, '9319466')
  assert.equal(parsed.buyerId, 'meridian')
  assert.equal(parsed.portId, 'singapore')
  assert.equal(parsed.grade, 'VLSFO')
  assert.equal(parsed.quantity, 450)
  assert.equal(parsed.margin, 0)
  assert.equal(parsed.price, 0)
  assert.match(parsed.eta, /15.*17.*oct/)
  assert.equal(parsed.confidence, 'high')
  assert.deepEqual(parsed.warnings, [])
})

test('credit shortfall and new-customer examples retain distinct context', () => {
  const shortfall = parse(samples[1].text)
  assert.equal(shortfall.buyerId, 'bluewater')
  assert.equal(shortfall.portId, 'fujairah')
  assert.equal(shortfall.quantity, 700)
  const newcomer = parse(samples[2].text)
  assert.equal(newcomer.buyerId, '')
  assert.equal(newcomer.buyerText, 'AURORA MARITIME HOLDINGS')
  assert.equal(newcomer.portId, 'rotterdam')
  assert.ok(newcomer.warnings.some(w => w.includes('new customer')))
})

test('buyer alias resolves only to a unique legal entity', () => {
  const text = samples[0].text.replace('Meridian Shipping Pte Ltd', 'Meridian Shipping')
  assert.equal(parse(text).buyerId, 'meridian')
  const ambiguous = parseEnquiry(text, [...companies, { id: 'meridian-other', name: 'Meridian Shipping Limited', aliases: ['Meridian Shipping'] }], ports)
  assert.equal(ambiguous.buyerId, '')
  assert.ok(ambiguous.warnings.some(w => w.includes('Several companies')))
})

test('no port is invented from the SPC Singapore default', () => {
  const noPort = parse(samples[0].text.replace('Port: Singapore\n', ''))
  assert.equal(noPort.portId, '')
  const alternatives = parse(samples[0].text.replace('Port: Singapore', 'Port: Singapore or Fujairah'))
  assert.equal(alternatives.portId, '')
})

test('FCUNO port aliases resolve to a unique supplied city record', () => {
  const vietnamPorts = [...ports, { id: 'ho-chi-minh', name: 'Ho Chi Minh City', code: 'VNSGN' }]
  for (const alias of ['Ho Chi Minh', 'Ho Chi Minh City', 'Hochiminh City', 'VNSGN']) {
    const parsed = parseEnquiry(samples[0].text.replace('Port: Singapore', `Port: ${alias}`), companies, vietnamPorts)
    assert.equal(parsed.portId, 'ho-chi-minh', alias)
  }
  const ambiguousPorts = [...vietnamPorts, { id: 'ho-chi-minh-duplicate', name: 'Ho Chi Minh', code: 'VNSGN' }]
  const ambiguous = parseEnquiry(samples[0].text.replace('Port: Singapore', 'Port: Ho Chi Minh City'), companies, ambiguousPorts)
  assert.equal(ambiguous.portId, '')
  assert.ok(ambiguous.warnings.some(w => w.includes('manual selection')))
})

test('unsupported quantities are never silently treated as MT', () => {
  for (const unit of ['CBM', 'm³', 'KL', 'KG', 'litres', 'bbl']) {
    const parsed = parse(samples[0].text.replace('450 MT', `450 ${unit}`))
    assert.equal(parsed.quantity, 0, unit)
    assert.ok(parsed.warnings.some(w => w.includes('non-MT')), unit)
  }
})

test('SPC quantities preserve ranges and each product without making a booked quantity assumption', () => {
  for (const value of ['450-500 MT', '450 / 500 MT']) {
    const parsed = parse(samples[0].text.replace('450 MT', value))
    assert.equal(parsed.quantity, 0, value)
    assert.equal(parsed.vlsfo, '450-500')
    assert.deepEqual(parsed.products, [{ grade: 'VLSFO', quantityText: '450-500' }])
  }
  const negative = parse(samples[0].text.replace('450 MT', '-450 MT'))
  assert.equal(negative.quantity, 0)
  assert.equal(negative.vlsfo, '')
  assert.ok(negative.warnings.some(warning => warning.includes('positive')))
  const multiple = parse(`${samples[0].text}\nHSFO: 1,000 MT\nLSMGO: 100 MT`)
  assert.equal(multiple.quantity, 0)
  assert.deepEqual(multiple.products, [
    { grade: 'HSFO', quantityText: '1000' },
    { grade: 'VLSFO', quantityText: '450' },
    { grade: 'LSMGO', quantityText: '100' },
  ])
  assert.equal(multiple.confidence, 'high')
})

test('conflicting buyer labels and conflicting quantities remain unconfirmed', () => {
  const buyer = parse(`${samples[0].text}\nBuyer: Bluewater Navigation Ltd`)
  assert.equal(buyer.buyerId, '')
  assert.ok(buyer.warnings.some(warning => warning.includes('Several companies')))
  const quantities = parse(`${samples[0].text}\nVLSFO: 500 MT`)
  assert.equal(quantities.vlsfo, '')
  assert.ok(quantities.warnings.some(warning => warning.includes('Conflicting VLSFO')))
  const reversed = parse(samples[0].text.replace('450 MT', '500-450 MT'))
  assert.equal(reversed.vlsfo, '')
})

test('SPC fields and output preserve operational remarks while excluding commercial prices and margins', () => {
  const parsed = parse(`${samples[0].text}\nPrice: USD 650\nMargin: USD 20\nRemarks: COQ REQUIRED / Price: USD 650 / 30D QUALITY TIME BAR / Margin: USD 20`)
  assert.equal(parsed.price, 0)
  assert.equal(parsed.margin, 0)
  assert.equal(parsed.remarks, 'COQ REQUIRED / 30D QUALITY TIME BAR')
  const text = formatEnquiry({ ...parsed, buyerName: companies[0].name, portName: 'Singapore', products: productsFromFields({ hsfo: '1000', vlsfo: '450-500', lsmgo: '100' }), vlsfoMaxRemarks: ['120cst max'], bimco: true })
  assert.doesNotMatch(text, /Buyer:|Meridian Shipping/i)
  assert.match(text, /1,000 MT HSFO RMG380 \(3.5%\)/)
  assert.match(text, /450-500 MT VLSFO \(0.5%\)/)
  assert.match(text, /100 MT LSMGO \(0.1%\)/)
  assert.match(text, /120CST MAX/)
  assert.match(text, /COQ REQUIRED/)
  assert.match(text, /BIMCO TERMS/)
  assert.doesNotMatch(text, /PRICE|MARGIN|650|USD/i)
  assert.equal(stripCommercialDetails('COQ REQUIRED / Margin: 20 / Price: 650'), 'COQ REQUIRED')
})

test('commercial stripping preserves preview lines and operational details beside financial annotations', () => {
  const text = 'Buyer: Meridian Shipping Pte Ltd\nPACIFIC HORIZON (9319466) / SG / 450 MT VLSFO (0.5%)\nPrice: USD 650 / MT\nMargin: 20'
  assert.equal(stripCommercialDetails(text), 'PACIFIC HORIZON (9319466) / SG / 450 MT VLSFO (0.5%)')
  assert.equal(stripCommercialDetails('PACIFIC HORIZON price 650 / VLSFO 450 MT margin: 20'), 'PACIFIC HORIZON / VLSFO 450 MT')
  assert.equal(stripCommercialDetails('PACIFIC HORIZON / Price (USD / MT): 650 / Margin (USD/MT): -5 / 450 MT VLSFO'), 'PACIFIC HORIZON / 450 MT VLSFO')
  const formatted = formatEnquiry({ vessel: 'PACIFIC HORIZON / PRICE: 650', imo: '9319466 margin: 20', buyerName: 'Meridian Shipping / Margin: 40', portName: 'Singapore / Price: 610', eta: '15-17 October / USD 650', vlsfo: '450' })
  assert.match(formatted, /PACIFIC HORIZON \(9319466\)/)
  assert.match(formatted, /450 MT VLSFO/)
  assert.doesNotMatch(formatted, /PRICE|MARGIN|USD|650|610/)
  assert.equal(stripCommercialDetails('PROFIT STAR / 450 MT VLSFO'), 'PROFIT STAR / 450 MT VLSFO')
})

test('quantities remain finite and the IMO check digit is validated', () => {
  const huge = parse(samples[0].text.replace('450 MT', `${'9'.repeat(350)} MT`))
  assert.equal(Number.isFinite(huge.quantity), true)
  assert.equal(huge.quantity, 0)
  const invalidImo = parse(samples[0].text.replace('9319466', '9319467'))
  assert.equal(invalidImo.imo, '')
  assert.ok(invalidImo.warnings.some(w => w.includes('check digit')))
})

test('formatted preview preserves BIMCO terms and rejects nonfinite quantities', () => {
  const fields = { vessel: 'PACIFIC HORIZON', imo: '9319466', buyerName: companies[0].name, portName: 'Singapore', eta: '15–17 October', grade: 'VLSFO', quantity: 450 }
  assert.match(formatEnquiry({ ...fields, bimco: true }), /BIMCO TERMS$/)
  assert.doesNotMatch(formatEnquiry(fields), /BIMCO/)
  assert.match(formatEnquiry({ ...fields, quantity: Number.NaN }), /\[CONFIRM QUANTITY\]/)
})


test('SPC standard format roundtrips multiple products and spaced ranges without treating ETA as negative quantities', () => {
  const fields = { vessel: 'PACIFIC HORIZON', imo: '9319466', buyerName: companies[0].name, portName: 'Singapore', eta: '15-17 October', hsfo: '1000', vlsfo: '450-500', lsmgo: '100', remarks: 'COQ REQUIRED' }
  const text = formatEnquiry(fields)
  const parsed = parse(text)
  assert.equal(parsed.vessel, fields.vessel)
  assert.equal(parsed.buyerId, '')
  assert.equal(parsed.portId, 'singapore')
  assert.deepEqual(parsed.products, productsFromFields(fields))
  assert.ok(parsed.warnings.every(warning => warning.startsWith('Buyer')))
  const spaced = parse(text.replace('450-500 MT', '450 - 500 MT'))
  assert.equal(spaced.vlsfo, '450-500')
  const negative = parse(text.replace('450-500 MT', '-450 MT'))
  assert.equal(negative.vlsfo, '')
  assert.ok(negative.warnings.some(warning => warning.includes('positive')))
})

test('custom previews omit the internal buyer and preserve vessel, port, IMO and fuel quantities', () => {
  const fields = { vessel: 'PACIFIC HORIZON', imo: '9319466', buyerName: companies[0].name, portName: 'Singapore', eta: '15-17 October', vlsfo: '450', lsmgo: '100' }
  const expected = { ...fields, buyerId: 'meridian', portId: 'singapore', products: productsFromFields(fields) }
  const standard = formatEnquiry(fields)
  const compare = (value: string) => compareEnquiryPreview(value, expected, companies, ports)
  assert.deepEqual(compare(standard), { matches: true, differences: [] })
  assert.equal(compare(`${standard} / Please confirm availability.`).matches, true)
  assert.equal(compare(standard.replace('OCTOBER', 'OCT')).matches, true)
  assert.deepEqual(compare(standard.replace('450 MT', '1,000 MT')).differences, ['Products'])
  assert.equal(compare(`Buyer: Bluewater Navigation Ltd\n${standard}`).matches, true)
  assert.deepEqual(compare(standard.replace('PACIFIC HORIZON', 'OCEAN HORIZON')).differences, ['Vessel'])
  assert.deepEqual(compare(standard.replace('9319466', '9876543')).differences, ['IMO'])
  assert.deepEqual(compare(standard.replace('/ SG /', '/ FUJAIRAH /')).differences, ['Port'])
  assert.deepEqual(compare(standard.replace('15 - 17 OCTOBER', '18 - 20 OCTOBER')).differences, ['ETA'])
  assert.equal(compare(`${standard}\nPrice: USD 600\nMargin: 20`).matches, true)
})


test('preview validation accepts generated RMK and viscosity options without changing the product identity', () => {
  const fields = { vessel: 'PACIFIC HORIZON', imo: '9319466', buyerName: companies[0].name, portName: 'Singapore', eta: '15-17 October', hsfo: '1000', vlsfo: '450-500', lsmgo: '100', rmk: true }
  for (const viscosity of ['80cst min', '120cst max', '180cst max']) {
    const standard = formatEnquiry({ ...fields, vlsfoMaxRemarks: [viscosity] })
    const compared = compareEnquiryPreview(standard, { ...fields, buyerId: 'meridian', portId: 'singapore', products: productsFromFields(fields) }, companies, ports)
    assert.deepEqual(compared, { matches: true, differences: [] }, viscosity)
  }
})

test('explicit RMK and VLSFO viscosity qualifiers survive parsing and outgoing formatting', () => {
  for (const viscosity of ['80cst min', '120cst max', '180cst max']) {
    const raw = `${samples[0].text}\nRMK: 1,000 MT\nRemarks: ${viscosity}`
    const parsed = parse(raw)
    assert.equal(parsed.rmk, true)
    assert.deepEqual(parsed.vlsfoMaxRemarks, [viscosity])
    const formatted = formatEnquiry({ ...parsed, buyerName: companies[0].name, portName: 'Singapore' })
    assert.match(formatted, /1,000 MT RMK/)
    assert.doesNotMatch(formatted, /HSFO RMG380/)
    assert.ok(formatted.includes(viscosity.toUpperCase()))
    assert.equal(compareEnquiryPreview(formatted, { ...parsed, products: parsed.products }, companies, ports).matches, true)
  }
  const inline = parse(samples[0].text.replace('VLSFO: 450 MT', 'RMK380: 1,000 MT\nVLSFO: 450 MT 80 cSt MIN'))
  assert.equal(inline.rmk, true)
  assert.deepEqual(inline.vlsfoMaxRemarks, ['80cst min'])
})

test('viscosity qualifiers and RMK are not inferred when the raw enquiry does not specify them', () => {
  const plain = parse(samples[0].text)
  assert.equal(plain.rmk, false)
  assert.deepEqual(plain.vlsfoMaxRemarks, [])
  for (const detail of ['VLSFO 180cst', 'VLSFO 80cst typical', 'VLSFO 140cst max', 'HSFO RMG380', 'No RMK required']) {
    const parsed = parse(`${samples[0].text}\nRemarks: ${detail}`)
    assert.equal(parsed.rmk, false)
    assert.deepEqual(parsed.vlsfoMaxRemarks, [])
  }
})

test('preview validation keeps explicit RMK and viscosity choices consistent with the recorded fields', () => {
  const fields = { vessel: 'PACIFIC HORIZON', imo: '9319466', buyerName: companies[0].name, portName: 'Singapore', eta: '15-17 October', hsfo: '1000', vlsfo: '450', rmk: true, vlsfoMaxRemarks: ['80cst min', '120cst max'] }
  const standard = formatEnquiry(fields)
  const expected = { ...fields, buyerId: 'meridian', portId: 'singapore', products: productsFromFields(fields) }
  assert.equal(compareEnquiryPreview(standard, expected, companies, ports).matches, true)
  for (const edited of [standard.replace('RMK', 'HSFO RMG380 (3.5%)'), standard.replace('80CST MIN', ''), standard.replace('120CST MAX', '180CST MAX')]) {
    assert.deepEqual(compareEnquiryPreview(edited, expected, companies, ports), { matches: false, differences: ['Specs'] })
  }
  const noSpecs = { ...fields, rmk: false, vlsfoMaxRemarks: [] }
  assert.equal(compareEnquiryPreview(formatEnquiry(noSpecs), { ...expected, rmk: false, vlsfoMaxRemarks: [] }, companies, ports).matches, true)
})
