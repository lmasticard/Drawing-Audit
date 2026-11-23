/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardCheck,
  CloudUpload,
  ExternalLink,
  FileText,
  Folder,
  LogOut,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { ConfirmActionModal } from './components/ConfirmActionModal';
import { DriveFolderModal } from './components/DriveFolderModal';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { PdfPreviewWorkspace } from './components/PdfPreviewWorkspace';
import { analyzeDrawingPdf } from './services/drawingAudit';
import {
  clearCachedToken,
  getAccessToken,
  googleSignIn,
  initAuth,
  logout,
  type User,
} from './services/googleAuth';
import {
  DriveAuthExpiredError,
  findExistingPdfInFolder,
  getDriveFolderById,
  uploadPdfToFolder,
  type DriveFolder,
  type DrivePdfFile,
} from './services/googleDrive';
import {
  AUDIT_STANDARDS,
  AUDIT_STANDARD_OPTIONS,
  type AuditRunState,
  type AuditStandard,
} from './types/audit';
import {
  createSamplePdfFile,
  formatFileSize,
  formatModifiedDate,
  inspectPdfFile,
  isPdfFile,
  type PdfInspectionResult,
} from './utils/pdfHelpers';

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading'; fileName: string }
  | { status: 'uploaded'; driveFile: DrivePdfFile; folderName: string }
  | { status: 'error'; message: string };

const LINKED_FOLDER_STORAGE_KEY = 'folio_linked_drive_folder_v2';
const AUDIT_STANDARD_STORAGE_KEY = 'drawing_audit_standard_v1';

function loadSavedStandard(): AuditStandard {
  try {
    const raw = window.localStorage.getItem(AUDIT_STANDARD_STORAGE_KEY);
    if (raw === 'ISO 1101:2017' || raw === 'ASME Y14.5-2018') {
      return raw;
    }
  } catch {
    // Ignore storage read errors
  }
  return 'ASME Y14.5-2018';
}

const DEFAULT_DRIVE_FOLDER: DriveFolder = {
  id: '1aiNBaSnOvfwFXfDwbChcqfNF2ESe721V',
  name: 'Linked Google Drive Folder',
  webViewLink: 'https://drive.google.com/drive/folders/1aiNBaSnOvfwFXfDwbChcqfNF2ESe721V',
};

function loadSavedFolder(): DriveFolder {
  try {
    const raw = window.localStorage.getItem(LINKED_FOLDER_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DriveFolder>;
      if (parsed && typeof parsed.id === 'string' && typeof parsed.name === 'string') {
        return {
          id: parsed.id,
          name: parsed.name,
          webViewLink: typeof parsed.webViewLink === 'string' ? parsed.webViewLink : undefined,
        };
      }
    }
  } catch {
    // Ignore storage read errors
  }
  return DEFAULT_DRIVE_FOLDER;
}

