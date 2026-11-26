import React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  CloudUpload,
  Download,
  FileDown,
  FileText,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import type { AuditRunState, AuditStandard, WeldingStandard } from '../types/audit';
import { exportAuditReportToPdf } from '../utils/exportAuditPdf';
import {
  formatFileSize,
  type PdfInspectionResult,
} from '../utils/pdfHelpers';

export interface BatchAuditConfig {
  standard: AuditStandard;
  isAssembly: boolean;
  isWelded: boolean;
  weldingStandard: WeldingStandard | null;
}

export type BatchItemStatus = 'queued' | 'analyzing' | 'complete' | 'error' | 'cancelled';

export interface BatchAuditItem {
  id: string;
  file: File;
  blobUrl: string;
  inspection: PdfInspectionResult | null;
  isInspecting: boolean;
  config: BatchAuditConfig;
  auditState: AuditRunState;
  status: BatchItemStatus;
  queuedAt: number;
}

export function formatBatchConfigLabel(config: BatchAuditConfig): string {
  if (config.isAssembly && config.isWelded && config.weldingStandard) {
    return `${config.standard} + ${config.weldingStandard}`;
  }
  if (config.isAssembly) {
    return `${config.standard} (Assembly)`;
  }
  return config.standard;
}

interface BatchQueuePanelProps {
  items: BatchAuditItem[];
  currentConfig: BatchAuditConfig;
  isDriveConnected: boolean;
  hasLinkedFolder: boolean;
  onOpenReview: (itemId: string) => void;
  onRetryItem: (itemId: string) => void;
  onRemoveItem: (itemId: string) => void;
  onAddMorePdfs: () => void;
  onStopBatch: () => void;
  onRerunAll: () => void;
  onClearAll: () => void;
  onUploadItemToDrive: (item: BatchAuditItem) => void;
}

