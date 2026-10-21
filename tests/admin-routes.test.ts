import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
/** Vercel's plain Node builder treats [...route].ts as a single dynamic segment, not a nested catchall. */
test('every administration handler path has a literal Vercel route without injected dynamic parameters', async () => {
  const handler=await readFile(new URL('../server/admin/handler.ts',import.meta.url),'utf8');
  const paths=[...new Set([...handler.matchAll(/['"](\/api\/admin\/[a-z/-]+)['"]/g)].map(match=>match[1]))];
  assert.ok(paths.length>=12,'Expected the administration route contract.');
  for(const path of paths){
    const file=new URL('..'+path+'.ts',import.meta.url);
    const source=await readFile(file,'utf8');
    assert.match(source,/export default serveAdministration/);assert.match(source,/server\/admin\/node\.ts/);
  }
  await assert.rejects(access(new URL('../api/admin/[...route].ts',import.meta.url)),{code:'ENOENT'});
});
