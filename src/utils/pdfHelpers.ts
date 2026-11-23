import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export { pdfjsLib };

export interface PdfInspectionResult {
  pageCount: number;
  widthPt: number;
  heightPt: number;
  paperFormat: string;
  title?: string;
  author?: string;
  thumbnailUrl?: string;
}

export function isPdfFile(file: File): boolean {
  const mime = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return mime === 'application/pdf' || mime === 'application/x-pdf' || name.endsWith('.pdf');
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

export function formatModifiedDate(timestamp: number): string {
  if (!timestamp) return 'Today';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(timestamp));
}

export function detectPaperFormat(widthPt: number, heightPt: number): string {
  const w = Math.round(Math.min(widthPt, heightPt));
  const h = Math.round(Math.max(widthPt, heightPt));
  const orientation = widthPt > heightPt ? 'Landscape' : 'Portrait';

  const matches = (targetW: number, targetH: number) =>
    Math.abs(w - targetW) <= 6 && Math.abs(h - targetH) <= 6;

  if (matches(612, 792)) return `US Letter · ${orientation}`;
  if (matches(595, 842)) return `A4 · ${orientation}`;
  if (matches(612, 1008)) return `US Legal · ${orientation}`;
  if (matches(792, 1224)) return `Tabloid · ${orientation}`;
  if (matches(420, 595)) return `A5 · ${orientation}`;
  return `${Math.round(widthPt)} × ${Math.round(heightPt)} pt`;
}

export async function inspectPdfFile(file: File): Promise<PdfInspectionResult> {
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  try {
    const firstPage = await pdf.getPage(1);
    const baseViewport = firstPage.getViewport({ scale: 1 });
    const widthPt = baseViewport.width;
    const heightPt = baseViewport.height;

    let title: string | undefined;
    let author: string | undefined;
    try {
      const metadata = await pdf.getMetadata();
      const info = metadata.info as Record<string, unknown> | undefined;
      if (info && typeof info.Title === 'string' && info.Title.trim()) {
        title = info.Title.trim();
      }
      if (info && typeof info.Author === 'string' && info.Author.trim()) {
        author = info.Author.trim();
      }
    } catch {
      // Metadata dictionary is optional in PDF files
    }

    let thumbnailUrl: string | undefined;
    try {
      const targetWidth = 420;
      const scale = Math.min(1.5, targetWidth / Math.max(widthPt, 1));
      const thumbViewport = firstPage.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(thumbViewport.width));
      canvas.height = Math.max(1, Math.floor(thumbViewport.height));

      await firstPage.render({
        canvas,
        viewport: thumbViewport,
      }).promise;

      thumbnailUrl = canvas.toDataURL('image/png');
    } catch {
      // Skip thumbnail gracefully if rendering fails
    }

    return {
      pageCount: pdf.numPages,
      widthPt,
      heightPt,
      paperFormat: detectPaperFormat(widthPt, heightPt),
      title,
      author,
      thumbnailUrl,
    };
  } finally {
    await loadingTask.destroy();
  }
}



/**
 * Generates a valid, vector 2D engineering drawing PDF in memory so users can
 * immediately test the upload preview and ASME Y14.5-2018 P0-P3 design review.
 */
