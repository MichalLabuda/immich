import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AddUsersDto,
  AlbumLockResponseDto,
  AlbumResponseDto,
  AlbumStatisticsResponseDto,
  AlbumsAddAssetsDto,
  AlbumsAddAssetsResponseDto,
  CreateAlbumDto,
  GetAlbumsDto,
  UpdateAlbumDto,
  UpdateAlbumUserDto,
  mapAlbum,
} from 'src/dtos/album.dto.js';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { MapMarkerResponseDto } from 'src/dtos/map.dto.js';
import { AlbumUserRole, AssetVisibility, JobName, Permission } from 'src/enum.js';
import { AlbumAssetCount, AlbumConversion, AlbumInfoOptions } from 'src/repositories/album.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { requireElevatedPermission } from 'src/utils/access.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';
import { asDateTimeString } from 'src/utils/date.js';
import { findOrFail } from 'src/utils/misc.js';
import { getPreferences } from 'src/utils/preferences.js';

@Injectable()
export class AlbumService extends BaseService {
  async getStatistics(auth: AuthDto): Promise<AlbumStatisticsResponseDto> {
    const [owned, shared, notShared] = await Promise.all([
      this.albumRepository.getAll(auth.user.id, { isOwned: true }),
      this.albumRepository.getAll(auth.user.id, { isShared: true }),
      this.albumRepository.getAll(auth.user.id, { isOwned: true, isShared: false }),
    ]);

    return {
      owned: owned.length,
      shared: shared.length,
      notShared: notShared.length,
    };
  }

  async getAll(auth: AuthDto, { assetId, ...rest }: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    const ownerId = auth.user.id;
    await this.albumRepository.updateThumbnails();

    const albums = assetId
      ? await this.albumRepository.getByAssetId(ownerId, assetId)
      : await this.albumRepository.getAll(ownerId, rest);

    if (albums.length === 0) {
      return [];
    }

    // PIN elevation is session-wide, not per-album: once elevated, the requester already has
    // standing access to open any of their locked albums with no extra friction. So it's safe
    // to also reveal locked albums' real counts here rather than showing a stale 0.
    const includeLockedAlbumAssets = !!auth.session?.hasElevatedPermission;

    // Get asset count for each album. Then map the result to an object:
    // { [albumId]: assetCount }
    const results = await this.albumRepository.getMetadataForIds(
      albums.map((album) => album.id),
      includeLockedAlbumAssets,
    );
    const albumMetadata: Record<string, AlbumAssetCount> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }

