import { Telemetry } from "@kilocode/kilo-telemetry"
import { execFile } from "child_process"
import { promisify } from "util"
import path from "path"
import type { Snapshot } from "@/snapshot"
import { Log } from "@/util"
import { createHash } from "crypto"

export namespace KiloAiCodeFlow {
  const added = /^\+(?!\+\+)(.*)$/
  const exec = promisify(execFile)
  const file = "kilo-ai-contributions.json"
  const log = Log.create({ service: "ai-code-flow" })

  type Contribution = {
    repo: string
    file: string
    source: "agent"
    chars: number
    lines: number
    time: number
    beforeHash: string
    afterHash: string
    patchHash: string
    chunks: { hash: string; chars: number }[]
  }

  export function chars(diff: Pick<Snapshot.FileDiff, "patch">) {
    if (!diff.patch) return 0
    return diff.patch.split(/\r?\n/).reduce((sum, line) => {
      const match = added.exec(line)
      if (!match) return sum
      return sum + match[1]!.length
    }, 0)
  }

  export function total(diffs: readonly Pick<Snapshot.FileDiff, "patch">[]) {
    return diffs.reduce((sum, diff) => sum + chars(diff), 0)
  }

  function hash(text: string) {
    return createHash("sha256").update(text).digest("hex")
  }

  function lines(diff: Pick<Snapshot.FileDiff, "patch">, prefix: "+" | "-") {
    if (!diff.patch) return []
    const header = prefix.repeat(3)
    return diff.patch
      .split(/\r?\n/)
      .filter((line) => line.startsWith(prefix) && !line.startsWith(header))
      .map((line) => line.slice(1))
  }

  export function chunks(diff: Pick<Snapshot.FileDiff, "patch">) {
    return lines(diff, "+")
      .filter((line) => line.length > 0)
      .map((line) => ({ hash: hash(line), chars: line.length }))
  }

  async function git(dir: string, args: string[]) {
    const result = await exec("git", args, { cwd: dir, windowsHide: true })
    return result.stdout.trim()
  }

  async function store(root: string) {
    const dir = await git(root, ["rev-parse", "--git-dir"])
    return path.join(path.isAbsolute(dir) ? dir : path.join(root, dir), file)
  }

  export async function record(diffs: readonly Snapshot.FileDiff[]) {
    const entries = diffs
      .map((diff) => ({ diff, chars: chars(diff) }))
      .filter((entry) => entry.chars > 0 && entry.diff.file)
    if (!entries.length) return
    const first = path.dirname(path.resolve(entries[0]!.diff.file))
    const root = (await git(first, ["rev-parse", "--show-toplevel"])).replace(/\\/g, "/")
    const target = await store(root)
    const existing = await Bun.file(target)
      .json()
      .catch(() => [])
    const records = Array.isArray(existing) ? (existing as Contribution[]) : []
    const time = Date.now()
    const next = entries.map((entry) => ({
      repo: root,
      file: path.relative(root, path.resolve(entry.diff.file)).replace(/\\/g, "/"),
      source: "agent" as const,
      chars: entry.chars,
      lines: entry.diff.additions,
      time,
      beforeHash: hash(lines(entry.diff, "-").join("\n")),
      afterHash: hash(lines(entry.diff, "+").join("\n")),
      patchHash: hash(entry.diff.patch),
      chunks: chunks(entry.diff),
    }))
    await Bun.write(target, JSON.stringify([...records, ...next].slice(-500)))
  }

  export function track(input: {
    diffs: readonly Snapshot.FileDiff[]
    sessionID?: string
    messageID?: string
    source: "tool"
    tool: string
  }) {
    const ai = total(input.diffs)
    if (ai <= 0) return
    void record(input.diffs).catch((err) => log.warn("failed to record agent contribution", { err }))
    Telemetry.trackAiCodeFlow({
      aiChars: ai,
      sessionId: input.sessionID,
      messageId: input.messageID,
      files: input.diffs.length,
      additions: input.diffs.reduce((sum, diff) => sum + diff.additions, 0),
      deletions: input.diffs.reduce((sum, diff) => sum + diff.deletions, 0),
      source: input.source,
      tool: input.tool,
    })
  }
}
