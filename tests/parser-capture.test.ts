import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnquiry } from '../src/lib/parser.ts';
import { captureParserSnapshot } from '../src/lib/parserCapture.ts';

test('original capture survives manual fields, AI application and caution selection changes', () => {
  const raw = 'VESSEL: ORIGINAL VESSEL\nPORT: SINGAPORE\nETA: 20 OCT 2026\nRMK: 300 MT\nVLSFO: 500 MT 120 CST MAX / 180 CST MAX\nLSMGO: 40 CBM';
  const parsed = parseEnquiry(raw, [], []);
  const original = captureParserSnapshot(raw, parsed, [], []);
  const preserved = JSON.parse(JSON.stringify(original));
  parsed.vessel = 'MANUAL VESSEL'; parsed.remarks = 'AI CHANGED'; parsed.warnings.push('LATER WARNING'); parsed.rmk = !parsed.rmk; parsed.vlsfoMaxRemarks.push('180cst max');
  assert.deepEqual(original, preserved);
  assert.equal(original.fields.vessel, 'ORIGINAL VESSEL');
  assert.equal(original.fields.portText.toUpperCase(), 'SINGAPORE');
  assert.equal(original.fields.lsmgo, '');
  for (const term of ['RMK', '120', '180', 'CBM']) assert.ok(original.warnings.some(value => value.includes(term)), term);
});

test('capture retains the actual directory resolution without changing raw-only parser data', () => {
  const raw = 'VESSEL: ALPHA\nBUYER: ASTER\nPORT: SINGAPORE\nETA: 20 OCT 2026\nVLSFO: 500 MT';
  const companies = [{id:'buyer-1',name:'ASTER SHIPPING PTE LTD',aliases:['ASTER']}];
  const ports = [{id:'port-1',name:'SINGAPORE',code:'SGSIN'}];
  const parsed = parseEnquiry(raw, companies, ports);
  const original = captureParserSnapshot(raw, parsed, companies, ports);
  assert.equal(original.fields.buyerText, 'ASTER SHIPPING PTE LTD');
  assert.equal(original.fields.portText, 'SINGAPORE');
  assert.notEqual(original.fields.buyerText, parseEnquiry(raw, [], []).buyerText);
  assert.ok(!original.standardText.includes('ASTER'), 'Buyer remains internal, never part of outbound standard format');
});
