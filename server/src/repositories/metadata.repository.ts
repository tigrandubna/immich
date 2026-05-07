import { Injectable } from '@nestjs/common';
import { BinaryField, DefaultReadTaskOptions, ExifTool, Tags } from 'exiftool-vendored';
import geotz from 'geo-tz';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { mimeTypes } from 'src/utils/mime-types';

export interface FaceRegion {
  name: string;
  // Bounding box in pixels of the (imageWidth, imageHeight) coordinate space
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const XMP_STUB =
  '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
  '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
  '<rdf:Description rdf:about=""/>\n' +
  '</rdf:RDF>\n' +
  '</x:xmpmeta>\n' +
  '<?xpacket end="w"?>\n';

interface ExifDuration {
  Value: number;
  Scale?: number;
}

type StringOrNumber = string | number;

type TagsWithWrongTypes =
  | 'FocalLength'
  | 'Duration'
  | 'Description'
  | 'ImageDescription'
  | 'RegionInfo'
  | 'TagsList'
  | 'Keywords'
  | 'HierarchicalSubject'
  | 'ISO';

export interface ImmichTags extends Omit<Tags, TagsWithWrongTypes> {
  ContentIdentifier?: string;
  MotionPhoto?: number;
  MotionPhotoVersion?: number;
  MotionPhotoPresentationTimestampUs?: number;
  MediaGroupUUID?: string;
  ImagePixelDepth?: string;
  FocalLength?: number;
  Duration?: number | string | ExifDuration;
  EmbeddedVideoType?: string;
  EmbeddedVideoFile?: BinaryField;
  MotionPhotoVideo?: BinaryField;
  TagsList?: StringOrNumber[];
  HierarchicalSubject?: StringOrNumber[];
  Keywords?: StringOrNumber | StringOrNumber[];
  ISO?: number | number[];

  // Type is wrong, can also be number.
  Description?: StringOrNumber;
  ImageDescription?: StringOrNumber;

  // Extended properties for image regions, such as faces
  RegionInfo?: {
    AppliedToDimensions: {
      W: number;
      H: number;
      Unit: string;
    };
    RegionList: {
      Area: {
        // (X,Y) // center of the rectangle
        X: number;
        Y: number;
        W: number;
        H: number;
        Unit: string;
      };
      Rotation?: number;
      Type?: string;
      Name?: string;
    }[];
  };

  Device?: {
    Manufacturer?: string;
    ModelName?: string;
  };

  AndroidMake?: string;
  AndroidModel?: string;
  DeviceManufacturer?: string;
  DeviceModelName?: string;
}

@Injectable()
export class MetadataRepository {
  private exiftool = new ExifTool({
    defaultVideosToUTC: true,
    backfillTimezones: true,
    inferTimezoneFromDatestamps: true,
    inferTimezoneFromTimeStamp: true,
    useMWG: true,
    numericTags: [...DefaultReadTaskOptions.numericTags, 'FocalLength', 'FileSize'],
    /* eslint unicorn/no-array-callback-reference: off, unicorn/no-array-method-this-argument: off */
    geoTz: (lat, lon) => geotz.find(lat, lon)[0],
    geolocation: true,
    // Enable exiftool LFS to parse metadata for files larger than 2GB.
    readArgs: ['-api', 'largefilesupport=1'],
    writeArgs: ['-api', 'largefilesupport=1', '-overwrite_original'],
    taskTimeoutMillis: 2 * 60 * 1000,
  });

  constructor(private logger: LoggingRepository) {
    this.logger.setContext(MetadataRepository.name);
  }

  setMaxConcurrency(concurrency: number) {
    this.exiftool.batchCluster.setMaxProcs(concurrency);
  }

  async teardown() {
    await this.exiftool.end();
  }

  readTags(path: string): Promise<ImmichTags> {
    const args = mimeTypes.isVideo(path) ? ['-ee'] : [];
    return this.exiftool.read(path, { readArgs: args }).catch((error) => {
      this.logger.warn(`Error reading exif data (${path}): ${error}\n${error?.stack}`);
      return {};
    }) as Promise<ImmichTags>;
  }

  extractBinaryTag(path: string, tagName: string): Promise<Buffer> {
    return this.exiftool.extractBinaryTagToBuffer(tagName, path);
  }

  async writeTags(path: string, tags: Partial<Tags>): Promise<void> {
    // If exiftool assigns a field with ^= instead of =, empty values will be written too.
    // Since exiftool-vendored doesn't support an option for this, we append the ^ to the name of the tag instead.
    // https://exiftool.org/exiftool_pod.html#:~:text=is%20used%20to%20write%20an%20empty%20string
    const tagsToWrite = Object.fromEntries(Object.entries(tags).map(([key, value]) => [`${key}^`, value]));
    try {
      await this.exiftool.write(path, tagsToWrite);
    } catch (error) {
      this.logger.warn(`Error writing exif data (${path}): ${error}`);
    }
  }

  async writeFaceRegions(
    path: string,
    options: { imageWidth: number; imageHeight: number; faces: FaceRegion[] },
  ): Promise<void> {
    const { imageWidth, imageHeight, faces } = options;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(path)) {
      writeFileSync(path, XMP_STUB, { encoding: 'utf8' });
    }

    const names: string[] = [];
    const types: string[] = [];
    const areaX: number[] = [];
    const areaY: number[] = [];
    const areaW: number[] = [];
    const areaH: number[] = [];
    const areaUnit: string[] = [];
    for (const face of faces) {
      const cx = ((face.x1 + face.x2) / 2) / imageWidth;
      const cy = ((face.y1 + face.y2) / 2) / imageHeight;
      const w = (face.x2 - face.x1) / imageWidth;
      const h = (face.y2 - face.y1) / imageHeight;
      names.push(face.name);
      types.push('Face');
      areaX.push(Number(cx.toFixed(6)));
      areaY.push(Number(cy.toFixed(6)));
      areaW.push(Number(w.toFixed(6)));
      areaH.push(Number(h.toFixed(6)));
      areaUnit.push('normalized');
    }

    try {
      // Replace any existing region list with a fresh one.
      await this.exiftool.write(path, {
        'RegionAppliedToDimensionsW^': imageWidth,
        'RegionAppliedToDimensionsH^': imageHeight,
        'RegionAppliedToDimensionsUnit^': 'pixel',
        'RegionName^': names,
        'RegionType^': types,
        'RegionAreaX^': areaX,
        'RegionAreaY^': areaY,
        'RegionAreaW^': areaW,
        'RegionAreaH^': areaH,
        'RegionAreaUnit^': areaUnit,
      } as never);
    } catch (error) {
      this.logger.warn(`Error writing face regions (${path}): ${error}`);
    }
  }
}
