import { useRef, useState } from 'react';
import { errorText } from './use-remote';

type DirectoryHandle = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle> };
export type LocalEntry = { name: string; type: 'd' | '-'; size?: number; modifyTime?: number; file?: File;
  handle?: FileSystemFileHandle; folder?: LocalFolder };
type LocalFolder = { name: string; entries: Map<string, LocalEntry>; handle?: DirectoryHandle };
type FilePickers = Window & {
  showDirectoryPicker?: () => Promise<DirectoryHandle>;
  showSaveFilePicker?: (options: { suggestedName: string; startIn?: FileSystemDirectoryHandle }) => Promise<FileSystemFileHandle>;
};

async function readFolder(handle: DirectoryHandle): Promise<LocalFolder> {
  const entries = new Map<string, LocalEntry>();
  for await (const item of handle.values()) {
    if (item.kind === 'directory') entries.set(item.name, { name: item.name, type: 'd', folder: { name: item.name, handle: item as DirectoryHandle, entries: new Map() } });
    else {
      const file = await (item as FileSystemFileHandle).getFile().catch(() => undefined);
      entries.set(item.name, { name: item.name, type: '-', handle: item as FileSystemFileHandle, size: file?.size, modifyTime: file?.lastModified });
    }
  }
  return { name: handle.name, entries, handle };
}

export function useSftpLocal() {
  const [folders, setFolders] = useState<LocalFolder[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const folder = folders.at(-1);

  async function run(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); }
    catch (failure) { if (!(failure instanceof DOMException && failure.name === 'AbortError')) setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  function importFolder(files: FileList | null) {
    const first = files?.[0];
    if (!first) return;
    const root: LocalFolder = { name: first.webkitRelativePath.split('/')[0], entries: new Map() };
    for (const file of Array.from(files)) {
      let parent = root;
      for (const name of file.webkitRelativePath.split('/').slice(1, -1)) {
        let child = parent.entries.get(name)?.folder;
        if (!child) { child = { name, entries: new Map() }; parent.entries.set(name, { name, type: 'd', folder: child }); }
        parent = child;
      }
      parent.entries.set(file.name, { name: file.name, type: '-', file, size: file.size, modifyTime: file.lastModified });
    }
    setError(''); setFolders([root]);
  }

  async function chooseFolder() {
    const pickers = window as FilePickers;
    if (!pickers.showDirectoryPicker) { folderInput.current?.click(); return; }
    await run(async () => {
      try { setFolders([await readFolder(await pickers.showDirectoryPicker!())]); }
      catch (failure) {
        if (failure instanceof DOMException && (failure.name === 'SecurityError' || failure.name === 'NotSupportedError')) {
          folderInput.current?.click(); return;
        }
        throw failure;
      }
    });
  }

  async function openFolder(child: LocalFolder) {
    await run(async () => { const next = child.handle ? await readFolder(child.handle) : child; setFolders([...folders, next]); });
  }

  async function refresh() {
    if (!folder?.handle) return;
    await run(async () => { const next = await readFolder(folder.handle!); setFolders([...folders.slice(0, -1), next]); });
  }

  function savePicker(name: string) {
    const pickers = window as FilePickers;
    return pickers.showSaveFilePicker?.({ suggestedName: name, ...(folder?.handle && { startIn: folder.handle }) });
  }

  return { folder, folders, folderInput, error, busy, importFolder, chooseFolder, openFolder, refresh, savePicker,
    up: () => setFolders(folders.slice(0, -1)) };
}
