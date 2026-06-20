import { SandboxProcessStream } from "../lib/resources/abstraction/sandbox";

// Minimal mock of SandboxProcess — only `status()` is used by the iterator
function makeMockProcess(exitCode: number = 0) {
  return {
    status: jest.fn().mockResolvedValue([exitCode, "done"]),
  } as any;
}

describe("SandboxProcessStream async iterator", () => {
  test("yields all lines from a multi-line buffer", async () => {
    const output = "line1\nline2\nline3\n";
    let callCount = 0;

    const stream = new SandboxProcessStream(
      makeMockProcess(0),
      () => {
        // Return the full output on the first call, then empty
        if (callCount++ === 0) return output;
        return output; // same content means no new data
      }
    );

    const lines: string[] = [];
    for await (const line of stream) {
      lines.push(line);
    }

    expect(lines).toEqual(["line1\n", "line2\n", "line3\n"]);
  });

  test("yields lines correctly when output arrives in chunks", async () => {
    const chunks = ["hello\nworld", "\nfoo\n"];
    let callCount = 0;
    let accumulated = "";

    const stream = new SandboxProcessStream(
      makeMockProcess(0),
      () => {
        if (callCount < chunks.length) {
          accumulated += chunks[callCount++];
        }
        return accumulated;
      }
    );

    const lines: string[] = [];
    for await (const line of stream) {
      lines.push(line);
    }

    expect(lines).toEqual(["hello\n", "world\n", "foo\n"]);
  });

  test("yields final partial line without trailing newline", async () => {
    const output = "line1\nno-newline-at-end";
    let callCount = 0;

    const stream = new SandboxProcessStream(
      makeMockProcess(0),
      () => {
        if (callCount++ === 0) return output;
        return output;
      }
    );

    const lines: string[] = [];
    for await (const line of stream) {
      lines.push(line);
    }

    expect(lines).toEqual(["line1\n", "no-newline-at-end"]);
  });

  test("handles single line with newline", async () => {
    const output = "only-line\n";
    let callCount = 0;

    const stream = new SandboxProcessStream(
      makeMockProcess(0),
      () => {
        if (callCount++ === 0) return output;
        return output;
      }
    );

    const lines: string[] = [];
    for await (const line of stream) {
      lines.push(line);
    }

    expect(lines).toEqual(["only-line\n"]);
  });

  test("recovers new data when server buffer rotates (drops old data from front)", async () => {
    // Simulate a server with a fixed-size stdout buffer of 15 chars.
    // Once output exceeds that, old data is dropped from the front.
    const BUFFER_SIZE = 15;
    const allLines = [
      "AAAA\n", // cumulative: 5  chars
      "BBBB\n", // cumulative: 10 chars
      "CCCC\n", // cumulative: 15 chars — buffer full
      "DDDD\n", // cumulative: 20 chars — "AAAA\n" dropped from front
      "EEEE\n", // cumulative: 25 chars — "BBBB\n" dropped from front
    ];

    // Build the sequence of server responses, trimming the front at BUFFER_SIZE
    let fullOutput = "";
    const serverResponses: string[] = [];
    for (const line of allLines) {
      fullOutput += line;
      if (fullOutput.length > BUFFER_SIZE) {
        fullOutput = fullOutput.slice(fullOutput.length - BUFFER_SIZE);
      }
      serverResponses.push(fullOutput);
    }
    // serverResponses:
    // [0] "AAAA\n"              (5 chars)
    // [1] "AAAA\nBBBB\n"        (10 chars)
    // [2] "AAAA\nBBBB\nCCCC\n"  (15 chars) — buffer full
    // [3] "BBBB\nCCCC\nDDDD\n"  (15 chars) — "AAAA\n" dropped
    // [4] "CCCC\nDDDD\nEEEE\n"  (15 chars) — "BBBB\n" dropped

    let fetchIndex = 0;
    const stream = new SandboxProcessStream(
      makeMockProcess(0),
      () => {
        if (fetchIndex < serverResponses.length) {
          return serverResponses[fetchIndex++];
        }
        return serverResponses[serverResponses.length - 1];
      }
    );

    const lines: string[] = [];
    for await (const line of stream) {
      lines.push(line);
    }

    expect(lines).toEqual([
      "AAAA\n",
      "BBBB\n",
      "CCCC\n",
      "DDDD\n",
      "EEEE\n",
    ]);
  });

  test("returns entire output when rotation leaves no overlap with previous buffer", async () => {
    // Simulate a server where the buffer is completely replaced between
    // two consecutive fetches — zero characters in common.
    const serverResponses = [
      "AAAA\nBBBB\n",   // fetch 0: initial data
      "CCCC\nDDDD\n",   // fetch 1: completely different content (no overlap)
    ];

    let fetchIndex = 0;
    const stream = new SandboxProcessStream(
      makeMockProcess(0),
      () => {
        if (fetchIndex < serverResponses.length) {
          return serverResponses[fetchIndex++];
        }
        return serverResponses[serverResponses.length - 1];
      }
    );

    const lines: string[] = [];
    for await (const line of stream) {
      lines.push(line);
    }

    // With no overlap the fallback returns the entire new buffer,
    // which may duplicate data already yielded — but duplicates are
    // preferable to silent data loss.
    expect(lines).toEqual([
      "AAAA\n",
      "BBBB\n",
      "CCCC\n",
      "DDDD\n",
    ]);
  });
});
