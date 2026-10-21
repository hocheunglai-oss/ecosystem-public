import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Minus, Plus } from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { Modal } from './ui';
import { loadPdfLibrary, pdfAssetBase, pdfRenderSize, PDF_MAX_BYTES } from './lib/pdfPreview';
import './pdf-attachment-preview.css';

export default function PdfAttachmentPreview({ blob, name, onClose }: { blob: Blob; name: string; onClose: () => void }) {
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(700), [error, setError] = useState(''), [rendering, setRendering] = useState(true);
  const [text, setText] = useState(''), [textMode, setTextMode] = useState(false);
  const [download, setDownload] = useState('');
  const viewport = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true, task: PDFDocumentLoadingTask | undefined;
    const url = URL.createObjectURL(blob); setDownload(url);
    void (async () => {
      try {
        if (blob.size > PDF_MAX_BYTES) throw new Error('PDF IS TOO LARGE TO PREVIEW.');
        const [pdf, bytes] = await Promise.all([loadPdfLibrary(), blob.arrayBuffer()]);
        if (!active) return;
        // Render page graphics only. No annotation actions, PDF scripting
        // manager, sandbox or XFA is instantiated (PDF.js 6 removed eval).
        task = pdf.getDocument({ data: new Uint8Array(bytes), enableXfa: false,
          cMapUrl: `${pdfAssetBase}cmaps/`, cMapPacked: true, standardFontDataUrl: `${pdfAssetBase}standard_fonts/`, wasmUrl: `${pdfAssetBase}wasm/` });
        const loaded = await task.promise;
        if (active) setDocument(loaded);
      } catch (failure) {
        if (active) { setError((failure as Error).name === 'PasswordException' ? 'PASSWORD-PROTECTED PDF. DOWNLOAD TO OPEN.' : 'PDF COULD NOT BE PREVIEWED. DOWNLOAD TO OPEN.'); setRendering(false); }
      }
    })();
    return () => { active = false; URL.revokeObjectURL(url); void task?.destroy(); };
  }, [blob]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(1, element.clientWidth - 24)));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document) return;
    let active = true, cancel: (() => void) | undefined;
    setRendering(true); setError(''); setText('');
    void (async () => {
      try {
        const pdfPage = await document.getPage(page);
        if (!active) return;
        const original = pdfPage.getViewport({ scale: 1 }), size = pdfRenderSize(original.width, original.height, width, zoom, window.devicePixelRatio || 1);
        const buffer = window.document.createElement('canvas');
        buffer.width = Math.max(1, Math.floor(size.width * size.pixelRatio)); buffer.height = Math.max(1, Math.floor(size.height * size.pixelRatio));
        const render = pdfPage.render({ canvas: buffer, viewport: pdfPage.getViewport({ scale: size.scale * size.pixelRatio }) });
        cancel = () => render.cancel();
        const [, content] = await Promise.all([render.promise, pdfPage.getTextContent()]);
        if (!active || !canvas.current) return;
        const target = canvas.current;
        target.width = buffer.width; target.height = buffer.height; target.style.width = `${size.width}px`; target.style.height = `${size.height}px`;
        target.getContext('2d')?.drawImage(buffer, 0, 0);
        setText(content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join(''));
        setRendering(false);
      } catch (failure) {
        if (active && (failure as Error).name !== 'RenderingCancelledException') { setError('THIS PAGE COULD NOT BE PREVIEWED.'); setRendering(false); }
      }
    })();
    return () => { active = false; cancel?.(); };
  }, [document, page, width, zoom]);
  return <Modal title="PDF PREVIEW" kicker={name} onClose={onClose} wide>
    <div className="pdf-preview">
      <div className="pdf-preview-toolbar" role="toolbar" aria-label="PDF controls">
        <div><button type="button" className="icon-button" aria-label="Previous page" disabled={!document || page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /></button>
          <span aria-live="polite">PAGE {page} / {document?.numPages ?? '—'}</span>
          <button type="button" className="icon-button" aria-label="Next page" disabled={!document || page >= document.numPages} onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></button></div>
        <div><button type="button" className="icon-button" aria-label="Zoom out" disabled={!document || zoom <= .5 || textMode} onClick={() => setZoom(value => Math.max(.5, value - .25))}><Minus size={16} /></button>
          <button type="button" className="button secondary" disabled={!document || textMode} onClick={() => setZoom(1)}>FIT WIDTH</button>
          <button type="button" className="icon-button" aria-label="Zoom in" disabled={!document || zoom >= 3 || textMode} onClick={() => setZoom(value => Math.min(3, value + .25))}><Plus size={16} /></button></div>
        <button type="button" className="button secondary" aria-pressed={textMode} disabled={!document} onClick={() => setTextMode(value => !value)}>TEXT</button>
        {download && <a className="button secondary" href={download} download={name}><Download size={16} />DOWNLOAD</a>}
      </div>
      {rendering && <p className="pdf-preview-status" role="status">LOADING PAGE…</p>}
      {error && <p className="pdf-preview-status" role="alert">{error}</p>}
      <div className="pdf-preview-pages" ref={viewport} aria-busy={rendering}>
        <canvas ref={canvas} hidden={textMode || rendering || !!error || !document} role="img" aria-label={`PDF page ${page}`} />
        {textMode && <pre data-preserve-case>{rendering ? '' : text || 'NO TEXT ON THIS PAGE.'}</pre>}
      </div>
    </div>
  </Modal>;
}
