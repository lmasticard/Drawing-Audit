import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Download,
  FileUp,
  PanelLeft,
  PanelRight,
  RotateCw,
  ZoomIn,
  ZoomOut,
  AlertCircle,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { AuditFinding, AuditRunState, AuditStandard } from '../types/audit';
import { pdfjsLib } from '../utils/pdfHelpers';
import { AuditReviewPanel } from './AuditReviewPanel';
import type { BatchAuditItem } from './BatchQueuePanel';
import {
  PdfFindingsOverlayCanvas,
  transformBoundingBoxToPixels,
  type IndexedOverlayFinding,
} from './PdfFindingsOverlayCanvas';

interface PdfPreviewWorkspaceProps {
  file: File;
  blobUrl: string;
  selectedStandard: AuditStandard;
  auditState: AuditRunState;
  batchItems?: BatchAuditItem[];
  activeBatchItemId?: string | null;
  onSelectBatchItem?: (itemId: string) => void;
  onRunAudit: () => void;
  onCancelAudit: () => void;
  onBack: () => void;
  onReplaceClick: () => void;
}

type ViewMode = 'single' | 'continuous';
type RenderEngine = 'canvas' | 'native';
type ZoomPreset = 'fit-page' | 'fit-width' | number;

const ZOOM_STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.75, 0.9, 1, 1.25, 1.5, 2, 2.5, 3];

function buildVisiblePageNumbers(current: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, idx) => idx + 1);
  }
  const pages = new Set<number>([1, total, current]);
  if (current > 1) pages.add(current - 1);
  if (current < total) pages.add(current + 1);
  if (current <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  } else if (current >= total - 2) {
    pages.add(total - 1);
    pages.add(total - 2);
    pages.add(total - 3);
  }
  const sorted = Array.from(pages)
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);

  const result: Array<number | 'ellipsis'> = [];
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
      result.push('ellipsis');
    }
    result.push(sorted[i]);
  }
  return result;
}

interface PdfPageCanvasProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  isThumbnail?: boolean;
  onVisible?: (pageNumber: number) => void;
  overlayFindings?: IndexedOverlayFinding[];
  activeFindingId?: string | null;
  hoveredFindingId?: string | null;
  onHoverFinding?: (findingId: string | null) => void;
  onSelectFinding?: (finding: AuditFinding | null) => void;
}

