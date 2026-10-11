import { getAlbumInfo, getAuthStatus } from '@immich/sdk';
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
  } catch {
    album = undefined;
  }

  if (album) {
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
  }

  // A locked album is denied entirely to a non-elevated session by the server (it is not listed
  // and its details are refused), so "locked" cannot be told apart from "not found" here. If the
  // user has a PIN, send them to unlock the session and come back; the prompt's Cancel returns to
  // the albums list.
  const { isElevated, pinCode } = await getAuthStatus();
  if (pinCode && !isElevated) {
    redirect(307, Route.pinPrompt({ continue: url.pathname + url.search }));
  }

  // Surface a clean "not found" via SvelteKit's own error helper instead of re-throwing the raw
  // API client error. 404 rather than 403 to match the server's own deliberate choice not to
  // reveal whether a locked resource exists at all.
  kitError(404, 'Not found');
}) satisfies PageLoad;
