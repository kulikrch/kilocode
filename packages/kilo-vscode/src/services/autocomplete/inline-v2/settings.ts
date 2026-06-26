import * as vscode from "vscode"
import { AUTOCOMPLETE_CONFIG } from "./constants"
import type { InlineV2AutocompleteSettings } from "./types"

export const DEFAULT_INLINE_V2_AUTOCOMPLETE_SETTINGS: InlineV2AutocompleteSettings = {
  enableNextEditSuggestion: false,
  enableEmptyIndicator: true,
  enableLoadingIndicator: true,
  enableEmptyLineHint: true,
  delayedRequestTimeoutMs: 200,
}

const MIN_DELAY_MS = 200

export function normalizeInlineV2AutocompleteSettings(
  settings: Partial<InlineV2AutocompleteSettings> = {},
): InlineV2AutocompleteSettings {
  return {
    ...DEFAULT_INLINE_V2_AUTOCOMPLETE_SETTINGS,
    ...settings,
    delayedRequestTimeoutMs: Math.max(
      settings.delayedRequestTimeoutMs ?? DEFAULT_INLINE_V2_AUTOCOMPLETE_SETTINGS.delayedRequestTimeoutMs,
      MIN_DELAY_MS,
    ),
  }
}

export function getInlineV2AutocompleteSettings(context: vscode.ExtensionContext): InlineV2AutocompleteSettings {
  const config = vscode.workspace.getConfiguration(AUTOCOMPLETE_CONFIG)
  return normalizeInlineV2AutocompleteSettings({
    enableNextEditSuggestion:
      context.globalState.get<boolean>("enableNextEditSuggestion") ??
      config.get<boolean>("enableNextEditSuggestion"),
    enableEmptyIndicator:
      context.globalState.get<boolean>("enableEmptyIndicator") ?? config.get<boolean>("enableEmptyIndicator"),
    enableLoadingIndicator:
      context.globalState.get<boolean>("enableLoadingIndicator") ?? config.get<boolean>("enableLoadingIndicator"),
    enableEmptyLineHint:
      context.globalState.get<boolean>("enableEmptyLineHint") ?? config.get<boolean>("enableEmptyLineHint"),
    delayedRequestTimeoutMs:
      context.globalState.get<number>("delayedRequestTimeoutMs") ?? config.get<number>("delayedRequestTimeoutMs"),
  })
}
