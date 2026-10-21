import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnquiry, formatEnquiry, compareEnquiryPreview, enquirySourceWarnings } from '../src/lib/parser';
const companies = [{ id: 'alpha', name: 'Alpha Shipping Ltd', aliases: ['ALPHA SHIPPING'] }, { id: 'beta', name: 'Beta Shipping Ltd', aliases: ['BETA'] }];
const ports = [{ id: 'sg', name: 'Singapore', code: 'SGSIN' }, { id: 'rotterdam', name: 'Rotterdam', code: 'NLRTM' }];
const source = 'Vessel: SYNTHETIC VOYAGER\nIMO: 9319466\nBuyer: Alpha Shipping Ltd\nPort: Singapore\nETA: 15-17 October\nVLSFO: 450 MT';
const parse = (raw: string) => parseEnquiry(raw, companies, ports);

test('buyer conflicts use the same accepted label spellings and never take the first entity silently', () => {
  for (const label of ['Buyer:', 'Client:', 'A/C:', 'Acct:', 'For acct of:', 'For a/c of:', 'For account of:', 'Account name:']) {
    const actual = parse(source + `\n${label} Beta Shipping Ltd`);
    assert.equal(actual.buyerId, '', label);
    assert.ok(actual.warnings.some(warning => warning.includes('Several companies')), label);
    assert.notEqual(actual.confidence, 'high');
  }
  assert.equal(parse(source + '\nA/C: ALPHA SHIPPING').buyerId, 'alpha', 'two aliases of the same entity are not a conflict');
});

test('company names in signatures or vessel names alone are never legal buyer matches', () => {
  const withoutBuyer = source.replace('Buyer: Alpha Shipping Ltd\n', '');
  for (const raw of [withoutBuyer + '\nBest regards\nAlpha Shipping Ltd', withoutBuyer.replace('SYNTHETIC VOYAGER', 'BETA'), withoutBuyer + '\nFrom: Alpha Shipping Ltd']) {
    assert.equal(parse(raw).buyerId, '');
    assert.notEqual(parse(raw).confidence, 'high');
  }
  assert.equal(parse(source.replace('Buyer: Alpha Shipping Ltd', 'A/C:\nAlpha Shipping Ltd')).buyerId, 'alpha');
});

test('repeated conflicting port fields require selection while repeated aliases retain the same port', () => {
  for (const second of ['Port: Rotterdam', 'Bunkering port: Rotterdam', '港口: Rotterdam']) {
    const actual = parse(source + '\n' + second);
    assert.equal(actual.portId, '', second);
    assert.ok(actual.warnings.some(warning => warning.includes('Several delivery ports')));
  }
  for (const alias of ['SG', 'Singapore', 'SGSIN']) assert.equal(parse(source + '\nPort: ' + alias).portId, 'sg', alias);
  assert.equal(parse(source.replace('Singapore', 'Singapore or Rotterdam')).portId, '');
});

test('impossible leap dates and missing or ambiguous date parts cannot confirm an ETA', () => {
  for (const eta of ['29 February 2026', '29 February 2100', '2026-02-29', '29/02/2026', '31-1 April 2026', '31/1 April 2026', 'April 30-31 2026', '31-02-2026', '29 February', '10/11/2026', '10-11-2026', '15th - 17th', '15-17']) {
    const actual = parse(source.replace('15-17 October', eta));
    assert.equal(actual.eta, '', eta);
    assert.notEqual(actual.confidence, 'high', eta);
    assert.ok(actual.warnings.some(warning => /delivery date|delivery month/i.test(warning)), eta);
  }
});

test('explicit years survive parsing and formatting without becoming quantities', () => {
  for (const eta of ['29 February 2028', '2028-02-29', '15-10-2026', '10-15-2026', 'October 15-17 2026', '15-17 October 2026', '31 December 2026 - 2 January 2027']) {
    const actual = parse(source.replace('15-17 October', eta));
    assert.equal(actual.vlsfo, '450', eta);
    for (const year of eta.match(/20\d{2}/g) ?? []) assert.ok(actual.eta.includes(year), eta);
    const formatted = formatEnquiry({ ...actual, portName: 'Singapore', buyerName: companies[0].name });
    assert.deepEqual(compareEnquiryPreview(formatted, actual, companies, ports), { matches: true, differences: [] }, eta);
    const changed = formatted.replace(/202[678]/, '2030');
    assert.ok(compareEnquiryPreview(changed, actual, companies, ports).differences.includes('ETA'), eta);
  }
});

