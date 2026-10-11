import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/repositories/album_api_repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

class _MockAlbumsApi extends Mock implements AlbumsApi {}

void main() {
  late _MockAlbumsApi api;
  late AlbumApiRepository repo;

  setUpAll(() {
    registerFallbackValue(BulkIdsDto(ids: const []));
  });

  setUp(() {
    api = _MockAlbumsApi();
    repo = AlbumApiRepository(api);
  });

  void stubResponse(List<BulkIdResponseDto> response) {
    when(
      () => api.addAssetsToAlbum(any(), any(), abortTrigger: any(named: 'abortTrigger')),
    ).thenAnswer((_) async => response);
  }

  test('no_permission failure surfaces as failed, not added (the #22342 bug)', () async {
    stubResponse([
      BulkIdResponseDto(id: 'a1', success: false, error: const Optional.present(BulkIdErrorReason.noPermission)),
    ]);

    final result = await repo.addAssets('album1', ['a1']);

    expect(result.added, isEmpty);
    expect(result.failed, ['a1']);
  });

  test('duplicate is neither added nor failed (genuinely already in album)', () async {
    stubResponse([
      BulkIdResponseDto(id: 'a1', success: false, error: const Optional.present(BulkIdErrorReason.duplicate)),
    ]);

    final result = await repo.addAssets('album1', ['a1']);

    expect(result.added, isEmpty);
    expect(result.failed, isEmpty);
  });

  test('success is added', () async {
    stubResponse([BulkIdResponseDto(id: 'a1', success: true)]);

    final result = await repo.addAssets('album1', ['a1']);

    expect(result.added, ['a1']);
    expect(result.failed, isEmpty);
  });

  test('not_found and unknown count as failures', () async {
    stubResponse([
      BulkIdResponseDto(id: 'a1', success: false, error: const Optional.present(BulkIdErrorReason.notFound)),
      BulkIdResponseDto(id: 'a2', success: false, error: const Optional.present(BulkIdErrorReason.unknown)),
    ]);

    final result = await repo.addAssets('album1', ['a1', 'a2']);

    expect(result.added, isEmpty);
    expect(result.failed, ['a1', 'a2']);
  });

  test('mixed: added kept, no_permission failed, duplicate dropped', () async {
    stubResponse([
      BulkIdResponseDto(id: 'ok', success: true),
      BulkIdResponseDto(id: 'perm', success: false, error: const Optional.present(BulkIdErrorReason.noPermission)),
      BulkIdResponseDto(id: 'dup', success: false, error: const Optional.present(BulkIdErrorReason.duplicate)),
    ]);

    final result = await repo.addAssets('album1', ['ok', 'perm', 'dup']);

    expect(result.added, ['ok']);
    expect(result.failed, ['perm']);
  });

  group('lockAlbum', () {
    test('returns the counts of the album', () async {
      when(() => api.lockAlbums(any())).thenAnswer(
        (_) async => [
          AlbumLockResponseDto(
            id: 'album-1',
            success: true,
            albumId: const Optional.present('album-2'),
            assetCount: 3,
            skippedAssetCount: 1,
            removed: true,
          ),
        ],
      );

      final result = await repo.lockAlbum('album-1');

      expect(result, (assetCount: 3, skippedAssetCount: 1, removed: true));
      final captured = verify(() => api.lockAlbums(captureAny())).captured.single as BulkIdsDto;
      expect(captured.ids, ['album-1']);
    });

    test('throws when the album was not moved', () async {
      when(() => api.lockAlbums(any())).thenAnswer(
        (_) async => [
          AlbumLockResponseDto(
            id: 'album-1',
            success: false,
            error: const Optional.present(BulkIdErrorReason.noPermission),
            assetCount: 0,
            skippedAssetCount: 0,
            removed: false,
          ),
        ],
      );

      await expectLater(repo.lockAlbum('album-1'), throwsException);
    });
  });

  group('unlockAlbum', () {
    test('returns the counts of the album', () async {
      when(() => api.unlockAlbums(any())).thenAnswer(
        (_) async => [
          AlbumLockResponseDto(
            id: 'album-1',
            success: true,
            albumId: const Optional.present('album-2'),
            assetCount: 2,
            skippedAssetCount: 0,
            removed: true,
          ),
        ],
      );

      final result = await repo.unlockAlbum('album-1');

      expect(result, (assetCount: 2, skippedAssetCount: 0, removed: true));
      verifyNever(() => api.lockAlbums(any()));
    });
  });
}
