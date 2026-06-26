import { describe, expect, it } from "vitest"
import {
  DEFAULT_SOURCECRAFT_AUTOCOMPLETE_SETTINGS,
  normalizeSourceCraftAutocompleteSettings,
} from "../settings"

describe("normalizeSourceCraftAutocompleteSettings", () => {
  it("uses conservative defaults for optional UX features", () => {
    expect(normalizeSourceCraftAutocompleteSettings()).toEqual(DEFAULT_SOURCECRAFT_AUTOCOMPLETE_SETTINGS)
  })

  it("clamps request delay to 200ms", () => {
    expect(normalizeSourceCraftAutocompleteSettings({ delayedRequestTimeoutMs: 1 }).delayedRequestTimeoutMs).toBe(200)
  })

  it("preserves explicit indicator and next-edit settings", () => {
    expect(
      normalizeSourceCraftAutocompleteSettings({
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

