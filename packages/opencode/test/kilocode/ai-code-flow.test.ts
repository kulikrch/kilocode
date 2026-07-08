import { describe, expect, test } from "bun:test"
import { KiloAiCodeFlow } from "../../src/kilocode/snapshot/ai-code-flow"
import type { Snapshot } from "../../src/snapshot"

function diff(patch: string): Snapshot.FileDiff {
  return {
    file: "src/app.ts",
    patch,
    additions: 0,
    deletions: 0,
    status: "modified",
  }
}

describe("KiloAiCodeFlow", () => {
  test("counts added patch payload characters", () => {
    const chars = KiloAiCodeFlow.chars(
      diff(
        [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1,3 @@",
          " const a = 1",
          "+const b = 2",
          "+",
          "+return a + b",
          "-return a",
        ].join("\n"),
      ),
    )

    expect(chars).toBe("const b = 2".length + "return a + b".length)
  })

  test("sums multiple file diffs and ignores metadata-only patches", () => {
    expect(
      KiloAiCodeFlow.total([
        diff("+++ b/a.ts\n+alpha"),
        diff("+++ b/b.ts\n+beta\n context\n-gamma"),
        diff(""),
      ]),
    ).toBe("alpha".length + "beta".length)
  })
})
