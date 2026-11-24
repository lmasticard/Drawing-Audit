/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardCheck,
  CloudUpload,
  ExternalLink,
  FileText,
  Folder,
  LogOut,
  Moon,
  RefreshCw,
  Sun,
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
  WELDING_STANDARDS,
  WELDING_STANDARD_OPTIONS,
  type AuditRunState,
  type AuditStandard,
  type WeldingStandard,
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
const ASSEMBLY_MODE_STORAGE_KEY = 'drawing_audit_is_assembly_v1';
const WELDED_ASSEMBLY_STORAGE_KEY = 'drawing_audit_is_welded_v1';
const WELDING_STANDARD_STORAGE_KEY = 'drawing_audit_welding_standard_v1';
const THEME_STORAGE_KEY = 'drawing_audit_theme_v1';

type InterfaceTheme = 'light' | 'dark';

function loadSavedTheme(): InterfaceTheme {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'dark' || raw === 'light') {
      return raw;
    }
  } catch {
    // Ignore storage read errors
  }
  return 'light';
}

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

function loadSavedAssemblyConfig(): {
  isAssembly: boolean;
  isWelded: boolean;
  weldingStandard: WeldingStandard | null;
} {
  try {
    const isAssembly = window.localStorage.getItem(ASSEMBLY_MODE_STORAGE_KEY) === 'true';
    if (!isAssembly) {
      return { isAssembly: false, isWelded: false, weldingStandard: null };
    }
    const isWelded = window.localStorage.getItem(WELDED_ASSEMBLY_STORAGE_KEY) === 'true';
    if (!isWelded) {
      return { isAssembly: true, isWelded: false, weldingStandard: null };
    }
    const rawWeld = window.localStorage.getItem(WELDING_STANDARD_STORAGE_KEY);
    const weldingStandard: WeldingStandard =
      rawWeld === 'ISO 2553:2019' || rawWeld === 'AWS A2.4:2007'
        ? rawWeld
        : 'AWS A2.4:2007';
    return { isAssembly: true, isWelded: true, weldingStandard };
  } catch {
    // Ignore storage read errors
  }
  return { isAssembly: false, isWelded: false, weldingStandard: null };
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
  const [theme, setTheme] = useState<InterfaceTheme>(() => loadSavedTheme());
  const [selectedStandard, setSelectedStandard] = useState<AuditStandard>(() =>
    loadSavedStandard(),
  );
  const [initialAssemblyConfig] = useState(() => loadSavedAssemblyConfig());
  const [isAssembly, setIsAssembly] = useState<boolean>(initialAssemblyConfig.isAssembly);
  const [isWelded, setIsWelded] = useState<boolean>(initialAssemblyConfig.isWelded);
  const [weldingStandard, setWeldingStandard] = useState<WeldingStandard | null>(
    initialAssemblyConfig.weldingStandard,
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

  // Sync Light / Dark interface theme class on <html> and persist preference
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage write errors
    }
  }, [theme]);

  // Persist selected audit standard preference
  useEffect(() => {
    try {
      window.localStorage.setItem(AUDIT_STANDARD_STORAGE_KEY, selectedStandard);
    } catch {
      // Ignore storage write errors
    }
  }, [selectedStandard]);

  // Persist assembly / welded / welding-standard workflow state
  useEffect(() => {
    try {
      window.localStorage.setItem(ASSEMBLY_MODE_STORAGE_KEY, String(isAssembly));
      window.localStorage.setItem(WELDED_ASSEMBLY_STORAGE_KEY, String(isAssembly && isWelded));
      if (isAssembly && isWelded && weldingStandard) {
        window.localStorage.setItem(WELDING_STANDARD_STORAGE_KEY, weldingStandard);
      } else {
        window.localStorage.removeItem(WELDING_STANDARD_STORAGE_KEY);
      }
    } catch {
      // Ignore storage write errors
    }
  }, [isAssembly, isWelded, weldingStandard]);

  // Step 1 handler: setting Assembly = No automatically resets & hides Steps 2 and 3
  const handleSetIsAssembly = useCallback((value: boolean) => {
    setIsAssembly(value);
    if (!value) {
      setIsWelded(false);
      setWeldingStandard(null);
    }
  }, []);

  // Step 2 handler: setting Welded = No automatically resets & hides Step 3
  const handleSetIsWelded = useCallback(
    (value: boolean) => {
      setIsWelded(value);
      if (!value) {
        setWeldingStandard(null);
      } else {
        setWeldingStandard(
          (prev) => prev ?? (selectedStandard === 'ISO 1101:2017' ? 'ISO 2553:2019' : 'AWS A2.4:2007'),
        );
      }
    },
    [selectedStandard],
  );

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
      overrides?: {
        standard?: AuditStandard;
        isAssembly?: boolean;
        isWelded?: boolean;
        weldingStandard?: WeldingStandard | null;
      },
    ) => {
      const targetStandard = overrides?.standard ?? selectedStandard;
      const targetIsAssembly = overrides?.isAssembly ?? isAssembly;
      const targetIsWelded = targetIsAssembly && (overrides?.isWelded ?? isWelded);
      const targetWeldingStandard: WeldingStandard | null = targetIsWelded
        ? (overrides?.weldingStandard !== undefined ? overrides.weldingStandard : weldingStandard) ??
          (targetStandard === 'ISO 1101:2017' ? 'ISO 2553:2019' : 'AWS A2.4:2007')
        : null;
      const initialTotalPages =
        typeof pageCount === 'number' && Number.isFinite(pageCount) && pageCount > 0
          ? Math.floor(pageCount)
          : 1;
      auditAbortRef.current?.abort();
      const controller = new AbortController();
      auditAbortRef.current = controller;

      setAuditState({
        status: 'analyzing',
        fileName: file.name,
        standard: targetStandard,
        isAssembly: targetIsAssembly,
        isWelded: targetIsWelded,
        weldingStandard: targetWeldingStandard,
        startedAt: Date.now(),
        progress: {
          totalPages: initialTotalPages,
          processedPages: 0,
          currentPage: 1,
          percent: initialTotalPages > 1 ? 3 : 10,
          stage: 'preparing',
          statusText:
            initialTotalPages > 1
              ? `Preparing ${initialTotalPages}-sheet drawing for audit...`
              : 'Preparing drawing sheet for audit...',
        },
      });

      try {
        const report = await analyzeDrawingPdf(file, {
          pageCount: initialTotalPages,
          standard: targetStandard,
          isAssembly: targetIsAssembly,
          isWelded: targetIsWelded,
          weldingStandard: targetWeldingStandard,
          reasoningDepth: 'deep',
          signal: controller.signal,
          onProgress: (progress) => {
            if (activeDocIdRef.current !== docId || controller.signal.aborted) {
              return;
            }
            setAuditState((prev) =>
              prev.status === 'analyzing' ? { ...prev, progress } : prev,
            );
          },
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
    [selectedStandard, isAssembly, isWelded, weldingStandard],
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
    <div className="min-h-screen flex flex-col bg-blueprint-mosaic text-slate-900 dark:text-slate-100 transition-colors duration-200">
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
      <header className="h-16 shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-8 flex items-center justify-between gap-8 transition-colors duration-200">
        {/* Zone 1: Single text element wordmark */}
        <button
          type="button"
          onClick={() => setIsPreviewOpen(false)}
          className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
        >
          Drawing Audit
        </button>

        {/* Zone 2: Clean single-line text navigation links */}
        <nav
          aria-label="Primary navigation"
          className="flex items-center gap-7 text-sm font-medium text-slate-600 dark:text-slate-400"
        >
          <button
            type="button"
            onClick={() => setIsPreviewOpen(false)}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
              !isPreviewOpen
                ? 'border-slate-900 text-slate-900 dark:border-sky-400 dark:text-white'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Upload
          </button>
          <button
            type="button"
            onClick={handleNavPreview}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
              isPreviewOpen
                ? 'border-slate-900 text-slate-900 dark:border-sky-400 dark:text-white'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Review
          </button>
          <button
            type="button"
            onClick={handleNavDriveFolder}
            className="py-1 border-b-2 border-transparent hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            Drive Folder
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={triggerFilePicker}
            className="px-4 py-2 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
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
              void runDrawingAudit(selectedFile, activeDocIdRef.current, inspection?.pageCount, {
                standard: selectedStandard,
                isAssembly,
                isWelded,
                weldingStandard,
              });
            }
          }}
          onCancelAudit={handleCancelAudit}
          onBack={() => setIsPreviewOpen(false)}
          onReplaceClick={triggerFilePicker}
        />
      ) : (
        <main className="flex-1 w-full max-w-[920px] mx-auto px-8 py-10">
          <div className="flex flex-col justify-between bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-700/80 rounded-xl p-8 shadow-xl transition-colors duration-200">
              <div>
                {/* Clean Editorial Header + Light/Dark Interface Switch */}
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
                  <div className="max-w-2xl">
                    <h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50 leading-tight [text-wrap:balance]">
                      Upload and audit engineering drawings
                    </h1>
                    <p className="mt-2.5 text-[15px] leading-relaxed text-slate-600 dark:text-slate-300">
                      Upload a manufacturing drawing PDF to run an automated {selectedStandard}{' '}
                      design review, inspect prioritized P0–P3 findings alongside the drawing preview,
                      and sync files to your linked Google Drive folder.
                    </p>
                  </div>

                  {/* Light / Dark Interface Switch */}
                  <div
                    role="radiogroup"
                    aria-label="Interface theme"
                    className="relative grid grid-cols-2 w-[164px] shrink-0 p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg select-none self-start"
                  >
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-0.25rem)] rounded-md bg-slate-900 dark:bg-sky-500 shadow-xs transition-transform duration-200 ease-out ${
                        theme === 'dark' ? 'translate-x-full' : 'translate-x-0'
                      }`}
                    />
                    <button
                      type="button"
                      role="radio"
                      aria-checked={theme === 'light'}
                      onClick={() => setTheme('light')}
                      className={`relative z-10 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-md transition-colors duration-200 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 ${
                        theme === 'light'
                          ? 'text-white'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                      }`}
                    >
                      <Sun className="w-3.5 h-3.5" />
                      <span>Light</span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={theme === 'dark'}
                      onClick={() => setTheme('dark')}
                      className={`relative z-10 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-md transition-colors duration-200 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 ${
                        theme === 'dark'
                          ? 'text-slate-950'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                      }`}
                    >
                      <Moon className="w-3.5 h-3.5" />
                      <span>Dark</span>
                    </button>
                  </div>
                </div>

                {/* Google Drive Folder Destination Bar */}
                <div
                  ref={driveSectionRef}
                  className="mb-6 py-4 border-y border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  {!isDriveConnected ? (
                    <>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                            Google Drive destination
                          </span>
                          {linkedFolder?.webViewLink && (
                            <a
                              href={linkedFolder.webViewLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 dark:text-sky-400 hover:underline whitespace-nowrap"
                            >
                              <span>Open linked folder</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
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
                        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span>Google Drive</span>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">{googleUser?.email}</span>
                        </div>
                        {linkedFolder ? (
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                            <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100 min-w-0">
                              <Folder className="w-4 h-4 text-blue-700 dark:text-sky-400 shrink-0" />
                              <span className="truncate max-w-[260px]" title={linkedFolder.name}>
                                {linkedFolder.name}
                              </span>
                            </div>
                            {linkedFolder.webViewLink && (
                              <a
                                href={linkedFolder.webViewLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 dark:text-sky-400 hover:underline whitespace-nowrap"
                              >
                                <span>Open in Drive</span>
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={autoUploadToDrive}
                                onChange={(e) => setAutoUploadToDrive(e.target.checked)}
                                className="rounded border-slate-300 dark:border-slate-600 text-blue-700 focus:ring-blue-600"
                              />
                              <span>Auto-upload on select</span>
                            </label>
                          </div>
                        ) : (
                          <div className="mt-1 text-sm text-slate-700 dark:text-slate-300">
                            No destination folder linked yet.
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => setIsFolderModalOpen(true)}
                          className="px-3.5 py-2 text-xs font-medium text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 hover:border-slate-300 dark:hover:border-slate-600 rounded-lg transition-colors whitespace-nowrap shrink-0"
                        >
                          {linkedFolder ? 'Change Folder' : 'Choose Folder'}
                        </button>
                        <button
                          type="button"
                          onClick={handleGoogleLogout}
                          title="Sign out of Google Drive"
                          aria-label="Sign out of Google Drive"
                          className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors shrink-0"
                        >
                          <LogOut className="w-4 h-4" />
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {/* Audit Standard Horizontal Slider Selector */}
                <div className="mb-6 pb-5 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="min-w-0">
                    <span
                      id="audit-standard-label"
                      className="text-sm font-semibold text-slate-900 dark:text-slate-100"
                    >
                      Audit standard
                    </span>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono tabular-nums">
                      {AUDIT_STANDARDS[selectedStandard].ruleCount} rules ·{' '}
                      {AUDIT_STANDARDS[selectedStandard].rulebookFile}
                    </p>
                  </div>

                  <div
                    role="radiogroup"
                    aria-labelledby="audit-standard-label"
                    className="relative grid grid-cols-2 w-full sm:w-[340px] shrink-0 p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg select-none"
                  >
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-0.25rem)] rounded-md bg-slate-900 dark:bg-sky-500 shadow-xs transition-transform duration-200 ease-out ${
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
                              ? 'text-white dark:text-slate-950'
                              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                          }`}
                        >
                          {standard}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Cascading Assembly & Welding Audit Configuration */}
                <div className="mb-6 pb-5 border-b border-slate-200 dark:border-slate-800 space-y-4">
                  {/* Step 1 — Assembly Check (Always Visible) */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-mono font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                          Step 1
                        </span>
                        <span
                          id="assembly-drawing-label"
                          className="text-sm font-semibold text-slate-900 dark:text-slate-100"
                        >
                          Assembly Check
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        Does the uploaded drawing represent an assembly?
                      </p>
                    </div>

                    <div
                      role="radiogroup"
                      aria-labelledby="assembly-drawing-label"
                      className="relative grid grid-cols-2 w-full sm:w-[164px] shrink-0 p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg select-none"
                    >
                      <span
                        aria-hidden="true"
                        className={`pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-0.25rem)] rounded-md bg-slate-900 dark:bg-sky-500 shadow-xs transition-transform duration-200 ease-out ${
                          isAssembly ? 'translate-x-0' : 'translate-x-full'
                        }`}
                      />
                      <button
                        type="button"
                        role="radio"
                        aria-checked={isAssembly}
                        onClick={() => handleSetIsAssembly(true)}
                        className={`relative z-10 px-3 py-2 text-xs font-semibold rounded-md transition-colors duration-200 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 ${
                          isAssembly
                            ? 'text-white dark:text-slate-950'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                        }`}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={!isAssembly}
                        onClick={() => handleSetIsAssembly(false)}
                        className={`relative z-10 px-3 py-2 text-xs font-semibold rounded-md transition-colors duration-200 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 ${
                          !isAssembly
                            ? 'text-white dark:text-slate-950'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                        }`}
                      >
                        No
                      </button>
                    </div>
                  </div>

                  {/* Step 2 — Welded Assembly Check (Visible ONLY IF Assembly == Yes) */}
                  {isAssembly && (
                    <div className="pl-4 border-l-2 border-slate-200 dark:border-slate-700 space-y-4 pt-1">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-mono font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                              Step 2
                            </span>
                            <span
                              id="welded-assembly-label"
                              className="text-sm font-semibold text-slate-900 dark:text-slate-100"
                            >
                              Welded Assembly Check
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            Is the assembly welded?
                          </p>
                          {!isWelded && (
                            <p className="text-xs text-blue-700 dark:text-sky-400 mt-1 font-mono">
                              Active: {selectedStandard} + BOM vs. balloon quantity check
                            </p>
                          )}
                        </div>

                        <div
                          role="radiogroup"
                          aria-labelledby="welded-assembly-label"
                          className="relative grid grid-cols-2 w-full sm:w-[164px] shrink-0 p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg select-none"
                        >
                          <span
                            aria-hidden="true"
                            className={`pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-0.25rem)] rounded-md bg-slate-900 dark:bg-sky-500 shadow-xs transition-transform duration-200 ease-out ${
                              isWelded ? 'translate-x-0' : 'translate-x-full'
                            }`}
                          />
                          <button
                            type="button"
                            role="radio"
                            aria-checked={isWelded}
                            onClick={() => handleSetIsWelded(true)}
                            className={`relative z-10 px-3 py-2 text-xs font-semibold rounded-md transition-colors duration-200 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 ${
                              isWelded
                                ? 'text-white dark:text-slate-950'
                                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                            }`}
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={!isWelded}
                            onClick={() => handleSetIsWelded(false)}
                            className={`relative z-10 px-3 py-2 text-xs font-semibold rounded-md transition-colors duration-200 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 ${
                              !isWelded
                                ? 'text-white dark:text-slate-950'
                                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                            }`}
                          >
                            No
                          </button>
                        </div>
                      </div>

                      {/* Step 3 — Welding Standard Check (Visible ONLY IF Assembly == Yes AND Welded == Yes) */}
                      {isWelded && weldingStandard && (
                        <div className="pl-4 border-l-2 border-blue-200 dark:border-sky-800/80 pt-1">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] font-mono font-semibold uppercase tracking-wide text-blue-700 dark:text-sky-400">
                                  Step 3
                                </span>
                                <span
                                  id="welding-standard-label"
                                  className="text-sm font-semibold text-slate-900 dark:text-slate-100"
                                >
                                  Welding Standard Check
                                </span>
                              </div>
                              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                Does the drawing use AWS or ISO welding representation?
                              </p>
                              <p className="text-xs text-blue-700 dark:text-sky-400 mt-1 font-mono tabular-nums">
                                + {WELDING_STANDARDS[weldingStandard].ruleCount} rules ·{' '}
                                {WELDING_STANDARDS[weldingStandard].rulebookFile}
                              </p>
                            </div>

                            <div
                              role="radiogroup"
                              aria-labelledby="welding-standard-label"
                              className="relative grid grid-cols-2 w-full sm:w-[300px] shrink-0 p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg select-none"
                            >
                              <span
                                aria-hidden="true"
                                className={`pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-0.25rem)] rounded-md bg-slate-900 dark:bg-sky-500 shadow-xs transition-transform duration-200 ease-out ${
                                  weldingStandard === 'ISO 2553:2019'
                                    ? 'translate-x-full'
                                    : 'translate-x-0'
                                }`}
                              />
                              {WELDING_STANDARD_OPTIONS.map((std) => {
                                const isSelected = weldingStandard === std;
                                return (
                                  <button
                                    key={std}
                                    type="button"
                                    role="radio"
                                    aria-checked={isSelected}
                                    onClick={() => setWeldingStandard(std)}
                                    className={`relative z-10 px-3 py-2 text-xs font-semibold rounded-md transition-colors duration-200 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 ${
                                      isSelected
                                        ? 'text-white dark:text-slate-950'
                                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                                    }`}
                                  >
                                    {std}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Inline Error Message (Non-Hue-Only State Signaling) */}
                {errorMessage && (
                  <div
                    role="alert"
                    className="mb-6 flex items-start justify-between gap-4 px-4 py-3.5 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900/60 rounded-lg text-sm text-red-800 dark:text-red-300"
                  >
                    <div className="flex items-start gap-2.5">
                      <AlertCircle className="w-4 h-4 text-red-700 dark:text-red-400 mt-0.5 shrink-0" />
                      <span>{errorMessage}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setErrorMessage(null)}
                      aria-label="Dismiss error"
                      className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-200 p-0.5 rounded shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {/* Gentle Inline Notice */}
                {noticeMessage && !errorMessage && (
                  <div
                    role="status"
                    className="mb-6 flex items-center justify-between gap-4 px-4 py-3 bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-700 dark:text-slate-200"
                  >
                    <span>{noticeMessage}</span>
                    <button
                      type="button"
                      onClick={() => setNoticeMessage(null)}
                      aria-label="Dismiss notice"
                      className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 p-0.5 rounded shrink-0"
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
                      ? 'border-blue-600 dark:border-sky-400 bg-blue-50/50 dark:bg-sky-950/30'
                      : 'border-slate-300 dark:border-slate-700 bg-[#FAFBFD] dark:bg-slate-950/50 hover:border-slate-400 dark:hover:border-slate-500'
                  }`}
                >
                  <div
                    className={`w-12 h-12 rounded-lg flex items-center justify-center mb-5 transition-colors duration-150 ${
                      isDragging
                        ? 'bg-blue-700 dark:bg-sky-500 text-white dark:text-slate-950'
                        : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    <Upload className="w-5 h-5" />
                  </div>

                  <label
                    htmlFor="pdf-file-input"
                    className="text-base font-semibold text-slate-900 dark:text-slate-100 cursor-pointer"
                  >
                    {isDragging
                      ? 'Release to load PDF document'
                      : 'Drop a Engineering Drawing here, or choose from your computer'}
                  </label>

                  <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
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
                      className="block w-full text-sm text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-1.5 cursor-pointer
                        file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0
                        file:text-sm file:font-medium file:bg-slate-900 file:text-white
                        dark:file:bg-sky-500 dark:file:text-slate-950
                        hover:file:bg-slate-800 dark:hover:file:bg-sky-400 file:transition-colors file:cursor-pointer
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
                  <div aria-live="polite" className="mt-6 pt-6 border-t border-slate-200 dark:border-slate-800">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
                      <div className="flex items-start gap-3.5 min-w-0">
                        <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 flex items-center justify-center shrink-0 mt-0.5">
                          <FileText className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-0.5">
                            Selected PDF File
                          </div>
                          <p
                            data-testid="selected-filename"
                            className="text-base font-semibold text-slate-900 dark:text-slate-100 truncate"
                            title={selectedFile.name}
                          >
                            {selectedFile.name}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
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
                          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 dark:bg-sky-500 dark:hover:bg-sky-400 dark:text-slate-950 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
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
                            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
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
                          className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>Replace</span>
                        </button>

                        <button
                          type="button"
                          onClick={handleClearFile}
                          aria-label="Remove selected file"
                          title="Remove selected file"
                          className="p-2.5 text-slate-500 dark:text-slate-400 hover:text-red-700 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 border border-slate-200 dark:border-slate-700 rounded-lg transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Google Drive Upload Status Feedback */}
                    {uploadState.status === 'uploading' && (
                      <div className="mt-4 pt-3.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
                        <div className="w-3.5 h-3.5 border-2 border-slate-300 dark:border-slate-700 border-t-blue-700 dark:border-t-sky-400 rounded-full animate-spin shrink-0" />
                        <span>
                          Uploading{' '}
                          <span className="font-medium text-slate-900 dark:text-slate-100">
                            {uploadState.fileName}
                          </span>{' '}
                          to{' '}
                          <span className="font-medium text-slate-900 dark:text-slate-100">
                            {linkedFolder?.name}
                          </span>
                          ...
                        </span>
                      </div>
                    )}

                    {uploadState.status === 'uploaded' && (
                      <div className="mt-4 pt-3.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-4 text-xs">
                        <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          <span>
                            Saved in Google Drive folder{' '}
                            <span className="font-semibold text-slate-900 dark:text-slate-100">
                              {uploadState.folderName}
                            </span>
                          </span>
                        </div>
                        {uploadState.driveFile.webViewLink && (
                          <a
                            href={uploadState.driveFile.webViewLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-blue-700 dark:text-sky-400 hover:underline whitespace-nowrap shrink-0"
                          >
                            <span>View in Drive</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    )}

                    {uploadState.status === 'error' && (
                      <div className="mt-4 pt-3.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-4 text-xs text-red-700 dark:text-red-400">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          <span>{uploadState.message}</span>
                        </div>
                        {linkedFolder && (
                          <button
                            type="button"
                            onClick={() => void initiateDriveUpload(selectedFile, linkedFolder)}
                            className="font-medium text-red-800 dark:text-red-300 hover:underline whitespace-nowrap shrink-0"
                          >
                            Retry upload
                          </button>
                        )}
                      </div>
                    )}
                    {/* Design Review Progress Row (when returning to Upload page mid-audit) */}
                    {auditState.status === 'analyzing' && (
                      <div className="mt-4 pt-3.5 border-t border-slate-100 dark:border-slate-800 space-y-2 text-xs">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-3.5 h-3.5 border-2 border-slate-300 dark:border-slate-700 border-t-blue-700 dark:border-t-sky-400 rounded-full animate-spin shrink-0" />
                            <span className="font-medium text-slate-800 dark:text-slate-100 truncate">
                              {auditState.progress.statusText}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 font-mono tabular-nums shrink-0">
                            <span className="text-slate-500 dark:text-slate-400">
                              {auditState.progress.processedPages} / {auditState.progress.totalPages}{' '}
                              {auditState.progress.totalPages === 1 ? 'sheet' : 'sheets'}
                            </span>
                            <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
                              ·
                            </span>
                            <span className="font-semibold text-blue-700 dark:text-sky-400">
                              {auditState.progress.percent}%
                            </span>
                          </div>
                        </div>
                        <div
                          role="progressbar"
                          aria-label="Drawing analysis progress"
                          aria-valuenow={auditState.progress.percent}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                        >
                          <div
                            className="h-full rounded-full bg-blue-700 dark:bg-sky-400 transition-[width] duration-300 ease-out"
                            style={{ width: `${Math.max(2, Math.min(100, auditState.progress.percent))}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Design Review Summary Status Row (when returning to Upload page) */}
                    {auditState.status === 'complete' && (
                      <div className="mt-4 pt-3.5 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-slate-600 dark:text-slate-400 font-mono tabular-nums">
                          <span className="font-sans font-medium text-slate-900 dark:text-slate-100">
                            {auditState.report.rulebookVersion} review ready
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="text-red-700 dark:text-red-400 font-semibold">
                            P0 {auditState.report.findings.filter((f) => f.priority === 'P0').length}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="text-orange-700 dark:text-orange-400 font-semibold">
                            P1 {auditState.report.findings.filter((f) => f.priority === 'P1').length}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="text-amber-700 dark:text-amber-400 font-semibold">
                            P2 {auditState.report.findings.filter((f) => f.priority === 'P2').length}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="text-slate-600 dark:text-slate-300 font-semibold">
                            P3 {auditState.report.findings.filter((f) => f.priority === 'P3').length}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          {(() => {
                            const expectedVersion =
                              isAssembly && isWelded && weldingStandard
                                ? `${selectedStandard} + ${weldingStandard}`
                                : isAssembly
                                  ? `${selectedStandard} (Assembly)`
                                  : selectedStandard;
                            if (auditState.report.rulebookVersion === expectedVersion) {
                              return null;
                            }
                            return (
                              <button
                                type="button"
                                onClick={() => {
                                  if (selectedFile && activeDocIdRef.current) {
                                    setIsPreviewOpen(true);
                                    void runDrawingAudit(
                                      selectedFile,
                                      activeDocIdRef.current,
                                      inspection?.pageCount,
                                      {
                                        standard: selectedStandard,
                                        isAssembly,
                                        isWelded,
                                        weldingStandard,
                                      },
                                    );
                                  }
                                }}
                                className="font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white underline underline-offset-2 whitespace-nowrap"
                              >
                                Re-run with {expectedVersion}
                              </button>
                            );
                          })()}
                          <button
                            type="button"
                            onClick={() => setIsPreviewOpen(true)}
                            className="font-medium text-blue-700 dark:text-sky-400 hover:underline whitespace-nowrap"
                          >
                            View P0–P3 findings
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-6 pt-5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-4 text-sm text-slate-500 dark:text-slate-400">
                    <span>No file selected yet.</span>
                    <button
                      type="button"
                      onClick={handleLoadSample}
                      className="font-medium text-slate-700 dark:text-slate-300 hover:text-blue-700 dark:hover:text-sky-400 underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
                    >
                      Load a sample engineering drawing to test review
                    </button>
                  </div>
                )}
              </div>

              {/* Quiet Desktop Footnote Strip */}
              <div className="mt-8 pt-5 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
                <span>
                  {isDriveConnected && linkedFolder
                    ? `Connected to Google Drive · Destination: ${linkedFolder.name}`
                    : 'Local PDF preview · Optional Google Drive folder sync'}
                </span>
                <span>
                  Press <kbd className="font-mono text-slate-700 dark:text-slate-300">Esc</kbd> inside
                  preview to return here
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
