import { InstallationVersion } from "@/installation/version"

export const DEFAULT_HEADERS = {
  "HTTP-Referer": "https://tmp_not_exist_for_test.ru",
  "X-Title": "Kilo Code",
  "User-Agent": `Kilo-Code/${InstallationVersion}`,
}
