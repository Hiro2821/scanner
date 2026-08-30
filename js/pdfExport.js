/* =====================================================
   pdfExport.js — 複数ページを1つのPDFにまとめて保存
   ===================================================== */

const PdfExport = (() => {
  const ASSUMED_DPI = 150;

  function pxToPt(px) { return (px / ASSUMED_DPI) * 72; }

  // pages: [{ dataUrl, width, height }]
  function buildAndDownload(pages, filename = 'scan.pdf') {
    if (!pages.length) return false;
    if (!window.jspdf || !window.jspdf.jsPDF) {
      throw new Error('jspdf-not-loaded');
    }
    const { jsPDF } = window.jspdf;

    const first = pages[0];
    const firstSize = [pxToPt(first.width), pxToPt(first.height)];
    const doc = new jsPDF({
      unit: 'pt',
      format: firstSize,
      orientation: firstSize[0] > firstSize[1] ? 'landscape' : 'portrait',
    });

    pages.forEach((page, idx) => {
      const size = [pxToPt(page.width), pxToPt(page.height)];
      if (idx > 0) {
        doc.addPage(size, size[0] > size[1] ? 'landscape' : 'portrait');
      }
      doc.addImage(page.dataUrl, 'JPEG', 0, 0, size[0], size[1]);
    });

    doc.save(filename);
    return true;
  }

  return { buildAndDownload };
})();
