import { readFile } from 'node:fs/promises';

/** Optional Vercel CLI-authorized staging cookie, never application identity. */
export async function installStagingCookies(context, base) {
  const file = process.env.ECO_PROTECTION_COOKIES;
  if (!file) return;
  const host = new URL(base).hostname;
  const cookies = (await readFile(file, 'utf8')).split('\n').flatMap(line => {
    if (line.startsWith('#HttpOnly_')) line = line.slice(10);
    else if (line.startsWith('#') || !line.trim()) return [];
    const [domain, , path, secure, expiry, name, value] = line.split('\t');
    if (!name || !value || domain.replace(/^\./, '') !== host) return [];
    return [{domain, path, secure:secure==='TRUE', expires:Number(expiry)||-1, name, value, httpOnly:true, sameSite:'Lax'}];
  });
  if (!cookies.length) throw new Error('No staging cookie matches the requested deployment host.');
  await context.addCookies(cookies);
}
