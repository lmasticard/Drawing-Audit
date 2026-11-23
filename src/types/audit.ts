export type AuditPriority = 'P0' | 'P1' | 'P2' | 'P3';

export type AuditStandard = 'ASME Y14.5-2018' | 'ISO 1101:2017';

export const AUDIT_STANDARD_OPTIONS: AuditStandard[] = ['ASME Y14.5-2018', 'ISO 1101:2017'];

export const AUDIT_STANDARDS: Record<
  AuditStandard,
  {
    id: AuditStandard;
    label: string;
    rulebookFile: string;
    ruleCount: number;
  }
> = {
  'ASME Y14.5-2018': {
    id: 'ASME Y14.5-2018',
    label: 'ASME Y14.5-2018',
    rulebookFile: 'src/data/asme-y14.5-2018-audit-rulebook.json',
    ruleCount: 191,
  },
  'ISO 1101:2017': {
    id: 'ISO 1101:2017',
    label: 'ISO 1101:2017',
    rulebookFile: 'src/data/iso-1101-2017-audit-rulebook.json',
    ruleCount: 163,
  },
};

export interface AuditBoundingBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface AuditFinding {
  id: string;
  priority: AuditPriority;
  pageNumber: number;
  location: string;
  description: string;
  impact: string;
  recommendedFix: string;
  asmeCitation?: string;
  costImpact: boolean;
  category: string;
  boundingBox?: AuditBoundingBox;
}

export interface DrawingAuditReport {
  drawingName: string;
  generalAssessment: string;
  findings: AuditFinding[];
  markdown: string;
  analyzedAt: string;
  rulebookVersion: string;
  ruleCount: number;
  pageCount: number;
  modelUsed: string;
}

export interface AuditProgress {
  totalPages: number;
  processedPages: number;
  currentPage: number;
  percent: number;
  stage: 'preparing' | 'rendering' | 'auditing' | 'finalizing';
  statusText: string;
}

export type AuditRunState =
  | { status: 'idle' }
  | {
      status: 'analyzing';
      fileName: string;
      standard: AuditStandard;
      startedAt: number;
      progress: AuditProgress;
    }
  | { status: 'complete'; report: DrawingAuditReport }
  | { status: 'error'; message: string };

export const PRIORITY_META: Record<
  AuditPriority,
  {
    code: AuditPriority;
    shortLabel: string;
    headingLabel: string;
    definition: string;
  }
> = {
  P0: {
    code: 'P0',
    shortLabel: 'Critical',
    headingLabel: 'P0 (Critical / Blocker)',
    definition:
      'Fatal flaws. Safety risks, impossible geometry, un-manufacturable features, or missing critical dimensions that prevent fabrication.',
  },
  P1: {
    code: 'P1',
    shortLabel: 'Major',
    headingLabel: 'P1 (Major)',
    definition:
      'Functional risks. GD&T errors, standard non-compliance, wrong material callouts, or missing tolerances.',
  },
  P2: {
    code: 'P2',
    shortLabel: 'Minor',
    headingLabel: 'P2 (Minor / Clarity)',
    definition:
      'Confusing layouts, overlapping lines, poor dimension placement, or missing title block info.',
  },
  P3: {
    code: 'P3',
    shortLabel: 'Suggestion',
    headingLabel: 'P3 (Suggestion)',
    definition: 'Best practice improvements, drafting standards, or aesthetic cleanup.',
  },
};

export const PRIORITY_ORDER: AuditPriority[] = ['P0', 'P1', 'P2', 'P3'];

export function formatFindingLine(finding: AuditFinding): string {
  const citationSuffix = finding.asmeCitation?.trim()
    ? ` (${finding.asmeCitation.trim()})`
    : '';
  const costPrefix = finding.costImpact ? '[High Cost Impact] ' : '';
  return `**${finding.location}:** ${costPrefix}${finding.description}${citationSuffix} -> ${finding.impact} -> ${finding.recommendedFix}`;
}

export function formatAuditReportToMarkdown(
  drawingName: string,
  generalAssessment: string,
  findings: AuditFinding[],
): string {
  const lines: string[] = [
    `# Drawing: ${drawingName}`,
    '',
    `**General Assessment:** ${generalAssessment}`,
    '',
    '## Actionable Findings',
  ];

  for (const priority of PRIORITY_ORDER) {
    const meta = PRIORITY_META[priority];
    const items = findings.filter((item) => item.priority === priority);
    lines.push('', `### ${meta.headingLabel}`);
    if (items.length === 0) {
      lines.push('- None identified.');
    } else {
      for (const item of items) {
        lines.push(`- ${formatFindingLine(item)}`);
      }
    }
  }

  return lines.join('\n');
}
