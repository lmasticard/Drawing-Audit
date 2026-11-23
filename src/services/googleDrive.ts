export interface DriveFolder {
  id: string;
  name: string;
  webViewLink?: string;
}

export interface DrivePdfFile {
  id: string;
  name: string;
  size?: number;
  modifiedTime?: string;
  webViewLink?: string;
}

export class DriveAuthExpiredError extends Error {
  constructor() {
    super('Your Google Drive session expired. Please sign in again to continue.');
    this.name = 'DriveAuthExpiredError';
  }
}

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function driveFetch(
  url: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    throw new DriveAuthExpiredError();
  }

  if (!response.ok) {
    let detail = `Google Drive request failed (${response.status}).`;
    try {
      const json = await response.json();
      if (json?.error?.message) {
        detail = json.error.message;
      }
    } catch {
      // Fall back to default message
    }
    throw new Error(detail);
  }

  return response;
}

/**
 * Extracts a Google Drive folder ID from either a full Drive folder URL or a raw ID.
 */
export function parseDriveFolderId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const folderPathMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderPathMatch?.[1]) return folderPathMatch[1];

  const idQueryMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idQueryMatch?.[1]) return idQueryMatch[1];

  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export async function listDriveFolders(
  accessToken: string,
  options: { parentId?: string; searchQuery?: string } = {},
): Promise<DriveFolder[]> {
  const clauses = [
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
  ];

  const search = options.searchQuery?.trim();
  if (search) {
    clauses.push(`name contains '${escapeDriveQueryValue(search)}'`);
  } else {
    const parent = options.parentId || 'root';
    clauses.push(`'${escapeDriveQueryValue(parent)}' in parents`);
  }

  const params = new URLSearchParams({
    q: clauses.join(' and '),
    fields: 'files(id,name,webViewLink)',
    orderBy: 'name_natural',
    pageSize: '50',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
  });

  const res = await driveFetch(`${DRIVE_API_BASE}/files?${params.toString()}`, accessToken);
  const data = (await res.json()) as { files?: DriveFolder[] };
  return data.files ?? [];
}

export async function getDriveFolderById(
  accessToken: string,
  folderId: string,
): Promise<DriveFolder> {
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,webViewLink,trashed',
    supportsAllDrives: 'true',
  });
  const res = await driveFetch(
    `${DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}?${params.toString()}`,
    accessToken,
  );
  const data = (await res.json()) as {
    id: string;
    name: string;
    mimeType: string;
    webViewLink?: string;
    trashed?: boolean;
  };

  if (data.trashed) {
    throw new Error('That Google Drive folder is in the trash.');
  }
  if (data.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('The provided Google Drive link does not point to a folder.');
  }

  return {
    id: data.id,
    name: data.name,
    webViewLink: data.webViewLink,
  };
}

export async function createDriveFolder(
  accessToken: string,
  folderName: string,
  parentId?: string,
): Promise<DriveFolder> {
  const trimmed = folderName.trim();
  if (!trimmed) {
    throw new Error('Please enter a folder name.');
  }

  const body: Record<string, unknown> = {
    name: trimmed,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId && parentId !== 'root') {
    body.parents = [parentId];
  }

  const params = new URLSearchParams({
    fields: 'id,name,webViewLink',
    supportsAllDrives: 'true',
  });

  const res = await driveFetch(`${DRIVE_API_BASE}/files?${params.toString()}`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return (await res.json()) as DriveFolder;
}

export async function listPdfsInFolder(
  accessToken: string,
  folderId: string,
): Promise<DrivePdfFile[]> {
  const clauses = [
    `'${escapeDriveQueryValue(folderId)}' in parents`,
    "mimeType = 'application/pdf'",
    'trashed = false',
  ];

  const params = new URLSearchParams({
    q: clauses.join(' and '),
    fields: 'files(id,name,size,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: '30',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
  });

  const res = await driveFetch(`${DRIVE_API_BASE}/files?${params.toString()}`, accessToken);
  const data = (await res.json()) as {
    files?: Array<{
      id: string;
      name: string;
      size?: string;
      modifiedTime?: string;
      webViewLink?: string;
    }>;
  };

  return (data.files ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    size: item.size ? Number(item.size) : undefined,
    modifiedTime: item.modifiedTime,
    webViewLink: item.webViewLink,
  }));
}

