import { planUploadTree, type UploadPlan } from './logic/upload';

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

// collectDropped walks files and folders dropped from the OS. It must be
// called synchronously from the drop handler: the DataTransfer is emptied
// once the handler returns, so the entries are captured before any await.
export async function collectDropped(dt: DataTransfer): Promise<UploadPlan> {
  const roots: FileSystemEntry[] = [];
  for (const it of Array.from(dt.items)) {
    if (it.kind !== 'file') continue;
    const entry = it.webkitGetAsEntry();
    if (entry) roots.push(entry);
  }
  const items: { relPath: string; file: File }[] =
    roots.length === 0 ? Array.from(dt.files).map((file) => ({ relPath: file.name, file })) : [];
  const emptyDirs: string[] = [];

  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      items.push({ relPath: prefix + entry.name, file: await fileOf(entry as FileSystemFileEntry) });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    // readEntries returns batches (Chrome: 100); call until empty.
    for (;;) {
      const batch = await readEntries(reader);
      if (batch.length === 0) break;
      children.push(...batch);
    }
    const rel = prefix + entry.name;
    if (children.length === 0) emptyDirs.push(rel);
    for (const c of children) await walk(c, rel + '/');
  };

  for (const r of roots) await walk(r, '');
  return planUploadTree(items, emptyDirs);
}
