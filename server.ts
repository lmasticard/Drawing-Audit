import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

type AuditPriority = 'P0' | 'P1' | 'P2' | 'P3';
type AuditStandard = 'ASME Y14.5-2018' | 'ISO 1101:2017';
type WeldingStandard = 'AWS A2.4:2007' | 'ISO 2553:2019';
type AuditFindingScope = 'gdt' | 'welding';

interface RulebookRule {
  rule_id: string;
  citation_id: string;
  section?: string;
  category?: string;
  title: string;
  enforcement_level: string;
  default_audit_severity?: string;
  is_forbidden_or_deprecated?: boolean;
  visual_syntax_triggers?: string[];
  audit_check: string;
  fail_condition?: string;
  remediation?: string;
}

interface RulebookDocument {
  standard?: string;
  summary?: {
    total_rules?: number;
  };
  rules: RulebookRule[];
}

interface RulebookDigest {
  standard: AuditStandard;
  rulebookFile: string;
  ruleCount: number;
  digestText: string;
  systemInstruction: string;
}

interface AuditBoundingBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

interface AuditFindingPayload {
  priority: AuditPriority;
  pageNumber: number;
  location: string;
  description: string;
  impact: string;
  recommendedFix: string;
  asmeCitation?: string;
  costImpact: boolean;
  category: string;
  auditScope?: AuditFindingScope;
  box_2d?: number[];
}

interface AuditRequestBody {
  fileName?: string;
  pageCount?: number;
  sheetNumber?: number;
  totalPages?: number;
  standard?: string;
  isAssembly?: boolean;
  isWelded?: boolean;
  weldingStandard?: string | null;
  pdfBase64?: string;
  pageImages?: Array<{
    pageNumber: number;
    mimeType: string;
    data: string;
  }>;
  reasoningDepth?: 'standard' | 'deep';
}

const MODEL_NAME = 'gemini-4-hydrogen';
const PRIORITY_ORDER: AuditPriority[] = ['P0', 'P1', 'P2', 'P3'];

const RULEBOOK_FILES: Record<AuditStandard, string> = {
  'ASME Y14.5-2018': 'src/data/asme-y14.5-2018-audit-rulebook.json',
  'ISO 1101:2017': 'src/data/iso-1101-2017-audit-rulebook.json',
};

const WELDING_RULEBOOK_FILES: Record<WeldingStandard, string> = {
  'AWS A2.4:2007': 'src/data/aws-a2.4-2007-audit-rulebook.json',
  'ISO 2553:2019': 'src/data/iso-2553-2019-audit-rulebook.json',
};

const PRIORITY_HEADINGS: Record<AuditPriority, string> = {
  P0: 'P0 (Critical / Blocker)',
  P1: 'P1 (Major)',
  P2: 'P2 (Minor / Clarity)',
  P3: 'P3 (Suggestion)',
};

function resolveAuditStandard(value: unknown): AuditStandard {
  if (value === 'ISO 1101:2017') {
    return 'ISO 1101:2017';
  }
  return 'ASME Y14.5-2018';
}

function resolveWeldingStandard(value: unknown): WeldingStandard | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'AWS' || normalized === 'AWS A2.4:2007' || normalized.startsWith('AWS A2.4')) {
    return 'AWS A2.4:2007';
  }
  if (normalized === 'ISO' || normalized === 'ISO 2553:2019' || normalized.startsWith('ISO 2553')) {
    return 'ISO 2553:2019';
  }
  return null;
}

