import { describe, expect, it, spyOn } from "bun:test"
import { Telemetry } from "@kilocode/kilo-telemetry"
import path from "path"
import { KiloAiCodeFlow } from "../../src/kilocode/telemetry/ai-code-flow"
import { tmpdir } from "../fixture/fixture"

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

  it("creates hashed chunks for generated lines without storing source text", () => {
    const patch = ["--- a/example.ts", "+++ b/example.ts", "@@ -1 +1,2 @@", "+const generated = true", "+done()"].join(
      "\n",
    )

    expect(KiloAiCodeFlow.chunks({ patch })).toEqual([
      { hash: expect.any(String), chars: 22 },
      { hash: expect.any(String), chars: 6 },
    ])
  })

  it("tracks sequential agent tool changes with session context", () => {
    const spy = spyOn(Telemetry, "trackAiCodeFlow").mockImplementation(() => {})
    try {
      KiloAiCodeFlow.track({
        diffs: [
          {
            file: "src/new.ts",
            patch: ["--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +1 @@", "+export const value = 1"].join("\n"),
            additions: 1,
            deletions: 0,
            status: "added",
          },
        ],
        sessionID: "ses_1",
        messageID: "msg_1",
        source: "tool",
        tool: "write",
      })

      KiloAiCodeFlow.track({
        diffs: [
          {
            file: "src/new.ts",
            patch: ["--- a/src/new.ts", "+++ b/src/new.ts", "@@ -1 +1,2 @@", " export const value = 1", "+value"].join(
              "\n",
            ),
            additions: 1,
            deletions: 0,
            status: "modified",
          },
          {
            file: "src/other.ts",
            patch: ["--- a/src/other.ts", "+++ b/src/other.ts", "@@ -1 +1 @@", "-old", "+newer"].join("\n"),
            additions: 1,
            deletions: 1,
            status: "modified",
          },
        ],
        sessionID: "ses_1",
        messageID: "msg_2",
        source: "tool",
        tool: "apply_patch",
      })

      expect(spy).toHaveBeenCalledTimes(2)
      expect(spy.mock.calls[0]?.[0]).toMatchObject({
        aiChars: 22,
        sessionId: "ses_1",
        messageId: "msg_1",
        files: 1,
        additions: 1,
        deletions: 0,
        source: "tool",
        tool: "write",
      })
      expect(spy.mock.calls[1]?.[0]).toMatchObject({
        aiChars: 10,
        sessionId: "ses_1",
        messageId: "msg_2",
        files: 2,
        additions: 2,
        deletions: 1,
        source: "tool",
        tool: "apply_patch",
      })
    } finally {
      spy.mockRestore()
    }
  })

  it("does not track agent tool calls that only remove code", () => {
    const spy = spyOn(Telemetry, "trackAiCodeFlow").mockImplementation(() => {})
    try {
      KiloAiCodeFlow.track({
        diffs: [
          {
            file: "src/remove.ts",
            patch: ["--- a/src/remove.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-removed()"].join("\n"),
            additions: 0,
            deletions: 1,
            status: "deleted",
          },
        ],
        sessionID: "ses_1",
        messageID: "msg_3",
        source: "tool",
        tool: "edit",
      })

      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it("stores agent contributions in the repository git directory", async () => {
    await using dir = await tmpdir({ git: true })
    const file = path.join(dir.path, "src", "agent.ts")
    await Bun.write(file, "export const value = 1\n")

    await KiloAiCodeFlow.record([
      {
        file,
        patch: ["--- /dev/null", "+++ b/src/agent.ts", "@@ -0,0 +1 @@", "+export const value = 1"].join("\n"),
        additions: 1,
        deletions: 0,
        status: "added",
      },
    ])

    const records = await Bun.file(path.join(dir.path, ".git", "kilo-ai-contributions.json")).json()
    expect(records).toMatchObject([
      {
        repo: dir.path.replace(/\\/g, "/"),
        file: "src/agent.ts",
        source: "agent",
        chars: 22,
        lines: 1,
        beforeHash: expect.any(String),
        afterHash: expect.any(String),
        patchHash: expect.any(String),
        chunks: [{ hash: expect.any(String), chars: 22 }],
      },
    ])
  })
})