export default function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedBlobUrl, setSelectedBlobUrl] = useState<string | null>(null);
  const [inspection, setInspection] = useState<PdfInspectionResult | null>(null);
  const [isInspecting, setIsInspecting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState<boolean>(false);
  const [selectedStandard, setSelectedStandard] = useState<AuditStandard>(() =>
    loadSavedStandard(),
  );
  const [auditState, setAuditState] = useState<AuditRunState>({ status: 'idle' });

  // Google Drive Auth & Folder State (access token is kept strictly in memory)
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState<boolean>(false);
  const [linkedFolder, setLinkedFolder] = useState<DriveFolder | null>(() => loadSavedFolder());
  const [autoUploadToDrive, setAutoUploadToDrive] = useState<boolean>(true);
  const [isFolderModalOpen, setIsFolderModalOpen] = useState<boolean>(false);
  const [uploadState, setUploadState] = useState<UploadState>({ status: 'idle' });

  // Confirmation dialog for overwriting existing Drive files
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    file: File;
    existing: DrivePdfFile;
    folder: DriveFolder;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const driveSectionRef = useRef<HTMLDivElement | null>(null);
  const dragDepthRef = useRef<number>(0);
  const blobUrlsRef = useRef<Set<string>>(new Set());
  const activeDocIdRef = useRef<string | null>(null);
  const auditAbortRef = useRef<AbortController | null>(null);

  // Initialize Firebase Auth listener (token stays strictly in memory)
  useEffect(() => {
    const unsubscribe = initAuth(
      (user, token) => {
        setGoogleUser(user);
        setAccessToken(token);
      },
      () => {
        setGoogleUser(null);
        setAccessToken(null);
      },
    );
    return () => unsubscribe();
  }, []);

  // Clean up all created object URLs and abort pending audit on unmount
  useEffect(() => {
    const urls = blobUrlsRef.current;
    return () => {
      auditAbortRef.current?.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  // Persist selected audit standard preference
  useEffect(() => {
    try {
      window.localStorage.setItem(AUDIT_STANDARD_STORAGE_KEY, selectedStandard);
    } catch {
      // Ignore storage write errors
    }
  }, [selectedStandard]);

  // Persist non-sensitive linked folder metadata (never tokens)
  useEffect(() => {
    try {
      if (linkedFolder) {
        window.localStorage.setItem(LINKED_FOLDER_STORAGE_KEY, JSON.stringify(linkedFolder));
      } else {
        window.localStorage.removeItem(LINKED_FOLDER_STORAGE_KEY);
      }
    } catch {
      // Ignore storage write errors
    }
  }, [linkedFolder]);

  const handleAuthExpired = useCallback(() => {
    clearCachedToken();
    setAccessToken(null);
    setGoogleUser(null);
    setErrorMessage('Your Google Drive session expired. Please sign in with Google again.');
  }, []);

  useEffect(() => {
    if (!accessToken || !linkedFolder) {
      return;
    }

    let cancelled = false;
    getDriveFolderById(accessToken, linkedFolder.id)
      .then((resolved) => {
        if (cancelled) return;
        setLinkedFolder((prev) => {
          if (!prev || prev.id !== resolved.id) return prev;
          if (prev.name === resolved.name && prev.webViewLink === resolved.webViewLink) {
            return prev;
          }
          return resolved;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof DriveAuthExpiredError) {
          handleAuthExpired();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, linkedFolder?.id, handleAuthExpired]);

  const performDriveUpload = useCallback(
    async (file: File, folder: DriveFolder, overwriteFileId?: string) => {
      const token = accessToken ?? getAccessToken();
      if (!token) {
        setUploadState({
          status: 'error',
          message: 'Sign in with Google to upload drawings to your Drive folder.',
        });
        return;
      }

      setUploadState({ status: 'uploading', fileName: file.name });
      try {
        const uploaded = await uploadPdfToFolder(token, file, folder.id, overwriteFileId);
        setUploadState({
          status: 'uploaded',
          driveFile: uploaded,
          folderName: folder.name,
        });
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          handleAuthExpired();
          setUploadState({ status: 'idle' });
          return;
        }
        setUploadState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to upload PDF to Google Drive.',
        });
      }
    },
    [accessToken, handleAuthExpired],
  );

  const initiateDriveUpload = useCallback(
    async (file: File, folder: DriveFolder) => {
      const token = accessToken ?? getAccessToken();
      if (!token) {
        setErrorMessage('Sign in with Google to upload to your Drive folder.');
        return;
      }

      setUploadState({ status: 'uploading', fileName: file.name });
      try {
        const existing = await findExistingPdfInFolder(token, folder.id, file.name);
        if (existing) {
          setUploadState({ status: 'idle' });
          setPendingOverwrite({ file, existing, folder });
          return;
        }
        await performDriveUpload(file, folder);
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          handleAuthExpired();
          setUploadState({ status: 'idle' });
          return;
        }
        setUploadState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Could not check Google Drive folder.',
        });
      }
    },
    [accessToken, handleAuthExpired, performDriveUpload],
  );

  const runDrawingAudit = useCallback(
    async (
      file: File,
      docId: string,
      pageCount?: number,
      standardOverride?: AuditStandard,
    ) => {
      const targetStandard = standardOverride ?? selectedStandard;
      auditAbortRef.current?.abort();
      const controller = new AbortController();
      auditAbortRef.current = controller;

      setAuditState({
        status: 'analyzing',
        fileName: file.name,
        standard: targetStandard,
        startedAt: Date.now(),
      });

      try {
        const report = await analyzeDrawingPdf(file, {
          pageCount,
          standard: targetStandard,
          reasoningDepth: 'deep',
          signal: controller.signal,
        });

        if (activeDocIdRef.current === docId && !controller.signal.aborted) {
          setAuditState({ status: 'complete', report });
        }
      } catch (err) {
        if (controller.signal.aborted || activeDocIdRef.current !== docId) {
          return;
        }
        setAuditState({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Unable to complete the engineering design review. Please retry.',
        });
      }
    },
    [selectedStandard],
  );

  const handleCancelAudit = useCallback(() => {
    auditAbortRef.current?.abort();
    auditAbortRef.current = null;
    setAuditState({ status: 'idle' });
  }, []);

  const selectPdfFile = useCallback(
    (file: File, options?: { skipAutoUpload?: boolean; existingDriveFile?: DrivePdfFile }) => {
      if (!isPdfFile(file)) {
        setErrorMessage(
          `"${file.name}" is not a PDF document. Please select a file ending in .pdf.`,
        );
        setNoticeMessage(null);
        return;
      }

      setErrorMessage(null);
      setNoticeMessage(null);

      const blobUrl = URL.createObjectURL(file);
      blobUrlsRef.current.add(blobUrl);

      const docId = `${file.name}-${file.size}-${file.lastModified}-${Date.now()}`;
      activeDocIdRef.current = docId;
      setSelectedFile(file);
      setSelectedBlobUrl(blobUrl);
      setInspection(null);
      setIsInspecting(true);
      setIsPreviewOpen(true);

      if (options?.existingDriveFile && linkedFolder) {
        setUploadState({
          status: 'uploaded',
          driveFile: options.existingDriveFile,
          folderName: linkedFolder.name,
        });
      } else {
        setUploadState({ status: 'idle' });
      }

      inspectPdfFile(file)
        .then((result) => {
          if (activeDocIdRef.current === docId) {
            setInspection(result);
            setIsInspecting(false);
            void runDrawingAudit(file, docId, result.pageCount);
          }
        })
        .catch(() => {
          if (activeDocIdRef.current === docId) {
            setIsInspecting(false);
            void runDrawingAudit(file, docId, 1);
          }
        });

      // Automatically upload to linked Google Drive folder if connected and enabled
      const token = accessToken ?? getAccessToken();
      if (!options?.skipAutoUpload && autoUploadToDrive && linkedFolder && token) {
        void initiateDriveUpload(file, linkedFolder);
      }
    },
    [accessToken, autoUploadToDrive, initiateDriveUpload, linkedFolder, runDrawingAudit],
  );

  const handleGoogleSignIn = async () => {
    setIsSigningIn(true);
    setErrorMessage(null);
    setNoticeMessage(null);
    try {
      const result = await googleSignIn();
      setGoogleUser(result.user);
      setAccessToken(result.accessToken);
      if (!linkedFolder) {
        setIsFolderModalOpen(true);
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Unable to sign in with Google. Please try again.',
        );
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleGoogleLogout = async () => {
    await logout();
    setGoogleUser(null);
    setAccessToken(null);
    setUploadState({ status: 'idle' });
  };

  const handleConfirmOverwrite = async () => {
    if (!pendingOverwrite) return;
    setConfirmBusy(true);
    const { file, existing, folder } = pendingOverwrite;
    setPendingOverwrite(null);
    try {
      await performDriveUpload(file, folder, existing.id);
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleUploadAsNewCopy = async () => {
    if (!pendingOverwrite) return;
    setConfirmBusy(true);
    const { file, folder } = pendingOverwrite;
    setPendingOverwrite(null);
    try {
      await performDriveUpload(file, folder);
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!isPdfFile(file)) {
      event.target.value = '';
    }
    selectPdfFile(file);
  };

  const triggerFilePicker = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleClearFile = () => {
    auditAbortRef.current?.abort();
    auditAbortRef.current = null;
    activeDocIdRef.current = null;
    setSelectedFile(null);
    setSelectedBlobUrl(null);
    setInspection(null);
    setIsInspecting(false);
    setIsPreviewOpen(false);
    setAuditState({ status: 'idle' });
    setErrorMessage(null);
    setNoticeMessage(null);
    setUploadState({ status: 'idle' });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleLoadSample = () => {
    const sampleFile = createSamplePdfFile();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    selectPdfFile(sampleFile, { skipAutoUpload: true });
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragging(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragging(false);

    const files = event.dataTransfer.files;
    if (!files || files.length === 0) return;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    selectPdfFile(files[0]);
  };

  const handleNavPreview = () => {
    if (selectedFile && selectedBlobUrl) {
      setIsPreviewOpen(true);
      setNoticeMessage(null);
    } else {
      setNoticeMessage('Select an engineering drawing PDF first to open the review workspace.');
      fileInputRef.current?.focus();
    }
  };

  const handleNavDriveFolder = () => {
    if (isPreviewOpen) {
      setIsPreviewOpen(false);
    }
    if (accessToken) {
      setIsFolderModalOpen(true);
    } else {
      requestAnimationFrame(() => {
        driveSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  };

  const isDriveConnected = Boolean(accessToken && googleUser);

  return (
    <div className="min-h-screen flex flex-col bg-blueprint-mosaic text-slate-900">
      {/* Hidden replacement input for when user triggers Select PDF from preview mode */}
      {isPreviewOpen && (
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          onChange={handleFileInputChange}
          className="sr-only"
          aria-label="Choose a PDF file"
        />
      )}

      {/* Top Bar — 3-Zone Contract */}
      <header className="h-16 shrink-0 bg-white border-b border-slate-200 px-8 flex items-center justify-between gap-8">
        {/* Zone 1: Single text element wordmark */}
        <button
          type="button"
          onClick={() => setIsPreviewOpen(false)}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
        >
          Drawing Audit
        </button>

        {/* Zone 2: Clean single-line text navigation links */}
        <nav
          aria-label="Primary navigation"
          className="flex items-center gap-7 text-sm font-medium text-slate-600"
        >
          <button
            type="button"
            onClick={() => setIsPreviewOpen(false)}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
              !isPreviewOpen
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            Upload
          </button>
          <button
            type="button"
            onClick={handleNavPreview}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
              isPreviewOpen
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            Review
          </button>
          <button
            type="button"
            onClick={handleNavDriveFolder}
            className="py-1 border-b-2 border-transparent hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            Drive Folder
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={triggerFilePicker}
            className="px-4 py-2 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Select PDF
          </button>
        </div>
      </header>

      {/* Main Content */}
      {isPreviewOpen && selectedFile && selectedBlobUrl ? (
        <PdfPreviewWorkspace
          file={selectedFile}
          blobUrl={selectedBlobUrl}
          selectedStandard={selectedStandard}
          auditState={auditState}
          onRunAudit={() => {
            if (selectedFile && activeDocIdRef.current) {
              void runDrawingAudit(
                selectedFile,
                activeDocIdRef.current,
                inspection?.pageCount,
                selectedStandard,
              );
            }
          }}
          onCancelAudit={handleCancelAudit}
          onBack={() => setIsPreviewOpen(false)}
          onReplaceClick={triggerFilePicker}
        />
      ) : (
        <main className="flex-1 w-full max-w-[920px] mx-auto px-8 py-10">
          <div className="flex flex-col justify-between bg-white border border-slate-200/90 rounded-xl p-8 shadow-xl">
              <div>
                {/* Clean Editorial Header */}
                <div className="max-w-2xl mb-6">
                  <h1 className="text-3xl font-semibold tracking-tight text-slate-900 leading-tight [text-wrap:balance]">
                    Upload and audit engineering drawings
                  </h1>
                  <p className="mt-2.5 text-[15px] leading-relaxed text-slate-600">
                    Upload a manufacturing drawing PDF to run an automated {selectedStandard} design
                    review, inspect prioritized P0–P3 findings alongside the drawing preview, and
                    sync files to your linked Google Drive folder.
                  </p>
                </div>

                {/* Google Drive Folder Destination Bar */}
                <div
                  ref={driveSectionRef}
                  className="mb-6 py-4 border-y border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  {!isDriveConnected ? (
                    <>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                          <span className="text-sm font-semibold text-slate-900">
                            Google Drive destination
                          </span>
                          {linkedFolder?.webViewLink && (
                            <a
                              href={linkedFolder.webViewLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline whitespace-nowrap"
                            >
                              <span>Open linked folder</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {linkedFolder
                            ? `Sign in with Google to upload engineering drawings directly to "${linkedFolder.name}".`
                            : 'Sign in with Google to choose a Drive folder for uploaded engineering drawings.'}
                        </p>
                      </div>
                      <GoogleSignInButton onClick={handleGoogleSignIn} loading={isSigningIn} />
                    </>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <span>Google Drive</span>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">{googleUser?.email}</span>
                        </div>
                        {linkedFolder ? (
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                            <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 min-w-0">
                              <Folder className="w-4 h-4 text-blue-700 shrink-0" />
                              <span className="truncate max-w-[260px]" title={linkedFolder.name}>
                                {linkedFolder.name}
                              </span>
                            </div>
                            {linkedFolder.webViewLink && (
                              <a
                                href={linkedFolder.webViewLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline whitespace-nowrap"
                              >
                                <span>Open in Drive</span>
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={autoUploadToDrive}
                                onChange={(e) => setAutoUploadToDrive(e.target.checked)}
                                className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                              />
                              <span>Auto-upload on select</span>
                            </label>
                          </div>
                        ) : (
                          <div className="mt-1 text-sm text-slate-700">
                            No destination folder linked yet.
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => setIsFolderModalOpen(true)}
                          className="px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 rounded-lg transition-colors whitespace-nowrap shrink-0"
                        >
                          {linkedFolder ? 'Change Folder' : 'Choose Folder'}
                        </button>
                        <button
                          type="button"
                          onClick={handleGoogleLogout}
                          title="Sign out of Google Drive"
                          aria-label="Sign out of Google Drive"
                          className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors shrink-0"
                        >
                          <LogOut className="w-4 h-4" />
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {/* Audit Standard Horizontal Slider Selector */}
                <div className="mb-6 pb-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="min-w-0">
                    <span
                      id="audit-standard-label"
                      className="text-sm font-semibold text-slate-900"
                    >
                      Audit standard
                    </span>
                    <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                      {AUDIT_STANDARDS[selectedStandard].ruleCount} rules ·{' '}
                      {AUDIT_STANDARDS[selectedStandard].rulebookFile}
                    </p>
                  </div>

                  <div
                    role="radiogroup"
                    aria-labelledby="audit-standard-label"
                    className="relative grid grid-cols-2 w-full sm:w-[340px] shrink-0 p-1 bg-slate-100 border border-slate-200 rounded-lg select-none"
                  >
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-0.25rem)] rounded-md bg-slate-900 shadow-xs transition-transform duration-200 ease-out ${
                        selectedStandard === 'ISO 1101:2017'
                          ? 'translate-x-full'
                          : 'translate-x-0'
                      }`}
                    />
                    {AUDIT_STANDARD_OPTIONS.map((standard) => {
                      const isSelected = selectedStandard === standard;
                      return (
                        <button
                          key={standard}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          onClick={() => setSelectedStandard(standard)}
                          className={`relative z-10 px-3 py-2 text-xs font-semibold rounded-md transition-colors duration-200 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 ${
                            isSelected
                              ? 'text-white'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {standard}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Inline Error Message (Non-Hue-Only State Signaling) */}
                {errorMessage && (
                  <div
                    role="alert"
                    className="mb-6 flex items-start justify-between gap-4 px-4 py-3.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800"
                  >
                    <div className="flex items-start gap-2.5">
                      <AlertCircle className="w-4 h-4 text-red-700 mt-0.5 shrink-0" />
                      <span>{errorMessage}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setErrorMessage(null)}
                      aria-label="Dismiss error"
                      className="text-red-600 hover:text-red-900 p-0.5 rounded shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {/* Gentle Inline Notice */}
                {noticeMessage && !errorMessage && (
                  <div
                    role="status"
                    className="mb-6 flex items-center justify-between gap-4 px-4 py-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700"
                  >
                    <span>{noticeMessage}</span>
                    <button
                      type="button"
                      onClick={() => setNoticeMessage(null)}
                      aria-label="Dismiss notice"
                      className="text-slate-500 hover:text-slate-900 p-0.5 rounded shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {/* Primary File Upload Area (Dominant Focal Anchor) */}
                <div
                  onDragEnter={handleDragEnter}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`rounded-lg border-2 border-dashed transition-colors duration-150 px-8 py-12 flex flex-col items-center justify-center text-center min-h-[280px] ${
                    isDragging
                      ? 'border-blue-600 bg-blue-50/50'
                      : 'border-slate-300 bg-[#FAFBFD] hover:border-slate-400'
                  }`}
                >
                  <div
                    className={`w-12 h-12 rounded-lg flex items-center justify-center mb-5 transition-colors duration-150 ${
                      isDragging
                        ? 'bg-blue-700 text-white'
                        : 'bg-white border border-slate-200 text-slate-700'
                    }`}
                  >
                    <Upload className="w-5 h-5" />
                  </div>

                  <label
                    htmlFor="pdf-file-input"
                    className="text-base font-semibold text-slate-900 cursor-pointer"
                  >
                    {isDragging
                      ? 'Release to load PDF document'
                      : 'Drop a Engineering Drawing here, or choose from your computer'}
                  </label>

                  <p className="mt-1.5 text-sm text-slate-500">
                    Accepts .pdf documents <span aria-hidden="true">·</span>{' '}
                    {isDriveConnected && linkedFolder
                      ? autoUploadToDrive
                        ? `Uploads directly to "${linkedFolder.name}"`
                        : `Linked to "${linkedFolder.name}"`
                      : 'Rendered locally on your machine'}
                  </p>

                  {/* Standard HTML File Input for PDF Files */}
                  <div className="mt-7 w-full max-w-md">
                    <input
                      ref={fileInputRef}
                      id="pdf-file-input"
                      name="pdfFile"
                      type="file"
                      accept=".pdf,application/pdf"
                      onChange={handleFileInputChange}
                      aria-describedby="pdf-upload-hint"
                      className="block w-full text-sm text-slate-600 bg-white border border-slate-200 rounded-lg p-1.5 cursor-pointer
                        file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0
                        file:text-sm file:font-medium file:bg-slate-900 file:text-white
                        hover:file:bg-slate-800 file:transition-colors file:cursor-pointer
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                    />
                    <p id="pdf-upload-hint" className="sr-only">
                      Select a PDF file from your computer to display its filename and enable
                      document preview.
                    </p>
                  </div>
                </div>

                {/* Selected File Summary & Conditional Preview Button */}
                {selectedFile ? (
                  <div aria-live="polite" className="mt-6 pt-6 border-t border-slate-200">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
                      <div className="flex items-start gap-3.5 min-w-0">
                        <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 text-slate-700 flex items-center justify-center shrink-0 mt-0.5">
                          <FileText className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-slate-500 mb-0.5">
                            Selected PDF File
                          </div>
                          <p
                            data-testid="selected-filename"
                            className="text-base font-semibold text-slate-900 truncate"
                            title={selectedFile.name}
                          >
                            {selectedFile.name}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 font-mono tabular-nums">
                            <span>{formatFileSize(selectedFile.size)}</span>
                            <span aria-hidden="true">·</span>
                            <span>
                              {isInspecting
                                ? 'Reading pages...'
                                : inspection
                                  ? `${inspection.pageCount} ${inspection.pageCount === 1 ? 'page' : 'pages'}`
                                  : 'PDF Document'}
                            </span>
                            {inspection && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{inspection.paperFormat}</span>
                              </>
                            )}
                            <span aria-hidden="true">·</span>
                            <span>Modified {formatModifiedDate(selectedFile.lastModified)}</span>
                          </div>
                        </div>
                      </div>

                      {/* Actions: Open Review button appears once a file is chosen */}
                      <div className="flex items-center gap-2 shrink-0 flex-wrap">
                        <button
                          type="button"
                          onClick={() => setIsPreviewOpen(true)}
                          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                        >
                          <ClipboardCheck className="w-4 h-4" />
                          <span>
                            {auditState.status === 'analyzing'
                              ? 'View Analysis'
                              : auditState.status === 'complete'
                                ? 'Open Review'
                                : 'Review Drawing'}
                          </span>
                        </button>

                        {isDriveConnected && linkedFolder && uploadState.status !== 'uploaded' && (
                          <button
                            type="button"
                            disabled={uploadState.status === 'uploading'}
                            onClick={() => void initiateDriveUpload(selectedFile, linkedFolder)}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                          >
                            <CloudUpload className="w-4 h-4" />
                            <span>
                              {uploadState.status === 'uploading' ? 'Uploading...' : 'Save to Drive'}
                            </span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={triggerFilePicker}
                          title="Choose a different PDF"
                          className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:text-slate-900 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>Replace</span>
                        </button>

                        <button
                          type="button"
                          onClick={handleClearFile}
                          aria-label="Remove selected file"
                          title="Remove selected file"
                          className="p-2.5 text-slate-500 hover:text-red-700 hover:bg-red-50 border border-slate-200 rounded-lg transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Google Drive Upload Status Feedback */}
                    {uploadState.status === 'uploading' && (
                      <div className="mt-4 pt-3.5 border-t border-slate-100 flex items-center gap-2 text-xs text-slate-600">
                        <div className="w-3.5 h-3.5 border-2 border-slate-300 border-t-blue-700 rounded-full animate-spin shrink-0" />
                        <span>
                          Uploading <span className="font-medium text-slate-900">{uploadState.fileName}</span> to{' '}
                          <span className="font-medium text-slate-900">{linkedFolder?.name}</span>...
                        </span>
                      </div>
                    )}

                    {uploadState.status === 'uploaded' && (
                      <div className="mt-4 pt-3.5 border-t border-slate-100 flex items-center justify-between gap-4 text-xs">
                        <div className="flex items-center gap-2 text-emerald-700">
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          <span>
                            Saved in Google Drive folder{' '}
                            <span className="font-semibold text-slate-900">
                              {uploadState.folderName}
                            </span>
                          </span>
                        </div>
                        {uploadState.driveFile.webViewLink && (
                          <a
                            href={uploadState.driveFile.webViewLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline whitespace-nowrap shrink-0"
                          >
                            <span>View in Drive</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    )}

                    {uploadState.status === 'error' && (
                      <div className="mt-4 pt-3.5 border-t border-slate-100 flex items-center justify-between gap-4 text-xs text-red-700">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          <span>{uploadState.message}</span>
                        </div>
                        {linkedFolder && (
                          <button
                            type="button"
                            onClick={() => void initiateDriveUpload(selectedFile, linkedFolder)}
                            className="font-medium text-red-800 hover:underline whitespace-nowrap shrink-0"
                          >
                            Retry upload
                          </button>
                        )}
                      </div>
                    )}
                    {/* Design Review Summary Status Row (when returning to Upload page) */}
                    {auditState.status === 'complete' && (
                      <div className="mt-4 pt-3.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-4 text-xs">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-slate-600 font-mono tabular-nums">
                          <span className="font-sans font-medium text-slate-900">
                            {auditState.report.rulebookVersion} review ready
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="text-red-700 font-semibold">
                            P0 {auditState.report.findings.filter((f) => f.priority === 'P0').length}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="text-orange-700 font-semibold">
                            P1 {auditState.report.findings.filter((f) => f.priority === 'P1').length}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="text-amber-700 font-semibold">
                            P2 {auditState.report.findings.filter((f) => f.priority === 'P2').length}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="text-slate-600 font-semibold">
                            P3 {auditState.report.findings.filter((f) => f.priority === 'P3').length}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          {auditState.report.rulebookVersion !== selectedStandard && (
                            <button
                              type="button"
                              onClick={() => {
                                if (selectedFile && activeDocIdRef.current) {
                                  setIsPreviewOpen(true);
                                  void runDrawingAudit(
                                    selectedFile,
                                    activeDocIdRef.current,
                                    inspection?.pageCount,
                                    selectedStandard,
                                  );
                                }
                              }}
                              className="font-medium text-slate-700 hover:text-slate-900 underline underline-offset-2 whitespace-nowrap"
                            >
                              Re-run with {selectedStandard}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setIsPreviewOpen(true)}
                            className="font-medium text-blue-700 hover:underline whitespace-nowrap"
                          >
                            View P0–P3 findings
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-6 pt-5 border-t border-slate-100 flex items-center justify-between gap-4 text-sm text-slate-500">
                    <span>No file selected yet.</span>
                    <button
                      type="button"
                      onClick={handleLoadSample}
                      className="font-medium text-slate-700 hover:text-blue-700 underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
                    >
                      Load a sample engineering drawing to test review
                    </button>
                  </div>
                )}
              </div>

              {/* Quiet Desktop Footnote Strip */}
              <div className="mt-8 pt-5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
                <span>
                  {isDriveConnected && linkedFolder
                    ? `Connected to Google Drive · Destination: ${linkedFolder.name}`
                    : 'Local PDF preview · Optional Google Drive folder sync'}
                </span>
                <span>
                  Press <kbd className="font-mono text-slate-700">Esc</kbd> inside preview to
                  return here
                </span>
              </div>
          </div>
        </main>
      )}

      {/* Google Drive Folder Browser Modal */}
      <DriveFolderModal
        open={isFolderModalOpen}
        accessToken={accessToken}
        currentFolder={linkedFolder}
        onSelectFolder={(folder) => {
          setLinkedFolder(folder);
          setUploadState({ status: 'idle' });
        }}
        onAuthExpired={handleAuthExpired}
        onClose={() => setIsFolderModalOpen(false)}
      />

      {/* Explicit Confirmation Dialog: Overwrite existing PDF in Google Drive */}
      <ConfirmActionModal
        open={Boolean(pendingOverwrite)}
        title="Overwrite existing drawing in Google Drive?"
        description={
          pendingOverwrite
            ? `"${pendingOverwrite.file.name}" already exists in "${pendingOverwrite.folder.name}". You can replace the existing file's contents or upload this as a separate copy.`
            : ''
        }
        confirmLabel="Overwrite Existing"
        secondaryLabel="Upload as Copy"
        busy={confirmBusy}
        onConfirm={() => void handleConfirmOverwrite()}
        onSecondary={() => void handleUploadAsNewCopy()}
        onCancel={() => setPendingOverwrite(null)}
      />
    </div>
  );
}
