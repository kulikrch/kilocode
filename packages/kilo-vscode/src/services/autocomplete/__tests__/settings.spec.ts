import { beforeEach, describe, expect, it, vi } from "vitest"

const state = new Map<string, unknown>()
const update = vi.fn((key: string, value: unknown) => {
  state.set(key, value)
})

vi.mock("vscode", () => ({
  ConfigurationTarget: {
    Global: 1,
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, fallback: unknown) => state.get(key) ?? fallback),
      update,
    })),
    onDidChangeConfiguration: vi.fn(),
  },
}))

describe("autocomplete settings", () => {
  beforeEach(() => {
    state.clear()
    update.mockClear()
  })

  it("includes the configured model in loaded settings", async () => {
    state.set("model", "inception/mercury-edit")
    const { buildAutocompleteSettingsMessage } = await import("../settings")

    expect(buildAutocompleteSettingsMessage().settings.model).toBe("inception/mercury-edit")
  })

  it("defaults to codestral when no model is set", async () => {
    const { buildAutocompleteSettingsMessage } = await import("../settings")

    expect(buildAutocompleteSettingsMessage().settings.model).toBe("mistralai/codestral-2508")
  })

  it("defaults to codestral when stored model is no longer supported", async () => {
    state.set("model", "some/removed-model")
    const { buildAutocompleteSettingsMessage } = await import("../settings")

    expect(buildAutocompleteSettingsMessage().settings.model).toBe("mistralai/codestral-2508")
  })

  it("validates supported model updates", async () => {
    const { validAutocompleteSetting } = await import("../settings")

    expect(validAutocompleteSetting("model", "inception/mercury-edit")).toBe(true)
  })

  it("rejects unsupported model updates", async () => {
    const { validAutocompleteSetting } = await import("../settings")

    expect(validAutocompleteSetting("model", "other/model")).toBe(false)
  })

  it("rejects non-boolean toggle updates", async () => {
    const { validAutocompleteSetting } = await import("../settings")

    expect(validAutocompleteSetting("enableAutoTrigger", "true")).toBe(false)
  })

  it("includes InlineV2 UX settings in loaded settings", async () => {
    state.set("enableNextEditSuggestion", true)
    state.set("enableEmptyIndicator", false)
    state.set("enableLoadingIndicator", false)
    state.set("enableEmptyLineHint", false)
    state.set("delayedRequestTimeoutMs", 450)
    const { buildAutocompleteSettingsMessage } = await import("../settings")

    expect(buildAutocompleteSettingsMessage().settings).toMatchObject({
      enableNextEditSuggestion: true,
      enableEmptyIndicator: false,
      enableLoadingIndicator: false,
      enableEmptyLineHint: false,
      delayedRequestTimeoutMs: 450,
    })
  })

  it("validates InlineV2 UX settings", async () => {
    const { validAutocompleteSetting } = await import("../settings")

    expect(validAutocompleteSetting("enableNextEditSuggestion", true)).toBe(true)
    expect(validAutocompleteSetting("enableEmptyIndicator", true)).toBe(true)
    expect(validAutocompleteSetting("enableLoadingIndicator", true)).toBe(true)
    expect(validAutocompleteSetting("enableEmptyLineHint", true)).toBe(true)
    expect(validAutocompleteSetting("delayedRequestTimeoutMs", 200)).toBe(true)
    expect(validAutocompleteSetting("delayedRequestTimeoutMs", 199)).toBe(false)
  })
})
