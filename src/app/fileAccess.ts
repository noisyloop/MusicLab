/**
 * Saving and opening files on the user's machine: File System Access API
 * where available (Chromium), download / <input type=file> elsewhere.
 */

// The File System Access picker functions are not yet in TypeScript's DOM lib.
interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: PickerType[];
}
interface OpenFilePickerOptions {
  types?: PickerType[];
  multiple?: boolean;
}
interface FilePickerWindow {
  showSaveFilePicker?: (o: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (o: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
}

const pickerWindow = window as unknown as FilePickerWindow; // feature-detected below

export const hasFileSystemAccess = typeof pickerWindow.showSaveFilePicker === 'function';

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

export interface SaveTarget {
  handle: FileSystemFileHandle | null;
  name: string;
}

/**
 * Write bytes to a file. With an existing handle, writes in place. Otherwise
 * asks for a location (or downloads). Returns null if the user cancelled.
 */
export async function saveBytes(
  bytes: Uint8Array,
  opts: { suggestedName: string; mime: string; extension: string; description: string; handle?: FileSystemFileHandle | null },
): Promise<SaveTarget | null> {
  if (hasFileSystemAccess) {
    let handle = opts.handle ?? null;
    if (!handle) {
      try {
        handle = await pickerWindow.showSaveFilePicker!({
          suggestedName: opts.suggestedName,
          types: [{ description: opts.description, accept: { [opts.mime]: [opts.extension] } }],
        });
      } catch (e) {
        if (isAbortError(e)) return null;
        throw e;
      }
    }
    const w = await handle.createWritable();
    await w.write(bytes as Uint8Array<ArrayBuffer>);
    await w.close();
    return { handle, name: handle.name };
  }
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: opts.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { handle: null, name: opts.suggestedName };
}

export interface OpenedFile {
  file: File;
  handle: FileSystemFileHandle | null;
}

/** Ask the user for a file. Returns null if cancelled. */
export async function openFile(opts: { extension: string; mime: string; description: string }): Promise<OpenedFile | null> {
  if (typeof pickerWindow.showOpenFilePicker === 'function') {
    try {
      const [handle] = await pickerWindow.showOpenFilePicker({
        types: [{ description: opts.description, accept: { [opts.mime]: [opts.extension] } }],
      });
      if (!handle) return null;
      return { file: await handle.getFile(), handle };
    } catch (e) {
      if (isAbortError(e)) return null;
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = opts.extension;
    input.onchange = () => resolve(input.files?.[0] ? { file: input.files[0], handle: null } : null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
