import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

type AuditPriority = 'P0' | 'P1' | 'P2' | 'P3';
type AuditStandard = 'ASME Y14.5-2018' | 'ISO 1101:2017';

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
}

interface AuditRequestBody {
  fileName?: string;
  pageCount?: number;
  standard?: string;
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
  - category: One of "GD&T Compliance", "Manufacturability & Cost", "Dimensions & Tolerances", "Clarity & Title Block", "Design Intent".
- Keep generalAssessment to a crisp 1-2 sentence summary of the drawing's overall manufacturing readiness, quality, and clarity.

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

const AUDIT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    drawingName: {
      type: Type.STRING,
      description: 'Drawing title, part number, or file name observed on the drawing.',
    },
    generalAssessment: {
      type: Type.STRING,
      description:
        'A concise 1-2 sentence summary of the drawing overall quality, clarity, and manufacturing readiness.',
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
              'Exact clause citation from the active standard rulebook (ASME-Y14.5-2018 or ISO-1101-2017) if applicable, otherwise empty string.',
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
            ],
            description: 'Primary engineering review domain for this finding.',
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
        ],
      },
    },
  },
  required: ['drawingName', 'generalAssessment', 'findings'],
};

function formatMarkdownReport(
  drawingName: string,
  generalAssessment: string,
  findings: AuditFindingPayload[],
): string {
  const lines: string[] = [
    `# Drawing: ${drawingName}`,
    '',
    `**General Assessment:** ${generalAssessment}`,
    '',
    '## Actionable Findings',
  ];

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
      model: MODEL_NAME,
    });
  });

  app.post('/api/audit', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as AuditRequestBody;
      const selectedStandard = resolveAuditStandard(body.standard);
      const activeRulebook = RULEBOOKS[selectedStandard];
      const fileName =
        typeof body.fileName === 'string' && body.fileName.trim()
          ? body.fileName.trim()
          : 'Uploaded_Drawing.pdf';
      const pageCount =
        typeof body.pageCount === 'number' && Number.isFinite(body.pageCount) && body.pageCount > 0
          ? Math.floor(body.pageCount)
          : 1;

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

      parts.push({
        text: `Conduct a formal Senior Mechanical Engineer manufacturing design review of the attached engineering drawing file "${fileName}" (${pageCount} ${pageCount === 1 ? 'sheet/page' : 'sheets/pages'}).

Evaluate all visible views, sections, dimensions, tolerance indicators / feature control frames, datum references, general notes, tolerances, material/finish callouts, and title block information against the ${activeRulebook.standard} rulebook and practical manufacturing / cost-driver best practices.

Return structured JSON containing drawingName, generalAssessment (1-2 sentences), and exhaustive prioritized actionable findings (P0, P1, P2, P3).`,
      });

      const ai = getGeminiClient();
      const thinkingLevel =
        body.reasoningDepth === 'standard' ? ThinkingLevel.MEDIUM : ThinkingLevel.HIGH;

      const response = await generateAuditWithRetry(
        ai,
        parts,
        thinkingLevel,
        activeRulebook.systemInstruction,
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
        generalAssessment?: string;
        findings?: AuditFindingPayload[];
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
      const generalAssessment =
        typeof parsed.generalAssessment === 'string' && parsed.generalAssessment.trim()
          ? parsed.generalAssessment.trim()
          : `Engineering design review completed against ${activeRulebook.standard} and manufacturing readiness criteria.`;

      const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
      const normalizedFindings = rawFindings
        .filter((f) => f && typeof f.description === 'string' && f.description.trim().length > 0)
        .map((f, idx) => {
          const priority: AuditPriority = PRIORITY_ORDER.includes(f.priority) ? f.priority : 'P2';
          const clampedPage =
            typeof f.pageNumber === 'number' && Number.isFinite(f.pageNumber)
              ? Math.max(1, Math.min(pageCount, Math.floor(f.pageNumber)))
              : 1;
          return {
            id: `finding-${priority.toLowerCase()}-${idx + 1}`,
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
                : `Clarify the callout in accordance with ${activeRulebook.standard}.`,
            asmeCitation:
              typeof f.asmeCitation === 'string' && f.asmeCitation.trim()
                ? f.asmeCitation.trim()
                : undefined,
            costImpact: Boolean(f.costImpact),
            category:
              typeof f.category === 'string' && f.category.trim()
                ? f.category.trim()
                : 'GD&T Compliance',
          };
        })
        .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));

      const markdown = formatMarkdownReport(drawingName, generalAssessment, normalizedFindings);

      res.json({
        drawingName,
        generalAssessment,
        findings: normalizedFindings,
        markdown,
        analyzedAt: new Date().toISOString(),
        rulebookVersion: activeRulebook.standard,
        ruleCount: activeRulebook.ruleCount,
        pageCount,
        modelUsed: MODEL_NAME,
      });
    } catch (err) {
      console.error('[Drawing Audit API] /api/audit failed:', err);
      const { status, message } = extractApiError(err);
      res.status(status).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
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

  app.listen(port, '0.0.0.0', () => {
    console.log(
      `Drawing Audit server running on http://0.0.0.0:${port} (ASME Y14.5-2018: ${RULEBOOKS['ASME Y14.5-2018'].ruleCount} rules, ISO 1101:2017: ${RULEBOOKS['ISO 1101:2017'].ruleCount} rules)`,
    );
  });
}

startServer().catch((err) => {
  console.error('Failed to start Drawing Audit server:', err);
  process.exit(1);
});
