import assert from "node:assert/strict";
import { test } from "node:test";

import { attachmentDisposition } from "@/lib/http/content-disposition";

test("a download keeps its name, and nothing in it escapes the header or the folder", () => {
  assert.equal(
    attachmentDisposition("/home/daytona/Downloads/outrunner-slack-icon.png"),
    `attachment; filename="outrunner-slack-icon.png"; filename*=UTF-8''outrunner-slack-icon.png`,
  );
  assert.equal(
    attachmentDisposition("résumé (1).pdf"),
    `attachment; filename="r_sum_ (1).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.pdf`,
  );
  // A quote, a backslash or a line break would end or split the header.
  assert.equal(
    attachmentDisposition('a"b\\c\r\nSet-Cookie: x.txt'),
    `attachment; filename="a_b_c__Set-Cookie_ x.txt"; filename*=UTF-8''a%22b%5Cc%0D%0ASet-Cookie%3A%20x.txt`,
  );
  // A dotfile would land hidden; a bare folder has no name.
  assert.equal(attachmentDisposition(".zshrc"), `attachment; filename="zshrc"; filename*=UTF-8''zshrc`);
  assert.match(attachmentDisposition("/w/dist/"), /^attachment; filename="file"; filename\*=UTF-8''file$/);
});