test('explicit slash day range stays supported and narrative specification years do not change ETA', () => {
  const actual = parse(source.replace('15-17 October', '1/5 aug') + '\nRemarks: ISO 8217:2024');
  assert.equal(actual.eta, '1 - 5 aug');
  assert.equal(actual.vlsfo, '450');
  assert.equal(parse(source + '\nNotes: report issued in December 2025').eta, '15 - 17 oct');
});

test('year ordering and partially specified cross-year windows require review', () => {
  for (const eta of ['31 December 2026 - 2 January 2026', '31 December 2026 - 2 January']) {
    const actual = parse(source.replace('15-17 October', eta));
    assert.equal(actual.eta, '', eta);
    assert.ok(actual.warnings.some(warning => /window/.test(warning)));
  }
  const dated = parse(source.replace('15-17 October', '2026-10-15'));
  const manual = formatEnquiry({ ...dated, eta: '2026-10-15', portName: 'Singapore', buyerName: companies[0].name });
  assert.deepEqual(compareEnquiryPreview(manual, dated, companies, ports), { matches: true, differences: [] });
});


test('RMK and viscosity source cautions remain visible without inventing product specifications', () => {
  for (const [text, term] of [['RMK', 'RMK'], ['r.m.k.', 'RMK'], ['RMK380', 'RMK'], ['120 CST', '120'], ['180cst', '180']] as const) {
    const actual = parse(source + `\nRemarks: ${text}`);
    assert.ok(actual.warnings.some(warning => warning.startsWith('WARNING:') && warning.includes(term)), text);
    assert.equal(actual.vlsfo, '450', text);
    assert.deepEqual(actual.vlsfoMaxRemarks, [], text);
    assert.equal(actual.rmk, false, text);
  }
  const combined = parse(source + '\nRemarks: No RMK required; VLSFO 120cst / 180cst');
  assert.ok(combined.warnings.some(warning => /^WARNING: 120 \/ 180 \/ RMK spotted/.test(warning)));
  assert.equal(combined.rmk, false);
  assert.deepEqual(combined.vlsfoMaxRemarks, []);
  assert.deepEqual(enquirySourceWarnings('VLSFO 1200 MT / HSFO 1800 MT'), []);
  assert.deepEqual(enquirySourceWarnings(source), []);
});

test('explicit RMK and viscosity selections retain source cautions and MT quantities', () => {
  const actual = parse(source.replace('VLSFO: 450 MT', 'RMK380: 300 MT\nVLSFO: 450 MT 120 CST MAX / 180 CST MAX'));
  assert.equal(actual.rmk, true);
  assert.equal(actual.hsfo, '300');
  assert.equal(actual.vlsfo, '450');
  assert.deepEqual(actual.vlsfoMaxRemarks, ['120cst max', '180cst max']);
  assert.ok(actual.warnings.some(warning => /^WARNING: 120 \/ 180 \/ RMK spotted/.test(warning)));
});

test('CBM cautions survive unit-only lines and compact quantities without silent MT conversion', () => {
  for (const product of ['VLSFO: 450 CBM', 'VLSFO: 450CBM', 'VLSFO: 450 c.b.m.', 'VLSFO: 450\nCBM', 'VLSFO: 450\nUnit: CBM', 'VLSFO\n450CBM']) {
    const actual = parse(source.replace('VLSFO: 450 MT', product));
    assert.equal(actual.vlsfo, '', product);
    assert.deepEqual(actual.products, [], product);
    assert.equal(actual.quantity, 0, product);
    const warnings = actual.warnings.filter(warning => /CBM|non-MT quantity unit/.test(warning));
    assert.equal(warnings.length, 1, product);
    assert.match(warnings[0], /^WARNING: CBM spotted\..*non-MT quantity unit/, product);
  }
  const standalone = parse(source + '\nCBM');
  assert.equal(standalone.vlsfo, '', 'unit-only source line also requires MT review');
  assert.ok(standalone.warnings.some(warning => /^WARNING: CBM spotted/.test(warning)));
  const narrative = parse(source + '\nRemarks: tank capacity given in CBM');
  assert.equal(narrative.vlsfo, '450', 'a narrative CBM mention warns but does not invent a quantity unit');
  assert.ok(narrative.warnings.some(warning => /^WARNING: CBM spotted/.test(warning)));
});
