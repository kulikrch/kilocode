import { describe, expect, it } from "vitest"
import {
  DEFAULT_INLINE_V2_AUTOCOMPLETE_SETTINGS,
  normalizeInlineV2AutocompleteSettings,
} from "../settings"

describe("normalizeInlineV2AutocompleteSettings", () => {
  it("uses conservative defaults for optional UX features", () => {
    expect(normalizeInlineV2AutocompleteSettings()).toEqual(DEFAULT_INLINE_V2_AUTOCOMPLETE_SETTINGS)
  })

  it("clamps request delay to 200ms", () => {
    expect(normalizeInlineV2AutocompleteSettings({ delayedRequestTimeoutMs: 1 }).delayedRequestTimeoutMs).toBe(200)
  })

  it("preserves explicit indicator and next-edit settings", () => {
    expect(
      normalizeInlineV2AutocompleteSettings({
        enableNextEditSuggestion: true,
        enableEmptyIndicator: false,
        enableLoadingIndicator: false,
        enableEmptyLineHint: false,
        delayedRequestTimeoutMs: 650,
      }),
    ).toMatchObject({
      enableNextEditSuggestion: true,
      enableEmptyIndicator: false,
      enableLoadingIndicator: false,
      enableEmptyLineHint: false,
      delayedRequestTimeoutMs: 650,
    })
  })
})
