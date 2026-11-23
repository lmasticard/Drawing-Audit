import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronRight,
  Folder,
  FolderPlus,
  Link2,
  Search,
  X,
} from 'lucide-react';
import {
  createDriveFolder,
  DriveAuthExpiredError,
  getDriveFolderById,
  listDriveFolders,
  parseDriveFolderId,
  type DriveFolder,
} from '../services/googleDrive';

interface DriveFolderModalProps {
  open: boolean;
  accessToken: string | null;
  currentFolder: DriveFolder | null;
  onSelectFolder: (folder: DriveFolder) => void;
  onAuthExpired: () => void;
  onClose: () => void;
}

interface BreadcrumbItem {
  id: string;
  name: string;
}

export const DriveFolderModal: React.FC<DriveFolderModalProps> = ({
  open,
  accessToken,
  currentFolder,
  onSelectFolder,
  onAuthExpired,
  onClose,
}) => {
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
    { id: 'root', name: 'My Drive' },
  ]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<DriveFolder | null>(currentFolder);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showNewFolderForm, setShowNewFolderForm] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  const [linkInput, setLinkInput] = useState('');
  const [resolvingLink, setResolvingLink] = useState(false);

  const activeParent = breadcrumbs[breadcrumbs.length - 1];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(searchQuery.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    if (!open) return;
    setSelectedCandidate(currentFolder);
    setError(null);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, currentFolder, onClose]);

  const loadFolders = useCallback(async () => {
    if (!open || !accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const results = await listDriveFolders(accessToken, {
        parentId: activeParent.id,
        searchQuery: debouncedQuery || undefined,
      });
      setFolders(results);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        onAuthExpired();
        onClose();
        return;
      }
      setError(err instanceof Error ? err.message : 'Unable to list Google Drive folders.');
    } finally {
      setLoading(false);
    }
  }, [open, accessToken, activeParent.id, debouncedQuery, onAuthExpired, onClose]);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  if (!open) return null;

  const handleOpenSubfolder = (folder: DriveFolder) => {
    setSearchQuery('');
    setDebouncedQuery('');
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setSelectedCandidate(folder);
  };

  const handleBreadcrumbClick = (index: number) => {
    setSearchQuery('');
    setDebouncedQuery('');
    const nextTrail = breadcrumbs.slice(0, index + 1);
    setBreadcrumbs(nextTrail);
    const target = nextTrail[nextTrail.length - 1];
    if (target.id === 'root') {
      setSelectedCandidate(currentFolder);
    } else {
      setSelectedCandidate({ id: target.id, name: target.name });
    }
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessToken || !newFolderName.trim()) return;
    setCreatingFolder(true);
    setError(null);
    try {
      const created = await createDriveFolder(accessToken, newFolderName, activeParent.id);
      setNewFolderName('');
      setShowNewFolderForm(false);
      setSelectedCandidate(created);
      await loadFolders();
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        onAuthExpired();
        onClose();
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not create folder.');
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleLinkByUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessToken || !linkInput.trim()) return;
    const folderId = parseDriveFolderId(linkInput);
    if (!folderId) {
      setError('Paste a valid Google Drive folder URL or folder ID.');
      return;
    }
    setResolvingLink(true);
    setError(null);
    try {
      const folder = await getDriveFolderById(accessToken, folderId);
      setLinkInput('');
      onSelectFolder(folder);
      onClose();
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        onAuthExpired();
        onClose();
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not access that Google Drive folder.');
    } finally {
      setResolvingLink(false);
    }
  };

  const handleConfirmSelection = () => {
    if (selectedCandidate) {
      onSelectFolder(selectedCandidate);
      onClose();
    } else if (activeParent.id !== 'root') {
      onSelectFolder({ id: activeParent.id, name: activeParent.name });
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 dark:bg-slate-950/70 flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drive-folder-modal-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg overflow-hidden flex flex-col max-h-[82vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div>
            <h2
              id="drive-folder-modal-title"
              className="text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              Choose Google Drive Folder
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Select an existing folder, create a new one, or paste a Google Drive folder link.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close folder chooser"
            className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search & New Folder Controls */}
        <div className="px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/50 space-y-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search your Google Drive folders..."
                className="w-full h-9 pl-9 pr-3 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
              />
            </div>

            <button
              type="button"
              onClick={() => setShowNewFolderForm((prev) => !prev)}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>New Folder</span>
            </button>
          </div>

          {showNewFolderForm && (
            <form onSubmit={handleCreateFolder} className="flex items-center gap-2">
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder={`New folder inside ${activeParent.name}...`}
                autoFocus
                className="flex-1 h-9 px-3 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <button
                type="submit"
                disabled={creatingFolder || !newFolderName.trim()}
                className="h-9 px-3.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 dark:bg-sky-500 dark:hover:bg-sky-400 dark:text-slate-950 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50"
              >
                {creatingFolder ? 'Creating...' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowNewFolderForm(false);
                  setNewFolderName('');
                }}
                className="h-9 px-3 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                Cancel
              </button>
            </form>
          )}

          {/* Breadcrumb Bar */}
          {!debouncedQuery && (
            <nav aria-label="Folder path" className="flex items-center flex-wrap gap-1 text-xs">
              {breadcrumbs.map((crumb, idx) => (
                <React.Fragment key={crumb.id}>
                  {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                  <button
                    type="button"
                    onClick={() => handleBreadcrumbClick(idx)}
                    className={`px-1.5 py-0.5 rounded transition-colors ${
                      idx === breadcrumbs.length - 1
                        ? 'font-semibold text-slate-900 dark:text-slate-100'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-700/60'
                    }`}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
            </nav>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-6 mt-3 px-3.5 py-2.5 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900/60 rounded-lg flex items-center gap-2 text-xs text-red-800 dark:text-red-300 shrink-0">
            <AlertCircle className="w-4 h-4 text-red-700 dark:text-red-400 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Folder List */}
        <div className="flex-1 overflow-y-auto px-6 py-3 min-h-[240px]">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2.5 text-xs text-slate-500 dark:text-slate-400">
              <div className="w-5 h-5 border-2 border-slate-300 dark:border-slate-700 border-t-slate-700 dark:border-t-sky-400 rounded-full animate-spin" />
              <span>Loading folders from Google Drive...</span>
            </div>
          ) : folders.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
              {debouncedQuery
                ? `No folders matching "${debouncedQuery}".`
                : 'No subfolders in this location. You can create a new folder above or select the current folder.'}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {folders.map((folder) => {
                const isSelected = selectedCandidate?.id === folder.id;
                return (
                  <li
                    key={folder.id}
                    className={`flex items-center justify-between gap-3 py-2 px-2.5 -mx-2.5 rounded-lg transition-colors ${
                      isSelected
                        ? 'bg-blue-50/80 dark:bg-sky-950/50'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedCandidate(folder)}
                      onDoubleClick={() => handleOpenSubfolder(folder)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left py-1"
                    >
                      <Folder
                        className={`w-4 h-4 shrink-0 ${
                          isSelected
                            ? 'text-blue-700 dark:text-sky-400'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      />
                      <span
                        className={`text-sm truncate ${
                          isSelected
                            ? 'font-semibold text-blue-900 dark:text-sky-200'
                            : 'text-slate-800 dark:text-slate-200'
                        }`}
                      >
                        {folder.name}
                      </span>
                      {isSelected && (
                        <Check className="w-4 h-4 text-blue-700 dark:text-sky-400 shrink-0 ml-auto" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleOpenSubfolder(folder)}
                      className="px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      Open
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Direct Folder URL / ID Linker */}
        <form
          onSubmit={handleLinkByUrl}
          className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/50 flex items-center gap-2 shrink-0"
        >
          <Link2 className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            type="text"
            value={linkInput}
            onChange={(e) => setLinkInput(e.target.value)}
            placeholder="Or paste a Google Drive folder URL or ID..."
            className="flex-1 h-8 px-2.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
          <button
            type="submit"
            disabled={resolvingLink || !linkInput.trim()}
            className="h-8 px-3 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            {resolvingLink ? 'Linking...' : 'Link URL'}
          </button>
        </form>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-4 shrink-0">
          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
            {selectedCandidate ? (
              <>
                Selected:{' '}
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {selectedCandidate.name}
                </span>
              </>
            ) : activeParent.id !== 'root' ? (
              <>
                Current folder:{' '}
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {activeParent.name}
                </span>
              </>
            ) : (
              'Click a folder above to select it as your upload destination.'
            )}
          </div>
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!selectedCandidate && activeParent.id === 'root'}
              onClick={handleConfirmSelection}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 dark:bg-sky-500 dark:hover:bg-sky-400 dark:text-slate-950 rounded-lg transition-colors whitespace-nowrap disabled:opacity-45"
            >
              Link Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
