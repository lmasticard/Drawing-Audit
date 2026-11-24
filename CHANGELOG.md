# Changelog

All notable changes to **Drawing Audit** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased] - 2026-11-23

### Added

- **Cascading Assembly & Welding Drawing Audit Workflow (Dynamic Rulebook Routing)**
  - Upgraded the front-page configuration beneath the Base GD&T Audit Standard selector into a 3-step cascading workflow with automatic state reset rules:
    - **Step 1 — Assembly Check (Always Visible):** *"Does the uploaded drawing represent an assembly?"* (`Yes` / `No`). Switching to `No` automatically resets and hides Steps 2 and 3.
    - **Step 2 — Welded Assembly Check (Conditionally visible when Assembly = `Yes`):** *"Is the assembly welded?"* (`Yes` / `No`). Switching to `No` automatically resets and hides Step 3.
    - **Step 3 — Welding Standard Check (Conditionally visible when Assembly = `Yes` and Welded = `Yes`):** *"Does the drawing use AWS or ISO welding representation?"* (`AWS A2.4:2007` [246 rules] / `ISO 2553:2019` [74 rules]), allowing independent pairing with either Base GD&T standard (`ASME Y14.5-2018` or `ISO 1101:2017`).
  - Implemented the **Dynamic Rulebook Routing Engine** in `POST /api/audit`:
    - Always loads the selected Base GD&T rulebook (`ASME Y14.5-2018` or `ISO 1101:2017`).
    - When `isAssembly && isWelded`, dynamically appends the chosen welding rulebook (`src/data/aws-a2.4-2007-audit-rulebook.json` or `src/data/iso-2553-2019-audit-rulebook.json`) alongside BOM/balloon parity checks and classifies welding findings with `auditScope: "welding"`.
    - When `isAssembly && !isWelded`, audits against the regular GD&T standard without loading welding rules while explicitly verifying that the **BOM / Parts List** item numbers and quantities match the **balloons** across all drawing views.
  - Added a dedicated **"Welding standard Audit"** section in the Design Review panel, Markdown report, and exported PDF report using the exact same P0–P3 formatting, `citation_id` tags, and canvas overlay numbering (`#N`) as the GD&T audit section.

- **ISO 2553:2019 Welding Drawing Audit Rulebook**
  - Compiled a machine-readable **ISO 2553:2019** (*Welding and allied processes — Symbolic representation on drawings — Welded joints*) audit rulebook (`src/data/iso-2553-2019-audit-rulebook.json`) containing **74 granular auditing rules** (55 `SHALL_MANDATORY`, 15 `SHOULD_RECOMMENDED`, 4 `DEFAULT_INTERPRETATION`, and 12 explicitly flagged forbidden/deprecated rules) tagged by `[SYSTEM A]` (5), `[SYSTEM B]` (4), and `[BOTH SYSTEMS]` (65).
  - Covers Foreword, Introduction, Clauses 1–7, Tables 1–7, and Annexes A–C (`Figure A.1`, `Table B.1`, `Tables C.1–C.2`), including System A dual-reference-line vs. System B single-reference-line segregation, fillet prefixes (`a`, `z`, `z1 × z2`, `s`), intermittent formats (`n × l (e)` vs. `l - p`), deprecated terms (`sealing run`, `weld metal thickness`), Clause 6 joint preparations, and Clause 7 ISO 5817 quality-level designations.

- **AWS A2.4:2007 Welding, Brazing & NDE Drawing Audit Rulebook**
  - Compiled a complete, machine-readable **AWS A2.4:2007** (*Standard Symbols for Welding, Brazing, and Nondestructive Examination*) audit rulebook (`src/data/aws-a2.4-2007-audit-rulebook.json`) containing **246 granular auditing rules** (187 `SHALL_MANDATORY`, 34 `SHOULD_RECOMMENDED`, 25 `DEFAULT_INTERPRETATION`, and 28 explicitly flagged forbidden/deprecated practices).
  - Covers every numbered clause from the Foreword and Clauses 3–16 (General Provisions, Groove, Fillet, Plug, Slot, Spot/Projection, Seam, Edge, Stud, Surfacing, Brazing, and Nondestructive Examination) plus **Annex A Normative Reference Tables** (Table A.1 joint designators, 126 Tables A.2–A.4 process codes, Table A.5 suffixes, Table A.6 NDE codes, Clause 5.5 finishing designators) and **Annex D Commentary drafting traps** (`D5.8`–`D6.12`).