export async function findExistingPdfInFolder(
  accessToken: string,
  folderId: string,
  filename: string,
): Promise<DrivePdfFile | null> {
  const clauses = [
    `'${escapeDriveQueryValue(folderId)}' in parents`,
    `name = '${escapeDriveQueryValue(filename)}'`,
    "mimeType = 'application/pdf'",
    'trashed = false',
  ];

  const params = new URLSearchParams({
    q: clauses.join(' and '),
    fields: 'files(id,name,size,modifiedTime,webViewLink)',
    pageSize: '1',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
  });

  const res = await driveFetch(`${DRIVE_API_BASE}/files?${params.toString()}`, accessToken);
  const data = (await res.json()) as {
    files?: Array<{
      id: string;
      name: string;
      size?: string;
      modifiedTime?: string;
      webViewLink?: string;
    }>;
  };

  const match = data.files?.[0];
  if (!match) return null;
  return {
    id: match.id,
    name: match.name,
    size: match.size ? Number(match.size) : undefined,
    modifiedTime: match.modifiedTime,
    webViewLink: match.webViewLink,
  };
}

export async function uploadPdfToFolder(
  accessToken: string,
  file: File,
  folderId: string,
  overwriteFileId?: string,
): Promise<DrivePdfFile> {
  const boundary = `folio_pdf_boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const metadata = overwriteFileId
    ? { name: file.name, mimeType: 'application/pdf' }
    : { name: file.name, mimeType: 'application/pdf', parents: [folderId] };

  const multipartBody = new Blob(
    [
      `--${boundary}\r\n`,
      'Content-Type: application/json; charset=UTF-8\r\n\r\n',
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\n`,
      'Content-Type: application/pdf\r\n\r\n',
      file,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  );

  const params = new URLSearchParams({
    uploadType: 'multipart',
    fields: 'id,name,size,modifiedTime,webViewLink',
    supportsAllDrives: 'true',
  });

  const url = overwriteFileId
    ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(overwriteFileId)}?${params.toString()}`
    : `${DRIVE_UPLOAD_BASE}/files?${params.toString()}`;

  const res = await driveFetch(url, accessToken, {
    method: overwriteFileId ? 'PATCH' : 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  const uploaded = (await res.json()) as {
    id: string;
    name: string;
    size?: string;
    modifiedTime?: string;
    webViewLink?: string;
  };

  return {
    id: uploaded.id,
    name: uploaded.name,
    size: uploaded.size ? Number(uploaded.size) : file.size,
    modifiedTime: uploaded.modifiedTime,
    webViewLink: uploaded.webViewLink,
  };
}

export async function downloadDrivePdfAsFile(
  accessToken: string,
  driveFile: DrivePdfFile,
): Promise<File> {
  const params = new URLSearchParams({
    alt: 'media',
    supportsAllDrives: 'true',
  });
  const res = await driveFetch(
    `${DRIVE_API_BASE}/files/${encodeURIComponent(driveFile.id)}?${params.toString()}`,
    accessToken,
  );
  const blob = await res.blob();
  const modifiedMs = driveFile.modifiedTime ? Date.parse(driveFile.modifiedTime) : Date.now();
  return new File([blob], driveFile.name, {
    type: 'application/pdf',
    lastModified: Number.isNaN(modifiedMs) ? Date.now() : modifiedMs,
  });
}

export async function deleteDriveFile(accessToken: string, fileId: string): Promise<void> {
  const params = new URLSearchParams({ supportsAllDrives: 'true' });
  await driveFetch(
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
    accessToken,
    {
      method: 'DELETE',
    },
  );
}
