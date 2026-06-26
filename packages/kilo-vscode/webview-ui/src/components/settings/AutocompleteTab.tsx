import { Component } from "solid-js"
import { Switch } from "@kilocode/kilo-ui/switch"
import { Card } from "@kilocode/kilo-ui/card"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import SettingsRow from "./SettingsRow"

const AutocompleteTab: Component<{ onNavigateToModels?: () => void }> = (props) => {
  const { settings, updateSetting } = useConfig()
  const language = useLanguage()

  const enabled = (key: string, fallback: boolean) => Boolean(settings()[key] ?? fallback)

  const save = (
    key:
      | "enableAutoTrigger"
      | "enableSmartInlineTaskKeybinding"
      | "enableChatAutocomplete"
      | "enableNextEditSuggestion"
      | "enableEmptyIndicator"
      | "enableLoadingIndicator"
      | "enableEmptyLineHint",
    value: boolean,
  ) => {
    updateSetting(`autocomplete.${key}`, value)
  }

  const saveDelay = (value: string) => {
    const ms = Math.max(Number(value) || 200, 200)
    updateSetting("autocomplete.delayedRequestTimeoutMs", ms)
  }

  return (
    <div data-component="autocomplete-settings">
      <Card>
        <SettingsRow
          title={language.t("settings.autocomplete.autoTrigger.title")}
          description={language.t("settings.autocomplete.autoTrigger.description")}
        >
          <Switch
            checked={enabled("autocomplete.enableAutoTrigger", true)}
            onChange={(checked) => save("enableAutoTrigger", checked)}
            hideLabel
          >
            {language.t("settings.autocomplete.autoTrigger.title")}
          </Switch>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.autocomplete.smartKeybinding.title")}
          description={language.t("settings.autocomplete.smartKeybinding.description")}
        >
          <Switch
            checked={enabled("autocomplete.enableSmartInlineTaskKeybinding", false)}
            onChange={(checked) => save("enableSmartInlineTaskKeybinding", checked)}
            hideLabel
          >
            {language.t("settings.autocomplete.smartKeybinding.title")}
          </Switch>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.autocomplete.chatAutocomplete.title")}
          description={language.t("settings.autocomplete.chatAutocomplete.description")}
        >
          <Switch
            checked={enabled("autocomplete.enableChatAutocomplete", false)}
            onChange={(checked) => save("enableChatAutocomplete", checked)}
            hideLabel
          >
            {language.t("settings.autocomplete.chatAutocomplete.title")}
          </Switch>
        </SettingsRow>

        <SettingsRow title="Enable next edit suggestions" description="Show related replace edit previews when available">
          <Switch
            checked={enabled("autocomplete.enableNextEditSuggestion", false)}
            onChange={(checked) => save("enableNextEditSuggestion", checked)}
            hideLabel
          >
            Enable next edit suggestions
          </Switch>
        </SettingsRow>

        <SettingsRow title="No-completion indicator" description="Show a gutter indicator when no suggestion is available">
          <Switch
            checked={enabled("autocomplete.enableEmptyIndicator", true)}
            onChange={(checked) => save("enableEmptyIndicator", checked)}
            hideLabel
          >
            No-completion indicator
          </Switch>
        </SettingsRow>

        <SettingsRow title="Loading indicator" description="Show a gutter indicator while autocomplete is loading">
          <Switch
            checked={enabled("autocomplete.enableLoadingIndicator", true)}
            onChange={(checked) => save("enableLoadingIndicator", checked)}
            hideLabel
          >
            Loading indicator
          </Switch>
        </SettingsRow>

        <SettingsRow title="Empty-line hint" description="Show a lightweight inline hint on empty editor lines">
          <Switch
            checked={enabled("autocomplete.enableEmptyLineHint", true)}
            onChange={(checked) => save("enableEmptyLineHint", checked)}
            hideLabel
          >
            Empty-line hint
          </Switch>
        </SettingsRow>

        <SettingsRow title="Request delay" description="Delay before sending an autocomplete request" last>
          <input
            type="number"
            min="200"
            value={String(settings()["autocomplete.delayedRequestTimeoutMs"] ?? 200)}
            onInput={(event) => saveDelay(event.currentTarget.value)}
            style={{
              width: "96px",
              padding: "4px 8px",
              color: "var(--vscode-input-foreground)",
              background: "var(--vscode-input-background)",
              border: "1px solid var(--vscode-input-border)",
              "border-radius": "4px",
            }}
          />
        </SettingsRow>
      </Card>
      <p
        data-slot="autocomplete-models-hint"
        style={{
          "margin-top": "20px",
          "font-size": "var(--kilo-font-size-12)",
          "text-align": "right",
          color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
        }}
      >
        <a
          href="#"
          style={{
            color: "var(--vscode-textLink-foreground)",
            "text-decoration": "none",
            cursor: "pointer",
          }}
          onClick={(e) => {
            e.preventDefault()
            props.onNavigateToModels?.()
          }}
        >
          {language.t("settings.autocomplete.modelsHint")}
        </a>
      </p>
    </div>
  )
}

export default AutocompleteTab
