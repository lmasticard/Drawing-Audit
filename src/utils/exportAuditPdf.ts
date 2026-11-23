import { jsPDF } from 'jspdf';
import {
  PRIORITY_META,
  PRIORITY_ORDER,
  type AuditFinding,
  type AuditPriority,
  type DrawingAuditReport,
} from '../types/audit';

type RgbColor = [number, number, number];

const COLORS = {
  ink: [15, 23, 42] as RgbColor,
  body: [51, 65, 85] as RgbColor,
  muted: [100, 116, 139] as RgbColor,
  border: [226, 232, 240] as RgbColor,
  surface: [248, 250, 252] as RgbColor,
  headerBg: [15, 23, 42] as RgbColor,
  white: [255, 255, 255] as RgbColor,
  blue: [29, 78, 216] as RgbColor,
  costText: [146, 64, 14] as RgbColor,
  costBg: [254, 243, 199] as RgbColor,
};

const PRIORITY_PALETTE: Record<
  AuditPriority,
  { accent: RgbColor; tint: RgbColor; border: RgbColor }
> = {
  P0: {
    accent: [185, 28, 28],
    tint: [254, 242, 242],
    border: [252, 165, 165],
  },
  P1: {
    accent: [194, 65, 12],
    tint: [255, 247, 237],
    border: [253, 186, 116],
  },
  P2: {
    accent: [180, 83, 9],
    tint: [255, 251, 235],
    border: [252, 211, 77],
  },
  P3: {
    accent: [71, 85, 105],
    tint: [248, 250, 252],
    border: [203, 213, 225],
  },
};

/**
 * Normalize engineering/GD&T/ISO GPS Unicode symbols into WinAnsi-safe text
 * so jsPDF standard fonts never render broken glyphs.
 */
function sanitizePdfText(input: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/[\u2018\u2019]/g, "'"],
    [/[\u201C\u201D]/g, '"'],
    [/[\u2013\u2014]/g, '-'],
    [/\u2026/g, '...'],
    [/\u00A0/g, ' '],
    [/\u2192/g, '->'],
    [/\u2194/g, '<->'],
    [/\u2264/g, '<='],
    [/\u2265/g, '>='],
    [/\u2260/g, '!='],
    [/\u2300|\u00D8|\u00F8/g, 'DIA '],
    [/\u24C2/g, '(M)'],
    [/\u24C1/g, '(L)'],
    [/\u24C7/g, '(R)'],
    [/\u24BA/g, '(E)'],
    [/\u24BB/g, '(F)'],
    [/\u24B6/g, '(A)'],
    [/\u24C5/g, '(P)'],
    [/\u24CA/g, '(U)'],
    [/\u24B8/g, '(C)'],
    [/\u24BC/g, '(G)'],
    [/\u24C3/g, '(N)'],
    [/\u24C9/g, '(T)'],
    [/\u24CD/g, '(X)'],
    [/\u23E4/g, '[Straightness]'],
    [/\u23E5/g, '[Flatness]'],
    [/\u25CB/g, '[Roundness]'],
    [/\u232D/g, '[Cylindricity]'],
    [/\u2312/g, '[Line Profile]'],
    [/\u2313/g, '[Surface Profile]'],
    [/\u2225/g, '[Parallelism]'],
    [/\u22A5/g, '[Perpendicularity]'],
    [/\u2220/g, '[Angularity]'],
    [/\u2316/g, '[Position]'],
    [/\u25CE/g, '[Concentricity]'],
    [/\u232F/g, '[Symmetry]'],
    [/\u2197/g, '[Circular Runout]'],
    [/\u2330/g, '[Total Runout]'],
    [/\u00B7/g, '|'],
  ];

  let text = input ?? '';
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }

  // Strip any remaining characters outside Latin-1 printable range
  return text.replace(/[^\x09\x0A\x0D\x20-\x7E\xA1-\xFF]/g, '');
}

function formatReadableTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return isoString;
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

