import {
  FeatureFlag,
  IAlbumRepository,
  IAssetRepository,
  IBaseJob,
  ICryptoRepository,
  IEntityJob,
  IGeocodingRepository,
  IJobRepository,
  IStorageRepository,
  ISystemConfigRepository,
  JobName,
  JOBS_ASSET_PAGINATION_SIZE,
  QueueName,
  StorageCore,
  StorageFolder,
  SystemConfigCore,
  usePagination,
  WithoutProperty,
} from '@app/domain';
import { AssetEntity, AssetType, ExifEntity } from '@app/infra/entities';
import { Inject, Logger } from '@nestjs/common';
import { DefaultReadTaskOptions, ExifDateTime, exiftool, ReadTaskOptions, Tags } from 'exiftool-vendored';
import { firstDateTime } from 'exiftool-vendored/dist/FirstDateTime';
import * as geotz from 'geo-tz';
import { Duration } from 'luxon';
import fs from 'node:fs/promises';
import path from 'node:path';

interface DirectoryItem {
  Length?: number;
  Mime: string;
  Padding?: number;
  Semantic?: string;
}

interface DirectoryEntry {
  Item: DirectoryItem;
}

interface ImmichTags extends Tags {
  ContentIdentifier?: string;
  MotionPhoto?: number;
  MotionPhotoVersion?: number;
  MotionPhotoPresentationTimestampUs?: number;
  MediaGroupUUID?: string;
  ImagePixelDepth?: string;
}

const exifDate = (dt: ExifDateTime | string | undefined) => (dt instanceof ExifDateTime ? dt?.toDate() : null);
// exiftool returns strings when it fails to parse non-string values, so this is used where a string is not expected
const validate = <T>(value: T): T | null => (typeof value === 'string' ? null : value ?? null);

export class MetadataExtractionProcessor {
  private logger = new Logger(MetadataExtractionProcessor.name);
  private storageCore: StorageCore;
  private configCore: SystemConfigCore;
  private oldCities?: string;

  constructor(
    @Inject(IAssetRepository) private assetRepository: IAssetRepository,
    @Inject(IAlbumRepository) private albumRepository: IAlbumRepository,
    @Inject(IJobRepository) private jobRepository: IJobRepository,
    @Inject(IGeocodingRepository) private geocodingRepository: IGeocodingRepository,
    @Inject(ICryptoRepository) private cryptoRepository: ICryptoRepository,
    @Inject(IStorageRepository) private storageRepository: IStorageRepository,
    @Inject(ISystemConfigRepository) configRepository: ISystemConfigRepository,
  ) {
    this.storageCore = new StorageCore(storageRepository);
    this.configCore = new SystemConfigCore(configRepository);
    this.configCore.config$.subscribe(() => this.init());
  }

  async init(deleteCache = false) {
    const { reverseGeocoding } = await this.configCore.getConfig();
    const { citiesFileOverride } = reverseGeocoding;

    if (!reverseGeocoding.enabled) {
      return;
    }

    try {
      if (deleteCache) {
        await this.geocodingRepository.deleteCache();
      } else if (this.oldCities && this.oldCities === citiesFileOverride) {
        return;
      }

      await this.jobRepository.pause(QueueName.METADATA_EXTRACTION);
      await this.geocodingRepository.init({ citiesFileOverride });
      await this.jobRepository.resume(QueueName.METADATA_EXTRACTION);

      this.logger.log(`Initialized local reverse geocoder with ${citiesFileOverride}`);
      this.oldCities = citiesFileOverride;
    } catch (error: Error | any) {
      this.logger.error(`Unable to initialize reverse geocoding: ${error}`, error?.stack);
    }
  }

  async handleLivePhotoLinking(job: IEntityJob) {
    const { id } = job;
    const [asset] = await this.assetRepository.getByIds([id]);
    if (!asset?.exifInfo) {
      return false;
    }

    if (!asset.exifInfo.livePhotoCID) {
      return true;
    }

    const otherType = asset.type === AssetType.VIDEO ? AssetType.IMAGE : AssetType.VIDEO;
    const match = await this.assetRepository.findLivePhotoMatch({
      livePhotoCID: asset.exifInfo.livePhotoCID,
      ownerId: asset.ownerId,
      otherAssetId: asset.id,
      type: otherType,
    });

    if (!match) {
      return true;
    }

    const [photoAsset, motionAsset] = asset.type === AssetType.IMAGE ? [asset, match] : [match, asset];

    await this.assetRepository.save({ id: photoAsset.id, livePhotoVideoId: motionAsset.id });
    await this.assetRepository.save({ id: motionAsset.id, isVisible: false });
    await this.albumRepository.removeAsset(motionAsset.id);

    return true;
  }

