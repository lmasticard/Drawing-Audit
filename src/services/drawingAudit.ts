import {
  AUDIT_STANDARDS,
  PRIORITY_ORDER,
  WELDING_STANDARDS,
  formatAuditReportToMarkdown,
  normalizeExecutiveSummary,
  type AuditFinding,
  type AuditProgress,
  type AuditStandard,
  type DrawingAuditReport,
  type WeldingStandard,
} from '../types/audit';
import { pdfjsLib } from '../utils/pdfHelpers';

const DIRECT_PDF_MAX_BYTES = 14 * 1024 * 1024; // 14 MB direct PDF threshold

interface AuditRequestPayload {
  fileName: string;
  pageCount: number;
  sheetNumber?: number;
  totalPages?: number;
  standard: AuditStandard;
  isAssembly?: boolean;
  isWelded?: boolean;
  weldingStandard?: WeldingStandard | null;
  pdfBase64?: string;
  pageImages?: Array<{ pageNumber: number; mimeType: string; data: string }>;
  reasoningDepth: 'standard' | 'deep';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Drawing analysis cancelled.', 'AbortError');
  }
}

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

async function renderLoadedPdfPageAsImage(
  pdf: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>,
  pageNumber: number,
): Promise<{ pageNumber: number; mimeType: string; data: string }> {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const targetWidth = 1800;
  const scale = Math.min(2.2, Math.max(1, targetWidth / Math.max(baseViewport.width, 1)));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));

  try {
    await page.render({ canvas, viewport }).promise;
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1] ?? '';

    return {
      pageNumber,
      mimeType: 'image/png',
      data: base64,
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function postAuditRequest(
  payload: AuditRequestPayload,
  signal?: AbortSignal,
): Promise<DrawingAuditReport> {
  const response = await fetch('/api/audit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
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

  const normalizedSummary = normalizeExecutiveSummary(
    data.executive_summary || data.generalAssessment || '',
  );

  return {
    ...(data as DrawingAuditReport),
    executive_summary: normalizedSummary,
    generalAssessment: normalizedSummary,
  };
}

function buildMultiPageAssessment(
  totalPages: number,
  findings: AuditFinding[],
  sheetAssessments: string[],
  rulebookLabel: string,
): string {
  const p0 = findings.filter((f) => f.priority === 'P0').length;
  const p1 = findings.filter((f) => f.priority === 'P1').length;
  const p2 = findings.filter((f) => f.priority === 'P2').length;
  const p3 = findings.filter((f) => f.priority === 'P3').length;

  const breakdown: string[] = [];
  if (p0 > 0) breakdown.push(`${p0} critical (P0)`);
  if (p1 > 0) breakdown.push(`${p1} major (P1)`);
  if (p2 > 0) breakdown.push(`${p2} minor (P2)`);
  if (p3 > 0) breakdown.push(`${p3} suggestion (P3)`);

  const overview =
    findings.length === 0
      ? `Completed ${rulebookLabel} review across all ${totalPages} drawing sheets with no actionable issues identified.`
      : `Completed ${rulebookLabel} review across all ${totalPages} drawing sheets, identifying ${findings.length} actionable ${findings.length === 1 ? 'finding' : 'findings'} (${breakdown.join(', ')}).`;

  const leadSummary = sheetAssessments
    .map((item) => normalizeExecutiveSummary(item))
    .find((item) => item.length > 0);
  return normalizeExecutiveSummary(leadSummary ? `${overview} ${leadSummary}` : overview);
}

export async function analyzeDrawingPdf(
  file: File,
  options?: {
    pageCount?: number;
    standard?: AuditStandard;
    isAssembly?: boolean;
    isWelded?: boolean;
    weldingStandard?: WeldingStandard | null;
    reasoningDepth?: 'standard' | 'deep';
    signal?: AbortSignal;
    onProgress?: (progress: AuditProgress) => void;
  },
): Promise<DrawingAuditReport> {
  const standard: AuditStandard = options?.standard ?? 'ASME Y14.5-2018';
  const isAssembly = Boolean(options?.isAssembly);
  const isWelded = isAssembly && Boolean(options?.isWelded);
  const weldingStandard: WeldingStandard | null =
    isWelded && options?.weldingStandard ? options.weldingStandard : null;
  const activeScopeLabel = weldingStandard
    ? `${standard} + ${weldingStandard}`
    : isAssembly
      ? `${standard} (Assembly & BOM)`
      : standard;
  const reasoningDepth = options?.reasoningDepth ?? 'deep';
  const signal = options?.signal;
  const emitProgress = (progress: AuditProgress) => {
    if (!signal?.aborted) {
      options?.onProgress?.(progress);
    }
  };

  throwIfAborted(signal);

  const knownPageCount =
    typeof options?.pageCount === 'number' && Number.isFinite(options.pageCount) && options.pageCount > 0
      ? Math.floor(options.pageCount)
      : undefined;

  // Fast direct-PDF path for single-page drawings under the size threshold
  if (knownPageCount === 1 && file.size <= DIRECT_PDF_MAX_BYTES) {
    emitProgress({
      totalPages: 1,
      processedPages: 0,
      currentPage: 1,
      percent: 12,
      stage: 'preparing',
      statusText: 'Preparing sheet 1 of 1 for audit...',
    });

    const pdfBase64 = await fileToBase64(file);
    throwIfAborted(signal);

    emitProgress({
      totalPages: 1,
      processedPages: 0,
      currentPage: 1,
      percent: 28,
      stage: 'auditing',
      statusText: `Auditing sheet 1 of 1 against ${activeScopeLabel}...`,
    });

    const report = await postAuditRequest(
      {
        fileName: file.name,
        pageCount: 1,
        standard,
        isAssembly,
        isWelded,
        weldingStandard,
        pdfBase64,
        reasoningDepth,
      },
      signal,
    );

    emitProgress({
      totalPages: 1,
      processedPages: 1,
      currentPage: 1,
      percent: 100,
      stage: 'finalizing',
      statusText: 'Completed sheet 1 of 1',
    });

    return report;
  }

  // Load PDF once via PDF.js to inspect authoritative page count and render sheets incrementally
  const buffer = await file.arrayBuffer();
  throwIfAborted(signal);

  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  try {
    const totalPages = Math.max(1, pdf.numPages);

    // If pageCount wasn't pre-supplied and turns out to be a small 1-page PDF, send directly
    if (totalPages === 1 && file.size <= DIRECT_PDF_MAX_BYTES) {
      emitProgress({
        totalPages: 1,
        processedPages: 0,
        currentPage: 1,
        percent: 15,
        stage: 'preparing',
        statusText: 'Preparing sheet 1 of 1 for audit...',
      });

      const pdfBase64 = await fileToBase64(file);
      throwIfAborted(signal);

      emitProgress({
        totalPages: 1,
        processedPages: 0,
        currentPage: 1,
        percent: 28,
        stage: 'auditing',
        statusText: `Auditing sheet 1 of 1 against ${activeScopeLabel}...`,
      });

      const report = await postAuditRequest(
        {
          fileName: file.name,
          pageCount: 1,
          standard,
          isAssembly,
          isWelded,
          weldingStandard,
          pdfBase64,
          reasoningDepth,
        },
        signal,
      );

      emitProgress({
        totalPages: 1,
        processedPages: 1,
        currentPage: 1,
        percent: 100,
        stage: 'finalizing',
        statusText: 'Completed sheet 1 of 1',
      });

      return report;
    }

    // Single-page large PDF (> 14 MB) or Multi-page engineering drawing:
    // Process sheet-by-sheet so the progress bar tracks real per-sheet completion
    const allFindings: AuditFinding[] = [];
    const sheetAssessments: string[] = [];
    let resolvedDrawingName = file.name;
    let modelUsed = 'gemini-4-hydrogen';
    let ruleCount =
      AUDIT_STANDARDS[standard].ruleCount +
      (weldingStandard ? WELDING_STANDARDS[weldingStandard].ruleCount : 0);
    let rulebookVersion: string = weldingStandard
      ? `${standard} + ${weldingStandard}`
      : standard;

    for (let pageNum = 1; pageNum <= totalPages; pageNum += 1) {
      throwIfAborted(signal);

      const renderPercent = Math.min(
        98,
        Math.max(3, Math.round(((pageNum - 1 + 0.08) / totalPages) * 100)),
      );
      emitProgress({
        totalPages,
        processedPages: pageNum - 1,
        currentPage: pageNum,
        percent: renderPercent,
        stage: 'rendering',
        statusText: `Rendering sheet ${pageNum} of ${totalPages}...`,
      });

      const renderedPage = await renderLoadedPdfPageAsImage(pdf, pageNum);
      throwIfAborted(signal);

      const auditStartPercent = Math.min(
        98,
        Math.max(renderPercent + 1, Math.round(((pageNum - 1 + 0.22) / totalPages) * 100)),
      );
      emitProgress({
        totalPages,
        processedPages: pageNum - 1,
        currentPage: pageNum,
        percent: auditStartPercent,
        stage: 'auditing',
        statusText: `Auditing sheet ${pageNum} of ${totalPages} against ${activeScopeLabel}...`,
      });

      const sheetReport = await postAuditRequest(
        {
          fileName: file.name,
          pageCount: totalPages,
          sheetNumber: pageNum,
          totalPages,
          standard,
          isAssembly,
          isWelded,
          weldingStandard,
          pageImages: [renderedPage],
          reasoningDepth,
        },
        signal,
      );

      throwIfAborted(signal);

      if (pageNum === 1 && sheetReport.drawingName.trim()) {
        resolvedDrawingName = sheetReport.drawingName.trim();
      }
      const sheetSummary = normalizeExecutiveSummary(
        sheetReport.executive_summary || sheetReport.generalAssessment || '',
      );
      if (sheetSummary) {
        sheetAssessments.push(sheetSummary);
      }
      modelUsed = sheetReport.modelUsed || modelUsed;
      ruleCount = sheetReport.ruleCount || ruleCount;
      rulebookVersion = sheetReport.rulebookVersion || rulebookVersion;

      sheetReport.findings.forEach((finding, idx) => {
        allFindings.push({
          ...finding,
          id: `finding-p${pageNum}-${finding.priority.toLowerCase()}-${idx + 1}`,
          pageNumber: pageNum,
        });
      });

      const completedPercent = Math.round((pageNum / totalPages) * 100);
      emitProgress({
        totalPages,
        processedPages: pageNum,
        currentPage: pageNum,
        percent: completedPercent,
        stage: pageNum < totalPages ? 'auditing' : 'finalizing',
        statusText:
          pageNum < totalPages
            ? `Completed sheet ${pageNum} of ${totalPages}`
            : `Finalizing ${totalPages}-sheet audit report...`,
      });
    }

    const sortedFindings = allFindings.sort((a, b) => {
      const priorityDelta = PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return a.pageNumber - b.pageNumber;
    });

    const executiveSummary =
      totalPages === 1 && sheetAssessments[0]
        ? sheetAssessments[0]
        : buildMultiPageAssessment(totalPages, sortedFindings, sheetAssessments, rulebookVersion);

    const markdown = formatAuditReportToMarkdown(
      resolvedDrawingName,
      executiveSummary,
      sortedFindings,
      { isWelded, weldingStandard },
    );

    return {
      drawingName: resolvedDrawingName,
      executive_summary: executiveSummary,
      generalAssessment: executiveSummary,
      findings: sortedFindings,
      markdown,
      analyzedAt: new Date().toISOString(),
      rulebookVersion,
      ruleCount,
      pageCount: totalPages,
      modelUsed,
      isAssembly,
      isWelded,
      weldingStandard,
    };
  } finally {
    await loadingTask.destroy();
  }
}