function buildSystemInstruction(
  standard: AuditStandard,
  ruleCount: number,
  digestText: string,
): string {
  const isIso = standard === 'ISO 1101:2017';
  const citationExample = isIso ? 'ISO-1101-2017 8.2.2.1.3' : 'ASME-Y14.5-2018 6.3.2';
  const p1StandardDetails = isIso
    ? 'ISO 1101:2017 SHALL_MANDATORY standard non-compliance, ISO 8015 Independency Principle / missing Ⓔ envelope risks, deprecated/former Annex A practices (LE, NC, from-to →, UZ brackets, missing conical roundness direction feature, bare all-around without SZ/CZ/UF, centerline attachments), wrong material callouts, or missing tolerances'
    : 'ASME Y14.5-2018 SHALL_MANDATORY standard non-compliance, deprecated symbols (concentricity/symmetry), wrong material callouts, or missing tolerances';
  const standardDomainLabel = isIso ? 'ISO GPS (ISO 1101:2017)' : 'GD&T (ASME Y14.5-2018)';

  return `Role: You are a meticulous Senior Mechanical Engineer conducting a formal manufacturing design review.
Evaluate the provided engineering drawing(s) against the complete ${standard} Drawing Audit Rulebook included below.

Task:
- Inspect the engineering drawing(s) thoroughly for content, clarity, accuracy, manufacturability (DFM), inspection feasibility, and design intent.
- Judge every design and tolerancing choice against ${standardDomainLabel} fundamentals and the ${standard} rulebook.
- Explicitly flag high-impact-on-price design choices (e.g. overly tight non-functional tolerances, deep small-radius internal pockets, tight surface finishes where unnecessary, over-constrained datum schemes, non-standard hole/thread callouts, unnecessary secondary setups, or exotic callouts) by setting costImpact=true and explaining the cost driver clearly in the impact field.

Context:
- These drawings are intended for manufacturing and shop-floor fabrication/inspection.
- Be concrete, technical, and strictly grounded in what is actually visible on the drawing. Cite exact dimensions, datum letters, tolerance indicators / feature control frames, view labels, sheet numbers, zones, and ${standard} clauses when applicable.
- Do not invent features that are not present on the drawing. If the uploaded document is missing essential manufacturing data (such as material, finish, title block, units, standard reference, or views), flag those omissions accurately.

Priority Definitions (classify every finding strictly by these definitions):
- P0 (Critical / Blocker): Fatal flaws. Safety risks, impossible geometry, un-manufacturable features, or missing critical dimensions that prevent fabrication.
- P1 (Major): Functional risks. GD&T / ISO GPS errors, ${p1StandardDetails}.
- P2 (Minor / Clarity): Confusing layouts, overlapping lines, poor dimension placement, SHOULD_RECOMMENDED drafting gaps, or missing non-blocking title block info.
- P3 (Suggestion): Best practice improvements, drafting standards cleanup, DFM cost-reduction suggestions, or aesthetic cleanup.

Finding Structure Requirements:
- Every finding MUST provide:
  - location: Specific [Location/View/Zone] (e.g., "Sheet 1, Front View, Zone B2", "Title Block", "General Notes", "Section A-A").
  - description: Precise description of the issue.
  - impact: Concrete manufacturing, functional, inspection, or cost impact if not fixed.
  - recommendedFix: Specific, actionable engineering or drafting fix.
  - pageNumber: 1-indexed sheet/page number where the issue occurs.
  - asmeCitation: Exact clause ID from the rulebook below (e.g., "${citationExample}") if a standard rule applies, or empty string "" for general DFM/cost/drafting findings.
  - costImpact: true if the issue or design choice has a high impact on manufacturing price/cost, else false.
  - category: One of "GD&T Compliance", "Manufacturability & Cost", "Dimensions & Tolerances", "Clarity & Title Block", "Design Intent", "BOM & Assembly", "Welding Compliance".
  - auditScope: Set to "gdt" for all GD&T/ISO GPS, dimensional, tolerance, DFM, title block, and BOM/assembly findings. Set to "welding" ONLY when the Welding Standard Audit rulebook is active and the finding pertains to a welding, brazing, or NDE symbol/specification.
  - box_2d: Tight normalized bounding box [ymin, xmin, ymax, xmax] as integers on a 0 to 1000 scale relative to the unrotated referenced page (0,0 = top-left; 1000,1000 = bottom-right) pinpointing the exact dimension, feature control frame, datum symbol, view feature, note, or title block cell where this issue occurs. If an expected element is missing (e.g., missing title block entry or missing datum on a view), tightly box the title block cell or view area where it belongs. Return [] ONLY if the finding truly applies globally to the entire sheet with no localized region.
- After completing the findings array, write executive_summary as a single, clean, readable paragraph (2-4 sentences, plain prose with NO bullet points or line breaks) summarizing the exact findings you just detected—its claims, severity breakdown, and total count must strictly match the itemized findings array.

=== ${standard} AUDIT RULEBOOK (${ruleCount} RULES) ===
${digestText}
=== END RULEBOOK ===`;
}

