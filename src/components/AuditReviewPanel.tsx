import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  FileDown,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import {
  AUDIT_STANDARDS,
  PRIORITY_META,
  PRIORITY_ORDER,
  type AuditFinding,
  type AuditPriority,
  type AuditRunState,
  type AuditStandard,
} from '../types/audit';
import { exportAuditReportToPdf } from '../utils/exportAuditPdf';

interface AuditReviewPanelProps {
  fileName: string;
  selectedStandard: AuditStandard;
  auditState: AuditRunState;
  activeFindingId: string | null;
  onSelectFinding: (finding: AuditFinding) => void;
  onRunAudit: () => void;
  onCancelAudit: () => void;
}

type PriorityFilter = 'ALL' | AuditPriority;
type ReviewViewTab = 'structured' | 'markdown';

const PRIORITY_TEXT_STYLE: Record<AuditPriority, string> = {
  P0: 'text-red-700',
  P1: 'text-orange-700',
  P2: 'text-amber-700',
  P3: 'text-slate-600',
};

const PRIORITY_HEADER_BG: Record<AuditPriority, string> = {
  P0: 'bg-red-50/60',
  P1: 'bg-orange-50/50',
  P2: 'bg-amber-50/50',
  P3: 'bg-slate-50',
};

export const AuditReviewPanel: React.FC<AuditReviewPanelProps> = ({
  fileName,
  selectedStandard,
  auditState,
  activeFindingId,
  onSelectFinding,
  onRunAudit,
  onCancelAudit,
}) => {
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('ALL');
  const [costImpactOnly, setCostImpactOnly] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [viewTab, setViewTab] = useState<ReviewViewTab>('structured');
  const [copied, setCopied] = useState<boolean>(false);

  const report = auditState.status === 'complete' ? auditState.report : null;
  const activeStandardLabel =
    report?.rulebookVersion ??
    (auditState.status === 'analyzing' ? auditState.standard : selectedStandard);
  const activeRuleCount =
    report?.ruleCount ??
    AUDIT_STANDARDS[
      auditState.status === 'analyzing' ? auditState.standard : selectedStandard
    ].ruleCount;

  const counts = useMemo(() => {
    const base = { ALL: 0, P0: 0, P1: 0, P2: 0, P3: 0, COST: 0 };
    if (!report) return base;
    base.ALL = report.findings.length;
    for (const f of report.findings) {
      base[f.priority] += 1;
      if (f.costImpact) base.COST += 1;
    }
    return base;
  }, [report]);

  const filteredFindings = useMemo(() => {
    if (!report) return [];
    const q = searchQuery.trim().toLowerCase();
    return report.findings.filter((f) => {
      if (priorityFilter !== 'ALL' && f.priority !== priorityFilter) return false;
      if (costImpactOnly && !f.costImpact) return false;
      if (!q) return true;
      return (
        f.location.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q) ||
        f.impact.toLowerCase().includes(q) ||
        f.recommendedFix.toLowerCase().includes(q) ||
        (f.asmeCitation?.toLowerCase().includes(q) ?? false) ||
        f.category.toLowerCase().includes(q)
      );
    });
  }, [report, priorityFilter, costImpactOnly, searchQuery]);

  const groupedByPriority = useMemo(() => {
    const groups: Array<{ priority: AuditPriority; items: AuditFinding[] }> = [];
    for (const priority of PRIORITY_ORDER) {
      if (priorityFilter !== 'ALL' && priorityFilter !== priority) continue;
      const items = filteredFindings.filter((f) => f.priority === priority);
      groups.push({ priority, items });
    }
    return groups;
  }, [filteredFindings, priorityFilter]);

  const handleCopyMarkdown = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback textarea copy if clipboard API is restricted in iframe
      const textarea = document.createElement('textarea');
      textarea.value = report.markdown;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownloadMarkdown = () => {
    if (!report) return;
    const baseName = fileName.replace(/\.pdf$/i, '');
    const blob = new Blob([report.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${baseName}_design_review.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExportPdf = () => {
    if (!report) return;
    exportAuditReportToPdf(report, fileName);
  };

  return (
    <aside
      aria-label="Engineering Design Review"
      className="w-full lg:w-[46%] xl:w-[44%] min-w-0 lg:min-w-[440px] max-w-full bg-white border-t lg:border-t-0 lg:border-l border-slate-200 flex flex-col min-h-0"
    >
      {/* Panel Header */}
      <div className="px-6 py-4 border-b border-slate-200 space-y-3 shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900 truncate">Design Review</h2>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
              <span>{activeStandardLabel}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{activeRuleCount} rules</span>
              {report && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {report.findings.length} {report.findings.length === 1 ? 'finding' : 'findings'}
                  </span>
                </>
              )}
            </div>
          </div>

          {auditState.status !== 'analyzing' && (
            <button
              type="button"
              onClick={onRunAudit}
              title="Re-run engineering review"
              aria-label="Re-run engineering review"
              className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {report && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center p-0.5 bg-slate-100 rounded-lg border border-slate-200/80">
              <button
                type="button"
                onClick={() => setViewTab('structured')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  viewTab === 'structured'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Findings
              </button>
              <button
                type="button"
                onClick={() => setViewTab('markdown')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  viewTab === 'markdown'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Markdown
              </button>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleExportPdf}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <FileDown className="w-3.5 h-3.5" />
                <span>Export as PDF</span>
              </button>

              <button
                type="button"
                onClick={() => void handleCopyMarkdown()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied' : 'Copy MD'}</span>
              </button>

              <button
                type="button"
                onClick={handleDownloadMarkdown}
                title="Download Markdown report (.md)"
                aria-label="Download Markdown report"
                className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* State 1: Analyzing */}
      {auditState.status === 'analyzing' && (
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="pb-5 border-b border-slate-200 flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-4 h-4 mt-0.5 border-2 border-slate-300 border-t-blue-700 rounded-full animate-spin shrink-0" />
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  Analyzing drawing for manufacturing review
                </p>
                <p className="mt-1 text-xs text-slate-500 leading-relaxed">
                  Checking GD&amp;T / GPS callouts, datum reference frames, tolerance stackups,
                  title block completeness, and high-cost machining drivers against{' '}
                  {activeRuleCount} {activeStandardLabel} rules.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onCancelAudit}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              Cancel
            </button>
          </div>

          {/* Geometry-matched Skeleton Rows */}
          <div className="mt-5 space-y-6 animate-pulse" aria-hidden="true">
            <div className="space-y-2">
              <div className="h-3.5 w-32 bg-slate-200 rounded" />
              <div className="h-3.5 w-full bg-slate-100 rounded" />
              <div className="h-3.5 w-5/6 bg-slate-100 rounded" />
            </div>
            {[0, 1, 2, 3].map((idx) => (
              <div key={idx} className="pt-5 border-t border-slate-100 space-y-2.5">
                <div className="flex items-center gap-2">
                  <div className="h-3.5 w-8 bg-slate-200 rounded" />
                  <div className="h-3.5 w-40 bg-slate-200 rounded" />
                  <div className="h-3.5 w-28 bg-slate-100 rounded" />
                </div>
                <div className="h-3.5 w-full bg-slate-100 rounded" />
                <div className="h-3.5 w-11/12 bg-slate-100 rounded" />
                <div className="h-3.5 w-4/5 bg-slate-100 rounded" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* State 2: Idle (e.g., cancelled) */}
      {auditState.status === 'idle' && (
        <div className="flex-1 flex flex-col items-center justify-center px-8 py-12 text-center">
          <h3 className="text-base font-semibold text-slate-900">Ready to review drawing</h3>
          <p className="mt-2 max-w-sm text-sm text-slate-600 leading-relaxed">
            Run a formal Senior Mechanical Engineer design review against the {selectedStandard}{' '}
            rulebook to categorize P0–P3 findings and flag manufacturing cost drivers.
          </p>
          <button
            type="button"
            onClick={onRunAudit}
            className="mt-6 px-5 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Run Design Review
          </button>
        </div>
      )}

      {/* State 3: Error */}
      {auditState.status === 'error' && (
        <div className="flex-1 px-6 py-8">
          <div
            role="alert"
            className="p-5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-900"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-700 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold text-red-900">Drawing analysis could not complete</p>
                <p className="mt-1.5 text-red-800 leading-relaxed break-words">
                  {auditState.message}
                </p>
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={onRunAudit}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-red-700 hover:bg-red-800 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Retry Design Review</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* State 4: Complete Report */}
      {report && (
        <>
          {/* General Assessment Band */}
          <div className="px-6 py-4 bg-slate-50/80 border-b border-slate-200 shrink-0">
            <div className="text-xs text-slate-500">
              <span>Drawing</span>
              <span className="mx-1.5" aria-hidden="true">
                ·
              </span>
              <span className="font-medium text-slate-800">{report.drawingName}</span>
            </div>
            <p className="mt-1.5 text-sm text-slate-800 leading-relaxed">
              {report.generalAssessment}
            </p>
          </div>

          {viewTab === 'markdown' ? (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="px-6 py-2.5 border-b border-slate-200 bg-white flex items-center justify-between gap-3 text-xs text-slate-500 shrink-0">
                <span>Formatted for direct copy-paste into Google Docs</span>
                <button
                  type="button"
                  onClick={() => void handleCopyMarkdown()}
                  className="font-medium text-blue-700 hover:underline whitespace-nowrap shrink-0"
                >
                  {copied ? 'Copied to clipboard' : 'Copy all Markdown'}
                </button>
              </div>
              <pre className="flex-1 overflow-auto p-6 text-xs font-mono leading-relaxed text-slate-800 bg-[#FAFBFD] whitespace-pre-wrap break-words select-all">
                {report.markdown}
              </pre>
            </div>
          ) : (
            <>
              {/* Priority Filter Bar & Search */}
              <div className="px-6 py-3 border-b border-slate-200 bg-white space-y-2.5 shrink-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="flex items-center p-0.5 bg-slate-100 rounded-lg border border-slate-200/80">
                    {(['ALL', 'P0', 'P1', 'P2', 'P3'] as PriorityFilter[]).map((level) => {
                      const active = priorityFilter === level;
                      const count = counts[level];
                      return (
                        <button
                          key={level}
                          type="button"
                          onClick={() => setPriorityFilter(level)}
                          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 font-mono tabular-nums ${
                            active
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {level === 'ALL' ? `All (${count})` : `${level} (${count})`}
                        </button>
                      );
                    })}
                  </div>

                  {counts.COST > 0 && (
                    <button
                      type="button"
                      onClick={() => setCostImpactOnly((prev) => !prev)}
                      aria-pressed={costImpactOnly}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 font-mono tabular-nums ${
                        costImpactOnly
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      Cost impact ({counts.COST})
                    </button>
                  )}
                </div>

                {/* Live Filter Input */}
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter findings by view, zone, clause, or keyword..."
                    aria-label="Filter findings"
                    className="w-full h-8 pl-8 pr-8 text-xs text-slate-900 bg-slate-50 border border-slate-200 rounded-lg placeholder:text-slate-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label="Clear filter"
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-700"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Scrollable P0–P3 Findings Stream */}
              <div className="flex-1 overflow-y-auto">
                {filteredFindings.length === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <p className="text-sm font-medium text-slate-800">
                      {report.findings.length === 0
                        ? 'No actionable issues identified.'
                        : 'No findings match the current filter.'}
                    </p>
                    {(priorityFilter !== 'ALL' || costImpactOnly || searchQuery) && (
                      <button
                        type="button"
                        onClick={() => {
                          setPriorityFilter('ALL');
                          setCostImpactOnly(false);
                          setSearchQuery('');
                        }}
                        className="mt-3 text-xs font-medium text-blue-700 hover:underline"
                      >
                        Reset filters
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200">
                    {groupedByPriority.map(({ priority, items }) => {
                      const meta = PRIORITY_META[priority];
                      return (
                        <section key={priority} aria-label={meta.headingLabel}>
                          {/* Priority Group Header */}
                          <div
                            className={`sticky top-0 z-10 px-6 py-2.5 border-b border-slate-200 flex items-center justify-between gap-3 ${PRIORITY_HEADER_BG[priority]}`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`text-xs font-bold font-mono ${PRIORITY_TEXT_STYLE[priority]}`}
                              >
                                {priority}
                              </span>
                              <span className="text-xs font-semibold text-slate-900 truncate">
                                {meta.headingLabel.replace(`${priority} `, '').replace(/^\(|\)$/g, '')}
                              </span>
                            </div>
                            <span className="text-xs font-mono tabular-nums text-slate-500 shrink-0">
                              {items.length}
                            </span>
                          </div>

                          {items.length === 0 ? (
                            <div className="px-6 py-4 text-xs text-slate-500">
                              No {meta.headingLabel} issues identified.
                            </div>
                          ) : (
                            <ul className="divide-y divide-slate-100">
                              {items.map((finding) => {
                                const isSelected = finding.id === activeFindingId;
                                return (
                                  <li key={finding.id}>
                                    <button
                                      type="button"
                                      onClick={() => onSelectFinding(finding)}
                                      className={`w-full text-left px-6 py-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 ${
                                        isSelected ? 'bg-blue-50/50' : 'hover:bg-slate-50/90'
                                      }`}
                                    >
                                      {/* Unboxed Metadata Row (Zero-Pill Discipline) */}
                                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                                        <span
                                          className={`font-mono font-semibold ${PRIORITY_TEXT_STYLE[finding.priority]}`}
                                        >
                                          {finding.priority}
                                        </span>
                                        <span className="text-slate-300" aria-hidden="true">
                                          ·
                                        </span>
                                        <span className="font-semibold text-slate-900">
                                          {finding.location}
                                        </span>
                                        {report.pageCount > 1 && (
                                          <>
                                            <span className="text-slate-300" aria-hidden="true">
                                              ·
                                            </span>
                                            <span className="font-mono tabular-nums text-slate-500">
                                              Sheet {finding.pageNumber}
                                            </span>
                                          </>
                                        )}
                                        {finding.asmeCitation && (
                                          <>
                                            <span className="text-slate-300" aria-hidden="true">
                                              ·
                                            </span>
                                            <span className="font-mono text-blue-700">
                                              {finding.asmeCitation}
                                            </span>
                                          </>
                                        )}
                                        {finding.costImpact && (
                                          <>
                                            <span className="text-slate-300" aria-hidden="true">
                                              ·
                                            </span>
                                            <span className="font-medium text-amber-800">
                                              High cost impact
                                            </span>
                                          </>
                                        )}
                                      </div>

                                      {/* Issue -> Impact -> Recommended Fix */}
                                      <div className="mt-2 space-y-1.5 text-[13px] leading-relaxed">
                                        <p className="text-slate-900">{finding.description}</p>
                                        <p className="text-slate-600">
                                          <span className="font-medium text-slate-700">Impact: </span>
                                          {finding.impact}
                                        </p>
                                        <p className="text-slate-700">
                                          <span className="font-medium text-slate-900">
                                            Recommended fix:{' '}
                                          </span>
                                          {finding.recommendedFix}
                                        </p>
                                      </div>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </section>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
};
