# Changelog

All notable changes to **Drawing Audit** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased] - 2026-11-23

### Added

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
