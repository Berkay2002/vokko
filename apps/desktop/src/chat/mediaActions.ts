import type { MouseEvent } from 'react';
import { onDesktopEvent } from '../desktop/tauri';
import { chatToast } from './toast';

/** The desktop shell saves downloads into the Downloads folder (src-tauri downloads.rs) and says how it went. */
let watching = false;
function watchDesktopDownloads(): void {
  if (watching) return;
  watching = true;
  void onDesktopEvent<{ success: boolean }>('desktop-download', ({ success }) => chatToast(success ? 'Saved to your Downloads folder.' : 'The download failed.'));
}

const copyLinkInstead = (url: string, why: string): void => {
  void navigator.clipboard?.writeText(url).then(() => chatToast(`${why} The link was copied instead.`), () => chatToast(why));
};

/**
 * Saves a file. The file is fetched first and saved from a blob URL: the `download` attribute is ignored for a file on another
 * origin (the API), where a plain link would navigate away instead, and the desktop shell only saves blobs the app made itself.
 * When the fetch is refused the link is copied instead (a link clicked after the await has lost the user gesture).
 */
export async function saveMedia(url: string, filename: string): Promise<void> {
  watchDesktopDownloads();
  let href: string;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    href = URL.createObjectURL(await res.blob());
  } catch {
    return copyLinkInstead(url, 'The file could not be downloaded.');
  }
  const link = document.createElement('a');
  link.download = filename;
  link.href = href;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** Click handler for a Download link: saves through `saveMedia` (a blob, so it also works for a file on another origin and in the desktop shell). */
export const saveOnClick = (url: string, filename: string) => (e: MouseEvent) => {
  e.preventDefault();
  void saveMedia(url, filename);
};

/** Re-encodes any picture the browser can decode as PNG, the one image type every clipboard accepts. */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob(png => (png ? resolve(png) : reject(new Error('no png'))), 'image/png'));
}

/** Whether this webview can put a picture on the clipboard (WebKitGTK and old WebViews cannot). */
const canCopyImages = (): boolean =>
  typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write && (ClipboardItem as unknown as { supports?(type: string): boolean }).supports?.('image/png') !== false;

/**
 * Copy Image. The ClipboardItem is built synchronously from the click (WebKit drops the user gesture across an await) with the
 * picture still loading as a promise. Where the clipboard cannot take pictures, or refuses this one, the link is copied instead.
 */
export function copyImage(url: string): void {
  if (!canCopyImages()) return copyLinkInstead(url, 'This app cannot copy pictures.');
  const png = fetch(url).then(res => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status))))).then(toPng);
  navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).catch(() => copyLinkInstead(url, 'The picture could not be copied.'));
}
