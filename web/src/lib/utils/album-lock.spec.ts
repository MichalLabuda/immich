import { describe, expect, it } from 'vitest';
import { canViewAlbum, getPinPromptCancelRoute } from '$lib/utils/album-lock';

describe('album lock guards', () => {
  describe('canViewAlbum', () => {
    it('always allows an unlocked album', () => {
      expect(canViewAlbum({ isLocked: false }, false)).toBe(true);
      expect(canViewAlbum({ isLocked: false }, true)).toBe(true);
    });

    it('only allows a locked album for an elevated session', () => {
      expect(canViewAlbum({ isLocked: true }, false)).toBe(false);
      expect(canViewAlbum({ isLocked: true }, true)).toBe(true);
    });
  });

  describe('getPinPromptCancelRoute', () => {
    it('returns to the albums list from an album page', () => {
      expect(getPinPromptCancelRoute('/albums/6bd3a8cc-9a3f-4c3b-8b24-7c7a6b1e4a1d')).toBe('/albums');
      expect(getPinPromptCancelRoute('/albums/6bd3a8cc-9a3f-4c3b-8b24-7c7a6b1e4a1d/photos/abc?at=1')).toBe('/albums');
      expect(getPinPromptCancelRoute(new URL('http://localhost/albums/6bd3a8cc?foo=bar'))).toBe('/albums');
      expect(getPinPromptCancelRoute('/albums')).toBe('/albums');
    });

    it('never returns to the page that required the PIN', () => {
      expect(getPinPromptCancelRoute('/albums/6bd3a8cc-9a3f-4c3b-8b24-7c7a6b1e4a1d')).not.toContain('6bd3a8cc');
      expect(getPinPromptCancelRoute('/locked')).toBe('/photos');
      expect(getPinPromptCancelRoute(new URL('http://localhost/locked/photos/abc'))).toBe('/photos');
    });

    it('falls back to the photos page', () => {
      expect(getPinPromptCancelRoute(undefined)).toBe('/photos');
      expect(getPinPromptCancelRoute(null)).toBe('/photos');
      expect(getPinPromptCancelRoute('')).toBe('/photos');
      expect(getPinPromptCancelRoute('/albumsx')).toBe('/photos');
      expect(getPinPromptCancelRoute('/sharing')).toBe('/photos');
    });
  });
});