- **Multi-Page Audit Progress Bar**
  - Added an accessible visual progress bar (`role="progressbar"`) beneath the drawing analysis status in the Design Review panel displaying the current processing stage, completed sheet counter (`X / N sheets`), completion percentage, and per-sheet segment indicators for multi-page drawings.
  - Added a matching compact progress bar on the Upload page file summary card when returning to the Upload view while an audit is running.
  - Updated client-side audit orchestration (`src/services/drawingAudit.ts`) and `POST /api/audit` to process multi-page engineering drawing PDFs incrementally sheet-by-sheet with real completion tracking and mid-run cancellation via `AbortController`.

- **Light Mode / Dark Mode Interface Switch**
  - Added a horizontal sliding **Light / Dark** interface switch in the front page header with preference persistence in `localStorage`.
  - Added full dark mode styling across the Upload view, split Review workspace, PDF previewer, Design Review panel, Google Sign-In control, Drive Folder modal, and confirmation modals.

- **Bottom Page-Selector Navigation Bar for PDF Previewer**
  - Added a docked navigation bar at the bottom of the PDF previewer with **Previous Page** and **Next Page** buttons, numbered sheet buttons (with compact ellipsis handling for larger packets and dot indicators on sheets containing findings), and a **Page X of N** dropdown selector.

- **Coordinate-Aware P0–P3 Canvas Findings Overlay**
  - Extended `POST /api/audit` to return validated normalized bounding boxes (`box_2d` on a `0–1000` coordinate scale) for localized drawing findings.
  - Implemented a canvas-based overlay (`PdfFindingsOverlayCanvas`) rendered over the PDF previewer that highlights P0–P3 findings directly on the drawing with numbered markers (`#N`), priority color coding, bidirectional hover/click selection with the findings list, auto-scroll focus, and a **Markers** toggle (`M` keyboard shortcut).

- **GitHub Documentation & Repository Hygiene**
  - Added `README.md` with workspace screenshots, end-to-end architecture workflow, ASME Y14.5-2018 / ISO 1101:2017 rulebook breakdown, local setup instructions, and roadmap next steps.
  - Added `CHANGELOG.md` in GitHub-flavored Markdown to track ongoing additions and fixes.
  - Excluded copyrighted reference standard PDFs (`public/assets/aistudio/*.pdf`) via `.gitignore` while preserving full app functionality through the compiled JSON rulebooks.

### Fixed

- **Vite Dev Server WebSocket Connection Error (`@vite/client`)**
  - Attached the Express `http.Server` directly to Vite's `ws` / `hmr` options in `middlewareMode` (`server.ts`) so `@vite/client` reuses the active server port instead of attempting to connect to an unreachable standalone port (`24678`).

- **PDF Previewer Viewport Scrolling & Full-Document Zoom**
  - Fixed horizontal viewport clipping on the left edge of wide or zoomed-in engineering drawings in the Review workspace so the full sheet can be scrolled and panned cleanly.
  - Fixed zoom scaling so full drawings fit inside the viewer by setting **Fit Page** as the default zoom preset alongside **Fit Width**, lowering the minimum zoom scale floor to `5%`, expanding zoom steps (`10%–300%`), and tracking intrinsic PDF page rotation and base dimensions per sheet.

---

## [Initial Release]

### Added

- Full-stack Engineering Drawing Audit application built with React 19, TypeScript, Vite 8, Tailwind CSS 4, Express, and `@google/genai`.
- Machine-readable audit rulebooks for **ASME Y14.5-2018** (191 rules) and **ISO 1101:2017** (163 rules) with a dual-standard selector on the Upload page.
- Local `pdfjs-dist` drawing viewer paired with a structured **P0–P3 Design Review** panel featuring severity filters, **Cost impact** filtering, and live keyword search.
- Client-side archival A4 PDF report export (`jsPDF`) and Google Docs-ready Markdown copy/download.
- Optional Google Drive folder sync via Firebase Auth with explicit overwrite confirmation.
