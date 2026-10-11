import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/album/album_tile.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/routing/router.dart';

/// The locked albums, listed at the top of the locked folder. They are synced like locked assets
/// and shown nowhere else: not in the albums tab, not in any picker, not in search.
class LockedAlbumsSliver extends ConsumerWidget {
  const LockedAlbumsSliver({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final albums = ref.watch(lockedAlbumsProvider).valueOrNull ?? const [];
    final userId = ref.watch(currentUserProvider)?.id;

    if (albums.isEmpty) {
      return const SliverToBoxAdapter(child: SizedBox.shrink());
    }

    return SliverToBoxAdapter(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Text(context.t.albums, style: context.textTheme.titleMedium),
          ),
          ListView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: albums.length,
            itemBuilder: (context, index) {
              final album = albums[index];
              return AlbumTile(
                album: album,
                isOwner: album.ownerId == userId,
                onAlbumSelected: (album) => context.pushRoute(RemoteAlbumRoute(album: album)),
              );
            },
          ),
          const Divider(height: 1),
        ],
      ),
    );
  }
}
