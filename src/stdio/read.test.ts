import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";

import { DEFAULT_STDIN_TIMEOUT_MS, readJsonFromStream } from "./read";

/** A Readable that emits `text` (in the given chunks) then ends. */
function streamOf(...chunks: string[]): Readable {
  return Readable.from(chunks);
}
/** A Readable that never pushes and never ends — exercises the timeout path. */
function neverEndingStream(): Readable {
  return new Readable({ read() {} });
}

describe("readJsonFromStream — posture-neutral T | null (AD-9.4 Rule 2)", () => {
  test("valid JSON → the parsed value (typed)", async () => {
    const v = await readJsonFromStream<{ a: number }>(streamOf('{"a":1}'));
    expect(v).toEqual({ a: 1 });
  });

  test("empty stdin → null", async () => {
    expect(await readJsonFromStream(streamOf(""))).toBeNull();
  });

  test("whitespace-only stdin → null", async () => {
    expect(await readJsonFromStream(streamOf("   \n  "))).toBeNull();
  });

  test("malformed JSON → null (never throws)", async () => {
    expect(await readJsonFromStream(streamOf("{not json"))).toBeNull();
  });

  test("multi-chunk JSON is reassembled before the parse", async () => {
    const v = await readJsonFromStream<{ a: number; b: number }>(streamOf('{"a":', '1,"b":', "2}"));
    expect(v).toEqual({ a: 1, b: 2 });
  });

  test("timeout → null; the promise resolves (never hangs) when the stream never ends", async () => {
    const start = Date.now();
    const v = await readJsonFromStream(neverEndingStream(), 40);
    expect(v).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000); // resolved via the 40ms override, not a hang
  });

  test("override timeout is honored — resolves fast, not at the 1000ms default", async () => {
    const start = Date.now();
    await readJsonFromStream(neverEndingStream(), 30);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("the default timeout is the generous 1000ms (AD-9.4 Rule 2.1)", () => {
    expect(DEFAULT_STDIN_TIMEOUT_MS).toBe(1000);
  });
});

describe("readStdinJson — reads the real process.stdin (subprocess smoke)", () => {
  // Proves the public export wires to process.stdin, not just the injected helper. Runs the barrel in a
  // child `bun` with piped stdin — the exact framing the hook harness uses.
  test("valid JSON on stdin → the parsed value", async () => {
    const script = `import { readStdinJson } from ${JSON.stringify(`${import.meta.dir}/index.ts`)};
      process.stdout.write(JSON.stringify(await readStdinJson()));`;
    const proc = Bun.spawn(["bun", "-e", script], { stdin: "pipe", stdout: "pipe" });
    proc.stdin.write('{"hello":"world"}');
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    expect(JSON.parse(out)).toEqual({ hello: "world" });
  });

  test("empty stdin → null", async () => {
    const script = `import { readStdinJson } from ${JSON.stringify(`${import.meta.dir}/index.ts`)};
      process.stdout.write(JSON.stringify(await readStdinJson()));`;
    const proc = Bun.spawn(["bun", "-e", script], { stdin: "pipe", stdout: "pipe" });
    await proc.stdin.end(); // no bytes written
    const out = await new Response(proc.stdout).text();
    expect(out).toBe("null");
  });
});