export function createSamplePdfFile(): File {
  const ops: string[] = [];

  // Landscape ANSI-B style sheet (792 x 612 pt)
  // Outer sheet border and zone ticks
  ops.push('0.08 0.10 0.14 RG 1.2 w 24 24 744 564 re S');
  ops.push('0.35 0.40 0.48 RG 0.6 w 34 34 724 544 re S');

  // Zone labels (1-4 horizontally, A-B vertically)
  ops.push('0.35 0.40 0.48 rg');
  ops.push('BT /F2 8 Tf 120 581 Td (4) Tj ET');
  ops.push('BT /F2 8 Tf 300 581 Td (3) Tj ET');
  ops.push('BT /F2 8 Tf 485 581 Td (2) Tj ET');
  ops.push('BT /F2 8 Tf 665 581 Td (1) Tj ET');
  ops.push('BT /F2 8 Tf 26 445 Td (B) Tj ET');
  ops.push('BT /F2 8 Tf 26 175 Td (A) Tj ET');

  // === FRONT VIEW (Zone B4 / B3) ===
  ops.push('0.08 0.10 0.14 RG 1.4 w');
  // Main L-bracket body outline (120 mm x 80 mm scaled)
  ops.push('90 290 m 330 290 l 330 350 l 170 350 l 170 470 l 90 470 l 90 290 l S');

  // Centerlines (dashed)
  ops.push('0.35 0.40 0.48 RG 0.6 w [6 3 2 3] 0 d');
  ops.push('130 275 m 130 485 l S');
  ops.push('75 425 m 185 425 l S');
  ops.push('265 275 m 265 365 l S');
  ops.push('[] 0 d');

  // Main bore circle on vertical leg (center 130, 425, r=24) approximated with bezier
  ops.push('0.08 0.10 0.14 RG 1.2 w');
  ops.push('154 425 m 154 438.25 143.25 449 130 449 c 116.75 449 106 438.25 106 425 c 106 411.75 116.75 401 130 401 c 143.25 401 154 411.75 154 425 c S');

  // Mounting hole on horizontal leg (center 265, 320, r=12)
  ops.push('277 320 m 277 326.6 271.6 332 265 332 c 258.4 332 253 326.6 253 320 c 253 313.4 258.4 308 265 308 c 271.6 308 277 313.4 277 320 c S');

  // Dimension lines for Front View
  ops.push('0.18 0.24 0.34 RG 0.7 w');
  // Overall width 120.0 (intentional trailing zero on metric whole number)
  ops.push('90 286 m 90 245 l S 330 286 m 330 245 l S 90 255 m 330 255 l S');
  ops.push('0.08 0.10 0.14 rg');
  ops.push('BT /F1 10 Tf 188 260 Td (120.0 +/- 0.005) Tj ET');

  // Overall height 90
  ops.push('86 290 m 52 290 l S 86 470 m 52 470 l S 62 290 m 62 470 l S');
  ops.push('BT /F1 10 Tf 42 380 Td (90) Tj ET');

  // Hole callout with deprecated concentricity note and missing basic dimensions
  ops.push('148 442 m 210 495 l 365 495 l S');
  ops.push('BT /F1 9.5 Tf 214 500 Td (DIA 24.00 +/- 0.004 THRU) Tj ET');
  ops.push('BT /F1 9 Tf 214 482 Td ([CONCENTRICITY | DIA 0.01 | A | B]) Tj ET');

  // Sharp internal corner callout (high machining cost / stress riser)
  ops.push('170 350 m 225 412 l 355 412 l S');
  ops.push('BT /F1 9 Tf 229 417 Td (SHARP INTERNAL CORNER R0.0 MAX) Tj ET');

  // Datum A attached to bottom surface
  ops.push('210 290 m 210 272 l S 200 254 20 18 re S');
  ops.push('BT /F2 10 Tf 206 259 Td (A) Tj ET');

  // Datum B attached directly to centerline (ASME Y14.5-2018 6.3.2 violation)
  ops.push('130 485 m 130 505 l S 120 505 20 18 re S');
  ops.push('BT /F2 10 Tf 126 510 Td (B) Tj ET');

  // Hole on horizontal leg callout (missing thread depth / countersink detail)
  ops.push('275 328 m 315 380 l 410 380 l S');
  ops.push('BT /F1 9 Tf 318 385 Td (M8 THREADED HOLE) Tj ET');

  // View Label
  ops.push('BT /F2 10 Tf 168 228 Td (FRONT VIEW - SCALE 1:1) Tj ET');

  // === RIGHT SIDE VIEW (Zone B2 / B1) ===
  ops.push('0.08 0.10 0.14 RG 1.4 w');
  ops.push('475 290 85 180 re S');
  // Hidden lines for bore
  ops.push('0.35 0.40 0.48 RG 0.7 w [4 3] 0 d');
  ops.push('475 449 m 560 449 l S 475 401 m 560 401 l S');
  ops.push('[] 0 d');

  // Thickness dimension (redundant / chain dimensioning example)
  ops.push('0.18 0.24 0.34 RG 0.7 w');
  ops.push('475 474 m 475 510 l S 560 474 m 560 510 l S 475 500 m 560 500 l S');
  ops.push('0.08 0.10 0.14 rg');
  ops.push('BT /F1 10 Tf 492 506 Td (42.5 +/- .2) Tj ET');

  // Surface finish callout (ultra-fine grind on non-mating face)
  ops.push('560 390 m 610 390 l S');
  ops.push('BT /F1 9 Tf 614 394 Td (Ra 0.2 um ALL OVER) Tj ET');

  // Flatness FCF referencing a datum (ASME Y14.5-2018 8.2 violation!)
  ops.push('560 330 m 595 330 l S 595 320 135 20 re S');
  ops.push('BT /F1 9 Tf 602 327 Td ([FLATNESS | 0.02 | A]) Tj ET');

  ops.push('BT /F2 10 Tf 470 228 Td (RIGHT SIDE VIEW) Tj ET');

  // === GENERAL NOTES (Zone A4 / A3) ===
  ops.push('0.08 0.10 0.14 rg');
  ops.push('BT /F2 10 Tf 52 195 Td (NOTES: UNLESS OTHERWISE SPECIFIED) Tj ET');
  ops.push('BT /F1 9 Tf 52 178 Td (1. INTERPRET DRAWING PER ASME Y14.5) Tj ET');
  ops.push('BT /F1 9 Tf 52 163 Td (2. DIMENSIONS ARE IN MILLIMETERS. REMOVE ALL BURRS.) Tj ET');
  ops.push('BT /F1 9 Tf 52 148 Td (3. MATERIAL: ALUMINUM) Tj ET');
  ops.push('BT /F1 9 Tf 52 133 Td (4. FINISH: ANODIZE) Tj ET');
  ops.push('BT /F1 9 Tf 52 118 Td (5. TOLERANCES: .X +/- 0.5, .XX +/- 0.1, ANGULAR +/- 1 DEG) Tj ET');
  ops.push('BT /F1 9 Tf 52 103 Td (6. BREAK ALL EXTERNAL EDGES 0.5 MAX.) Tj ET');

  // === TITLE BLOCK (Zone A2 / A1) ===
  ops.push('0.08 0.10 0.14 RG 1.0 w 430 34 328 118 re S');
  ops.push('0.35 0.40 0.48 RG 0.6 w');
  ops.push('430 112 m 758 112 l S');
  ops.push('430 74 m 758 74 l S');
  ops.push('585 34 m 585 112 l S');
  ops.push('675 34 m 675 74 l S');

  ops.push('0.08 0.10 0.14 rg');
  ops.push('BT /F2 12 Tf 442 128 Td (SENSOR MOUNTING BRACKET - PRODUCTION) Tj ET');
  ops.push('BT /F1 8 Tf 442 98 Td (DWG NO:) Tj ET');
  ops.push('BT /F2 10 Tf 442 84 Td (BRKT-4028) Tj ET');
  ops.push('BT /F1 8 Tf 595 98 Td (REV:) Tj ET');
  ops.push('BT /F2 10 Tf 625 98 Td (A) Tj ET');
  ops.push('BT /F1 8 Tf 595 84 Td (PROJECTION: NOT SPECIFIED) Tj ET');
  ops.push('BT /F1 8 Tf 442 58 Td (DRAWN BY: J. MERCER) Tj ET');
  ops.push('BT /F1 8 Tf 442 44 Td (CHECKED BY: ________) Tj ET');
  ops.push('BT /F1 8 Tf 595 58 Td (SCALE: 1:1) Tj ET');
  ops.push('BT /F1 8 Tf 595 44 Td (SHEET 1 OF 1) Tj ET');
  ops.push('BT /F1 8 Tf 684 58 Td (UNITS: MM) Tj ET');
  ops.push('BT /F1 8 Tf 684 44 Td (MASS: TBD) Tj ET');

  const stream = ops.join('\n');

  const encoder = new TextEncoder();
  const chunks: string[] = [];
  const offsets: number[] = [];
  let byteLength = 0;

  const push = (str: string) => {
    chunks.push(str);
    byteLength += encoder.encode(str).length;
  };

  const addObject = (id: number, body: string) => {
    offsets[id] = byteLength;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');
  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObject(2, '<< /Type /Pages /Kids [5 0 R] /Count 1 >>');
  addObject(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  addObject(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const streamBytes = encoder.encode(stream).length;
  addObject(
    5,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents 6 0 R >>',
  );
  addObject(6, `<< /Length ${streamBytes} >>\nstream\n${stream}\nendstream`);
  addObject(
    7,
    '<< /Title (BRKT-4028 Sensor Mounting Bracket - Rev A) /Author (Drawing Audit Sample Generator) >>',
  );

  const xrefStart = byteLength;
  push('xref\n0 8\n');
  push('0000000000 65535 f \n');
  for (let i = 1; i < 8; i += 1) {
    push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size 8 /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const pdfBytes = encoder.encode(chunks.join(''));
  return new File([pdfBytes], 'BRKT-4028-REV-A_Mounting_Bracket.pdf', {
    type: 'application/pdf',
    lastModified: Date.now(),
  });
}