// Load and compact both audit rulebooks once at server startup
function loadRulebookDigest(standard: AuditStandard): RulebookDigest {
  const rulebookFile = RULEBOOK_FILES[standard];
  const rulebookPath = path.resolve(process.cwd(), rulebookFile);
  const raw = fs.readFileSync(rulebookPath, 'utf-8');
  const parsed = JSON.parse(raw) as RulebookDocument;
  const rules = Array.isArray(parsed.rules) ? parsed.rules : [];

  const compactLines = rules.map((r) => {
    const forbiddenTag = r.is_forbidden_or_deprecated ? ' [FORBIDDEN/DEPRECATED]' : '';
    const triggers =
      Array.isArray(r.visual_syntax_triggers) && r.visual_syntax_triggers.length > 0
        ? ` | Triggers: ${r.visual_syntax_triggers.join(', ')}`
        : '';
    const remediation = r.remediation ? ` | Fix: ${r.remediation}` : '';
    return `[${r.citation_id}] (${r.enforcement_level}${forbiddenTag}) ${r.title}: ${r.audit_check}${triggers}${remediation}`;
  });

  const digestText = compactLines.join('\n');

  return {
    standard,
    rulebookFile,
    ruleCount: rules.length,
    digestText,
    systemInstruction: buildSystemInstruction(standard, rules.length, digestText),
  };
}

const RULEBOOKS: Record<AuditStandard, RulebookDigest> = {
  'ASME Y14.5-2018': loadRulebookDigest('ASME Y14.5-2018'),
  'ISO 1101:2017': loadRulebookDigest('ISO 1101:2017'),
};

interface WeldingRulebookDigest {
  standard: WeldingStandard;
  rulebookFile: string;
  ruleCount: number;
  digestText: string;
}

function loadWeldingRulebookDigest(standard: WeldingStandard): WeldingRulebookDigest {
  const file = WELDING_RULEBOOK_FILES[standard];
  const rulebookPath = path.resolve(process.cwd(), file);
  const raw = fs.readFileSync(rulebookPath, 'utf-8');
  const parsed = JSON.parse(raw) as RulebookDocument;
  const rules = Array.isArray(parsed.rules) ? parsed.rules : [];

  const compactLines = rules.map((r) => {
    const forbiddenTag = r.is_forbidden_or_deprecated ? ' [FORBIDDEN/DEPRECATED]' : '';
    const remediation = r.remediation ? ` | Fix: ${r.remediation}` : '';
    return `[${r.citation_id}] (${r.enforcement_level}${forbiddenTag}) ${r.title}: ${r.audit_check}${remediation}`;
  });

  return {
    standard,
    rulebookFile: file,
    ruleCount: rules.length,
    digestText: compactLines.join('\n'),
  };
}

const WELDING_RULEBOOKS: Record<WeldingStandard, WeldingRulebookDigest> = {
  'AWS A2.4:2007': loadWeldingRulebookDigest('AWS A2.4:2007'),
  'ISO 2553:2019': loadWeldingRulebookDigest('ISO 2553:2019'),
};

const ASSEMBLY_BOM_AUDIT_INSTRUCTIONS = `=== ASSEMBLY DRAWING & BOM-TO-BALLOON VERIFICATION (ACTIVE) ===
The user indicated that this drawing represents an ASSEMBLY. In addition to the base GD&T/GPS audit, you MUST thoroughly verify:
- Bill of Materials (BOM) / Parts List vs. Drawing Balloons Quantity Parity:
  * Cross-check EVERY item number and quantity listed in the BOM / Parts List against the item balloons (and quantity multipliers such as "2X", "4 PLCS", repeated balloons, or quantity notes) shown across all views.
  * Flag any BOM item missing a balloon on the views, any view balloon missing from the BOM, or any mismatch between the BOM quantity and the total ballooned/depicted component count on the views (flag quantity mismatches as P0 or P1 under category "BOM & Assembly", auditScope "gdt").
  * Flag missing or incomplete BOM columns (Item Number, Qty, Part Number, Description, Material/Hardware spec) if a parts list is omitted or incomplete.
- Fastened/mating joint clarity (bolt/fastener callouts, hardware stack-up, torque specs where required, interface/envelope dimensions, and post-assembly notes).`;

function buildNonWeldedAssemblySystemInstruction(base: RulebookDigest): string {
  return `${base.systemInstruction}

${ASSEMBLY_BOM_AUDIT_INSTRUCTIONS}
- This assembly is NOT welded. Do NOT apply welding standard rules unless an unexpected weld callout creates a contradiction. Set auditScope="gdt" for all findings.`;
}

