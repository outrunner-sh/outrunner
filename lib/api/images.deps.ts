/**
 * Images sent inline (lib/api/images.ts), made uploads: a `url` fetched from
 * the public internet only (its host's addresses checked in the lookup the
 * socket connects with, as a webhook delivery's are), and each kept as the
 * caller's attachment, so it goes to the box with the prompt or message.
 */

import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

import { storeAttachment, uploadRoom } from "@/lib/api/attachments";
import { apiError } from "@/lib/api/errors";
import type { ApiContext } from "@/lib/api/handler";
import { imageFilename, imageTypeOf, type ImageInput, type ImageType } from "@/lib/api/images";
import { publicOnlyLookup } from "@/lib/api/webhook-lookup";
import { isPrivateAddress, webhookUrl } from "@/lib/api/webhooks";
import { MAX_ATTACHMENT_BYTES } from "@/lib/runtime/attachments";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

class ImageFetchError extends Error {}

/** GET `url` (https, public), following a few redirects that are too: its
 *  bytes and type, at most MAX_ATTACHMENT_BYTES. */
function fetchImage(url: string, redirects = 0): Promise<{ bytes: Buffer; mimeType: ImageType }> {
  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host)) return Promise.reject(new ImageFetchError("points at a private address"));
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      target,
      { method: "GET", headers: { accept: "image/*" }, lookup: publicOnlyLookup, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), timeout: FETCH_TIMEOUT_MS },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.destroy();
          const next = webhookUrl(new URL(res.headers.location, target).toString());
          if (!next || redirects >= MAX_REDIRECTS) return reject(new ImageFetchError("redirects somewhere it can't be fetched from"));
          return fetchImage(next, redirects + 1).then(resolve, reject);
        }
        if (status !== 200) {
          res.destroy();
          return reject(new ImageFetchError(`answered ${status}`));
        }
        const mimeType = imageTypeOf(res.headers["content-type"] ?? null);
        if (!mimeType) {
          res.destroy();
          return reject(new ImageFetchError("isn't a PNG, JPEG, GIF or WebP image"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ATTACHMENT_BYTES) {
            res.destroy();
            reject(new ImageFetchError(`is over ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB`));
          } else chunks.push(chunk);
        });
        res.on("end", () => (size > 0 ? resolve({ bytes: Buffer.concat(chunks), mimeType }) : reject(new ImageFetchError("is empty"))));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new ImageFetchError(`didn't answer in ${FETCH_TIMEOUT_MS / 1000}s`)));
    req.on("error", (error) => reject(error instanceof ImageFetchError ? error : new ImageFetchError(error.name === "AbortError" || error.name === "TimeoutError" ? `didn't answer in ${FETCH_TIMEOUT_MS / 1000}s` : "couldn't be reached")));
    req.end();
  });
}

/** `images` kept as the caller's uploads: their ids, in order, or the answer
 *  to give (an image that couldn't be fetched names which). */
export async function imagesToAttachments(context: ApiContext, images: readonly ImageInput[]): Promise<string[] | Response> {
  if (images.length === 0) return [];
  const full = await uploadRoom();
  if (full) return full;
  // Fetched together; kept in order, so the files are numbered as sent.
  const fetched = await Promise.all(
    images.map(async (image, index) => {
      if (image.kind === "data") return image;
      try {
        return await fetchImage(image.url);
      } catch (error) {
        const why = error instanceof ImageFetchError ? error.message : "couldn't be fetched";
        return apiError(400, `\`images[${index}]\`'s \`url\` ${why}.`);
      }
    }),
  );
  const refused = fetched.find((item): item is Response => item instanceof Response);
  if (refused) return refused;
  const ids: string[] = [];
  for (const [index, image] of (fetched as { bytes: Buffer; mimeType: ImageType }[]).entries()) {
    const file = new File([new Uint8Array(image.bytes)], imageFilename(index, image.mimeType), { type: image.mimeType });
    const stored = await storeAttachment(context, file);
    if (stored instanceof Response) return stored;
    ids.push(stored.id);
  }
  return ids;
}
