// Synthetic public test document only. No business data or external requests.
export function syntheticPdf() {
  const content = page => `0.12 0.25 0.4 rg\nBT /F1 24 Tf 40 740 Td (ECO PDF preview - page ${page}) Tj ET\nBT /F1 14 Tf 40 700 Td (Case-sensitive document text ${page}) Tj ET\n0.2 0.6 0.7 RG 40 660 500 1 re S\nBT /F1 12 Tf 40 630 Td (Synthetic attachment: no commercial data.) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 8 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...[1, 2].map(page => `<< /Length ${Buffer.byteLength(content(page))} >>\nstream\n${content(page)}\nendstream`),
    '<< /S /JavaScript /JS (globalThis.__pdfExecuted = true;) >>',
  ];
  let result = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(result);
}