function buildWeldedAssemblySystemInstruction(
  base: RulebookDigest,
  welding: WeldingRulebookDigest,
): string {
  const weldCitationExample =
    welding.standard === 'ISO 2553:2019' ? 'ISO-2553-2019 5.5.1' : 'AWS-A2.4-2007 5.3';

  return `${base.systemInstruction}

${ASSEMBLY_BOM_AUDIT_INSTRUCTIONS}

=== WELDING STANDARD AUDIT MODE (ACTIVE: ${welding.standard}) ===
This assembly IS WELDED and uses ${welding.standard} welding representation.
- Inspect EVERY visible welding, brazing, and NDE symbol, reference line, arrow-side/other-side placement, elementary/supplementary symbol orientation, size/leg/throat prefix, length/pitch syntax, process/NDE designator, contour/finishing indicator, and weld note against the complete ${welding.standard} Welding Audit Rulebook (${welding.ruleCount} rules) below.
- CRITICAL OUTPUT CLASSIFICATION:
  * For EVERY finding related to welding, brazing, or NDE symbols, callouts, weld notes, or ${welding.standard} rules:
    - Set auditScope to "welding"
    - Set category to "Welding Compliance"
    - Cite the exact ${welding.standard} rule citation_id in asmeCitation (e.g., "${weldCitationExample}")
  * For ALL GD&T/ISO GPS, dimensional, tolerance, DFM, title block, and BOM/balloon findings:
    - Set auditScope to "gdt"
    - Cite the exact ${base.standard} clause ID in asmeCitation when applicable (or "" for general DFM/BOM findings).

=== ${welding.standard} WELDING AUDIT RULEBOOK (${welding.ruleCount} RULES) ===
${welding.digestText}
=== END WELDING RULEBOOK ===`;
}

const AUDIT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    drawingName: {
      type: Type.STRING,
      description: 'Drawing title, part number, or file name observed on the drawing.',
    },
    findings: {
      type: Type.ARRAY,
      description: 'Exhaustive list of actionable design review findings sorted from P0 to P3.',
      items: {
        type: Type.OBJECT,
        properties: {
          priority: {
            type: Type.STRING,
            enum: ['P0', 'P1', 'P2', 'P3'],
            description: 'Severity level: P0 (Critical/Blocker), P1 (Major), P2 (Minor/Clarity), P3 (Suggestion).',
          },
          pageNumber: {
            type: Type.INTEGER,
            description: '1-indexed sheet or page number where the finding is located.',
          },
          location: {
            type: Type.STRING,
            description: 'Specific location, view, section, note number, or drawing zone (e.g. "Front View, Zone B3").',
          },
          description: {
            type: Type.STRING,
            description: 'Clear technical description of the issue observed on the drawing.',
          },
          impact: {
            type: Type.STRING,
            description: 'Concrete impact on fabrication, function, inspection, safety, or manufacturing cost if not fixed.',
          },
          recommendedFix: {
            type: Type.STRING,
            description: 'Actionable engineering or drafting fix to resolve the issue.',
          },
          asmeCitation: {
            type: Type.STRING,
            description:
              'Exact clause citation from the active standard rulebook(s) (ASME-Y14.5-2018, ISO-1101-2017, AWS-A2.4-2007, or ISO-2553-2019) if applicable, otherwise empty string.',
          },
          costImpact: {
            type: Type.BOOLEAN,
            description: 'True if this finding flags a high-impact-on-price design or tolerancing choice.',
          },
          category: {
            type: Type.STRING,
            enum: [
              'GD&T Compliance',
              'Manufacturability & Cost',
              'Dimensions & Tolerances',
              'Clarity & Title Block',
              'Design Intent',
              'BOM & Assembly',
              'Welding Compliance',
            ],
            description: 'Primary engineering review domain for this finding.',
          },
          auditScope: {
            type: Type.STRING,
            enum: ['gdt', 'welding'],
            description:
              'Use "welding" for welding/brazing/NDE standard audit findings when a welding rulebook is active, and "gdt" for all GD&T, dimensional, DFM, title block, and BOM/assembly findings.',
          },
          box_2d: {
            type: Type.ARRAY,
            description:
              'Tight normalized 0-1000 bounding box [ymin, xmin, ymax, xmax] locating the issue on the page (0,0 = top-left; 1000,1000 = bottom-right), or [] if strictly whole-sheet global.',
            items: {
              type: Type.INTEGER,
            },
          },
        },
        required: [
          'priority',
          'pageNumber',
          'location',
          'description',
          'impact',
          'recommendedFix',
          'asmeCitation',
          'costImpact',
          'category',
          'auditScope',
          'box_2d',
        ],
      },
    },
    executive_summary: {
      type: Type.STRING,
      description:
        'A single, clean, readable prose paragraph (2-4 sentences, no bullet points or newlines) generated AFTER the findings array, accurately summarizing the exact findings just detected, their manufacturing/compliance impact, and overall drawing readiness so every claim matches the itemized findings count and details.',
    },
  },
  propertyOrdering: ['drawingName', 'findings', 'executive_summary'],
  required: ['drawingName', 'findings', 'executive_summary'],
};