  async handleQueueMetadataExtraction(job: IBaseJob) {
    const { force } = job;
    const assetPagination = usePagination(JOBS_ASSET_PAGINATION_SIZE, (pagination) => {
      return force
        ? this.assetRepository.getAll(pagination)
        : this.assetRepository.getWithout(pagination, WithoutProperty.EXIF);
    });

    for await (const assets of assetPagination) {
      for (const asset of assets) {
        await this.jobRepository.queue({ name: JobName.METADATA_EXTRACTION, data: { id: asset.id } });
      }
    }

    return true;
  }

  async handleMetadataExtraction({ id }: IEntityJob) {
    const [asset] = await this.assetRepository.getByIds([id]);
    if (!asset || !asset.isVisible) {
      return false;
    }

    const [exifData, tags] = await this.exifData(asset);

    await this.applyMotionPhotos(asset, tags);
    await this.applyReverseGeocoding(asset, exifData);
    await this.assetRepository.upsertExif(exifData);
    await this.assetRepository.save({
      id: asset.id,
      duration: tags.Duration ? Duration.fromObject({ seconds: tags.Duration }).toFormat('hh:mm:ss.SSS') : null,
      fileCreatedAt: exifData.dateTimeOriginal ?? undefined,
    });

    return true;
  }

  private async applyReverseGeocoding(asset: AssetEntity, exifData: ExifEntity) {
    const { latitude, longitude } = exifData;
    if (!(await this.configCore.hasFeature(FeatureFlag.REVERSE_GEOCODING)) || !longitude || !latitude) {
      return;
    }

    try {
      const { city, state, country } = await this.geocodingRepository.reverseGeocode({ latitude, longitude });
      Object.assign(exifData, { city, state, country });
    } catch (error: Error | any) {
      this.logger.warn(
        `Unable to run reverse geocoding due to ${error} for asset ${asset.id} at ${asset.originalPath}`,
        error?.stack,
      );
    }
  }

  private async applyMotionPhotos(asset: AssetEntity, tags: ImmichTags) {
    if (asset.type !== AssetType.IMAGE || asset.livePhotoVideoId) {
      return;
    }

    const rawDirectory = tags.Directory;
    const isMotionPhoto = tags.MotionPhoto;
    const isMicroVideo = tags.MicroVideo;
    const videoOffset = tags.MicroVideoOffset;
    const directory = Array.isArray(rawDirectory) ? (rawDirectory as DirectoryEntry[]) : null;

    let length = 0;
    let padding = 0;

    if (isMotionPhoto && directory) {
      for (const entry of directory) {
        if (entry.Item.Semantic == 'MotionPhoto') {
          length = entry.Item.Length ?? 0;
          padding = entry.Item.Padding ?? 0;
          break;
        }
      }
    }

    if (isMicroVideo && typeof videoOffset === 'number') {
      length = videoOffset;
    }

    if (!length) {
      return;
    }

    this.logger.debug(`Starting motion photo video extraction (${asset.id})`);

    let file = null;
    try {
      const encodedFolder = this.storageCore.getFolderLocation(StorageFolder.ENCODED_VIDEO, asset.ownerId);
      const encodedFile = path.join(encodedFolder, path.parse(asset.originalPath).name + '.mp4');
      this.storageRepository.mkdirSync(encodedFolder);

      file = await fs.open(asset.originalPath);

      const stat = await file.stat();
      const position = stat.size - length - padding;
      const video = await file.read({ buffer: Buffer.alloc(length), position, length });
      const checksum = await this.cryptoRepository.hashSha1(video.buffer);

      let motionAsset = await this.assetRepository.getByChecksum(asset.ownerId, checksum);
      if (!motionAsset) {
        motionAsset = await this.assetRepository.save({
          libraryId: asset.libraryId,
          type: AssetType.VIDEO,
          fileCreatedAt: asset.fileCreatedAt ?? asset.createdAt,
          fileModifiedAt: asset.fileModifiedAt,
          checksum,
          ownerId: asset.ownerId,
          originalPath: encodedFile,
          originalFileName: asset.originalFileName,
          isVisible: false,
          isReadOnly: true,
          deviceAssetId: 'NONE',
          deviceId: 'NONE',
        });

        await fs.writeFile(encodedFile, video.buffer);

        await this.jobRepository.queue({ name: JobName.METADATA_EXTRACTION, data: { id: motionAsset.id } });
      }

      await this.assetRepository.save({ id: asset.id, livePhotoVideoId: motionAsset.id });

      this.logger.debug(`Finished motion photo video extraction (${asset.id})`);
    } catch (error: Error | any) {
      this.logger.error(`Failed to extract live photo ${asset.originalPath}: ${error}`, error?.stack);
    } finally {
      await file?.close();
    }
  }

