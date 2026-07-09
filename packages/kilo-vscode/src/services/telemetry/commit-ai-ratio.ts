import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { createHash } from "crypto"
import { execFile } from "child_process"
import { promisify } from "util"
import { TelemetryEventName } from "./types"
import { TelemetryProxy } from "./telemetry-proxy"

export type Source = "inline" | "agent" | "ask"

export type Contribution = {
  repo: string
  file: string
  source: Source
  chars: number
  lines: number
  time: number
}

export type Commit = {
  hash: string
  name: string
  email: string
  time: number
}

export type Payload = {
  commit_hash: string
  commit_whole_lines: number
  inline_lines: number
  agent_lines: number
  ask_lines: number
  ai_percent: number
  inline_percent: number
  agent_percent: number
  ask_percent: number
  analyzer_version: number
}

type Git = (dir: string, args: string[]) => Promise<string>

const exec = promisify(execFile)
const interval = 10 * 60_000
const version = 1
const cutoffKey = "kilo.aiRatio.cutoff"
const processedKey = "kilo.aiRatio.processed"
const recordsKey = "kilo.aiRatio.records"
const diskKey = "kilo-ai-contributions.json"

function percent(value: number, total: number) {
  if (total <= 0) return 0
  return Math.min(100, (value / total) * 100)
}

export function lines(text: string) {
  if (!text) return 0
  return text.split(/\r?\n/).length
}

export function hash(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

export function parseLog(raw: string): Commit[] {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id, name, email, time] = line.split("\t")
      return {
        hash: id ?? "",
        name: name ?? "",
        email: email ?? "",
        time: Date.parse(time ?? ""),
      }
    })
    .filter((commit) => commit.hash && Number.isFinite(commit.time))
}

export function patch(input: string) {
  return input.split(/\r?\n/).reduce(
    (state, line) => {
      const file = /^\+\+\+ b\/(.+)$/.exec(line)
      const current = file?.[1] ?? state.file
      if (/^\+(?!\+\+)(.*)$/.test(line)) {
        const text = line.slice(1)
        return {
          file: current,
          lines: state.lines + 1,
          symbols: state.symbols + text.length,
        }
      }
      return { ...state, file: current }
    },
    { file: "", lines: 0, symbols: 0 },
  )
}

export function build(input: {
  commit: Commit
  patch: string
  from: number
  records: Contribution[]
}): Payload | undefined {
  const stats = patch(input.patch)
  if (stats.lines <= 0 && stats.symbols <= 0) return undefined
  const files = new Set(
    input.patch
      .split(/\r?\n/)
      .map((line) => /^\+\+\+ b\/(.+)$/.exec(line)?.[1])
      .filter((file): file is string => Boolean(file)),
  )
  const records = input.records.filter(
    (item) => item.time > input.from && item.time <= input.commit.time && files.has(item.file),
  )
  const sum = (source: Source, key: "chars" | "lines") =>
    records.filter((item) => item.source === source).reduce((total, item) => total + item[key], 0)
  const inlineChars = sum("inline", "chars")
  const agentChars = sum("agent", "chars")
  const askChars = sum("ask", "chars")
  return {
    commit_hash: input.commit.hash,
    commit_whole_lines: stats.lines,
    inline_lines: sum("inline", "lines"),
    agent_lines: sum("agent", "lines"),
    ask_lines: sum("ask", "lines"),
    ai_percent: percent(inlineChars + agentChars + askChars, stats.symbols),
    inline_percent: percent(inlineChars, stats.symbols),
    agent_percent: percent(agentChars, stats.symbols),
    ask_percent: percent(askChars, stats.symbols),
    analyzer_version: version,
  }
}

async function run(dir: string, args: string[]) {
  const result = await exec("git", args, { cwd: dir, windowsHide: true })
  return result.stdout.trim()
}

