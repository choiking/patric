import { expect, test } from "bun:test";
import { parseNdjsonStream, parseSseStream } from "./stream.js";

function fragmentedResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      // Split even multibyte UTF-8 characters across network chunks.
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    }
  }));
}

test("SSE parser preserves fragmented Unicode payloads and ignores stream terminators", async () => {
  const events: string[] = [];
  await parseSseStream(fragmentedResponse('event: message\ndata: {"text":"你好"}\n\ndata: {"text":"next"}\n\ndata: [DONE]\n\n'), value => events.push(value));
  expect(events).toEqual(['{"text":"你好"}', '{"text":"next"}']);
});

test("NDJSON parser preserves fragmented payloads and a final line without a newline", async () => {
  const events: string[] = [];
  await parseNdjsonStream(fragmentedResponse('{"text":"你好"}\n\n{"done":true}'), value => events.push(value));
  expect(events).toEqual(['{"text":"你好"}', '{"done":true}']);
});

test("stream parsers report a missing response body", async () => {
  await expect(parseSseStream(new Response(null), () => {})).rejects.toThrow("no stream body");
  await expect(parseNdjsonStream(new Response(null), () => {})).rejects.toThrow("no stream body");
});
