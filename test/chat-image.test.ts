import assert from "node:assert/strict";
import { test } from "node:test";

import { boxImageUrl, localImagePath, sniffImage } from "@/lib/runtime/chat-image";

test("a reply's image is read off the box when it names a path, not a URL", () => {
  assert.equal(localImagePath(".context/tree.png"), ".context/tree.png");
  assert.equal(localImagePath("/tmp/shot%201.png"), "/tmp/shot 1.png");
  assert.equal(localImagePath("file:///home/daytona/w/a.png"), "/home/daytona/w/a.png");
  // Escapes are the name's, a query or fragment isn't.
  assert.equal(localImagePath(".context/shot%23one%26two.png"), ".context/shot#one&two.png");
  assert.equal(localImagePath(".context/shot.png?v=2#top"), ".context/shot.png");
  for (const url of ["https://x.dev/a.png", "http://x/a.png", "data:image/png;base64,AA", "blob:abc", "//cdn.x/a.png", "", undefined]) {
    assert.equal(localImagePath(url), null, String(url));
  }
});

test("only images' bytes pass, and never SVG", () => {
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(new TextEncoder().encode("GIF89a")), "image/gif");
  assert.equal(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")), null);
  assert.equal(sniffImage(new TextEncoder().encode("#!/bin/sh")), null);
});

test("the URL carries the path as one value", () => {
  assert.equal(boxImageUrl("w1", ".context/a b&c.png"), "/api/workspaces/w1/image?path=.context%2Fa%20b%26c.png");
});