export const BatchQueuePanel: React.FC<BatchQueuePanelProps> = ({
  items,
  currentConfig,
  isDriveConnected,
  hasLinkedFolder,
  onOpenReview,
  onRetryItem,
  onRemoveItem,
  onAddMorePdfs,
  onStopBatch,
  onRerunAll,
  onClearAll,
  onUploadItemToDrive,
}) => {
  const totalCount = items.length;
  const completedItems = items.filter((item) => item.status === 'complete');
  const completedCount = completedItems.length;
  const errorCount = items.filter((item) => item.status === 'error').length;
  const queuedCount = items.filter((item) => item.status === 'queued').length;
  const analyzingItem = items.find((item) => item.status === 'analyzing') ?? null;
  const isBatchRunning = Boolean(analyzingItem || queuedCount > 0);

  // Overall progress: completed + errored items count as 100%, analyzing item contributes its fractional sheet progress
  const activeFraction =
    analyzingItem && analyzingItem.auditState.status === 'analyzing'
      ? Math.max(0, Math.min(100, analyzingItem.auditState.progress.percent)) / 100
      : 0;
  const finishedCount = completedCount + errorCount;
  const overallPercent =
    totalCount > 0
      ? Math.min(100, Math.round(((finishedCount + activeFraction) / totalCount) * 100))
      : 0;

  // Aggregate P0–P3 counts across all completed drawings
  const totals = completedItems.reduce(
    (acc, item) => {
      if (item.auditState.status === 'complete') {
        for (const finding of item.auditState.report.findings) {
          acc[finding.priority] += 1;
        }
      }
      return acc;
    },
    { P0: 0, P1: 0, P2: 0, P3: 0 },
  );

  const currentConfigLabel = formatBatchConfigLabel(currentConfig);

  const handleExportCombinedMarkdown = () => {
    const reports = completedItems
      .map((item) =>
        item.auditState.status === 'complete'
          ? { fileName: item.file.name, report: item.auditState.report }
          : null,
      )
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (reports.length === 0) return;

    const sections: string[] = [
      `# Batch Engineering Drawing Audit Report`,
      '',
      `- **Drawings Completed:** ${reports.length} of ${totalCount}`,
      `- **Total Findings:** P0 (${totals.P0}) · P1 (${totals.P1}) · P2 (${totals.P2}) · P3 (${totals.P3})`,
      `- **Generated:** ${new Date().toISOString()}`,
      '',
      '---',
    ];

    reports.forEach(({ fileName, report }, idx) => {
      sections.push(
        '',
        `<!-- Drawing ${idx + 1}: ${fileName} -->`,
        report.markdown,
        '',
        '---',
      );
    });

    const blob = new Blob([sections.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `batch_drawing_audit_${reports.length}_files.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div aria-live="polite" className="mt-6 pt-6 border-t border-slate-200 dark:border-slate-800 space-y-4">
      {/* Batch Queue Summary & Overall Progress Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Batch Audit Queue
            </h2>
            <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
              ·
            </span>
            <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
              {completedCount} of {totalCount} completed
            </span>
            {errorCount > 0 && (
              <>
                <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span className="text-xs font-mono tabular-nums text-red-700 dark:text-red-400">
                  {errorCount} failed
                </span>
              </>
            )}
          </div>

          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {analyzingItem
              ? `Processing "${analyzingItem.file.name}" sequentially in the background (${queuedCount} remaining in queue).`
              : completedCount === totalCount && totalCount > 0
                ? `All ${totalCount} engineering drawings audited sequentially.`
                : `Sequential background audit paused or finished.`}
          </p>

          {completedCount > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
              <span className="font-sans font-medium text-slate-700 dark:text-slate-300">
                Batch totals:
              </span>
              <span className="text-red-700 dark:text-red-400 font-semibold">P0 {totals.P0}</span>
              <span aria-hidden="true">·</span>
              <span className="text-orange-700 dark:text-orange-400 font-semibold">
                P1 {totals.P1}
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-amber-700 dark:text-amber-400 font-semibold">
                P2 {totals.P2}
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-slate-600 dark:text-slate-300 font-semibold">
                P3 {totals.P3}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onAddMorePdfs}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add PDFs</span>
          </button>

          {completedCount > 0 && (
            <button
              type="button"
              onClick={handleExportCombinedMarkdown}
              title="Download combined Markdown report for all completed drawings"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export Batch MD</span>
            </button>
          )}

          {isBatchRunning ? (
            <button
              type="button"
              onClick={onStopBatch}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900/60 hover:bg-red-100 dark:hover:bg-red-950/80 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600"
            >
              <Square className="w-3 h-3 fill-current" />
              <span>Stop Batch</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onRerunAll}
              title={`Re-run all ${totalCount} drawings with ${currentConfigLabel}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Re-run All</span>
            </button>
          )}

          <button
            type="button"
            onClick={onClearAll}
            title="Clear all drawings from batch queue"
            aria-label="Clear batch queue"
            className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-red-700 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 border border-slate-200 dark:border-slate-700 rounded-lg transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Overall Batch Progress Bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="font-medium text-slate-700 dark:text-slate-200 truncate">
            {analyzingItem && analyzingItem.auditState.status === 'analyzing'
              ? `${analyzingItem.file.name} — ${analyzingItem.auditState.progress.statusText}`
              : isBatchRunning
                ? 'Starting next drawing in queue...'
                : `Batch progress (${finishedCount} of ${totalCount} processed)`}
          </span>
          <span className="font-mono tabular-nums font-semibold text-blue-700 dark:text-sky-400 shrink-0">
            {overallPercent}%
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Overall batch audit progress"
          aria-valuenow={overallPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80"
        >
          <div
            className="h-full rounded-full bg-blue-700 dark:bg-sky-400 transition-[width] duration-300 ease-out"
            style={{ width: `${Math.max(isBatchRunning ? 3 : 0, overallPercent)}%` }}
          />
        </div>
      </div>

      {/* Sequential Drawing Queue Rows */}
      <ul className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900">
        {items.map((item, idx) => {
          const itemConfigLabel = formatBatchConfigLabel(item.config);
          const report = item.auditState.status === 'complete' ? item.auditState.report : null;
          const analyzingProgress =
            item.auditState.status === 'analyzing' ? item.auditState.progress : null;
          const configDiffers = itemConfigLabel !== currentConfigLabel;

          return (
            <li
              key={item.id}
              className={`px-4 py-3.5 transition-colors ${
                item.status === 'analyzing'
                  ? 'bg-blue-50/40 dark:bg-sky-950/25'
                  : 'bg-white dark:bg-slate-900'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                {/* Left: Queue Index + File Metadata */}
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 flex items-center justify-center shrink-0 mt-0.5 font-mono text-xs font-semibold tabular-nums">
                    {String(idx + 1).padStart(2, '0')}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <FileText className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
                      <span
                        className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate max-w-[340px]"
                        title={item.file.name}
                      >
                        {item.file.name}
                      </span>
                      <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        {formatFileSize(item.file.size)}
                        {item.inspection
                          ? ` · ${item.inspection.pageCount} ${item.inspection.pageCount === 1 ? 'sheet' : 'sheets'}`
                          : ''}
                      </span>
                    </div>

                    {/* Status Line */}
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      {item.status === 'queued' && (
                        <span className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                          <Clock className="w-3.5 h-3.5" />
                          <span>Queued · {itemConfigLabel}</span>
                        </span>
                      )}

                      {item.status === 'analyzing' && (
                        <span className="inline-flex items-center gap-1.5 font-medium text-blue-700 dark:text-sky-400">
                          <span className="w-3 h-3 border-2 border-slate-300 dark:border-slate-700 border-t-blue-700 dark:border-t-sky-400 rounded-full animate-spin shrink-0" />
                          <span>
                            {analyzingProgress?.statusText ?? `Auditing against ${itemConfigLabel}...`}
                          </span>
                        </span>
                      )}

                      {item.status === 'complete' && report && (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono tabular-nums">
                          <span className="inline-flex items-center gap-1 font-sans font-medium text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>{report.rulebookVersion}</span>
                          </span>
                          <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-red-700 dark:text-red-400 font-semibold">
                            P0 {report.findings.filter((f) => f.priority === 'P0').length}
                          </span>
                          <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-orange-700 dark:text-orange-400 font-semibold">
                            P1 {report.findings.filter((f) => f.priority === 'P1').length}
                          </span>
                          <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-amber-700 dark:text-amber-400 font-semibold">
                            P2 {report.findings.filter((f) => f.priority === 'P2').length}
                          </span>
                          <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-slate-600 dark:text-slate-300 font-semibold">
                            P3 {report.findings.filter((f) => f.priority === 'P3').length}
                          </span>
                        </div>
                      )}

                      {item.status === 'cancelled' && (
                        <span className="text-slate-500 dark:text-slate-400">
                          Cancelled · Ready to retry with {currentConfigLabel}
                        </span>
                      )}

                      {item.status === 'error' && item.auditState.status === 'error' && (
                        <span className="inline-flex items-center gap-1.5 text-red-700 dark:text-red-400">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                          <span className="line-clamp-1" title={item.auditState.message}>
                            {item.auditState.message}
                          </span>
                        </span>
                      )}
                    </div>

                    {/* Per-Item Live Progress Bar while Analyzing */}
                    {item.status === 'analyzing' && analyzingProgress && (
                      <div className="mt-2 flex items-center gap-2.5 max-w-md">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800">
                          <div
                            className="h-full rounded-full bg-blue-700 dark:bg-sky-400 transition-[width] duration-300 ease-out"
                            style={{
                              width: `${Math.max(4, Math.min(100, analyzingProgress.percent))}%`,
                            }}
                          />
                        </div>
                        <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                          {analyzingProgress.processedPages}/{analyzingProgress.totalPages} sheets ·{' '}
                          {analyzingProgress.percent}%
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right: Per-Item Actions */}
                <div className="flex items-center gap-1.5 shrink-0 flex-wrap sm:flex-nowrap">
                  <button
                    type="button"
                    onClick={() => onOpenReview(item.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                      item.status === 'complete'
                        ? 'text-white bg-blue-700 hover:bg-blue-800 dark:bg-sky-500 dark:hover:bg-sky-400 dark:text-slate-950'
                        : 'text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'
                    }`}
                  >
                    <ClipboardCheck className="w-3.5 h-3.5" />
                    <span>{item.status === 'complete' ? 'Open Review' : 'Inspect'}</span>
                  </button>

                  {report && (
                    <button
                      type="button"
                      onClick={() => exportAuditReportToPdf(report, item.file.name)}
                      title="Export A4 PDF report"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                    >
                      <FileDown className="w-3.5 h-3.5" />
                      <span>PDF</span>
                    </button>
                  )}

                  {(item.status === 'error' ||
                    item.status === 'cancelled' ||
                    (item.status === 'complete' && configDiffers)) && (
                    <button
                      type="button"
                      onClick={() => onRetryItem(item.id)}
                      title={`Run audit with ${currentConfigLabel}`}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>{item.status === 'complete' ? 'Re-run' : 'Retry'}</span>
                    </button>
                  )}

                  {isDriveConnected && hasLinkedFolder && (
                    <button
                      type="button"
                      onClick={() => onUploadItemToDrive(item)}
                      title="Save this PDF to linked Google Drive folder"
                      aria-label={`Save ${item.file.name} to Google Drive`}
                      className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                    >
                      <CloudUpload className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onRemoveItem(item.id)}
                    title="Remove drawing from queue"
                    aria-label={`Remove ${item.file.name}`}
                    className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-red-700 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 border border-slate-200 dark:border-slate-700 rounded-lg transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