export function exportAuditReportToPdf(report: DrawingAuditReport, originalFileName: string): void {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  const pageWidth = doc.internal.pageSize.getWidth(); // 210mm
  const pageHeight = doc.internal.pageSize.getHeight(); // 297mm
  const marginX = 16;
  const contentWidth = pageWidth - marginX * 2; // 178mm
  const bottomMargin = 18;
  const maxContentY = pageHeight - bottomMargin;
  const topContinuationY = 20;

  let cursorY = 16;

  const ensureSpace = (neededHeight: number) => {
    if (cursorY + neededHeight > maxContentY) {
      doc.addPage();
      cursorY = topContinuationY;
    }
  };

  // =========================================================================
  // 1. HEADER BANNER (Page 1)
  // =========================================================================
  const bannerHeight = 26;
  doc.setFillColor(...COLORS.headerBg);
  doc.roundedRect(marginX, cursorY, contentWidth, bannerHeight, 2.5, 2.5, 'F');

  doc.setTextColor(...COLORS.white);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('ENGINEERING DESIGN REVIEW REPORT', marginX + 6, cursorY + 10.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(203, 213, 225);
  doc.text(
    sanitizePdfText(
      `Standard: ${report.rulebookVersion} (${report.ruleCount} Rules)   |   Manufacturing & GD&T Audit`,
    ),
    marginX + 6,
    cursorY + 17.5,
  );

  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text(
    sanitizePdfText(formatReadableTimestamp(report.analyzedAt)),
    marginX + contentWidth - 6,
    cursorY + 10.5,
    { align: 'right' },
  );
  doc.text(
    sanitizePdfText(
      `${report.pageCount} ${report.pageCount === 1 ? 'Sheet' : 'Sheets'} Analyzed`,
    ),
    marginX + contentWidth - 6,
    cursorY + 17.5,
    { align: 'right' },
  );

  cursorY += bannerHeight + 6;

  // =========================================================================
  // 2. METADATA SUMMARY BLOCK
  // =========================================================================
  const costCount = report.findings.filter((f) => f.costImpact).length;
  const drawingTitleText = sanitizePdfText(report.drawingName || originalFileName);
  const drawingTitleLines = doc.splitTextToSize(drawingTitleText, contentWidth - 46) as string[];
  const metaBoxHeight = Math.max(18, 11 + drawingTitleLines.length * 4.5);

  doc.setFillColor(...COLORS.surface);
  doc.setDrawColor(...COLORS.border);
  doc.setLineWidth(0.3);
  doc.roundedRect(marginX, cursorY, contentWidth, metaBoxHeight, 2, 2, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...COLORS.muted);
  doc.text('DRAWING', marginX + 5, cursorY + 6.5);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(...COLORS.ink);
  doc.text(drawingTitleLines, marginX + 26, cursorY + 6.5);

  const metaRow2Y = cursorY + 6.5 + drawingTitleLines.length * 4.5 + 1.5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...COLORS.muted);
  doc.text(
    sanitizePdfText(
      `Source file: ${originalFileName}   |   Total findings: ${report.findings.length}   |   High cost impact flags: ${costCount}`,
    ),
    marginX + 5,
    metaRow2Y,
  );

  cursorY += metaBoxHeight + 5;

  // =========================================================================
  // 3. P0–P3 SEVERITY KPI CARDS
  // =========================================================================
  const cardGap = 3.5;
  const cardWidth = (contentWidth - cardGap * 3) / 4;
  const cardHeight = 18;

  PRIORITY_ORDER.forEach((priority, idx) => {
    const x = marginX + idx * (cardWidth + cardGap);
    const palette = PRIORITY_PALETTE[priority];
    const count = report.findings.filter((f) => f.priority === priority).length;
    const meta = PRIORITY_META[priority];

    doc.setFillColor(...palette.tint);
    doc.setDrawColor(...palette.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, cursorY, cardWidth, cardHeight, 1.8, 1.8, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...palette.accent);
    doc.text(`${priority}  ${meta.shortLabel.toUpperCase()}`, x + 4, cursorY + 6.5);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(...COLORS.ink);
    doc.text(String(count), x + 4, cursorY + 14);
  });

  cursorY += cardHeight + 6;

  // =========================================================================
  // 4. GENERAL ASSESSMENT
  // =========================================================================
  const assessmentText = sanitizePdfText(report.generalAssessment);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  const assessmentLines = doc.splitTextToSize(assessmentText, contentWidth - 10) as string[];
  const assessmentBoxHeight = 11 + assessmentLines.length * 4.6;

  ensureSpace(assessmentBoxHeight + 4);
  doc.setFillColor(...COLORS.white);
  doc.setDrawColor(...COLORS.border);
  doc.setLineWidth(0.3);
  doc.roundedRect(marginX, cursorY, contentWidth, assessmentBoxHeight, 2, 2, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...COLORS.muted);
  doc.text('GENERAL ASSESSMENT', marginX + 5, cursorY + 6);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...COLORS.ink);
  doc.text(assessmentLines, marginX + 5, cursorY + 11.2, { lineHeightFactor: 1.32 });

  cursorY += assessmentBoxHeight + 8;

  // =========================================================================
  // 5. ACTIONABLE FINDINGS BY PRIORITY (P0 -> P3)
  // =========================================================================
  const renderFindingCard = (finding: AuditFinding, indexInGroup: number) => {
    const palette = PRIORITY_PALETTE[finding.priority];
    const textLeft = marginX + 5.5;
    const textWidth = contentWidth - 9;

    const headerParts: string[] = [
      `#${indexInGroup}`,
      finding.priority,
      sanitizePdfText(finding.location),
    ];
    if (report.pageCount > 1) {
      headerParts.push(`Sheet ${finding.pageNumber}`);
    }
    if (finding.category) {
      headerParts.push(sanitizePdfText(finding.category));
    }
    const headerLine = headerParts.join('  |  ');

    const citationLine = finding.asmeCitation?.trim()
      ? sanitizePdfText(`Standard Citation: ${finding.asmeCitation.trim()}`)
      : '';

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    const headerLines = doc.splitTextToSize(headerLine, textWidth - (finding.costImpact ? 34 : 0)) as string[];

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.8);
    const descLines = doc.splitTextToSize(
      sanitizePdfText(`Issue: ${finding.description}`),
      textWidth,
    ) as string[];
    const impactLines = doc.splitTextToSize(
      sanitizePdfText(`Impact: ${finding.impact}`),
      textWidth,
    ) as string[];
    const fixLines = doc.splitTextToSize(
      sanitizePdfText(`Recommended Fix: ${finding.recommendedFix}`),
      textWidth,
    ) as string[];

    const lineStep = 4.3;
    const blockHeight =
      5 +
      headerLines.length * 4.2 +
      (citationLine ? 4.4 : 0) +
      1.8 +
      descLines.length * lineStep +
      1.6 +
      impactLines.length * lineStep +
      1.6 +
      fixLines.length * lineStep +
      4;

    ensureSpace(Math.min(blockHeight, maxContentY - topContinuationY));

    const startY = cursorY;

    // Card background & border
    doc.setFillColor(...COLORS.white);
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.28);
    doc.roundedRect(marginX, startY, contentWidth, blockHeight, 1.5, 1.5, 'FD');

    // Left priority accent bar
    doc.setFillColor(...palette.accent);
    doc.rect(marginX, startY, 1.8, blockHeight, 'F');

    let innerY = startY + 5.5;

    // Header text
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...COLORS.ink);
    doc.text(headerLines, textLeft, innerY, { lineHeightFactor: 1.25 });

    // High Cost Impact tag on top-right
    if (finding.costImpact) {
      const badgeW = 31;
      const badgeH = 4.8;
      const badgeX = marginX + contentWidth - badgeW - 3.5;
      const badgeY = startY + 2.4;
      doc.setFillColor(...COLORS.costBg);
      doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 1, 1, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.8);
      doc.setTextColor(...COLORS.costText);
      doc.text('HIGH COST IMPACT', badgeX + badgeW / 2, badgeY + 3.4, { align: 'center' });
    }

    innerY += headerLines.length * 4.2;

    // Citation row
    if (citationLine) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(...COLORS.blue);
      doc.text(citationLine, textLeft, innerY + 0.5);
      innerY += 4.4;
    }

    innerY += 1.4;

    // Issue
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.8);
    doc.setTextColor(...COLORS.ink);
    doc.text(descLines, textLeft, innerY, { lineHeightFactor: 1.32 });
    innerY += descLines.length * lineStep + 1.6;

    // Impact
    doc.setTextColor(...COLORS.body);
    doc.text(impactLines, textLeft, innerY, { lineHeightFactor: 1.32 });
    innerY += impactLines.length * lineStep + 1.6;

    // Recommended Fix
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.ink);
    doc.text(fixLines, textLeft, innerY, { lineHeightFactor: 1.32 });

    cursorY = startY + blockHeight + 3.5;
  };

  for (const priority of PRIORITY_ORDER) {
    const meta = PRIORITY_META[priority];
    const palette = PRIORITY_PALETTE[priority];
    const groupItems = report.findings.filter((f) => f.priority === priority);

    // Section heading band (ensure at least header + one line/item fits)
    const sectionBandHeight = 12.5;
    ensureSpace(sectionBandHeight + 18);

    doc.setFillColor(...palette.tint);
    doc.setDrawColor(...palette.border);
    doc.setLineWidth(0.35);
    doc.roundedRect(marginX, cursorY, contentWidth, sectionBandHeight, 1.8, 1.8, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...palette.accent);
    doc.text(
      sanitizePdfText(`${meta.headingLabel}   (${groupItems.length})`),
      marginX + 4.5,
      cursorY + 5.5,
    );

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.6);
    doc.setTextColor(...COLORS.muted);
    const defLines = doc.splitTextToSize(sanitizePdfText(meta.definition), contentWidth - 9) as string[];
    doc.text(defLines[0] ?? '', marginX + 4.5, cursorY + 10.2);

    cursorY += sectionBandHeight + 3.5;

    if (groupItems.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8.5);
      doc.setTextColor(...COLORS.muted);
      doc.text(
        sanitizePdfText(`No ${meta.headingLabel} issues identified.`),
        marginX + 4.5,
        cursorY + 3,
      );
      cursorY += 9;
    } else {
      groupItems.forEach((finding, idx) => {
        renderFindingCard(finding, idx + 1);
      });
      cursorY += 2.5;
    }
  }

  // =========================================================================
  // 6. RUNNING HEADER (Pages 2+) & PAGE FOOTERS (All Pages)
  // =========================================================================
  const totalPages = doc.getNumberOfPages();
  const shortTitle = sanitizePdfText(report.drawingName || originalFileName).slice(0, 68);

  for (let p = 1; p <= totalPages; p += 1) {
    doc.setPage(p);

    if (p > 1) {
      doc.setDrawColor(...COLORS.border);
      doc.setLineWidth(0.25);
      doc.line(marginX, 13, marginX + contentWidth, 13);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(...COLORS.muted);
      doc.text(`DESIGN REVIEW  |  ${shortTitle}`, marginX, 10.5);
      doc.setFont('helvetica', 'normal');
      doc.text(sanitizePdfText(report.rulebookVersion), marginX + contentWidth, 10.5, {
        align: 'right',
      });
    }

    // Footer divider & page numbers
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.25);
    doc.line(marginX, pageHeight - 13, marginX + contentWidth, pageHeight - 13);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...COLORS.muted);
    doc.text(
      sanitizePdfText(`Drawing Audit  |  ${report.rulebookVersion} Compliance Report`),
      marginX,
      pageHeight - 8.5,
    );
    doc.text(`Page ${p} of ${totalPages}`, marginX + contentWidth, pageHeight - 8.5, {
      align: 'right',
    });
  }

  // Trigger clean blob download (iframe-safe)
  const baseName = (originalFileName || report.drawingName || 'drawing')
    .replace(/\.pdf$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_');
  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${baseName}_design_review.pdf`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
