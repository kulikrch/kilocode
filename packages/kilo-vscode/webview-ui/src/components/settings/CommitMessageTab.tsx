import { Component, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { Switch } from "@kilocode/kilo-ui/switch"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Card } from "@kilocode/kilo-ui/card"
import { Select } from "@kilocode/kilo-ui/select"
import { useConfig } from "../../context/config"
import { LOCALES, LOCALE_LABELS, useLanguage } from "../../context/language"
import type { Locale } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"
import SettingsRow from "./SettingsRow"

const SYNC = "sync"
const opts = [SYNC, ...LOCALES] as const
type Option = typeof SYNC | Locale

const CommitMessageTab: Component = () => {
  const { config, updateConfig } = useConfig()
  const vscode = useVSCode()
  const language = useLanguage()

  const [lang, setLang] = createSignal<Option>(SYNC)
  const [expanded, setExpanded] = createSignal(Boolean(config().commit_message?.prompt))

  const unsubscribe = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type !== "commitMessageSettingsLoaded") return
    setLang((opts as readonly string[]).includes(message.language) ? (message.language as Option) : SYNC)
  })

  onCleanup(unsubscribe)
  vscode.postMessage({ type: "requestCommitMessageSettings" })

  const toggle = (checked: boolean) => {
    setExpanded(checked)
    if (!checked) {
      updateConfig({ commit_message: { prompt: "" } })
    }
  }

  const label = (opt: Option) =>
    opt === SYNC ? language.t("settings.commitMessage.language.sync") : LOCALE_LABELS[opt]

  const value = (opt: Option) => opt

  const select = (opt: Option | undefined) => {
    if (opt === undefined) return
    setLang(opt)
    vscode.postMessage({ type: "updateSetting", key: "languageCommitMessage", value: opt })
  }

  const currentLabel = createMemo(() => label(lang()))

  return (
    <div>
      <Card>
        <div style={{ padding: "16px" }}>
          <p style={{ "font-size": "var(--kilo-font-size-13)", "margin-bottom": "12px" }}>
            {language.t("settings.commitMessage.language.description")}
          </p>
          <Select
            options={[...opts]}
            current={lang()}
            label={label}
            value={value}
            onSelect={select}
            variant="secondary"
            size="large"
          />
          <p
            style={{
              "font-size": "var(--kilo-font-size-12)",
              color: "var(--vscode-descriptionForeground)",
              "margin-top": "8px",
            }}
          >
            {language.t("settings.language.current")} {currentLabel()}
          </p>
        </div>

        <div style={{ "border-bottom": "1px solid var(--border-weak-base)" }} />

        <SettingsRow
          title={language.t("settings.commitMessage.override.title")}
          description={language.t("settings.commitMessage.override.description")}
          last={!expanded()}
        >
          <Switch checked={expanded()} onChange={toggle} hideLabel>
            {language.t("settings.commitMessage.override.title")}
          </Switch>
        </SettingsRow>

        <Show when={expanded()}>
          <div style={{ "padding-top": "8px" }}>
            <div data-slot="settings-row-label-title" style={{ "margin-bottom": "4px" }}>
              {language.t("settings.commitMessage.prompt.title")}
            </div>
            <div data-slot="settings-row-label-subtitle" style={{ "margin-bottom": "8px" }}>
              {language.t("settings.commitMessage.prompt.description")}
            </div>
            <div style={{ "max-height": "300px", overflow: "auto" }}>
              <TextField
                value={config().commit_message?.prompt ?? ""}
                placeholder={language.t("settings.commitMessage.prompt.placeholder")}
                multiline
                onChange={(val) => {
                  updateConfig({ commit_message: { prompt: val } })
                }}
              />
            </div>
          </div>
        </Show>
      </Card>
    </div>
  )
}

export default CommitMessageTab
