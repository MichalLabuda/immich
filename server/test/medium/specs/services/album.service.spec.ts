import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AssetVisibility, JobName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(AlbumService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AlbumRepository, AssetRepository, UserRepository],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  return { sut, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumService.name, () => {
  describe('removeAssets', () => {
    it('should not remove assets from an album of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);

      await expect(sut.removeAssets(factory.auth({ user: otherUser }), album.id, { ids: [asset.id] })).rejects.toThrow(
        'Not found or no albumAsset.delete access',
      );
      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toContain(asset.id);
    });
  });

  describe('database triggers', () => {
    it('should cascade delete an album when the owner is deleted', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      await ctx.get(UserRepository).delete({ id: user.id }, true);

      await expect(ctx.database.selectFrom('album').selectAll().where('id', '=', album.id).execute()).resolves.toEqual(
        [],
      );
      await expect(
        ctx.database.selectFrom('album_user').selectAll().where('albumId', '=', album.id).execute(),
      ).resolves.toEqual([]);
    });
  });

  describe('create', () => {
    it('should create a locked album with locked assets for an elevated session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

      const album = await sut.create(auth, { albumName: 'Secret', isLocked: true, assetIds: [asset1.id, asset2.id] });

      expect(album).toEqual(expect.objectContaining({ albumName: 'Secret', isLocked: true }));
      await expect(ctx.get(AlbumRepository).getAllAssetIds(album.id)).resolves.toEqual(
        expect.arrayContaining([asset1.id, asset2.id]),
      );
      await expect(sut.get(auth, album.id)).resolves.toEqual(expect.objectContaining({ assetCount: 2 }));
    });

    it('should reject a locked album with assets that are not locked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: lockedAsset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: timelineAsset } = await ctx.newAsset({ ownerId: user.id });
      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

      await expect(
        sut.create(auth, { albumName: 'Secret', isLocked: true, assetIds: [lockedAsset.id, timelineAsset.id] }),
      ).rejects.toThrow(new BadRequestException('A locked album can only contain assets that are already locked'));

      await expect(ctx.get(AlbumRepository).getAll(user.id, { withLocked: true })).resolves.toEqual([]);
    });

    it('should reject a locked album with assets of another user instead of dropping them', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset: ownAsset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: otherAsset } = await ctx.newAsset({ ownerId: otherUser.id, visibility: AssetVisibility.Locked });
      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

      await expect(
        sut.create(auth, { albumName: 'Secret', isLocked: true, assetIds: [ownAsset.id, otherAsset.id] }),
      ).rejects.toThrow('Not found or no asset.update access');

      await expect(ctx.get(AlbumRepository).getAll(user.id, { withLocked: true })).resolves.toEqual([]);
    });

    it('should reject a locked album for a non-elevated session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: false } });

      await expect(sut.create(auth, { albumName: 'Secret', isLocked: true, assetIds: [asset.id] })).rejects.toThrow(
        UnauthorizedException,
      );

      await expect(ctx.get(AlbumRepository).getAll(user.id, { withLocked: true })).resolves.toEqual([]);
    });
  });

  describe('lock', () => {
    it('should move the assets into a new locked album and remove the source album', async () => {
      const { sut, ctx } = setup();
      const albumRepo = ctx.get(AlbumRepository);
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum(
        { ownerId: user.id, albumName: 'Holiday', description: 'Summer', albumThumbnailAssetId: asset2.id },
        [asset1.id, asset2.id],
      );
      const auth = factory.auth({ user: { id: user.id } });

      const [result] = await sut.lock(auth, { ids: [album.id] });

      expect(result).toEqual({
        id: album.id,
        success: true,
        albumId: expect.any(String),
        assetCount: 2,
        skippedAssetCount: 0,
        removed: true,
      });

      const newAlbum = await albumRepo.getById(result.albumId!, { withAssets: false });
      expect(newAlbum).toEqual(
        expect.objectContaining({
          albumName: 'Holiday',
          description: 'Summer',
          albumThumbnailAssetId: asset2.id,
          isLocked: true,
        }),
      );
      expect(newAlbum!.albumUsers.map(({ user }) => user.id)).toEqual([user.id]);
      await expect(albumRepo.getAllAssetIds(result.albumId!)).resolves.toEqual(
        expect.arrayContaining([asset1.id, asset2.id]),
      );
      await expect(albumRepo.getById(album.id, { withAssets: false })).resolves.toBeUndefined();
      await expect(ctx.get(AssetRepository).getLockedAssetIds([asset1.id, asset2.id])).resolves.toEqual(
        new Set([asset1.id, asset2.id]),
      );
      expect(ctx.getMock(JobRepository).queueAll).toHaveBeenCalledWith(
        expect.arrayContaining([
          { name: JobName.SidecarWrite, data: { id: asset1.id } },
          { name: JobName.SidecarWrite, data: { id: asset2.id } },
        ]),
      );
    });

    it('should keep the source album when it holds assets of other users', async () => {
      const { sut, ctx } = setup();
      const albumRepo = ctx.get(AlbumRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user1.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user2.id });
      const { album } = await ctx.newAlbum({ ownerId: user1.id, albumThumbnailAssetId: asset2.id }, [
        asset1.id,
        asset2.id,
      ]);
      const auth = factory.auth({ user: { id: user1.id } });

      const [result] = await sut.lock(auth, { ids: [album.id] });

      expect(result).toEqual(
        expect.objectContaining({ id: album.id, success: true, assetCount: 1, skippedAssetCount: 1, removed: false }),
      );
      await expect(albumRepo.getAllAssetIds(album.id)).resolves.toEqual([asset2.id]);
      await expect(albumRepo.getAllAssetIds(result.albumId!)).resolves.toEqual([asset1.id]);
      expect(await albumRepo.getById(result.albumId!, { withAssets: false })).toEqual(
        expect.objectContaining({ albumThumbnailAssetId: asset1.id, isLocked: true }),
      );
      await expect(ctx.get(AssetRepository).getLockedAssetIds([asset1.id, asset2.id])).resolves.toEqual(
        new Set([asset1.id]),
      );
    });

    it('should put an asset in every new album it was selected for and drop its other memberships', async () => {
      const { sut, ctx } = setup();
      const albumRepo = ctx.get(AlbumRepository);
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album: album1 } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
      const { album: album2 } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
      const { album: album3 } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
      const auth = factory.auth({ user: { id: user.id } });

      const [result1, result2] = await sut.lock(auth, { ids: [album1.id, album2.id] });

      expect(result1).toEqual(expect.objectContaining({ id: album1.id, success: true, removed: true }));
      expect(result2).toEqual(expect.objectContaining({ id: album2.id, success: true, removed: true }));
      await expect(albumRepo.getAllAssetIds(result1.albumId!)).resolves.toEqual([asset.id]);
      await expect(albumRepo.getAllAssetIds(result2.albumId!)).resolves.toEqual([asset.id]);
      await expect(albumRepo.getAllAssetIds(album3.id)).resolves.toEqual([]);
      expect(await albumRepo.getById(album3.id, { withAssets: false })).toEqual(
        expect.objectContaining({ id: album3.id, isLocked: false }),
      );
    });

    it('should not lock albums of other users', async () => {
      const { sut, ctx } = setup();
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user2.id });
      const auth = factory.auth({ user: { id: user1.id } });

      await expect(sut.lock(auth, { ids: [album.id] })).resolves.toEqual([
        expect.objectContaining({ id: album.id, success: false, error: BulkIdErrorReason.NO_PERMISSION }),
      ]);

      expect(await ctx.get(AlbumRepository).getById(album.id, { withAssets: false })).toEqual(
        expect.objectContaining({ id: album.id, isLocked: false }),
      );
    });

    it('should record the removed memberships and albums for sync', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album: album1 } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
      const { album: album2 } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
      const auth = factory.auth({ user: { id: user.id } });

      await sut.lock(auth, { ids: [album1.id] });

      // The removed album takes its own membership audit rows with it; clients drop those
      // memberships through the album delete instead.
      const albumAssetAudits = await ctx.database
        .selectFrom('album_asset_audit')
        .select(['albumId', 'assetId'])
        .where('assetId', '=', asset.id)
        .execute();
      expect(albumAssetAudits).toEqual([{ albumId: album2.id, assetId: asset.id }]);

      const albumAudits = await ctx.database
        .selectFrom('album_audit')
        .select(['albumId', 'userId'])
        .where('userId', '=', user.id)
        .execute();
      expect(albumAudits).toEqual([{ albumId: album1.id, userId: user.id }]);
    });
  });

  describe('unlock', () => {
    it('should require an elevated session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id, isLocked: true });
      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: false } });

      await expect(sut.unlock(auth, { ids: [album.id] })).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('should move the assets into a new unlocked album and out of other locked albums', async () => {
      const { sut, ctx } = setup();
      const albumRepo = ctx.get(AlbumRepository);
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { album: lockedAlbum1 } = await ctx.newAlbum({ ownerId: user.id, isLocked: true }, [asset.id]);
      const { album: lockedAlbum2 } = await ctx.newAlbum({ ownerId: user.id, isLocked: true }, [asset.id]);
      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

      const [result] = await sut.unlock(auth, { ids: [lockedAlbum1.id] });

      expect(result).toEqual(
        expect.objectContaining({
          id: lockedAlbum1.id,
          success: true,
          assetCount: 1,
          skippedAssetCount: 0,
          removed: true,
        }),
      );
      expect(await albumRepo.getById(result.albumId!, { withAssets: false })).toEqual(
        expect.objectContaining({ albumName: lockedAlbum1.albumName, isLocked: false }),
      );
      await expect(albumRepo.getAllAssetIds(result.albumId!)).resolves.toEqual([asset.id]);
      await expect(albumRepo.getById(lockedAlbum1.id, { withAssets: false })).resolves.toBeUndefined();
      await expect(albumRepo.getAllAssetIds(lockedAlbum2.id)).resolves.toEqual([]);
      await expect(ctx.get(AssetRepository).getLockedAssetIds([asset.id])).resolves.toEqual(new Set());
    });
  });
});
