import { Injectable } from '@nestjs/common';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import { ConfigService } from '../config/config.service';

@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(private readonly config: ConfigService) {
    this.s3 = new S3Client({
      endpoint: config.minioEndpoint,
      region: config.minioRegion,
      credentials: {
        accessKeyId: config.minioAccessKey,
        secretAccessKey: config.minioSecretKey,
      },
      forcePathStyle: true,
    });
    this.bucket = config.minioAvatarsBucket;
    this.publicUrl = config.minioPublicUrl;
  }

  async upload(key: string, buffer: Buffer, mimeType: string, bucket?: string): Promise<string> {
    const b = bucket ?? this.bucket;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: b,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );
    return `${this.publicUrl}/${b}/${key}`;
  }

  async delete(key: string, bucket?: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: bucket ?? this.bucket, Key: key }));
  }

  async getObject(key: string, bucket?: string): Promise<{ body: Readable; contentType: string; contentLength: number }> {
    const b = bucket ?? this.bucket;
    const output = await this.s3.send(new GetObjectCommand({ Bucket: b, Key: key }));
    return {
      body: output.Body as Readable,
      contentType: output.ContentType ?? 'application/octet-stream',
      contentLength: output.ContentLength ?? 0,
    };
  }
}
