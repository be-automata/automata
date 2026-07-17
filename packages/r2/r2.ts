import {
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Dual-driver R2 access, mirroring the DB dual-driver:
 *   - Off Workers (self-host :3100, tests → MinIO): the S3 client (needs creds).
 *   - On Workers: the NATIVE R2 binding (env.<BUCKET>), no S3 credentials at all.
 *
 * Selection is per-operation via an injected `resolveBinding()` — the binding is
 * only reachable inside a request on Workers (getCloudflareContext), while the
 * R2Client singletons are constructed at module load, so the app injects a lazy
 * resolver and each op picks native when the binding is present, else S3. This
 * keeps packages/r2 framework-agnostic (no @opennextjs/cloudflare import here).
 *
 * Presigned upload URLs do NOT exist on native bindings (S3-SDK only). In native
 * mode `generatePresignedUploadUrl` returns a same-origin Worker upload-proxy URL
 * (see the app's /api/r2-upload route) so the client's existing "PUT the file to
 * the returned URL" flow is unchanged and needs zero credentials.
 */

/** The subset of the Workers `R2Bucket` binding this package uses. */
export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  head(
    key: string,
  ): Promise<{ httpMetadata?: { contentType?: string } } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    objects: Array<{
      key: string;
      size: number;
      uploaded: Date;
      httpEtag?: string;
    }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface R2ListResult {
  objects: Array<{
    key: string;
    size: number;
    lastModified: Date;
    etag?: string;
  }>;
  isTruncated: boolean;
  nextContinuationToken?: string;
}

interface R2Config {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
  bucketName: string;
  endpoint?: string;
  publicUrl?: string;
  /**
   * Lazy accessor for the native R2 binding (Workers). Returns the binding when
   * running on Workers within a request, else null/undefined (→ S3 path). The app
   * wires this to `getCloudflareContext().env.<BINDING>`.
   */
  resolveBinding?: () => R2BucketLike | null | undefined;
  /**
   * Same-origin path the native driver points browser uploads at (the Worker
   * upload proxy). Required for `generatePresignedUploadUrl` in native mode.
   */
  uploadProxyPath?: string;
}

class R2Client {
  private s3Client: S3Client;
  private bucketName: string;
  private publicUrl?: string;
  private resolveBinding?: () => R2BucketLike | null | undefined;
  private uploadProxyPath?: string;

  public constructor(config: R2Config) {
    const {
      accessKeyId,
      secretAccessKey,
      accountId,
      bucketName,
      publicUrl,
      endpoint,
      resolveBinding,
      uploadProxyPath,
    } = config;

    this.bucketName = bucketName;
    this.publicUrl = publicUrl;
    this.resolveBinding = resolveBinding;
    this.uploadProxyPath = uploadProxyPath;
    const r2Endpoint =
      endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`;

    this.s3Client = new S3Client({
      region: "auto",
      endpoint: r2Endpoint,
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
      },
    });
  }

  /** The native binding when on Workers within a request, else null (→ S3). */
  private binding(): R2BucketLike | null {
    return this.resolveBinding?.() ?? null;
  }

  public async generatePresignedUploadUrl(
    filename: string,
    contentType: string,
    maxSizeInBytes?: number,
    options?: { skipPrefix?: boolean },
  ) {
    const r2Key = options?.skipPrefix
      ? filename
      : `uploads/${crypto.randomUUID()}-${filename}`;

    // Native binding: no S3 presigning. Route the browser upload through the
    // same-origin Worker proxy — the client PUTs the file to this URL exactly as
    // it would a presigned URL, and the proxy writes it with the binding.
    const bucket = this.binding();
    if (bucket) {
      if (!this.uploadProxyPath) {
        throw new Error(
          "R2 native binding is active but no uploadProxyPath configured for presigned uploads",
        );
      }
      const presignedUrl = `${this.uploadProxyPath}?key=${encodeURIComponent(
        r2Key,
      )}&bucket=${encodeURIComponent(this.bucketName)}`;
      return { presignedUrl, r2Key };
    }

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: r2Key,
      ContentType: contentType,
      ...(maxSizeInBytes && {
        ContentLength: maxSizeInBytes,
      }),
    });

    try {
      const expiresInSeconds = 15 * 60;
      const presignedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: expiresInSeconds,
      });

      console.log(`Successfully generated pre-signed URL for ${r2Key}`);
      return { presignedUrl, r2Key };
    } catch (error) {
      console.error("Error generating pre-signed URL:", error);
      throw new Error(
        `Failed to generate R2 pre-signed URL: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Writes an object to the bucket. Used by the Worker upload proxy (native) and
   * available for server-side puts. Native → binding.put; else S3 PutObject.
   */
  public async putObject(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType?: string,
  ): Promise<void> {
    const bucket = this.binding();
    if (bucket) {
      await bucket.put(key, body, {
        httpMetadata: contentType ? { contentType } : undefined,
      });
      return;
    }
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }

  /**
   * Gets the content type of an object, or null if not found.
   */
  public async getContentType(r2Key: string): Promise<string | null> {
    const bucket = this.binding();
    if (bucket) {
      try {
        const head = await bucket.head(r2Key);
        return head?.httpMetadata?.contentType ?? null;
      } catch (error) {
        console.error(`Error getting content type for ${r2Key}:`, error);
        return null;
      }
    }
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: r2Key,
      });

      const response = await this.s3Client.send(command);
      return response.ContentType || null;
    } catch (error) {
      console.error(`Error getting content type for ${r2Key}:`, error);
      return null;
    }
  }

  // Helper function to construct public R2 URLs.
  public getPublicR2Url(r2Key: string | null | undefined): string | null {
    if (!r2Key) {
      return null;
    }
    if (!this.publicUrl) {
      throw new Error(
        "Public URL not set for R2 client. Is this bucket meant to be private?",
      );
    }
    return `${this.publicUrl}/${r2Key}`;
  }

  /**
   * Deletes an object from the bucket.
   */
  public async deleteObject(r2Key: string): Promise<void> {
    const bucket = this.binding();
    if (bucket) {
      try {
        await bucket.delete(r2Key);
        console.log(`Successfully deleted object: ${r2Key}`);
        return;
      } catch (error) {
        console.error(`Error deleting object ${r2Key}:`, error);
        throw new Error(
          `Failed to delete R2 object: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: r2Key,
      });

      await this.s3Client.send(command);
      console.log(`Successfully deleted object: ${r2Key}`);
    } catch (error) {
      console.error(`Error deleting object ${r2Key}:`, error);
      throw new Error(
        `Failed to delete R2 object: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Lists objects in the bucket.
   */
  public async listObjects(
    prefix?: string,
    maxKeys: number = 1000,
    continuationToken?: string,
  ): Promise<R2ListResult> {
    const bucket = this.binding();
    if (bucket) {
      try {
        const response = await bucket.list({
          prefix,
          limit: maxKeys,
          cursor: continuationToken,
        });
        return {
          objects: response.objects.map((obj) => ({
            key: obj.key,
            size: obj.size,
            lastModified: obj.uploaded,
            etag: obj.httpEtag,
          })),
          isTruncated: response.truncated,
          nextContinuationToken: response.cursor,
        };
      } catch (error) {
        console.error(`Error listing objects:`, error);
        throw new Error(
          `Failed to list R2 objects: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        MaxKeys: maxKeys,
        ContinuationToken: continuationToken,
      });

      const response = await this.s3Client.send(command);

      const objects = (response.Contents || []).map((obj) => ({
        key: obj.Key!,
        size: obj.Size || 0,
        lastModified: obj.LastModified!,
        etag: obj.ETag,
      }));

      return {
        objects,
        isTruncated: response.IsTruncated || false,
        nextContinuationToken: response.NextContinuationToken,
      };
    } catch (error) {
      console.error(`Error listing objects:`, error);
      throw new Error(
        `Failed to list R2 objects: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Downloads an object as a Buffer.
   */
  public async downloadData(key: string): Promise<Buffer> {
    const bucket = this.binding();
    if (bucket) {
      try {
        const object = await bucket.get(key);
        if (!object) {
          throw new Error("No data returned from R2");
        }
        return Buffer.from(await object.arrayBuffer());
      } catch (error) {
        console.error(`Error downloading data from ${key}:`, error);
        throw new Error(
          `Failed to download from R2: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new Error("No data returned from R2");
      }

      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      console.error(`Error downloading data from ${key}:`, error);
      throw new Error(
        `Failed to download from R2: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export { R2Client };
