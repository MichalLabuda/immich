import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/table/remote/asset.dart';
import 'package:immich_mobile/data/db/util/datetime_clamp_type.dart';
import 'package:immich_mobile/data/db/util/defaults_mixin.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';

class RemoteAlbumEntity extends Table with DriftDefaultsMixin {
  const RemoteAlbumEntity();

  TextColumn get id => text()();

  TextColumn get name => text()();

  TextColumn get description => text().withDefault(const Constant(''))();

  DateTimeColumn get createdAt => customType(clampedDateTime).withDefault(currentDateAndTime)();

  DateTimeColumn get updatedAt => customType(clampedDateTime).withDefault(currentDateAndTime)();

  TextColumn get thumbnailAssetId =>
      text().references(RemoteAssetEntity, #id, onDelete: KeyAction.setNull).nullable()();

  BoolColumn get isActivityEnabled => boolean().withDefault(const Constant(true))();

  IntColumn get order => intEnum<AlbumAssetOrder>()();

  /// A locked album is a container of locked assets. Like them it is synced and stored, but only
  /// ever shown inside the locked folder, never in an album list or picker.
  BoolColumn get isLocked => boolean().withDefault(const Constant(false))();

  @override
  Set<Column> get primaryKey => {id};
}