    return albums.map((album) => ({
      ...mapAlbum(album),
      sharedLinks: undefined,
      startDate: asDateTimeString(albumMetadata[album.id]?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadata[album.id]?.endDate ?? undefined),
      assetCount: albumMetadata[album.id]?.assetCount ?? 0,
      // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadata[album.id]?.lastModifiedAssetTimestamp ?? undefined),
    }));
  }

  async get(auth: AuthDto, id: string): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await this.albumRepository.updateThumbnails();
    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    // requireAccess(AlbumRead) above already denies access to a locked album unless the
    // requester is elevated, so it's safe to include this album's Locked assets in its own
    // count/date-range metadata here.
    const [albumMetadataForIds] = await this.albumRepository.getMetadataForIds([album.id], true);

    const hasSharedUsers = album.albumUsers && album.albumUsers.length > 1;
    const hasSharedLink = album.sharedLinks && album.sharedLinks.length > 0;
    const isShared = hasSharedUsers || hasSharedLink;

    return {
      ...mapAlbum(album),
      startDate: asDateTimeString(albumMetadataForIds?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadataForIds?.endDate ?? undefined),
      assetCount: albumMetadataForIds?.assetCount ?? 0,
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadataForIds?.lastModifiedAssetTimestamp ?? undefined),
      contributorCounts: isShared ? await this.albumRepository.getContributorCounts(album.id) : undefined,
    };
  }

  async getMapMarkers(auth: AuthDto, id: string): Promise<MapMarkerResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });

    if (auth.sharedLink && !auth.sharedLink.showExif) {
      return [];
    }

    return this.mapRepository.getAlbumMapMarkers(id);
  }

  async create(auth: AuthDto, dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    const albumUsers = (dto.albumUsers || []).filter(({ userId }) => userId !== auth.user.id);

    if (dto.isLocked) {
      // A locked album is invisible to a non-elevated session, so creating one without the PIN
      // would produce an album the requester cannot see or use. Require elevation up front.
      requireElevatedPermission(auth);

      if (albumUsers.length > 0) {
        throw new BadRequestException('A locked album cannot be shared');
      }
    }

    for (const { userId } of albumUsers) {
      const exists = await this.userRepository.get(userId, {});
      if (!exists) {
        this.logger.debug('Album creation failed: user not found');
        throw new BadRequestException('Invalid user');
      }
    }

    let assetIds: string[];
    if (dto.isLocked) {
      // A locked album can only ever contain assets that are already locked (already sitting in
      // the locked folder). Permission.AssetShare hardcodes non-elevated access, which would drop
      // every locked asset before the check below could run -- so the album would silently end
      // up empty. AssetUpdate respects elevation, and organizing an asset the requester already
      // owns into a locked album they also own doesn't expose it to anyone else. Every requested
      // asset must pass: nothing is dropped silently, the request is rejected instead.
      assetIds = [...new Set(dto.assetIds || [])];
      await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: assetIds });

      const lockedAssetIds = await this.assetRepository.getLockedAssetIds(assetIds);
      if (lockedAssetIds.size !== assetIds.length) {
        throw new BadRequestException('A locked album can only contain assets that are already locked');
      }
    } else {
      const allowedAssetIdsSet = await this.checkAccess({
        auth,
        permission: Permission.AssetShare,
        ids: dto.assetIds || [],
      });
      assetIds = [...allowedAssetIdsSet];
    }

    const userMetadata = await this.userRepository.getMetadata(auth.user.id);

    const album = await this.albumRepository.create(
      {
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: assetIds[0] || null,
        order: getPreferences(userMetadata).albums.defaultAssetOrder,
        isLocked: dto.isLocked ?? false,
      },
      assetIds,
      [{ userId: auth.user.id, role: AlbumUserRole.Owner }, ...albumUsers],
      auth.user.id,
    );

    for (const { userId } of albumUsers) {
      await this.eventRepository.emit('AlbumInvite', { id: album.id, userId, senderName: auth.user.name });
    }

    return mapAlbum(album);
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: true });

    if (dto.albumThumbnailAssetId) {
      const results = await this.albumRepository.getAssetIds(id, [dto.albumThumbnailAssetId]);
      if (results.size === 0) {
        throw new BadRequestException('Invalid album thumbnail');
      }
    }
    const updatedAlbum = await this.albumRepository.update(
      album.id,
      {
        id: album.id,
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: dto.albumThumbnailAssetId,
        isActivityEnabled: dto.isActivityEnabled,
        order: dto.order,
      },
      auth.user.id,
    );

    return mapAlbum({ ...updatedAlbum, assets: album.assets });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    await this.albumRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });

    let results: BulkIdResponseDto[];

    if (album.isLocked) {
      // A locked album can only ever contain assets that are already locked (already sitting in
      // the locked folder) -- reject outright rather than silently dropping the offending assets.
      const lockedAssetIds = await this.assetRepository.getLockedAssetIds(dto.ids);
      if (lockedAssetIds.size !== dto.ids.length) {
        throw new BadRequestException('A locked album can only contain assets that are already locked');
      }

      // Can't use the shared addAssets() util below here: it gates each asset via
      // Permission.AssetShare, which hardcodes non-elevated access -- deliberately, since that
      // permission also covers shared-link/album-sharing paths that must never expose locked
      // content. Permission.AssetUpdate does respect elevation, and organizing an asset the
      // requester already owns (and has already locked) into a locked album they also own doesn't
      // expose it to anyone else, so it's the right check here.
      const existingAssetIds = await this.albumRepository.getAssetIds(id, dto.ids);
      const notPresentAssetIds = dto.ids.filter((assetId) => !existingAssetIds.has(assetId));

      const allowedAssetIds = await this.checkAccess({
        auth,
        permission: Permission.AssetUpdate,
        ids: notPresentAssetIds,
      });

      results = dto.ids.map((assetId) => {
        if (existingAssetIds.has(assetId)) {
          return { id: assetId, success: false, error: BulkIdErrorReason.DUPLICATE };
        }
        if (!allowedAssetIds.has(assetId)) {
          return { id: assetId, success: false, error: BulkIdErrorReason.NO_PERMISSION };
        }
        return { id: assetId, success: true };
      });

      const newAssetIds = results.filter(({ success }) => success).map(({ id: assetId }) => assetId);
      if (newAssetIds.length > 0) {
        await this.albumRepository.addAssetIds(id, newAssetIds);
      }
    } else {
      results = await addAssets(
        auth,
        { access: this.accessRepository, bulk: this.albumRepository },
        { parentId: id, assetIds: dto.ids, permission: Permission.AssetShare },
      );
    }

    const { id: firstNewAssetId } = results.find(({ success }) => success) || {};
    if (firstNewAssetId) {
      await this.albumRepository.update(
        id,
        {
          id,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? firstNewAssetId,
        },
        auth.user.id,
      );

      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      await this.eventRepository.emit('AlbumUpdate', { id, userIds, recipientIds });
    }

    return results;
  }

  async addAssetsToAlbums(auth: AuthDto, dto: AlbumsAddAssetsDto): Promise<AlbumsAddAssetsResponseDto> {
    const results: AlbumsAddAssetsResponseDto = {
      success: false,
      error: BulkIdErrorReason.DUPLICATE,
    };

    const allowedAlbumIds = await this.checkAccess({
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: dto.albumIds,
    });
    if (allowedAlbumIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    // Locked and unlocked albums are separate spaces: a locked asset can sit in any number of
    // locked albums, but a single add-to-albums call can never target both kinds at once, since
    // the same assets can't be valid for both. Mirrors the client-side filtering in the album
    // picker, enforced here too for any caller.
    const lockedTargetAlbumIds = await this.albumRepository.getLockedAlbumIds([...allowedAlbumIds]);
    if (lockedTargetAlbumIds.size > 0 && lockedTargetAlbumIds.size !== allowedAlbumIds.size) {
      throw new BadRequestException('Assets cannot be added to locked and unlocked albums at the same time');
    }

    const isLockedTarget = lockedTargetAlbumIds.size > 0;
    let allowedAssetIds: Set<string>;

    if (isLockedTarget) {
      // A locked album can only ever contain assets that are already locked (already sitting in
      // the locked folder) -- reject outright rather than converting/evicting them.
      const lockedAssetIds = await this.assetRepository.getLockedAssetIds(dto.assetIds);
      if (lockedAssetIds.size !== dto.assetIds.length) {
        throw new BadRequestException('A locked album can only contain assets that are already locked');
      }

      // Permission.AssetShare (used below for the unlocked-album path) hardcodes non-elevated
      // access, since it also covers shared-link/album-sharing paths that must never expose locked
      // content -- so it would reject every one of these assets outright. AssetUpdate respects
      // elevation, and organizing an asset the requester already owns into a locked album they
      // also own doesn't expose it to anyone else.
      allowedAssetIds = await this.checkAccess({ auth, permission: Permission.AssetUpdate, ids: dto.assetIds });
    } else {
      allowedAssetIds = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });
    }

    if (allowedAssetIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const albumAssetValues: { albumId: string; assetId: string }[] = [];
    const events: { id: string; userIds: string[]; recipientIds: string[] }[] = [];
    for (const albumId of allowedAlbumIds) {
      const existingAssetIds = await this.albumRepository.getAssetIds(albumId, [...allowedAssetIds]);
      const notPresentAssetIds = [...allowedAssetIds.difference(existingAssetIds)];
      if (notPresentAssetIds.length === 0) {
        continue;
      }
      const album = await this.findOrFail(albumId, auth.user.id, { withAssets: false });
      results.error = undefined;
      results.success = true;

      for (const assetId of notPresentAssetIds) {
        albumAssetValues.push({ albumId, assetId });
      }
      await this.albumRepository.update(
        albumId,
        {
          id: albumId,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? notPresentAssetIds[0],
        },
        auth.user.id,
      );
      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      events.push({ id: albumId, userIds, recipientIds });
    }

    await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);

    for (const event of events) {
      await this.eventRepository.emit('AlbumUpdate', event);
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.AlbumDelete },
    );

    const removedIds = results.filter(({ success }) => success).map(({ id }) => id);
    if (removedIds.length > 0) {
      if (album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
        await this.albumRepository.updateThumbnails();
      }

      await this.eventRepository.emit('AlbumUpdate', {
        id,
        userIds: album.albumUsers.map(({ user }) => user.id),
        recipientIds: [],
      });
    }

    return results;
  }

  lock(auth: AuthDto, dto: BulkIdsDto): Promise<AlbumLockResponseDto[]> {
    return this.convert(auth, dto.ids, true);
  }

  unlock(auth: AuthDto, dto: BulkIdsDto): Promise<AlbumLockResponseDto[]> {
    return this.convert(auth, dto.ids, false);
  }

  /**
   * Move each album's assets into a fresh album of the other kind: into a new locked album when
   * locking, into a new ordinary album when unlocking. Only the requester's own assets move; any
   * others stay behind in the source album, which is removed once it is empty.
   */
  private async convert(auth: AuthDto, ids: string[], isLocked: boolean): Promise<AlbumLockResponseDto[]> {
    if (!isLocked) {
      requireElevatedPermission(auth);
    }

    const albumIds = [...new Set(ids)];
    // Converting replaces the album, so it needs the same owner access as deleting it. For a
    // non-elevated session that check also hides locked albums, so unlocking needs elevation.
    const allowedAlbumIds = await this.checkAccess({ auth, permission: Permission.AlbumDelete, ids: albumIds });

    const albums = [];
    for (const id of albumIds) {
      if (!allowedAlbumIds.has(id)) {
        continue;
      }

      const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
      if (album.isLocked === isLocked) {
        throw new BadRequestException(isLocked ? 'Album is already locked' : 'Album is not locked');
      }

      albums.push(album);
    }

    // Changing the visibility strips every album membership, so capture which assets are in which
    // album before anything is written.
    const albumAssetIds = new Map<string, string[]>();
    for (const album of albums) {
      albumAssetIds.set(album.id, await this.albumRepository.getAllAssetIds(album.id));
    }

    // Only the requester's own assets can change visibility; anything else stays where it is.
    const ownedAssetIds = await this.checkAccess({
      auth,
      permission: Permission.AssetUpdate,
      ids: albumAssetIds.values().toArray().flat(),
    });

    const conversions = new Map<string, AlbumConversion>();
    for (const album of albums) {
      const assetIds = albumAssetIds.get(album.id)!.filter((assetId) => ownedAssetIds.has(assetId));
      const keepsThumbnail = !!album.albumThumbnailAssetId && assetIds.includes(album.albumThumbnailAssetId);
      conversions.set(album.id, {
        sourceAlbumId: album.id,
        album: {
          albumName: album.albumName,
          description: album.description,
          order: album.order,
          albumThumbnailAssetId: keepsThumbnail ? album.albumThumbnailAssetId : (assetIds[0] ?? null),
          isLocked,
        },
        assetIds,
      });
    }

    const converted = new Map<string, { albumId: string; removed: boolean }>();
    if (conversions.size > 0) {
      const results = await this.albumRepository.convert({
        ownerId: auth.user.id,
        visibility: isLocked ? AssetVisibility.Locked : AssetVisibility.Timeline,
        albums: conversions.values().toArray(),
      });
      for (const result of results) {
        converted.set(result.sourceAlbumId, result);
      }
    }

    if (ownedAssetIds.size > 0) {
      await this.jobRepository.queueAll([...ownedAssetIds].map((id) => ({ name: JobName.SidecarWrite, data: { id } })));
    }

    return albumIds.map((id) => {
      const conversion = conversions.get(id);
      const result = converted.get(id);
      if (!conversion || !result) {
        return {
          id,
          success: false,
          error: BulkIdErrorReason.NO_PERMISSION,
          assetCount: 0,
          skippedAssetCount: 0,
          removed: false,
        };
      }

      return {
        id,
        success: true,
        albumId: result.albumId,
        assetCount: conversion.assetIds.length,
        skippedAssetCount: albumAssetIds.get(id)!.length - conversion.assetIds.length,
        removed: result.removed,
      };
    });
  }

  async addUsers(auth: AuthDto, id: string, { albumUsers }: AddUsersDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    if (album.isLocked) {
      throw new BadRequestException('A locked album cannot be shared');
    }

    for (const { userId, role } of albumUsers) {
      if (role === AlbumUserRole.Owner) {
        throw new BadRequestException('Cannot add another owner');
      }

      const exists = album.albumUsers.some(({ user: { id } }) => id === userId);
      if (exists) {
        continue;
      }

      const user = await this.userRepository.get(userId, {});
      if (!user) {
        this.logger.debug('Adding user to album failed: user not found');
        throw new BadRequestException('Invalid user');
      }

      await this.albumUserRepository.create({ userId, albumId: id, role });
      await this.eventRepository.emit('AlbumInvite', { id, userId, senderName: auth.user.name });
    }

    return mapAlbum(await this.findOrFail(id, auth.user.id, { withAssets: true }));
  }

  async removeUser(auth: AuthDto, id: string, userId: string | 'me'): Promise<void> {
    if (userId === 'me') {
      userId = auth.user.id;
    }

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });

    const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
    if (!exists) {
      throw new BadRequestException('Album not shared with user');
    }

    if (
      exists.role === AlbumUserRole.Owner &&
      album.albumUsers.filter(({ role }) => role === AlbumUserRole.Owner).length === 1
    ) {
      throw new BadRequestException('Cannot remove the last album owner');
    }

    // non-admin can remove themselves
    if (auth.user.id !== userId) {
      await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    }

    await this.albumUserRepository.delete({ albumId: id, userId });
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: UpdateAlbumUserDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, userId, { withAssets: false });
    const owner = album.albumUsers[0];

    if (owner.user.id === userId) {
      throw new BadRequestException('User is owner');
    }

    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
  }

  private findOrFail(id: string, authUserId: string, options: AlbumInfoOptions) {
    return findOrFail(() => this.albumRepository.getById(id, options, authUserId), 'Album');
  }
}
