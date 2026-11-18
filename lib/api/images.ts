/**
 * Images sent inline with a prompt or a message (`images`), the parts with
 * no network: what one may be, and what it's called once it's a file. Each
 * is base64 `data` with its `mime_type`, or an https `url` Outrunner fetches;
 * either way it lands on the box as an upload would (POST /attachments), so
 * the agent sees it. lib/api/images.deps.ts fetches and stores them.
 */

import { webhookUrl } from "@/lib/api/webhooks";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/runtime/attachments";

/** The image types a model is sent as images. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export type ImageInput = { kind: "data"; bytes: Buffer; mimeType: ImageType } | { kind: "url"; url: string };

const EXTENSIONS: Record<ImageType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export function isImageType(value: unknown): value is ImageType {
  return typeof value === "string" && (IMAGE_TYPES as readonly string[]).includes(value.toLowerCase());
}

/** The type a fetched image's Content-Type names, or null for one that isn't an image we send. */
export function imageTypeOf(contentType: string | null): ImageType | null {
  const type = contentType?.split(";")[0].trim().toLowerCase() ?? "";
  return isImageType(type) ? type : null;
}

/** An image's file name on the box: `image-2.png`, numbered from 1. */
export function imageFilename(index: number, mimeType: ImageType): string {
  return `image-${index + 1}.${EXTENSIONS[mimeType]}`;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * `images` as posted (none is an empty list), or the reason they're refused.
 * `mime_type` is also taken as `mimeType`, as clients written for Cursor's
 * API send it, and a `data:` URL as `data`. `alongside` is how many files
 * the request names already (`attachment_ids`): together they're as many as
 * one message takes.
 */
export function parseImages(value: unknown, alongside = 0): ImageInput[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return "`images` is a list of `{ data, mime_type }` or `{ url }`.";
  if (value.length + alongside > MAX_ATTACHMENTS_PER_MESSAGE) return `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} files and images go with one message.`;
  const mb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
  const images: ImageInput[] = [];
  for (const [index, item] of value.entries()) {
    const which = `\`images[${index}]\``;
    if (!item || typeof item !== "object" || Array.isArray(item)) return `${which} is \`{ data, mime_type }\` or \`{ url }\`.`;
    const { data, url } = item as { data?: unknown; url?: unknown };
    if ((data === undefined) === (url === undefined)) return `${which} has either \`data\` or \`url\`.`;
    if (url !== undefined) {
      const checked = webhookUrl(url);
      if (!checked) return `${which}'s \`url\` is an https address on the public internet.`;
      images.push({ kind: "url", url: checked });
      continue;
    }
    if (typeof data !== "string" || !data) return `${which}'s \`data\` is the image, base64.`;
    const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/.exec(data);
    const given = (item as { mime_type?: unknown; mimeType?: unknown }).mime_type ?? (item as { mimeType?: unknown }).mimeType ?? dataUrl?.[1];
    // image/jpg isn't a type, but clients send it for JPEGs.
    const mimeType = typeof given === "string" && given.trim().toLowerCase() === "image/jpg" ? "image/jpeg" : given;
    if (!isImageType(mimeType)) return `${which}'s \`mime_type\` (or \`mimeType\`) is one of ${IMAGE_TYPES.join(", ")}.`;
    const encoded = (dataUrl ? dataUrl[2] : data).replace(/\s+/g, "");
    // A length check first: a body far over the cap isn't decoded to find out.
    if (encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) return `${which} is over ${mb} MB.`;
    if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) return `${which}'s \`data\` isn't base64.`;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0) return `${which} is empty.`;
    images.push({ kind: "data", bytes, mimeType: mimeType.toLowerCase() as ImageType });
  }
  return images;
}
