import type { AuditStandard, DrawingAuditReport } from '../types/audit';
import { pdfjsLib } from '../utils/pdfHelpers';

const DIRECT_PDF_MAX_BYTES = 14 * 1024 * 1024; // 14 MB direct PDF threshold
const FALLBACK_MAX_PAGES = 10;

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function renderPdfPagesAsImages(
  file: File,
  maxPages = FALLBACK_MAX_PAGES,
): Promise<{ pageCount: number; pageImages: Array<{ pageNumber: number; mimeType: string; data: string }> }> {
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  try {
    const total = pdf.numPages;
    const count = Math.min(total, maxPages);
    const pageImages: Array<{ pageNumber: number; mimeType: string; data: string }> = [];

    for (let pageNum = 1; pageNum <= count; pageNum += 1) {
      const page = await pdf.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      const targetWidth = 1800;
      const scale = Math.min(2.2, Math.max(1, targetWidth / Math.max(baseViewport.width, 1)));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));

      await page.render({ canvas, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/png');
      const base64 = dataUrl.split(',')[1] ?? '';

      pageImages.push({
        pageNumber: pageNum,
        mimeType: 'image/png',
        data: base64,
      });
    }

    return { pageCount: total, pageImages };
  } finally {
    await loadingTask.destroy();
  }
}

export async function analyzeDrawingPdf(
  file: File,
  options?: {
    pageCount?: number;
    standard?: AuditStandard;
    reasoningDepth?: 'standard' | 'deep';
    signal?: AbortSignal;
  },
): Promise<DrawingAuditReport> {
  const standard: AuditStandard = options?.standard ?? 'ASME Y14.5-2018';
  let payload: {
    fileName: string;
    pageCount: number;
    standard: AuditStandard;
    pdfBase64?: string;
    pageImages?: Array<{ pageNumber: number; mimeType: string; data: string }>;
    reasoningDepth: 'standard' | 'deep';
  };

  if (file.size <= DIRECT_PDF_MAX_BYTES) {
    const pdfBase64 = await fileToBase64(file);
    payload = {
      fileName: file.name,
      pageCount: options?.pageCount && options.pageCount > 0 ? options.pageCount : 1,
      standard,
      pdfBase64,
      reasoningDepth: options?.reasoningDepth ?? 'deep',
    };
  } else {
    const rendered = await renderPdfPagesAsImages(file);
    payload = {
      fileName: file.name,
      pageCount: rendered.pageCount,
      standard,
      pageImages: rendered.pageImages,
      reasoningDepth: options?.reasoningDepth ?? 'deep',
    };
  }

  const response = await fetch('/api/audit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: options?.signal,
  });

  const data = (await response.json().catch(() => ({}))) as Partial<DrawingAuditReport> & {
    error?: string;
  };

  if (!response.ok) {
    throw new Error(
      data.error || `Drawing analysis failed with status ${response.status}. Please try again.`,
    );
  }

  if (!data.drawingName || !Array.isArray(data.findings) || typeof data.markdown !== 'string') {
    throw new Error('Server returned an incomplete audit report. Please retry the analysis.');
  }

  return data as DrawingAuditReport;
}
