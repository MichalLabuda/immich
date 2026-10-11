import { getAlbumInfo, isHttpError } from '@immich/sdk';
import { error as kitError, redirect } from '@sveltejs/kit';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

export const load = (async ({ params, url, depends }) => {
  await authenticate(url);

  depends('album:data');

  let album;
  try {
    album = await getAlbumInfo({ id: params.albumId });
  } catch (error) {
    // The server answers 401 for a locked album of the requester when the session is not
    // elevated (it reveals nothing else about the album), and "not found" for anything else.
    // Treat the 401 like the locked folder route: send the user to the PIN prompt, which offers
    // PIN creation when there is none yet (locking an album needs no PIN, just like locking a
    // photo, so this is how a user without a PIN reaches the album afterwards), and comes back
    // here. The prompt's Cancel returns to the albums list.
    if (isHttpError(error) && error.status === 401) {
      redirect(307, Route.pinPrompt({ continue: url.pathname + url.search }));
    }

    // Surface a clean "not found" via SvelteKit's own error helper instead of re-throwing the raw
    // API client error. 404 rather than 403 to match the server's own deliberate choice not to
    // reveal whether an album of another user exists at all.
    kitError(404, 'Not found');
  }

  if (album.isLocked) {
    // The server only hands out a locked album to an elevated session. Re-check the client-side
    // elevation state against the server here, before anything is rendered, so a stale state
    // (e.g. the page was opened again after the elevation expired, or the session was locked
    // from another tab) never shows the album; the page itself re-checks while it is open.
    await authManager.refreshElevation();
    if (!authManager.isElevated) {
      redirect(307, Route.pinPrompt({ continue: url.pathname + url.search }));
    }
  }

  return {
    album,
    meta: {
      title: album.albumName,
    },
  };
}) satisfies PageLoad;
