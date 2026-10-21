import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textLinks } from '../src/lib/textLinks';

test('web links preserve case-sensitive paths and queries and leave punctuation outside', () => {
  const text = 'SEE (https://Example.test/PortData?Key=AbC), THEN www.example.test/report_(final).';
  const parts = textLinks(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.href), [
    { text: 'https://Example.test/PortData?Key=AbC', href: 'https://Example.test/PortData?Key=AbC' },
    { text: 'www.example.test/report_(final)', href: 'https://www.example.test/report_(final)' },
  ]);
});

test('untrusted prose never becomes executable markup or a credential-bearing link', () => {
  const text = '<script>alert(1)</script> javascript:alert(1) data:text/html,evil https://user:secret@example.test/report https://';
  const parts = textLinks(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.ok(parts.every(part => !part.href));
});
