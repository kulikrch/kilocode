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

  it("sums generated characters across multiple tool diffs", () => {
    const write = ["--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1,2 @@", "+export const a = 1", "+export const b = 2"].join(
      "\n",
    )
    const edit = ["--- a/existing.ts", "+++ b/existing.ts", "@@ -1 +1,2 @@", "-old()", "+new()", "+extra()"].join(
      "\n",
    )

    expect(KiloAiCodeFlow.total([{ patch: write }, { patch: edit }])).toBe(48)
  })

  it("handles CRLF patches from Windows git output", () => {
    const patch = [
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1 +1,2 @@",
      "+const crlf = true",
      "+done()",
    ].join("\r\n")

    expect(KiloAiCodeFlow.chars({ patch })).toBe(23)
  })

  it("does not count pure deletions as generated code", () => {
    const patch = ["--- a/example.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-remove()", "-alsoRemove()"].join("\n")

    expect(KiloAiCodeFlow.chars({ patch })).toBe(0)
  })

  it("returns zero for empty patches", () => {
    expect(KiloAiCodeFlow.chars({ patch: "" })).toBe(0)
  })
})