  private async exifData(asset: AssetEntity): Promise<[ExifEntity, ImmichTags]> {
    const readTaskOptions: ReadTaskOptions = {
      ...DefaultReadTaskOptions,

      defaultVideosToUTC: true,
      backfillTimezones: true,
      inferTimezoneFromDatestamps: true,
      useMWG: true,
      numericTags: DefaultReadTaskOptions.numericTags.concat(['FocalLength']),
      geoTz: (lat: number, lon: number): string => geotz.find(lat, lon)[0],
    };

    const mediaTags = await exiftool
      .read<ImmichTags>(asset.originalPath, undefined, readTaskOptions)
      .catch((error: any) => {
        this.logger.warn(`error reading exif data (${asset.id} at ${asset.originalPath}): ${error}`, error?.stack);
        return null;
      });

    const sidecarTags = asset.sidecarPath
      ? await exiftool.read<ImmichTags>(asset.sidecarPath, undefined, readTaskOptions).catch((error: any) => {
          this.logger.warn(`error reading exif data (${asset.id} at ${asset.sidecarPath}): ${error}`, error?.stack);
          return null;
        })
      : null;

    const stats = await fs.stat(asset.originalPath);

    const tags = { ...mediaTags, ...sidecarTags };

    this.logger.verbose('Exif Tags', tags);

    return [
      <ExifEntity>{
        // altitude: tags.GPSAltitude ?? null,
        assetId: asset.id,
        bitsPerSample: this.getBitsPerSample(tags),
        colorspace: tags.ColorSpace ?? null,
        dateTimeOriginal: exifDate(firstDateTime(tags)) ?? asset.fileCreatedAt,
        exifImageHeight: validate(tags.ImageHeight),
        exifImageWidth: validate(tags.ImageWidth),
        exposureTime: tags.ExposureTime ?? null,
        fileSizeInByte: stats.size,
        fNumber: validate(tags.FNumber),
        focalLength: validate(tags.FocalLength),
        fps: validate(tags.VideoFrameRate),
        iso: validate(tags.ISO),
        latitude: validate(tags.GPSLatitude),
        lensModel: tags.LensModel ?? null,
        livePhotoCID: (asset.type === AssetType.VIDEO ? tags.ContentIdentifier : tags.MediaGroupUUID) ?? null,
        longitude: validate(tags.GPSLongitude),
        make: tags.Make ?? null,
        model: tags.Model ?? null,
        modifyDate: exifDate(tags.ModifyDate) ?? asset.fileModifiedAt,
        orientation: validate(tags.Orientation)?.toString() ?? null,
        profileDescription: tags.ProfileDescription || tags.ProfileName || null,
        projectionType: tags.ProjectionType ? String(tags.ProjectionType).toUpperCase() : null,
        timeZone: tags.tz,
      },
      tags,
    ];
  }

  getBitsPerSample(tags: ImmichTags): number | null {
    const bitDepthTags = [
      tags.BitsPerSample,
      tags.ComponentBitDepth,
      tags.ImagePixelDepth,
      tags.BitDepth,
      tags.ColorBitDepth,
      // `numericTags` doesn't parse values like '12 12 12'
    ].map((tag) => (typeof tag === 'string' ? Number.parseInt(tag) : tag));

    let bitsPerSample = bitDepthTags.find((tag) => typeof tag === 'number' && !Number.isNaN(tag)) ?? null;
    if (bitsPerSample && bitsPerSample >= 24 && bitsPerSample % 3 === 0) {
      bitsPerSample /= 3; // converts per-pixel bit depth to per-channel
    }

    return bitsPerSample;
  }
}
