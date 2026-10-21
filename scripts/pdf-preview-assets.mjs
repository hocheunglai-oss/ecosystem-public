import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const config = JSON.parse(await readFile(new URL('../config/pdf-preview.json', import.meta.url), 'utf8'));
export const pdfPreviewAssetPath = config.assetPath;

// Only the pinned renderer and its fonts/decoders are public. PDF scripting and
// its QuickJS engine are deliberately excluded. Document bytes stay in memory.
export function pdfPreviewAssets() {
  let assets;
  async function load() {
    if (assets) return assets;
    const root = dirname(require.resolve('pdfjs-dist/package.json'));
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (metadata.version !== config.version || config.assetPath !== `pdf-preview/${metadata.version}/`) throw new Error('PDF preview version mismatch.');
    const paths = ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE'];
    for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
      for (const name of await readdir(join(root, folder))) {
        if (name.startsWith('quickjs-')) continue;
        paths.push(`${folder}/${name}`);
      }
    }
    assets = new Map(await Promise.all(paths.map(async path => [path.replace(/^build\//, ''), await readFile(join(root, path))])));
    return assets;
  }
  return {
    name: 'eco-pdf-preview-assets',
    async generateBundle() {
      for (const [name, source] of await load()) this.emitFile({ type: 'asset', fileName: `${config.assetPath}${name}`, source });
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split('?')[0];
        if (!path?.startsWith(`/${config.assetPath}`)) return next();
        const name = path.slice(config.assetPath.length + 1), bytes = (await load()).get(name);
        if (!bytes) { response.statusCode = 404; response.end(); return; }
        response.setHeader('Content-Type', /\.m?js$/.test(name) ? 'text/javascript' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        response.end(bytes);
      });
    },
  };
}
