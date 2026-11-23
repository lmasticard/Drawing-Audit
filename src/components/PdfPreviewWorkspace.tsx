import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
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

interface PdfPreviewWorkspaceProps {
  file: File;
  blobUrl: string;
  selectedStandard: AuditStandard;
  auditState: AuditRunState;
  onRunAudit: () => void;
  onCancelAudit: () => void;
  onBack: () => void;
  onReplaceClick: () => void;
}

type ViewMode = 'single' | 'continuous';
type RenderEngine = 'canvas' | 'native';
type ZoomPreset = 'fit-width' | number;

const ZOOM_STEPS = [0.5, 0.75, 0.9, 1, 1.15, 1.25, 1.5, 1.75, 2];

interface PdfPageCanvasProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  isThumbnail?: boolean;
  onVisible?: (pageNumber: number) => void;
}

const PdfPageCanvas: React.FC<PdfPageCanvasProps> = ({
  pdf,
  pageNumber,
  scale,
  rotation,
  isThumbnail = false,
  onVisible,
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

        const viewport = page.getViewport({ scale, rotation });
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
  onRunAudit,
  onCancelAudit,
  onBack,
  onReplaceClick,
}) => {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageInput, setPageInput] = useState<string>('1');
  const [zoomPreset, setZoomPreset] = useState<ZoomPreset>('fit-width');
  const [computedScale, setComputedScale] = useState<number>(1.0);
  const [basePageWidth, setBasePageWidth] = useState<number>(612);
  const [rotation, setRotation] = useState<number>(0);
  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const [renderEngine, setRenderEngine] = useState<RenderEngine>('canvas');
  const [showThumbnails, setShowThumbnails] = useState<boolean>(false);
  const [showReviewPanel, setShowReviewPanel] = useState<boolean>(true);
  const [activeFindingId, setActiveFindingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const viewportScrollRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

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
        setBasePageWidth(vp.width);
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

  // Compute responsive Fit-Width scale based on desktop viewport panel size
  const recomputeScale = useCallback(() => {
    if (zoomPreset !== 'fit-width') {
      setComputedScale(zoomPreset);
      return;
    }
    const container = viewportScrollRef.current;
    if (!container) {
      setComputedScale(1.15);
      return;
    }
    const availableWidth = Math.max(320, container.clientWidth - 64);
    const effectiveBaseWidth =
      rotation % 180 === 0 ? basePageWidth : Math.max(basePageWidth * 1.28, 680);
    const fitScale = Math.min(1.85, Math.max(0.45, availableWidth / effectiveBaseWidth));
    setComputedScale(Number(fitScale.toFixed(3)));
  }, [zoomPreset, basePageWidth, rotation]);

  useEffect(() => {
    recomputeScale();
    const container = viewportScrollRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => recomputeScale());
    observer.observe(container);
    return () => observer.disconnect();
  }, [recomputeScale, showThumbnails, showReviewPanel]);

  const goToPage = useCallback(
    (target: number) => {
      if (numPages <= 0) return;
      const clamped = Math.max(1, Math.min(numPages, target));
      setCurrentPage(clamped);
      setPageInput(String(clamped));
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
        const next = ZOOM_STEPS.find((z) => z > current + 0.04) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
        setZoomPreset(next);
      } else {
        const reversed = [...ZOOM_STEPS].reverse();
        const prev = reversed.find((z) => z < current - 0.04) ?? ZOOM_STEPS[0];
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
        setZoomPreset('fit-width');
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        rotateClockwise();
      } else if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        setShowThumbnails((prev) => !prev);
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

  const handleSelectFinding = useCallback(
    (finding: AuditFinding) => {
      setActiveFindingId(finding.id);
      if (finding.pageNumber >= 1 && finding.pageNumber <= Math.max(numPages, 1)) {
        goToPage(finding.pageNumber);
      }
    },
    [goToPage, numPages],
  );

  const zoomPercentageLabel = `${Math.round(computedScale * 100)}%`;

  return (
    <section
      aria-label="Drawing Review Workspace"
      className="flex flex-col h-[calc(100vh-4rem)] bg-blueprint-mosaic"
    >
      {/* Desktop Studio Preview Toolbar */}
      <div className="h-14 shrink-0 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-4">
        {/* Left: Return & Active Document Info */}
        <div className="flex items-center gap-4 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Upload</span>
          </button>

          <div className="h-5 w-px bg-slate-200 shrink-0" aria-hidden="true" />

          <div className="min-w-0 flex items-center gap-2.5">
            <span
              className="text-sm font-semibold text-slate-900 truncate max-w-[260px] xl:max-w-[360px]"
              title={file.name}
            >
              {file.name}
            </span>
            {numPages > 0 && renderEngine === 'canvas' && (
              <>
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
                <span className="text-xs font-mono tabular-nums text-slate-500 whitespace-nowrap shrink-0">
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
                className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
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
                  className="w-11 h-7 text-center text-xs font-mono tabular-nums text-slate-900 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                />
                <span className="text-xs font-mono tabular-nums text-slate-500 whitespace-nowrap">
                  / {numPages || '–'}
                </span>
              </form>

              <button
                type="button"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= numPages || isLoading}
                aria-label="Next page"
                className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="h-5 w-px bg-slate-200" aria-hidden="true" />

            {/* Zoom Controls */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => stepZoom('out')}
                aria-label="Zoom out"
                className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <ZoomOut className="w-4 h-4" />
              </button>

              <select
                aria-label="Zoom level"
                value={zoomPreset === 'fit-width' ? 'fit-width' : String(zoomPreset)}
                onChange={(e) => {
                  const val = e.target.value;
                  setZoomPreset(val === 'fit-width' ? 'fit-width' : Number(val));
                }}
                className="h-7 px-2 text-xs font-mono tabular-nums text-slate-800 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer"
              >
                <option value="fit-width">Fit ({zoomPercentageLabel})</option>
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
                className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
            </div>

            <div className="h-5 w-px bg-slate-200" aria-hidden="true" />

            {/* Rotate */}
            <button
              type="button"
              onClick={rotateClockwise}
              title="Rotate 90° clockwise (R)"
              aria-label="Rotate page 90 degrees clockwise"
              className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <RotateCw className="w-4 h-4" />
            </button>

            {/* View Mode Segmented Control */}
            <div className="hidden xl:flex items-center p-0.5 bg-slate-100 rounded-lg border border-slate-200/80">
              <button
                type="button"
                onClick={() => setViewMode('single')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'single'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Single Page
              </button>
              <button
                type="button"
                onClick={() => setViewMode('continuous')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'continuous'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
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
                  ? 'bg-slate-100 text-slate-900 border-slate-300'
                  : 'bg-white text-slate-600 border-slate-200 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <PanelLeft className="w-3.5 h-3.5" />
              <span>Pages</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowReviewPanel((prev) => !prev)}
            aria-pressed={showReviewPanel}
            title="Toggle P0-P3 Design Review panel"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
              showReviewPanel
                ? 'bg-slate-100 text-slate-900 border-slate-300'
                : 'bg-white text-slate-600 border-slate-200 hover:text-slate-900 hover:bg-slate-50'
            }`}
          >
            <PanelRight className="w-3.5 h-3.5" />
            <span>Review</span>
          </button>

          <div className="hidden 2xl:flex items-center p-0.5 bg-slate-100 rounded-lg border border-slate-200/80">
            <button
              type="button"
              onClick={() => setRenderEngine('canvas')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                renderEngine === 'canvas'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Canvas
            </button>
            <button
              type="button"
              onClick={() => setRenderEngine('native')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                renderEngine === 'native'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Browser PDF
            </button>
          </div>

          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:text-slate-900 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download</span>
          </button>

          <button
            type="button"
            onClick={onReplaceClick}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <FileUp className="w-3.5 h-3.5" />
            <span>Open PDF</span>
          </button>
        </div>
      </div>

      {/* Main Split Review + Drawing Preview Viewport */}
      <div className="flex flex-col lg:flex-row flex-1 min-h-0 overflow-hidden">
        {/* Left Collapsible Thumbnail Rail */}
        {renderEngine === 'canvas' && !loadError && showThumbnails && pdfDoc && (
          <aside
            aria-label="Page thumbnails"
            className="w-56 shrink-0 bg-[#F8F9FB] border-r border-slate-200 overflow-y-auto px-4 py-5"
          >
            <div className="text-xs font-medium text-slate-500 mb-4 px-1">
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
                        ? 'bg-blue-50/70 border-blue-600'
                        : 'bg-transparent border-transparent hover:bg-slate-100 hover:border-slate-200'
                    }`}
                  >
                    <div className="shadow-xs border border-slate-200 overflow-hidden bg-white">
                      <PdfPageCanvas
                        pdf={pdfDoc}
                        pageNumber={pageNum}
                        scale={148 / Math.max(basePageWidth, 1)}
                        rotation={rotation}
                        isThumbnail
                      />
                    </div>
                    <span
                      className={`text-xs font-mono tabular-nums ${
                        isActive ? 'font-medium text-blue-700' : 'text-slate-500'
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

        {/* Primary Document Canvas / Native Frame */}
        <div
          ref={viewportScrollRef}
          className="flex-1 min-w-0 min-h-[42vh] lg:min-h-0 overflow-auto flex flex-col items-center py-6 px-6"
        >
          {renderEngine === 'native' ? (
            <div className="w-full h-full max-w-5xl bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
              <iframe
                src={blobUrl}
                title={`Preview of ${file.name}`}
                className="w-full h-full min-h-[720px] border-0"
              />
            </div>
          ) : isLoading ? (
            <div className="w-[680px] max-w-full aspect-[8.5/11] bg-white border border-slate-200 shadow-sm flex flex-col items-center justify-center gap-3">
              <div className="w-6 h-6 border-2 border-slate-300 border-t-blue-700 rounded-full animate-spin" />
              <p className="text-sm text-slate-600">Rendering PDF document...</p>
            </div>
          ) : loadError ? (
            <div className="max-w-lg w-full bg-white border border-slate-200 rounded-xl p-8 text-center mt-12">
              <div className="w-10 h-10 rounded-lg bg-red-50 text-red-700 flex items-center justify-center mx-auto mb-4">
                <AlertCircle className="w-5 h-5" />
              </div>
              <h2 className="text-base font-semibold text-slate-900 mb-2">
                Could not render this PDF on canvas
              </h2>
              <p className="text-sm text-slate-600 mb-6">{loadError}</p>
              <div className="flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setRenderEngine('native')}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap"
                >
                  Open in Browser PDF Viewer
                </button>
                <button
                  type="button"
                  onClick={onBack}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap"
                >
                  Back to Upload
                </button>
              </div>
            </div>
          ) : pdfDoc ? (
            viewMode === 'single' ? (
              <div className="shadow-md border border-slate-300/80 bg-white">
                <PdfPageCanvas
                  pdf={pdfDoc}
                  pageNumber={currentPage}
                  scale={computedScale}
                  rotation={rotation}
                />
              </div>
            ) : (
              <div className="flex flex-col items-center gap-6 pb-12">
                {Array.from({ length: numPages }, (_, idx) => idx + 1).map((pageNum) => (
                  <div
                    key={pageNum}
                    ref={(el) => {
                      pageRefs.current[pageNum] = el;
                    }}
                    className="flex flex-col items-center gap-2"
                  >
                    <div className="shadow-md border border-slate-300/80 bg-white">
                      <PdfPageCanvas
                        pdf={pdfDoc}
                        pageNumber={pageNum}
                        scale={computedScale}
                        rotation={rotation}
                        onVisible={handleVisiblePage}
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

        {/* Right P0-P3 Engineering Design Review Panel */}
        {showReviewPanel && (
          <AuditReviewPanel
            fileName={file.name}
            selectedStandard={selectedStandard}
            auditState={auditState}
            activeFindingId={activeFindingId}
            onSelectFinding={handleSelectFinding}
            onRunAudit={onRunAudit}
            onCancelAudit={onCancelAudit}
          />
        )}
      </div>
    </section>
  );
};
