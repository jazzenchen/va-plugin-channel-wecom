import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedResponse } from "../dist/bounded-response.js";

test("rejects a declared oversized response before reading the body", async () => {
  let opened = false;
  const response = {
    headers: new Headers({ "content-length": "11" }),
    body: { getReader() { opened = true; throw new Error("body opened"); } },
  };
  await assert.rejects(() => readBoundedResponse(response, 10), /exceeds 10 bytes/);
  assert.equal(opened, false);
});

test("rejects a chunked response after crossing the streamed limit", async () => {
  await assert.rejects(
    () => readBoundedResponse(new Response(new Uint8Array([1, 2, 3, 4])), 3),
    /exceeds 3 bytes/,
  );
});
