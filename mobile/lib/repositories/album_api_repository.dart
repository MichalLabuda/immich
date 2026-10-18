import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/repositories/api.repository.dart';
// ignore: import_rule_openapi
import 'package:openapi/api.dart' hide AlbumUserRole;

final albumApiRepositoryProvider = Provider((ref) => AlbumApiRepository(ref.watch(apiServiceProvider).albumsApi));

class AlbumApiRepository extends ApiRepository {
  final AlbumsApi _api;

  AlbumApiRepository(this._api);

  Future<RemoteAlbum> createDriftAlbum(
    String name,
    UserDto owner, {
    required Iterable<String> assetIds,
    String? description,
  }) async {
    final responseDto = await checkNull(
      _api.createAlbum(
        CreateAlbumDto(
          albumName: name,
          description: description == null
              ? const Optional.absent()
              : Optional.present(description.isEmpty ? null : description),
          assetIds: Optional.present(assetIds.toList()),
        ),
      ),
    );

    return responseDto.toRemoteAlbum(owner);
  }

  Future<({List<String> removed, List<String> failed})> removeAssets(String albumId, Iterable<String> assetIds) async {
    final response = await checkNull(_api.removeAssetFromAlbum(albumId, BulkIdsDto(ids: assetIds.toList())));
    final List<String> removed = [];
    final List<String> failed = [];
    for (final dto in response) {
      if (dto.success) {
        removed.add(dto.id);
      } else {
        failed.add(dto.id);
      }
    }
    return (removed: removed, failed: failed);
  }

  Future<({List<String> added, List<String> failed})> addAssets(
    String albumId,
    Iterable<String> assetIds, {
    Future<void>? abortTrigger,
  }) async {
    final response = await checkNull(
      _api.addAssetsToAlbum(albumId, BulkIdsDto(ids: assetIds.toList()), abortTrigger: abortTrigger),
    );
    final List<String> added = [];
    final List<String> failed = [];
    for (final dto in response) {
      if (dto.success) {
        added.add(dto.id);
      } else if (dto.error.orElse(null) != BulkIdErrorReason.duplicate) {
        failed.add(dto.id);
      }
    }

    return (added: added, failed: failed);
  }

  Future<RemoteAlbum> updateAlbum(
    String albumId,
    UserDto owner, {
    String? name,
    String? description,
    String? thumbnailAssetId,
    bool? isActivityEnabled,
    AlbumAssetOrder? order,
  }) async {
    AssetOrder? apiOrder;
    if (order != null) {
      apiOrder = order == AlbumAssetOrder.asc ? AssetOrder.asc : AssetOrder.desc;
    }

    final responseDto = await checkNull(
      _api.updateAlbumInfo(
        albumId,
        UpdateAlbumDto(
          albumName: name == null ? const Optional.absent() : Optional.present(name),
          description: description == null
              ? const Optional.absent()
              : Optional.present(description.isEmpty ? null : description),
          albumThumbnailAssetId: thumbnailAssetId == null
              ? const Optional.absent()
              : Optional.present(thumbnailAssetId),
          isActivityEnabled: isActivityEnabled == null ? const Optional.absent() : Optional.present(isActivityEnabled),
          order: apiOrder == null ? const Optional.absent() : Optional.present(apiOrder),
        ),
      ),
    );

    return responseDto.toRemoteAlbum(owner);
  }

  Future<void> deleteAlbum(String albumId) {
    return _api.deleteAlbum(albumId);
  }

  /// Moves the user's assets of the album to the locked folder. The server replaces the album
  /// with a new locked album, which is synced like the locked assets themselves.
  Future<AlbumLockResult> lockAlbum(String albumId) => _setLocked(albumId, isLocked: true);

  /// Moves the user's assets of a locked album back to the library, into a new unlocked album.
  Future<AlbumLockResult> unlockAlbum(String albumId) => _setLocked(albumId, isLocked: false);

  Future<AlbumLockResult> _setLocked(String albumId, {required bool isLocked}) async {
    final dto = BulkIdsDto(ids: [albumId]);
    final response = await checkNull(isLocked ? _api.lockAlbums(dto) : _api.unlockAlbums(dto));
    final result = response.where((item) => item.id == albumId).firstOrNull;
    if (result == null || !result.success) {
      throw Exception(
        'Failed to ${isLocked ? 'lock' : 'unlock'} album $albumId: ${result?.error.orElse(null) ?? 'no result'}',
      );
    }

    return (assetCount: result.assetCount, skippedAssetCount: result.skippedAssetCount, removed: result.removed);
  }

  Future<void> addUsers(String albumId, Iterable<String> userIds) async {
    final albumUsers = userIds.map((userId) => AlbumUserAddDto(userId: userId)).toList();
    await checkNull(_api.addUsersToAlbum(albumId, AddUsersDto(albumUsers: albumUsers)));
  }

  Future<void> removeUser(String albumId, {required String userId}) async {
    await _api.removeUserFromAlbum(albumId, userId);
  }

  Future<bool> setActivityStatus(String albumId, bool isEnabled) async {
    final response = await checkNull(
      _api.updateAlbumInfo(albumId, UpdateAlbumDto(isActivityEnabled: Optional.present(isEnabled))),
    );
    return response.isActivityEnabled;
  }
}

extension on AlbumResponseDto {
  RemoteAlbum toRemoteAlbum(final UserDto user) {
    return RemoteAlbum(
      id: id,
      name: albumName,
      ownerId: user.id,
      ownerName: user.name,
      description: description,
      createdAt: createdAt,
      updatedAt: updatedAt,
      thumbnailAssetId: albumThumbnailAssetId,
      isActivityEnabled: isActivityEnabled,
      order: order.orElse(null) == AssetOrder.asc ? AlbumAssetOrder.asc : AlbumAssetOrder.desc,
      assetCount: assetCount,
      isShared: albumUsers.length > 2,
    );
  }
}
