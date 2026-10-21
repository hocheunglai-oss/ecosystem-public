import assert from 'node:assert/strict'
import test from 'node:test'
import { isEmailText, uppercaseSelectionOffset, uppercaseText } from '../src/lib/uppercase'

test('identify email-only cells without exempting surrounding prose', () => {
  for (const value of ['Jane.Doe+Stem@Example.COM', ' opérateur@exemple.fr ', 'Ops@fcuno.com']) {
    assert.equal(isEmailText(value), true, value)
  }
  for (const value of ['', 'Contact Jane.Doe@Example.COM', 'Ops@fcuno.com confirmed', 'Ops@fcuno.com\nJane@example.com', 'https://example.com', 'VLSFO 500 MT', 'buyer@']) {
    assert.equal(isEmailText(value), false, value)
  }
})

test('uppercase prose, quantities, and Unicode without changing whitespace', () => {
  assert.equal(uppercaseText('Chiba\n\tVlsfo 450–500 mt; Straße, café, 日本'), 'CHIBA\n\tVLSFO 450–500 MT; STRASSE, CAFÉ, 日本')
  assert.equal(uppercaseText(''), '')
  assert.equal(uppercaseText('ALREADY UPPERCASE'), 'ALREADY UPPERCASE')
})

test('preserve mailbox spelling embedded in prose and punctuation', () => {
  const text = 'Email Jane.Doe+Stem@Example.COM, or <Ops@fcuno.com>; contact: operations@example.co.jp.'
  assert.equal(uppercaseText(text), 'EMAIL Jane.Doe+Stem@Example.COM, OR <Ops@fcuno.com>; CONTACT: operations@example.co.jp.')
  assert.equal(uppercaseText('Contact "User@example.com" today.'), 'CONTACT "User@example.com" TODAY.')
  assert.equal(uppercaseText('Email opérateur@exemple.fr'), 'EMAIL opérateur@exemple.fr')
})

test('preserve functional URLs including case-sensitive path, query, and fragment', () => {
  const links = [
    'https://fcuno.com/PortData?token=AbCdEf#Latest',
    'HTTP://Example.com/CaseSensitive',
    'www.example.com/FileName?key=aB',
    'example.com/CaseSensitive?signature=aBcD',
    'example.co.jp?key=abcDEF',
    'https://user:Password@host.example/Path',
    'mailto:Jane.Doe@example.com?subject=Chiba',
    'tel:+852-1234-5678',
  ]
  for (const link of links) assert.equal(uppercaseText(`See ${link} for details`), `SEE ${link} FOR DETAILS`, link)
})

test('normalization is idempotent across preserved addresses and Unicode', () => {
  const text = 'Straße — Jane@Example.com\nSee https://example.com/aBc?token=XyZ and vlsfo.'
  assert.equal(uppercaseText(uppercaseText(text)), uppercaseText(text))
  assert.equal(uppercaseText('plain text'), 'PLAIN TEXT')
})

test('selection follows Unicode expansion before the caret or selection end', () => {
  const original = 'aßbc'
  assert.equal(uppercaseSelectionOffset(original, 0), 0)
  assert.equal(uppercaseSelectionOffset(original, 1), 1)
  assert.equal(uppercaseSelectionOffset(original, 2), 3)
  assert.equal(uppercaseSelectionOffset(original, 4), 5)
  assert.equal(uppercaseSelectionOffset(original, 100), 5)
  assert.equal(uppercaseSelectionOffset(original, -1), 0)
})

test('selection inside preserved addresses uses the complete token', () => {
  const original = 'ß before straße@example.com after'
  const beforeAddress = original.indexOf('straße')
  const insideAddress = beforeAddress + 5
  assert.equal(uppercaseSelectionOffset(original, insideAddress), insideAddress + 1)
  assert.equal(uppercaseSelectionOffset(original, original.length), original.length + 1)
  const url = 'ß https://example.com/Straße then'
  const insideUrl = url.indexOf('Straße') + 5
  assert.equal(uppercaseSelectionOffset(url, insideUrl), insideUrl + 1)
})

test('selection uses browser UTF-16 offsets for emoji and combining characters', () => {
  assert.equal(uppercaseSelectionOffset('🚢ß port', 2), 2)
  assert.equal(uppercaseSelectionOffset('🚢ß port', 3), 4)
  assert.equal(uppercaseText('e\u0301ta'), 'E\u0301TA')
})

test('long unbroken pasted text normalizes without repeatedly rescanning every suffix', () => {
  const start = performance.now()
  for (const text of ['a'.repeat(30000), 'aaa.'.repeat(7500), '-'.repeat(30000)]) {
    assert.equal(uppercaseText(text), text.toUpperCase())
  }
  assert.ok(performance.now() - start < 500, 'normalization should stay responsive for a full-length paste')
})
