import * as vscode from "vscode"
import { AUTOCOMPLETE_CONFIG } from "./constants"
import type { SourceCraftAutocompleteSettings } from "./types"

export const DEFAULT_SOURCECRAFT_AUTOCOMPLETE_SETTINGS: SourceCraftAutocompleteSettings = {
  enableNextEditSuggestion: false,
  enableEmptyIndicator: true,
  enableLoadingIndicator: true,
  enableEmptyLineHint: true,
  delayedRequestTimeoutMs: 200,
}

const MIN_DELAY_MS = 200

export function normalizeSourceCraftAutocompleteSettings(
  settings: Partial<SourceCraftAutocompleteSettings> = {},
): SourceCraftAutocompleteSettings {
  return {
    ...DEFAULT_SOURCECRAFT_AUTOCOMPLETE_SETTINGS,
    ...settings,
    delayedRequestTimeoutMs: Math.max(
      settings.delayedRequestTimeoutMs ?? DEFAULT_SOURCECRAFT_AUTOCOMPLETE_SETTINGS.delayedRequestTimeoutMs,
      MIN_DELAY_MS,
    ),
  }
}

export function getSourceCraftAutocompleteSettings(context: vscode.ExtensionContext): SourceCraftAutocompleteSettings {
  const config = vscode.workspace.getConfiguration(AUTOCOMPLETE_CONFIG)
  return normalizeSourceCraftAutocompleteSettings({
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