const PdfPageCanvas: React.FC<PdfPageCanvasProps> = ({
  pdf,
  pageNumber,
  scale,
  rotation,
  isThumbnail = false,
  onVisible,
  overlayFindings,
  activeFindingId = null,
  hoveredFindingId = null,
  onHoverFinding,
  onSelectFinding,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rendering, setRendering] = useState(true);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (!onVisible || !containerRef.current) return;
    const el = containerRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.45) {
            onVisible(pageNumber);
          }
        }
      },
      { threshold: [0.45, 0.65] },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible, pageNumber]);

  useEffect(() => {
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null =
      null;

    const renderPage = async () => {
      setRendering(true);
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        const effectiveRotation = (page.rotate + rotation) % 360;
        const viewport = page.getViewport({ scale, rotation: effectiveRotation });
        const dpr = Math.min(window.devicePixelRatio || 1, isThumbnail ? 1.5 : 2.5);
        const canvas = canvasRef.current;
        if (!canvas) return;

        const cssWidth = Math.floor(viewport.width);
        const cssHeight = Math.floor(viewport.height);
        setDimensions({ width: cssWidth, height: cssHeight });

        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));

        renderTask = page.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });

        await renderTask.promise;
        if (!cancelled) {
          setRendering(false);
        }
      } catch (err) {
        if (!cancelled && err instanceof Error && err.name !== 'RenderingCancelledException') {
          setRendering(false);
        }
      }
    };

    renderPage();

    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // Ignore cancel errors
        }
      }
    };
  }, [pdf, pageNumber, scale, rotation, isThumbnail]);

  return (
    <div
      ref={containerRef}
      className="relative bg-white transition-shadow"
      style={
        dimensions
          ? { width: `${dimensions.width}px`, height: `${dimensions.height}px` }
          : isThumbnail
            ? { width: '148px', height: '192px' }
            : { width: '612px', height: '792px' }
      }
    >
      <canvas
        ref={canvasRef}
        className="block w-full h-full"
        aria-label={`PDF page ${pageNumber}`}
      />
      {!isThumbnail &&
        !rendering &&
        dimensions &&
        overlayFindings &&
        overlayFindings.length > 0 &&
        onHoverFinding &&
        onSelectFinding && (
          <PdfFindingsOverlayCanvas
            width={dimensions.width}
            height={dimensions.height}
            rotation={rotation}
            pageNumber={pageNumber}
            findings={overlayFindings}
            activeFindingId={activeFindingId}
            hoveredFindingId={hoveredFindingId}
            onHoverFinding={onHoverFinding}
            onSelectFinding={onSelectFinding}
          />
        )}
      {rendering && (
        <div
          className="absolute inset-0 bg-slate-50/80 flex items-center justify-center"
          aria-hidden="true"
        >
          <div className="w-5 h-5 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
};

export const PdfPreviewWorkspace: React.FC<PdfPreviewWorkspaceProps> = ({
  file,
  blobUrl,
  selectedStandard,
  auditState,
  batchItems,
  activeBatchItemId = null,
  onSelectBatchItem,
  onRunAudit,
  onCancelAudit,
  onBack,
  onReplaceClick,
}) => {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageInput, setPageInput] = useState<string>('1');
  const [zoomPreset, setZoomPreset] = useState<ZoomPreset>('fit-page');
  const [computedScale, setComputedScale] = useState<number>(1.0);
  const [basePageSize, setBasePageSize] = useState<{ width: number; height: number }>({
    width: 612,
    height: 792,
  });
  const [rotation, setRotation] = useState<number>(0);
  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const [renderEngine, setRenderEngine] = useState<RenderEngine>('canvas');
  const [showThumbnails, setShowThumbnails] = useState<boolean>(false);
  const [showReviewPanel, setShowReviewPanel] = useState<boolean>(true);
  const [showOverlay, setShowOverlay] = useState<boolean>(true);
  const [activeFindingId, setActiveFindingId] = useState<string | null>(null);
  const [hoveredFindingId, setHoveredFindingId] = useState<string | null>(null);
  const [canvasFocusSignal, setCanvasFocusSignal] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const viewportScrollRef = useRef<HTMLDivElement | null>(null);
  const singlePageContainerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // Group located audit findings by page with stable 1-based display indices
  const { findingsByPage, locatedFindingsCount } = useMemo(() => {
    const byPage = new Map<number, IndexedOverlayFinding[]>();
    let count = 0;
    if (auditState.status === 'complete') {
      auditState.report.findings.forEach((finding, idx) => {
        if (!finding.boundingBox) return;
        count += 1;
        const list = byPage.get(finding.pageNumber) ?? [];
        list.push({ finding, index: idx + 1 });
        byPage.set(finding.pageNumber, list);
      });
    }
    return { findingsByPage: byPage, locatedFindingsCount: count };
  }, [auditState]);

  // Clear stale selection/hover when re-running an audit
  useEffect(() => {
    if (auditState.status === 'analyzing') {
      setActiveFindingId(null);
      setHoveredFindingId(null);
    }
  }, [auditState.status]);

  // Load PDF document via PDF.js
  useEffect(() => {
    let active = true;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;

    const load = async () => {
      setIsLoading(true);
      setLoadError(null);
      setCurrentPage(1);
      setPageInput('1');
      setRotation(0);
      setZoomPreset('fit-page');
      setActiveFindingId(null);
      setHoveredFindingId(null);

      try {
        const buffer = await file.arrayBuffer();
        if (!active) return;

        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
        const loadedDoc = await loadingTask.promise;
        if (!active) {
          await loadingTask.destroy();
          return;
        }

        const firstPage = await loadedDoc.getPage(1);
        const vp = firstPage.getViewport({ scale: 1 });
        setBasePageSize({ width: vp.width, height: vp.height });
        setPdfDoc(loadedDoc);
        setNumPages(loadedDoc.numPages);
        setIsLoading(false);
      } catch (err) {
        if (!active) return;
        setLoadError(
          err instanceof Error
            ? err.message
            : 'Unable to parse this PDF in the canvas renderer.',
        );
        setIsLoading(false);
      }
    };

    load();

    return () => {
      active = false;
      if (loadingTask) {
        loadingTask.destroy().catch(() => {});
      }
    };
  }, [file]);

  // Keep basePageSize in sync with the active page (supports mixed sheet sizes in multi-page PDFs)
  useEffect(() => {
    if (!pdfDoc || currentPage < 1 || currentPage > numPages) return;
    let cancelled = false;
    pdfDoc
      .getPage(currentPage)
      .then((page) => {
        if (cancelled) return;
        const vp = page.getViewport({ scale: 1 });
        setBasePageSize({ width: vp.width, height: vp.height });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, currentPage, numPages]);

  // Compute responsive Fit-Page / Fit-Width scale based on actual viewport and page dimensions
  const recomputeScale = useCallback(() => {
    if (typeof zoomPreset === 'number') {
      setComputedScale(zoomPreset);
      return;
    }
    const container = viewportScrollRef.current;
    if (!container) {
      setComputedScale(1.0);
      return;
    }
    const availableWidth = Math.max(160, container.clientWidth - 56);
    const availableHeight = Math.max(160, container.clientHeight - 56);
    const isRotated = rotation % 180 !== 0;
    const effectiveBaseWidth = Math.max(1, isRotated ? basePageSize.height : basePageSize.width);
    const effectiveBaseHeight = Math.max(1, isRotated ? basePageSize.width : basePageSize.height);

    const rawScale =
      zoomPreset === 'fit-page'
        ? Math.min(availableWidth / effectiveBaseWidth, availableHeight / effectiveBaseHeight)
        : availableWidth / effectiveBaseWidth;

    const fitScale = Math.min(3.0, Math.max(0.05, rawScale));
    setComputedScale(Number(fitScale.toFixed(4)));
  }, [zoomPreset, basePageSize, rotation]);

  useEffect(() => {
    recomputeScale();
    const container = viewportScrollRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => recomputeScale());
    observer.observe(container);
    return () => observer.disconnect();
  }, [recomputeScale, showThumbnails, showReviewPanel]);

  const goToPage = useCallback(
    (target: number, skipScrollReset = false) => {
      if (numPages <= 0) return;
      const clamped = Math.max(1, Math.min(numPages, target));
      setCurrentPage(clamped);
      setPageInput(String(clamped));
      if (skipScrollReset) return;
      if (viewMode === 'continuous') {
        const node = pageRefs.current[clamped];
        if (node) {
          node.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } else if (viewportScrollRef.current) {
        viewportScrollRef.current.scrollTo({ top: 0, behavior: 'auto' });
      }
    },
    [numPages, viewMode],
  );

  const stepZoom = useCallback(
    (direction: 'in' | 'out') => {
      const current = computedScale;
      if (direction === 'in') {
        const next = ZOOM_STEPS.find((z) => z > current + 0.02) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
        setZoomPreset(next);
      } else {
        const reversed = [...ZOOM_STEPS].reverse();
        const prev = reversed.find((z) => z < current - 0.02) ?? ZOOM_STEPS[0];
        setZoomPreset(prev);
      }
    },
    [computedScale],
  );

  const rotateClockwise = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360);
  }, []);

  const handleDownload = useCallback(() => {
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [blobUrl, file.name]);

  // Desktop keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA')
      ) {
        return;
      }

      if (event.key === 'Escape') {
        onBack();
      } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        goToPage(currentPage + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        goToPage(currentPage - 1);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        stepZoom('in');
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        stepZoom('out');
      } else if (event.key === '0') {
        event.preventDefault();
        setZoomPreset('fit-page');
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        rotateClockwise();
      } else if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        setShowThumbnails((prev) => !prev);
      } else if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        setShowOverlay((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPage, goToPage, onBack, rotateClockwise, stepZoom]);

  const handlePageInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number.parseInt(pageInput, 10);
    if (!Number.isNaN(parsed)) {
      goToPage(parsed);
    } else {
      setPageInput(String(currentPage));
    }
  };

  const handleVisiblePage = useCallback((pageNum: number) => {
    setCurrentPage(pageNum);
    setPageInput(String(pageNum));
  }, []);

  const scrollToFindingBox = useCallback(
    (finding: AuditFinding) => {
      if (!finding.boundingBox || renderEngine !== 'canvas') return;
      const box = finding.boundingBox;

      const attemptScroll = () => {
        const scrollEl = viewportScrollRef.current;
        if (!scrollEl) return;
        const wrapper =
          viewMode === 'single'
            ? singlePageContainerRef.current
            : pageRefs.current[finding.pageNumber];
        const pageCanvas = wrapper?.querySelector('canvas');
        if (!pageCanvas) return;

        const scrollRect = scrollEl.getBoundingClientRect();
        const canvasRect = pageCanvas.getBoundingClientRect();
        if (canvasRect.width <= 0 || canvasRect.height <= 0) return;

        const pixelRect = transformBoundingBoxToPixels(
          box,
          canvasRect.width,
          canvasRect.height,
          rotation,
        );

        const targetCenterX =
          canvasRect.left - scrollRect.left + scrollEl.scrollLeft + pixelRect.x + pixelRect.w / 2;
        const targetCenterY =
          canvasRect.top - scrollRect.top + scrollEl.scrollTop + pixelRect.y + pixelRect.h / 2;

        scrollEl.scrollTo({
          left: Math.max(0, targetCenterX - scrollEl.clientWidth / 2),
          top: Math.max(0, targetCenterY - scrollEl.clientHeight / 2),
          behavior: 'smooth',
        });
      };

      // Defer two animation frames so any page switch renders before centering
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(attemptScroll);
      });
    },
    [renderEngine, rotation, viewMode],
  );

  const handleSelectFindingFromPanel = useCallback(
    (finding: AuditFinding) => {
      setActiveFindingId(finding.id);
      if (finding.boundingBox) {
        setShowOverlay(true);
      }
      if (finding.pageNumber >= 1 && finding.pageNumber <= Math.max(numPages, 1)) {
        goToPage(finding.pageNumber, Boolean(finding.boundingBox));
      }
      if (finding.boundingBox) {
        scrollToFindingBox(finding);
      }
    },
    [goToPage, numPages, scrollToFindingBox],
  );

  const handleSelectFindingFromCanvas = useCallback((finding: AuditFinding | null) => {
    if (!finding) {
      setActiveFindingId(null);
      return;
    }
    setActiveFindingId(finding.id);
    setCanvasFocusSignal((prev) => prev + 1);
    setShowReviewPanel(true);
  }, []);

  const zoomPercentageLabel = `${Math.round(computedScale * 100)}%`;

  return (
    <section
      aria-label="Drawing Review Workspace"
      className="flex flex-col h-[calc(100vh-4rem)] bg-blueprint-mosaic"
    >
      {/* Desktop Studio Preview Toolbar */}
      <div className="h-14 shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 flex items-center justify-between gap-4 transition-colors duration-200">
        {/* Left: Return & Active Document Info */}
        <div className="flex items-center gap-4 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Upload</span>
          </button>

          <div className="h-5 w-px bg-slate-200 dark:bg-slate-700 shrink-0" aria-hidden="true" />

          <div className="min-w-0 flex items-center gap-2.5">
            <span
              className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate max-w-[260px] xl:max-w-[360px]"
              title={file.name}
            >
              {file.name}
            </span>
            {numPages > 0 && renderEngine === 'canvas' && (
              <>
                <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
                  {numPages} {numPages === 1 ? 'page' : 'pages'}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Center: Navigation, Zoom & Rotation Controls */}
        {renderEngine === 'canvas' && !loadError && (
          <div className="flex items-center gap-3 shrink-0">
            {/* Page Stepper */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1 || isLoading}
                aria-label="Previous page"
                className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-transparent rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              <form onSubmit={handlePageInputSubmit} className="flex items-center gap-1.5">
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="Current page number"
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onBlur={() => {
                    const parsed = Number.parseInt(pageInput, 10);
                    if (!Number.isNaN(parsed)) {
                      goToPage(parsed);
                    } else {
                      setPageInput(String(currentPage));
                    }
                  }}
                  className="w-11 h-7 text-center text-xs font-mono tabular-nums text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                />
                <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                  / {numPages || '–'}
                </span>
              </form>

              <button
                type="button"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= numPages || isLoading}
                aria-label="Next page"
                className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-transparent rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="h-5 w-px bg-slate-200 dark:bg-slate-700" aria-hidden="true" />

            {/* Zoom Controls */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => stepZoom('out')}
                aria-label="Zoom out"
                className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <ZoomOut className="w-4 h-4" />
              </button>

              <select
                aria-label="Zoom level"
                value={typeof zoomPreset === 'string' ? zoomPreset : String(zoomPreset)}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === 'fit-page' || val === 'fit-width') {
                    setZoomPreset(val);
                  } else {
                    setZoomPreset(Number(val));
                  }
                }}
                className="h-7 px-2 text-xs font-mono tabular-nums text-slate-800 dark:text-slate-100 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer"
              >
                <option value="fit-page">
                  {zoomPreset === 'fit-page' ? `Fit Page (${zoomPercentageLabel})` : 'Fit Page'}
                </option>
                <option value="fit-width">
                  {zoomPreset === 'fit-width' ? `Fit Width (${zoomPercentageLabel})` : 'Fit Width'}
                </option>
                {ZOOM_STEPS.map((z) => (
                  <option key={z} value={String(z)}>
                    {Math.round(z * 100)}%
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => stepZoom('in')}
                aria-label="Zoom in"
                className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
            </div>

            <div className="h-5 w-px bg-slate-200 dark:bg-slate-700" aria-hidden="true" />

            {/* Rotate */}
            <button
              type="button"
              onClick={rotateClockwise}
              title="Rotate 90° clockwise (R)"
              aria-label="Rotate page 90 degrees clockwise"
              className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <RotateCw className="w-4 h-4" />
            </button>

            {/* View Mode Segmented Control */}
            <div className="hidden xl:flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200/80 dark:border-slate-700">
              <button
                type="button"
                onClick={() => setViewMode('single')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'single'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                Single Page
              </button>
              <button
                type="button"
                onClick={() => setViewMode('continuous')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'continuous'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                Continuous
              </button>
            </div>
          </div>
        )}

        {/* Right: Sidebar Toggle, Engine Switch, Download & Replace */}
        <div className="flex items-center gap-2 shrink-0">
          {renderEngine === 'canvas' && !loadError && numPages > 1 && (
            <button
              type="button"
              onClick={() => setShowThumbnails((prev) => !prev)}
              aria-pressed={showThumbnails}
              title="Toggle page thumbnails (T)"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                showThumbnails
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white border-slate-300 dark:border-slate-600'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:text-slate-900 dark:hover:text-white hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <PanelLeft className="w-3.5 h-3.5" />
              <span>Pages</span>
            </button>
          )}

          {renderEngine === 'canvas' && !loadError && (
            <button
              type="button"
              onClick={() => setShowOverlay((prev) => !prev)}
              aria-pressed={showOverlay}
              title="Toggle P0–P3 bounding-box overlay (M)"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                showOverlay && locatedFindingsCount > 0
                  ? 'bg-blue-50 dark:bg-sky-950/60 text-blue-800 dark:text-sky-300 border-blue-200 dark:border-sky-800'
                  : showOverlay
                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white border-slate-300 dark:border-slate-600'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:text-slate-900 dark:hover:text-white hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Crosshair className="w-3.5 h-3.5" />
              <span>
                Markers
                {locatedFindingsCount > 0 ? ` (${locatedFindingsCount})` : ''}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowReviewPanel((prev) => !prev)}
            aria-pressed={showReviewPanel}
            title="Toggle P0-P3 Design Review panel"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
              showReviewPanel
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white border-slate-300 dark:border-slate-600'
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:text-slate-900 dark:hover:text-white hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            <PanelRight className="w-3.5 h-3.5" />
            <span>Review</span>
          </button>

          <div className="hidden 2xl:flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200/80 dark:border-slate-700">
            <button
              type="button"
              onClick={() => setRenderEngine('canvas')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                renderEngine === 'canvas'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Canvas
            </button>
            <button
              type="button"
              onClick={() => setRenderEngine('native')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                renderEngine === 'native'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Browser PDF
            </button>
          </div>

          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download</span>
          </button>

          <button
            type="button"
            onClick={onReplaceClick}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <FileUp className="w-3.5 h-3.5" />
            <span>{batchItems && batchItems.length > 1 ? 'Add PDFs' : 'Open PDF'}</span>
          </button>
        </div>
      </div>

      {/* Compact Batch Drawing Switcher Bar (visible when multiple PDFs are queued/loaded) */}
      {batchItems && batchItems.length > 1 && onSelectBatchItem && (() => {
        const currentIndex = Math.max(
          0,
          batchItems.findIndex((item) => item.id === activeBatchItemId),
        );
        const total = batchItems.length;
        const completedCount = batchItems.filter((item) => item.status === 'complete').length;
        const errorCount = batchItems.filter((item) => item.status === 'error').length;
        const analyzingItem = batchItems.find((item) => item.status === 'analyzing') ?? null;
        const activeFraction =
          analyzingItem && analyzingItem.auditState.status === 'analyzing'
            ? Math.max(0, Math.min(100, analyzingItem.auditState.progress.percent)) / 100
            : 0;
        const overallPercent = Math.min(
          100,
          Math.round(((completedCount + errorCount + activeFraction) / total) * 100),
        );

        const formatOptionLabel = (item: BatchAuditItem, index: number) => {
          const prefix = `${String(index + 1).padStart(2, '0')}. ${item.file.name}`;
          if (item.status === 'complete' && item.auditState.status === 'complete') {
            return `${prefix} — Complete (${item.auditState.report.findings.length})`;
          }
          if (item.status === 'analyzing' && item.auditState.status === 'analyzing') {
            return `${prefix} — Auditing ${item.auditState.progress.percent}%`;
          }
          if (item.status === 'queued') return `${prefix} — Queued`;
          if (item.status === 'error') return `${prefix} — Error`;
          return `${prefix} — Cancelled`;
        };

        return (
          <div
            aria-label="Batch drawing switcher"
            className="h-10 shrink-0 bg-slate-50 dark:bg-slate-900/95 border-b border-slate-200 dark:border-slate-800 px-6 flex items-center justify-between gap-4 text-xs transition-colors duration-200"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono font-semibold uppercase tracking-wide text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
                Batch
              </span>
              <button
                type="button"
                onClick={() => onSelectBatchItem(batchItems[currentIndex - 1].id)}
                disabled={currentIndex <= 0}
                aria-label="Previous drawing in batch"
                className="p-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-transparent rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>

              <select
                aria-label="Select drawing from batch"
                value={batchItems[currentIndex]?.id ?? ''}
                onChange={(e) => onSelectBatchItem(e.target.value)}
                className="h-7 px-2 max-w-[280px] sm:max-w-[380px] text-xs font-medium text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer truncate"
              >
                {batchItems.map((item, idx) => (
                  <option key={item.id} value={item.id}>
                    {formatOptionLabel(item, idx)}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => onSelectBatchItem(batchItems[currentIndex + 1].id)}
                disabled={currentIndex >= total - 1}
                aria-label="Next drawing in batch"
                className="p-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-transparent rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>

              <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
                {currentIndex + 1} / {total}
              </span>
            </div>

            <div className="hidden md:flex items-center gap-3 min-w-0 shrink-0">
              {analyzingItem && analyzingItem.auditState.status === 'analyzing' ? (
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-3 h-3 border-2 border-slate-300 dark:border-slate-700 border-t-blue-700 dark:border-t-sky-400 rounded-full animate-spin shrink-0" />
                  <span className="text-slate-700 dark:text-slate-200 truncate max-w-[220px]">
                    Auditing {analyzingItem.file.name} ({analyzingItem.auditState.progress.percent}%)
                  </span>
                </div>
              ) : (
                <span className="text-slate-600 dark:text-slate-300 whitespace-nowrap">
                  {completedCount} of {total} completed
                  {errorCount > 0 ? ` · ${errorCount} failed` : ''}
                </span>
              )}

              <div
                role="progressbar"
                aria-label="Background batch progress"
                aria-valuenow={overallPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="w-24 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800 shrink-0"
              >
                <div
                  className="h-full rounded-full bg-blue-700 dark:bg-sky-400 transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.max(analyzingItem ? 4 : 0, overallPercent)}%` }}
                />
              </div>
              <span className="font-mono tabular-nums font-semibold text-blue-700 dark:text-sky-400 shrink-0">
                {overallPercent}%
              </span>
            </div>
          </div>
        );
      })()}

      {/* Main Split Review + Drawing Preview Viewport */}
      <div className="flex flex-col lg:flex-row flex-1 min-h-0 overflow-hidden">
        {/* Left Collapsible Thumbnail Rail */}
        {renderEngine === 'canvas' && !loadError && showThumbnails && pdfDoc && (
          <aside
            aria-label="Page thumbnails"
            className="w-56 shrink-0 bg-[#F8F9FB] dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 overflow-y-auto px-4 py-5"
          >
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-4 px-1">
              Pages ({numPages})
            </div>
            <div className="flex flex-col gap-4">
              {Array.from({ length: numPages }, (_, idx) => idx + 1).map((pageNum) => {
                const isActive = pageNum === currentPage;
                return (
                  <button
                    key={pageNum}
                    type="button"
                    onClick={() => goToPage(pageNum)}
                    className={`group flex flex-col items-center gap-2 p-2.5 rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                      isActive
                        ? 'bg-blue-50/70 dark:bg-sky-950/50 border-blue-600 dark:border-sky-500'
                        : 'bg-transparent border-transparent hover:bg-slate-100 dark:hover:bg-slate-800 hover:border-slate-200 dark:hover:border-slate-700'
                    }`}
                  >
                    <div className="shadow-xs border border-slate-200 dark:border-slate-700 overflow-hidden bg-white">
                      <PdfPageCanvas
                        pdf={pdfDoc}
                        pageNumber={pageNum}
                        scale={148 / Math.max(basePageSize.width, 1)}
                        rotation={rotation}
                        isThumbnail
                      />
                    </div>
                    <span
                      className={`text-xs font-mono tabular-nums ${
                        isActive
                          ? 'font-medium text-blue-700 dark:text-sky-400'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {pageNum}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>
        )}

        {/* Primary Document Canvas / Native Frame + Bottom Page Navigation */}
        <div className="flex-1 min-w-0 min-h-[42vh] lg:min-h-0 flex flex-col overflow-hidden">
          <div ref={viewportScrollRef} className="flex-1 min-h-0 overflow-auto">
            {renderEngine === 'native' ? (
              <div className="w-full h-full p-6 flex justify-center">
                <div className="w-full h-full max-w-5xl bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
                  <iframe
                    src={blobUrl}
                    title={`Preview of ${file.name}`}
                    className="w-full h-full min-h-[720px] border-0"
                  />
                </div>
              </div>
            ) : (
              <div className="min-w-full min-h-full w-fit p-6 flex flex-col items-center justify-start">
                {isLoading ? (
                  <div className="w-[680px] max-w-full aspect-[8.5/11] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col items-center justify-center gap-3">
                    <div className="w-6 h-6 border-2 border-slate-300 dark:border-slate-700 border-t-blue-700 dark:border-t-sky-400 rounded-full animate-spin" />
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                      Rendering PDF document...
                    </p>
                  </div>
                ) : loadError ? (
                  <div className="max-w-lg w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-8 text-center mt-12">
                    <div className="w-10 h-10 rounded-lg bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400 flex items-center justify-center mx-auto mb-4">
                      <AlertCircle className="w-5 h-5" />
                    </div>
                    <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-2">
                      Could not render this PDF on canvas
                    </h2>
                    <p className="text-sm text-slate-600 dark:text-slate-300 mb-6">{loadError}</p>
                    <div className="flex items-center justify-center gap-3">
                      <button
                        type="button"
                        onClick={() => setRenderEngine('native')}
                        className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 dark:bg-sky-500 dark:hover:bg-sky-400 dark:text-slate-950 rounded-lg transition-colors whitespace-nowrap"
                      >
                        Open in Browser PDF Viewer
                      </button>
                      <button
                        type="button"
                        onClick={onBack}
                        className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap"
                      >
                        Back to Upload
                      </button>
                    </div>
                  </div>
                ) : pdfDoc ? (
                  viewMode === 'single' ? (
                    <div
                      ref={singlePageContainerRef}
                      className="shadow-md border border-slate-300/80 bg-white shrink-0"
                    >
                      <PdfPageCanvas
                        pdf={pdfDoc}
                        pageNumber={currentPage}
                        scale={computedScale}
                        rotation={rotation}
                        overlayFindings={showOverlay ? (findingsByPage.get(currentPage) ?? []) : []}
                        activeFindingId={activeFindingId}
                        hoveredFindingId={hoveredFindingId}
                        onHoverFinding={setHoveredFindingId}
                        onSelectFinding={handleSelectFindingFromCanvas}
                      />
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-6 pb-6">
                      {Array.from({ length: numPages }, (_, idx) => idx + 1).map((pageNum) => (
                        <div
                          key={pageNum}
                          ref={(el) => {
                            pageRefs.current[pageNum] = el;
                          }}
                          className="flex flex-col items-center gap-2 shrink-0"
                        >
                          <div className="shadow-md border border-slate-300/80 bg-white">
                            <PdfPageCanvas
                              pdf={pdfDoc}
                              pageNumber={pageNum}
                              scale={computedScale}
                              rotation={rotation}
                              onVisible={handleVisiblePage}
                              overlayFindings={showOverlay ? (findingsByPage.get(pageNum) ?? []) : []}
                              activeFindingId={activeFindingId}
                              hoveredFindingId={hoveredFindingId}
                              onHoverFinding={setHoveredFindingId}
                              onSelectFinding={handleSelectFindingFromCanvas}
                            />
                          </div>
                          <span className="text-xs font-mono tabular-nums text-slate-200">
                            Page {pageNum} of {numPages}
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                ) : null}
              </div>
            )}
          </div>

          {/* Bottom Page-Selector Navigation Bar */}
          {renderEngine === 'canvas' && !loadError && pdfDoc && numPages > 0 && (
            <nav
              aria-label="PDF page navigation"
              className="h-12 shrink-0 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 px-4 flex items-center justify-between gap-3 transition-colors duration-200"
            >
              <button
                type="button"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1 || isLoading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white disabled:opacity-40 disabled:hover:bg-white dark:disabled:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Previous Page</span>
              </button>

              <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto">
                <div className="hidden sm:flex items-center gap-1">
                  {buildVisiblePageNumbers(currentPage, numPages).map((item, idx) =>
                    item === 'ellipsis' ? (
                      <span
                        key={`ellipsis-${idx}`}
                        className="px-1.5 text-xs font-mono text-slate-400 dark:text-slate-500 select-none"
                        aria-hidden="true"
                      >
                        …
                      </span>
                    ) : (
                      <button
                        key={item}
                        type="button"
                        onClick={() => goToPage(item)}
                        aria-current={item === currentPage ? 'page' : undefined}
                        title={
                          (findingsByPage.get(item)?.length ?? 0) > 0
                            ? `Sheet ${item} (${findingsByPage.get(item)?.length} pinned findings)`
                            : `Go to page ${item}`
                        }
                        className={`relative min-w-[28px] h-7 px-2 text-xs font-mono tabular-nums rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                          item === currentPage
                            ? 'bg-slate-900 text-white dark:bg-sky-500 dark:text-slate-950 font-semibold'
                            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                        }`}
                      >
                        {item}
                        {(findingsByPage.get(item)?.length ?? 0) > 0 && (
                          <span
                            aria-hidden="true"
                            className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ${
                              item === currentPage
                                ? 'bg-sky-300 dark:bg-slate-950'
                                : 'bg-blue-600 dark:bg-sky-400'
                            }`}
                          />
                        )}
                      </button>
                    ),
                  )}
                </div>

                {numPages > 1 && (
                  <div
                    className="hidden md:block h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1"
                    aria-hidden="true"
                  />
                )}

                <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
                  <span className="sr-only">Jump to page</span>
                  <select
                    aria-label="Select PDF page"
                    value={String(currentPage)}
                    onChange={(e) => goToPage(Number(e.target.value))}
                    className="h-7 px-2 text-xs font-mono tabular-nums text-slate-800 dark:text-slate-100 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer"
                  >
                    {Array.from({ length: numPages }, (_, idx) => idx + 1).map((pageNum) => (
                      <option key={pageNum} value={String(pageNum)}>
                        Page {pageNum} of {numPages}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <button
                type="button"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= numPages || isLoading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white disabled:opacity-40 disabled:hover:bg-white dark:disabled:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <span>Next Page</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </nav>
          )}
        </div>

        {/* Right P0-P3 Engineering Design Review Panel */}
        {showReviewPanel && (
          <AuditReviewPanel
            fileName={file.name}
            selectedStandard={selectedStandard}
            auditState={auditState}
            activeFindingId={activeFindingId}
            hoveredFindingId={hoveredFindingId}
            canvasFocusSignal={canvasFocusSignal}
            onHoverFinding={setHoveredFindingId}
            onSelectFinding={handleSelectFindingFromPanel}
            onRunAudit={onRunAudit}
            onCancelAudit={onCancelAudit}
          />
        )}
      </div>
    </section>
  );
};