function normalizeBoundingBox(raw: unknown): AuditBoundingBox | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) {
    return undefined;
  }
  const nums = raw.map((v) => Number(v));
  if (nums.some((n) => !Number.isFinite(n))) {
    return undefined;
  }

  let [ymin, xmin, ymax, xmax] = nums.map((n) => Math.max(0, Math.min(1000, Math.round(n))));

  if (ymin > ymax) {
    [ymin, ymax] = [ymax, ymin];
  }
  if (xmin > xmax) {
    [xmin, xmax] = [xmax, xmin];
  }

  const width = xmax - xmin;
  const height = ymax - ymin;

  // Ignore degenerate zero-area boxes or full-sheet catch-all boxes (>96% of both axes)
  if (width < 2 || height < 2) {
    return undefined;
  }
  if (width > 960 && height > 960) {
    return undefined;
  }

  // Ensure very tiny callout points remain visibly selectable (min 14 units ~1.4%)
  if (width < 14) {
    const cx = Math.round((xmin + xmax) / 2);
    xmin = Math.max(0, cx - 7);
    xmax = Math.min(1000, cx + 7);
  }
  if (height < 14) {
    const cy = Math.round((ymin + ymax) / 2);
    ymin = Math.max(0, cy - 7);
    ymax = Math.min(1000, cy + 7);
  }

  return { ymin, xmin, ymax, xmax };
}

function appendMarkdownPrioritySections(lines: string[], findings: AuditFindingPayload[]): void {
  for (const priority of PRIORITY_ORDER) {
    const items = findings.filter((item) => item.priority === priority);
    lines.push('', `### ${PRIORITY_HEADINGS[priority]}`);
    if (items.length === 0) {
      lines.push('- None identified.');
    } else {
      for (const item of items) {
        const citationSuffix = item.asmeCitation?.trim() ? ` (${item.asmeCitation.trim()})` : '';
        const costPrefix = item.costImpact ? '[High Cost Impact] ' : '';
        lines.push(
          `- **${item.location}:** ${costPrefix}${item.description}${citationSuffix} -> ${item.impact} -> ${item.recommendedFix}`,
        );
      }
    }
  }
}

