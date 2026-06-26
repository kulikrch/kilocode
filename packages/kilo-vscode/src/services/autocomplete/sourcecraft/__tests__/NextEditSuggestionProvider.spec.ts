import { describe, expect, it } from "bun:test"

describe("next edit line helpers", () => {
  it("splits LF and CRLF replace blocks without trailing empty line", async () => {
    const { splitEditLines } = await import("../NextEditSuggestionProvider")

    expect(splitEditLines("a\nb\n")).toEqual(["a", "b"])
    expect(splitEditLines("a\r\nb\r\n")).toEqual(["a", "b"])
    expect(splitEditLines("")).toEqual([])
  })

  it("keeps single-line edits as a single preview block", async () => {
    const { splitEditLines } = await import("../NextEditSuggestionProvider")

    expect(splitEditLines("newApiCall()")).toEqual(["newApiCall()"])
  })
})
