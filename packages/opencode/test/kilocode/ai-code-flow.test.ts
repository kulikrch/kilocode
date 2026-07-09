import { describe, expect, it } from "bun:test"
import { KiloAiCodeFlow } from "../../src/kilocode/telemetry/ai-code-flow"

describe("KiloAiCodeFlow", () => {
  it("counts added characters from unified diff additions", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "index 1111111..2222222 100644",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1 +1,2 @@",
      " const kept = true",
      "+const added = 123",
      "+return added",
    ].join("\n")

    expect(KiloAiCodeFlow.chars({ patch })).toBe(29)
  })

  it("ignores diff headers and deleted lines", () => {
    const patch = [
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n")

    expect(KiloAiCodeFlow.chars({ patch })).toBe(3)
  })
})
