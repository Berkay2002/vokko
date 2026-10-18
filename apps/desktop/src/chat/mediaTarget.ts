/** What a right click landed on inside a message: a picture, a video, an audio file or a web link. */
export interface MediaTarget {
  kind: 'image' | 'video' | 'audio' | 'link';
  /** Absolute URL of the file or link. */
  url: string;
  /** The clicked link, so "Open Link" goes through the same handlers as a click (in-app routing, the browser hand-off). */
  anchor?: HTMLAnchorElement;
}

const isWeb = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * The media under `el`, or null when it is plain message text (or a link that is not a web link). A picture still behind its
 * SPOILER cover is not media yet: the menu must not hand out what the cover hides.
 */
export function mediaTargetFrom(el: Element | null): MediaTarget | null {
  const image = el?.closest<HTMLElement>('.chat-image');
  if (image) return image.classList.contains('spoiler') || !image.dataset.src ? null : { kind: 'image', url: image.dataset.src };
  const video = el?.closest<HTMLVideoElement>('video.chat-video');
  if (video?.src) return { kind: 'video', url: video.src };
  const audio = el?.closest<HTMLAudioElement>('audio.chat-audio');
  if (audio?.src) return { kind: 'audio', url: audio.src };
  const anchor = el?.closest<HTMLAnchorElement>('a[href]');
  return anchor && isWeb(anchor.href) ? { kind: 'link', url: anchor.href, anchor } : null;
}

/** The file name for a saved URL: the attachment's own name when it is known, else the last path segment. */
export function fileNameFromUrl(url: string, known?: string): string {
  if (known) return known;
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'download';
  } catch {
    return 'download';
  }
}