function normalizeSingleParagraph(text: string): string {
  return text
    .split(/\r?\n+/)
    .map((line) => line.trim().replace(/^([-*•+]|\d+[.)])\s+/, ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatMarkdownReport(
  drawingName: string,
  executiveSummary: string,
  findings: AuditFindingPayload[],
  weldingStandard?: WeldingStandard | null,
): string {
  const verdictLabel =
    findings.length > 0
      ? `REVISE (${findings.length} ${findings.length === 1 ? 'finding' : 'findings'})`
      : 'PASS (only p2 and p3 findings)';
  const weldingFindings = findings.filter((item) => item.auditScope === 'welding');
  const includeWeldingSection = Boolean(weldingStandard) || weldingFindings.length > 0;

  const lines: string[] = [
    `# Drawing: ${drawingName}`,
    '',
    `**Verdict:** ${verdictLabel}`,
    '',
    `**Executive Assessment:** ${normalizeSingleParagraph(executiveSummary)}`,
    '',
    '## Actionable Findings',
  ];

  if (!includeWeldingSection) {
    appendMarkdownPrioritySections(lines, findings);
    return lines.join('\n');
  }

  const gdtFindings = findings.filter((item) => item.auditScope !== 'welding');
  appendMarkdownPrioritySections(lines, gdtFindings);

  lines.push('', '## Welding standard Audit');
  if (weldingStandard) {
    lines.push('', `**Welding Standard:** ${weldingStandard}`);
  }
  appendMarkdownPrioritySections(lines, weldingFindings);

  return lines.join('\n');
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please check your API key in the Settings > Secrets panel.',
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isTransientError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return msg.includes('timeout') || msg.includes('econnreset') || msg.includes('unavailable');
}

async function generateAuditWithRetry(
  ai: GoogleGenAI,
  parts: Array<
    | { inlineData: { mimeType: string; data: string } }
    | { text: string }
  >,
  thinkingLevel: ThinkingLevel,
  systemInstruction: string,
) {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await ai.models.generateContent({
        model: MODEL_NAME,
        contents: { parts },
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: AUDIT_RESPONSE_SCHEMA,
          seed: 42,
          thinkingConfig: { thinkingLevel },
        },
      });
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && isTransientError(err)) {
        const delayMs = 800 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

function extractApiError(err: unknown): { status: number; message: string } {
  const rawStatus = (err as { status?: number })?.status;
  const rawMessage = err instanceof Error ? err.message : 'Drawing analysis failed unexpectedly.';
  const upper = rawMessage.toUpperCase();

  if (rawStatus === 403 || upper.includes('PERMISSION_DENIED') || upper.includes('API_KEY_INVALID')) {
    return {
      status: 403,
      message:
        'Gemini API key was rejected or lacks permission. Please verify your API key in the Settings > Secrets panel.',
    };
  }
  if (rawStatus === 429 || upper.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message:
        'Gemini API rate limit or quota was reached. Please retry in a moment or check your billing-enabled API key in Settings > Secrets.',
    };
  }
  if (rawStatus === 400 || upper.includes('INVALID_ARGUMENT')) {
    return {
      status: 400,
      message: `The drawing could not be processed by Gemini: ${rawMessage}`,
    };
  }
  if (rawMessage.includes('GEMINI_API_KEY is not configured')) {
    return { status: 500, message: rawMessage };
  }

  return {
    status: typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 502,
    message: rawMessage,
  };
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '45mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      rulebooks: {
        'ASME Y14.5-2018': {
          file: RULEBOOKS['ASME Y14.5-2018'].rulebookFile,
          rules: RULEBOOKS['ASME Y14.5-2018'].ruleCount,
        },
        'ISO 1101:2017': {
          file: RULEBOOKS['ISO 1101:2017'].rulebookFile,
          rules: RULEBOOKS['ISO 1101:2017'].ruleCount,
        },
      },
      weldingRulebooks: {
        'AWS A2.4:2007': {
          file: WELDING_RULEBOOKS['AWS A2.4:2007'].rulebookFile,
          rules: WELDING_RULEBOOKS['AWS A2.4:2007'].ruleCount,
        },
        'ISO 2553:2019': {
          file: WELDING_RULEBOOKS['ISO 2553:2019'].rulebookFile,
          rules: WELDING_RULEBOOKS['ISO 2553:2019'].ruleCount,
        },
      },
      model: MODEL_NAME,
    });
  });

  app.post('/api/audit', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as AuditRequestBody;
      const selectedStandard = resolveAuditStandard(body.standard);
      const isAssembly = Boolean(body.isAssembly);
      const isWelded = isAssembly && Boolean(body.isWelded);
      const requestedWeldingStandard = isWelded
        ? resolveWeldingStandard(body.weldingStandard)
        : null;
      const activeRulebook = RULEBOOKS[selectedStandard];
      const activeWelding = requestedWeldingStandard
        ? WELDING_RULEBOOKS[requestedWeldingStandard]
        : null;

      // Dynamic Rulebook Routing Engine
      let effectiveSystemInstruction = activeRulebook.systemInstruction;
      let effectiveRulebookVersion: string = activeRulebook.standard;
      let effectiveRuleCount = activeRulebook.ruleCount;

      if (isAssembly && activeWelding) {
        effectiveSystemInstruction = buildWeldedAssemblySystemInstruction(
          activeRulebook,
          activeWelding,
        );
        effectiveRulebookVersion = `${activeRulebook.standard} + ${activeWelding.standard}`;
        effectiveRuleCount = activeRulebook.ruleCount + activeWelding.ruleCount;
      } else if (isAssembly) {
        effectiveSystemInstruction = buildNonWeldedAssemblySystemInstruction(activeRulebook);
        effectiveRulebookVersion = `${activeRulebook.standard} (Assembly)`;
      }
      const fileName =
        typeof body.fileName === 'string' && body.fileName.trim()
          ? body.fileName.trim()
          : 'Uploaded_Drawing.pdf';
      const pageCount =
        typeof body.pageCount === 'number' && Number.isFinite(body.pageCount) && body.pageCount > 0
          ? Math.floor(body.pageCount)
          : 1;
      const sheetNumber =
        typeof body.sheetNumber === 'number' &&
        Number.isFinite(body.sheetNumber) &&
        body.sheetNumber >= 1
          ? Math.floor(body.sheetNumber)
          : undefined;
      const totalPages = Math.max(
        pageCount,
        sheetNumber ?? 1,
        typeof body.totalPages === 'number' && Number.isFinite(body.totalPages) && body.totalPages > 0
          ? Math.floor(body.totalPages)
          : 1,
      );

      const parts: Array<
        | { inlineData: { mimeType: string; data: string } }
        | { text: string }
      > = [];

      if (typeof body.pdfBase64 === 'string' && body.pdfBase64.trim().length > 0) {
        parts.push({
          inlineData: {
            mimeType: 'application/pdf',
            data: body.pdfBase64.trim(),
          },
        });
      } else if (Array.isArray(body.pageImages) && body.pageImages.length > 0) {
        for (const pageImg of body.pageImages.slice(0, 12)) {
          if (
            pageImg &&
            typeof pageImg.data === 'string' &&
            pageImg.data.trim().length > 0 &&
            typeof pageImg.mimeType === 'string'
          ) {
            parts.push({
              inlineData: {
                mimeType: pageImg.mimeType,
                data: pageImg.data.trim(),
              },
            });
          }
        }
      }

      if (parts.length === 0) {
        res.status(400).json({
          error: 'No drawing PDF or rendered page images were provided for inspection.',
        });
        return;
      }

      const documentScopePrompt = sheetNumber
        ? `Conduct a formal Senior Mechanical Engineer manufacturing design review of Sheet ${sheetNumber} of ${totalPages} from the engineering drawing file "${fileName}". Set pageNumber to ${sheetNumber} for every finding on this sheet.`
        : `Conduct a formal Senior Mechanical Engineer manufacturing design review of the attached engineering drawing file "${fileName}" (${totalPages} ${totalPages === 1 ? 'sheet/page' : 'sheets/pages'}).`;

      const assemblyScopeLine = activeWelding
        ? `This drawing represents a WELDED ASSEMBLY. In addition to ${activeRulebook.standard}, verify that the BOM / Parts List quantities and item numbers match every balloon on the views, and audit all visible welding/brazing/NDE callouts against ${activeWelding.standard}. Tag every welding/brazing/NDE finding with auditScope="welding" and exact ${activeWelding.standard} citation_id, and tag all GD&T/BOM/general findings with auditScope="gdt".`
        : isAssembly
          ? `This drawing represents a NON-WELDED ASSEMBLY. Proceed with the ${activeRulebook.standard} audit and explicitly verify that the BOM / Parts List item numbers and quantities match the balloons shown on the drawing views (flag any quantity or missing-balloon discrepancy under category "BOM & Assembly"). Set auditScope="gdt" for all findings.`
          : 'Set auditScope="gdt" for all findings.';

      parts.push({
        text: `${documentScopePrompt}

Evaluate all visible views, sections, dimensions, tolerance indicators / feature control frames, datum references, general notes, tolerances, material/finish callouts, and title block information against the ${effectiveRulebookVersion} rulebook and practical manufacturing / cost-driver best practices.
${assemblyScopeLine}

Return structured JSON in exact schema order: first drawingName, then exhaustive prioritized actionable findings (P0, P1, P2, P3) with tight normalized [ymin, xmin, ymax, xmax] (0-1000) box_2d coordinates for every localized finding, and finally executive_summary (a single clean prose paragraph with no bullet points summarizing the exact findings you just detected so the count and details match).`,
      });

      const ai = getGeminiClient();
      const thinkingLevel =
        body.reasoningDepth === 'standard' ? ThinkingLevel.MEDIUM : ThinkingLevel.HIGH;

      const response = await generateAuditWithRetry(
        ai,
        parts,
        thinkingLevel,
        effectiveSystemInstruction,
      );
      const rawText = (response.text ?? '').trim();

      if (!rawText) {
        res.status(502).json({
          error: 'The model returned an empty audit response. Please retry the drawing analysis.',
        });
        return;
      }

      let parsed: {
        drawingName?: string;
        findings?: AuditFindingPayload[];
        executive_summary?: string;
        generalAssessment?: string;
      };

      try {
        parsed = JSON.parse(rawText);
      } catch {
        const cleaned = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
        parsed = JSON.parse(cleaned);
      }

      const drawingName =
        typeof parsed.drawingName === 'string' && parsed.drawingName.trim()
          ? parsed.drawingName.trim()
          : fileName;
      const rawSummary =
        typeof parsed.executive_summary === 'string' && parsed.executive_summary.trim()
          ? parsed.executive_summary
          : typeof parsed.generalAssessment === 'string' && parsed.generalAssessment.trim()
            ? parsed.generalAssessment
            : '';
      const executiveSummary =
        normalizeSingleParagraph(rawSummary) ||
        `Engineering design review completed against ${activeRulebook.standard} and manufacturing readiness criteria.`;

      const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
      const normalizedFindings = rawFindings
        .filter((f) => f && typeof f.description === 'string' && f.description.trim().length > 0)
        .map((f, idx) => {
          const priority: AuditPriority = PRIORITY_ORDER.includes(f.priority) ? f.priority : 'P2';
          const clampedPage = sheetNumber
            ? sheetNumber
            : typeof f.pageNumber === 'number' && Number.isFinite(f.pageNumber)
              ? Math.max(1, Math.min(totalPages, Math.floor(f.pageNumber)))
              : 1;
          const citationStr =
            typeof f.asmeCitation === 'string' && f.asmeCitation.trim()
              ? f.asmeCitation.trim()
              : undefined;
          const isWeldingCitation = Boolean(
            citationStr && /^(AWS-A2\.4|ISO-2553)/i.test(citationStr),
          );
          const categoryStr =
            typeof f.category === 'string' && f.category.trim()
              ? f.category.trim()
              : 'GD&T Compliance';
          const auditScope: AuditFindingScope =
            activeWelding &&
            (f.auditScope === 'welding' ||
              isWeldingCitation ||
              categoryStr === 'Welding Compliance')
              ? 'welding'
              : 'gdt';

          return {
            id: `finding-p${clampedPage}-${priority.toLowerCase()}-${idx + 1}`,
            priority,
            pageNumber: clampedPage,
            location:
              typeof f.location === 'string' && f.location.trim()
                ? f.location.trim()
                : `Sheet ${clampedPage}`,
            description: f.description.trim(),
            impact:
              typeof f.impact === 'string' && f.impact.trim()
                ? f.impact.trim()
                : 'May cause manufacturing ambiguity or inspection non-conformance.',
            recommendedFix:
              typeof f.recommendedFix === 'string' && f.recommendedFix.trim()
                ? f.recommendedFix.trim()
                : `Clarify the callout in accordance with ${
                    auditScope === 'welding' && activeWelding
                      ? activeWelding.standard
                      : activeRulebook.standard
                  }.`,
            asmeCitation: citationStr,
            costImpact: Boolean(f.costImpact),
            category: categoryStr,
            auditScope,
            boundingBox: normalizeBoundingBox(f.box_2d),
          };
        })
        .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));

      const markdown = formatMarkdownReport(
        drawingName,
        executiveSummary,
        normalizedFindings,
        activeWelding?.standard ?? null,
      );

      res.json({
        drawingName,
        executive_summary: executiveSummary,
        generalAssessment: executiveSummary,
        findings: normalizedFindings,
        markdown,
        analyzedAt: new Date().toISOString(),
        rulebookVersion: effectiveRulebookVersion,
        ruleCount: effectiveRuleCount,
        pageCount: totalPages,
        modelUsed: MODEL_NAME,
        isAssembly,
        isWelded: Boolean(activeWelding),
        weldingStandard: activeWelding?.standard ?? null,
      });
    } catch (err) {
      console.error('[Drawing Audit API] /api/audit failed:', err);
      const { status, message } = extractApiError(err);
      res.status(status).json({ error: message });
    }
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const isHmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: isHmrDisabled ? false : { server: httpServer },
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(
      `Drawing Audit server running on http://0.0.0.0:${port} (ASME Y14.5-2018: ${RULEBOOKS['ASME Y14.5-2018'].ruleCount} rules, ISO 1101:2017: ${RULEBOOKS['ISO 1101:2017'].ruleCount} rules, AWS A2.4:2007: ${WELDING_RULEBOOKS['AWS A2.4:2007'].ruleCount} rules, ISO 2553:2019: ${WELDING_RULEBOOKS['ISO 2553:2019'].ruleCount} rules)`,
    );
  });
}

startServer().catch((err) => {
  console.error('Failed to start Drawing Audit server:', err);
  process.exit(1);
});
