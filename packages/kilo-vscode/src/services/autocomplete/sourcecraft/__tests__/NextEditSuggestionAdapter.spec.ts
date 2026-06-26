import { describe, expect, it } from "vitest"
import { noopNextEditSuggestionAdapter } from "../NextEditSuggestionAdapter"

describe("noopNextEditSuggestionAdapter", () => {
  it("returns no replace suggestions until a real backend contract is wired", async () => {
    const items = await noopNextEditSuggestionAdapter.getNextEdits({} as any, { isCancellationRequested: false } as any)

    expect(items).toEqual([])
  })
})

