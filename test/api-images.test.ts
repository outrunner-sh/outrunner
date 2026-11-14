import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCreate } from "@/lib/api/create-request";
import { imageFilename, imageTypeOf, parseImages, type ImageInput } from "@/lib/api/images";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/runtime/attachments";

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

test("an image is base64 data with its type, or an https url", () => {
  const images = parseImages([{ data: PNG, mime_type: "image/png" }, { url: "https://example.com/mock.png" }]) as ImageInput[];
  assert.equal(images.length, 2);
  assert.deepEqual(images[0], { kind: "data", bytes: Buffer.from(PNG, "base64"), mimeType: "image/png" });
  assert.deepEqual(images[1], { kind: "url", url: "https://example.com/mock.png" });
  assert.deepEqual(parseImages(undefined), []);
  assert.deepEqual(parseImages(null), []);
});

test("a client written for Cursor's API sends mimeType, and a data: URL is read as one", () => {
  assert.equal((parseImages([{ data: PNG, mimeType: "image/png" }]) as ImageInput[])[0].kind, "data");
  const [image] = parseImages([{ data: `data:image/webp;base64,${PNG}` }]) as ImageInput[];
  assert.equal(image.kind === "data" && image.mimeType, "image/webp");
});

test("anything else is refused, saying which image and why", () => {
  assert.match(parseImages("x") as string, /is a list/);
  assert.match(parseImages([{}]) as string, /images\[0\].*either/);
  assert.match(parseImages([{ data: PNG, url: "https://example.com/a.png" }]) as string, /either/);
  assert.match(parseImages([{ data: PNG }]) as string, /mime_type/);
  assert.match(parseImages([{ data: PNG, mime_type: "image/svg+xml" }]) as string, /mime_type/);
  assert.match(parseImages([{ data: "not base64!", mime_type: "image/png" }]) as string, /isn't base64/);
  assert.match(parseImages([{ data: "", mime_type: "image/png" }]) as string, /base64/);
  assert.match(parseImages([{ data: "A".repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4), mime_type: "image/png" }]) as string, /over/);
});

test("an image url is https on the public internet", () => {
  for (const url of ["http://example.com/a.png", "https://localhost/a.png", "https://10.0.0.5/a.png", "https://user:pw@example.com/a.png", "ftp://example.com/a.png"]) {
    assert.match(parseImages([{ url }]) as string, /https address on the public internet/, url);
  }
});

test("images and uploads together are as many as one message takes", () => {
  const one = { data: PNG, mime_type: "image/png" };
  assert.equal((parseImages(Array(MAX_ATTACHMENTS_PER_MESSAGE).fill(one)) as ImageInput[]).length, MAX_ATTACHMENTS_PER_MESSAGE);
  assert.match(parseImages(Array(MAX_ATTACHMENTS_PER_MESSAGE).fill(one), 1) as string, /Up to/);
});

test("a fetched image's type comes from its Content-Type", () => {
  assert.equal(imageTypeOf("image/JPEG; charset=binary"), "image/jpeg");
  assert.equal(imageTypeOf("text/html"), null);
  assert.equal(imageTypeOf(null), null);
});

test("images land on the box numbered, with their type's extension", () => {
  assert.equal(imageFilename(0, "image/png"), "image-1.png");
  assert.equal(imageFilename(2, "image/jpeg"), "image-3.jpg");
});

test("a create takes images beside its uploads", () => {
  const input = parseCreate({ project_id: "11111111-1111-4111-8111-111111111111", prompt: "match this mock", images: [{ data: PNG, mime_type: "image/png" }] });
  assert.equal(typeof input !== "string" && input.images.length, 1);
  assert.equal(typeof parseCreate({ project_id: "11111111-1111-4111-8111-111111111111", prompt: "x", images: [{ url: "http://x" }] }), "string");
});