export class CommitAiRatioCalculator implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly proxy = TelemetryProxy.getInstance(),
    private readonly git: Git = run,
  ) {}

  register() {
    const cutoff = this.context.globalState.get<number>(cutoffKey)
    if (!cutoff) void this.context.globalState.update(cutoffKey, Date.now())
    this.timer = setInterval(() => void this.run(), interval)
    this.context.subscriptions.push(this)
  }

  async record(input: Omit<Contribution, "repo" | "time"> & { time?: number }) {
    const repo = await this.repo(path.dirname(input.file)).catch(() => undefined)
    if (!repo) return
    const records = this.context.globalState.get<Contribution[]>(recordsKey, [])
    await this.context.globalState.update(recordsKey, [
      ...records.slice(-499),
      {
        repo,
        file: path.relative(repo, input.file).replace(/\\/g, "/"),
        source: input.source,
        chars: Math.max(0, Math.trunc(input.chars)),
        lines: Math.max(0, Math.trunc(input.lines)),
        time: input.time ?? Date.now(),
      },
    ])
  }

  async run() {
    const roots = await this.roots()
    for (const root of roots) await this.analyze(root).catch(() => undefined)
  }

  private async roots() {
    const dirs = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
    const roots = await Promise.all(dirs.map((dir) => this.repo(dir).catch(() => undefined)))
    return [...new Set(roots.filter((root): root is string => Boolean(root)))]
  }

  private async repo(dir: string) {
    return (await this.git(dir, ["rev-parse", "--show-toplevel"])).replace(/\\/g, "/")
  }

  private async analyze(root: string) {
    const cutoff = this.context.globalState.get<number>(cutoffKey, Date.now())
    const processed = this.context.globalState.get<{ [key: string]: true }>(processedKey, {})
    const records = [
      ...this.context.globalState.get<Contribution[]>(recordsKey, []),
      ...(await this.disk(root)),
    ].filter((item) => item.repo === root)
    const email = await this.git(root, ["config", "user.email"]).catch(() => "")
    const name = await this.git(root, ["config", "user.name"]).catch(() => "")
    const raw = await this.git(root, [
      "log",
      "--format=%H%x09%an%x09%ae%x09%aI",
      `--since=${new Date(cutoff).toISOString()}`,
      "HEAD",
    ])
    const commits = parseLog(raw)
      .filter((commit) => commit.time >= cutoff)
      .filter((commit) => (email ? commit.email === email : commit.name === name))
      .sort((a, b) => a.time - b.time)
    for (const commit of commits) {
      const diff = await this.git(root, ["show", "--format=", "--no-ext-diff", "--unified=0", commit.hash])
      const key = `${commit.hash}:${hash(diff)}`
      if (processed[key]) continue
      const from = await this.from(root, commit, cutoff)
      const payload = build({ commit, patch: diff, from, records })
      if (payload) this.proxy.capture(TelemetryEventName.GIT_COMMIT_AI_CONTRIBUTION, payload)
      processed[key] = true
      await this.context.globalState.update(processedKey, processed)
    }
  }

  private async from(root: string, commit: Commit, cutoff: number) {
    const parents = await this.git(root, ["show", "-s", "--format=%P", commit.hash]).catch(() => "")
    const parent = parents.split(/\s+/).find(Boolean)
    if (!parent) return cutoff
    const time = await this.git(root, ["show", "-s", "--format=%aI", parent]).catch(() => "")
    const parsed = Date.parse(time)
    if (!Number.isFinite(parsed)) return cutoff
    return Math.max(cutoff, parsed)
  }

  private async disk(root: string): Promise<Contribution[]> {
    const dir = await this.git(root, ["rev-parse", "--git-dir"]).catch(() => "")
    if (!dir) return []
    const target = path.join(path.isAbsolute(dir) ? dir : path.join(root, dir), diskKey)
    const parsed = await fs
      .readFile(target, "utf8")
      .then((raw) => JSON.parse(raw) as unknown)
      .catch(() => [])
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is Contribution => {
      if (!item || typeof item !== "object") return false
      const record = item as Partial<Contribution>
      return (
        typeof record.repo === "string" &&
        typeof record.file === "string" &&
        (record.source === "inline" || record.source === "agent" || record.source === "ask") &&
        typeof record.chars === "number" &&
        typeof record.lines === "number" &&
        typeof record.time === "number"
      )
    })
  }

  dispose() {
    if (this.timer) clearInterval(this.timer)
  }
}
