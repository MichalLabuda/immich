import { Route } from '$lib/route';

/**
 * Whether an album's content may be rendered. A locked album is only ever shown to a session that
 * has been elevated with the PIN; the server enforces the same rule, this guard keeps the client
 * from painting anything (title, counts, thumbnails) from stale data before or after that.
 */
export const canViewAlbum = (album: { isLocked: boolean }, isElevated: boolean) => !album.isLocked || isElevated;

const getPathname = (url: string | URL | null | undefined): string => {
  if (!url) {
    return '';
  }

  if (typeof url === 'string') {
    return url.split(/[?#]/, 1)[0];
  }

  return url.pathname;
};

/**
 * Where cancelling the PIN prompt should land. The prompt is reached from a page that needs
 * elevation; the album pages are the only ones with a sensible, non-elevated parent (the albums
 * list), everything else (the locked folder) falls back to the photos page. Never the page that
 * sent the user to the prompt: that page cannot be shown without the PIN.
 */
export const getPinPromptCancelRoute = (continueUrl: string | URL | null | undefined): string => {
  const pathname = getPathname(continueUrl);
  const albums = Route.albums();
  if (pathname === albums || pathname.startsWith(`${albums}/`)) {
    return albums;
  }

  return Route.photos();
};
