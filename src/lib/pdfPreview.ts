import config from '../../config/pdf-preview.json';
import type * as PdfJs from 'pdfjs-dist';

export const pdfAssetBase = `/${config.assetPath}`;
export const PDF_MAX_PIXELS = 4_000_000;
export const PDF_MAX_BYTES = 100 * 1024 * 1024;
export const isPdfAttachment = (mime: string, name: string) => mime.split(';')[0].trim().toLowerCase() === 'application/pdf' || /\.pdf$/i.test(name);

export function pdfRenderSize(width: number, height: number, available: number, zoom: number, density: number) {
  const scale = Math.max(1, available) / Math.max(1, width) * Math.min(3, Math.max(.5, zoom));
  const cssWidth = width * scale, cssHeight = height * scale;
  const pixelRatio = Math.min(Math.max(1, density), 2, Math.sqrt(PDF_MAX_PIXELS / Math.max(1, cssWidth * cssHeight)));
  return { scale, width: cssWidth, height: cssHeight, pixelRatio };
}

let library: Promise<typeof PdfJs> | undefined;
export function loadPdfLibrary(): Promise<typeof PdfJs> {
  // Vite copies the pinned local assets; no CDN or external document viewer.
  return library ??= import(/* @vite-ignore */ `${pdfAssetBase}pdf.min.mjs`).then(module => {
    const pdf = module as typeof PdfJs;
    pdf.GlobalWorkerOptions.workerSrc = `${pdfAssetBase}pdf.worker.min.mjs`;
    return pdf;
  }).catch(error => { library = undefined; throw error; });
}
