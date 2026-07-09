import { describe, expect, it } from "bun:test"
import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import {
  CommitAiRatioCalculator,
  build,
  chunks,
  hash,
  parseLog,
  patch,
  type Commit,
} from "../../src/services/telemetry/commit-ai-ratio"

type State = { [key: string]: unknown }

function state(data: State = {}) {
  return {
    data,
    get<T>(key: string, fallback?: T) {
      return (Object.hasOwn(data, key) ? data[key] : fallback) as T
    },
    async update(key: string, value: unknown) {
      if (value === undefined) delete data[key]
      else data[key] = value
    },
  }
}

function context(data: State = {}) {
  return {
    subscriptions: [] as vscode.Disposable[],
    globalState: state(data),
  } as unknown as vscode.ExtensionContext & { globalState: ReturnType<typeof state> }
}

function workspace(path: string) {
  const previous = vscode.workspace.workspaceFolders
  ;(vscode.workspace as { workspaceFolders: typeof previous }).workspaceFolders = [{ uri: { fsPath: path } }] as never
  return () => {
    ;(vscode.workspace as { workspaceFolders: typeof previous }).workspaceFolders = previous
  }
}

function commit(input: Partial<Commit> & { hash: string }): Commit {
  return {
    hash: input.hash,
    name: input.name ?? "Kilo User",
    email: input.email ?? "kilo@example.com",
    time: input.time ?? Date.parse("2026-07-09T12:00:00.000Z"),
  }
}

function diff(text = "generated") {
  return ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -0,0 +1 @@", `+${text}`].join(
    "\n",
  )
}

function fake(responses: { log: string; diffs: { [key: string]: string }; parents?: { [key: string]: string } }) {
  return async (_dir: string, args: string[]) => {
    if (args[0] === "rev-parse") return "/repo"
    if (args.join(" ") === "config user.email") return "kilo@example.com"
    if (args.join(" ") === "config user.name") return "Kilo User"
    if (args[0] === "log") return responses.log
    if (args[0] === "show" && args.includes("--format=%P")) return responses.parents?.[args.at(-1) ?? ""] ?? "parent"
    if (args[0] === "show" && args.includes("--format=%aI")) return "2026-07-09T11:00:00.000Z"
    if (args[0] === "show") return responses.diffs[args.at(-1) ?? ""] ?? ""
    return ""
  }
}

function fakeRoot(root: string, responses: { log: string; diffs: { [key: string]: string } }) {
  return async (_dir: string, args: string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return root
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return path.join(root, ".git")
    if (args.join(" ") === "config user.email") return "kilo@example.com"
    if (args.join(" ") === "config user.name") return "Kilo User"
    if (args[0] === "log") return responses.log
    if (args[0] === "show" && args.includes("--format=%P")) return "parent"
    if (args[0] === "show" && args.includes("--format=%aI")) return "2026-07-09T11:00:00.000Z"
    if (args[0] === "show") return responses.diffs[args.at(-1) ?? ""] ?? ""
    return ""
  }
}

describe("commit ai ratio calculator", () => {
  it("parses git log output", () => {
    const raw = "abc\tKilo User\tkilo@example.com\t2026-07-09T12:00:00.000Z"

    expect(parseLog(raw)).toEqual([commit({ hash: "abc" })])
  })

  it("counts added lines and symbols from a commit patch", () => {
    expect(patch(diff("const value = 1"))).toMatchObject({ lines: 1, symbols: 15 })
  })

  it("builds the required ai contribution payload", () => {
    const payload = build({
      commit: commit({ hash: "abc" }),
      patch: diff("1234567890"),
      from: Date.parse("2026-07-09T11:00:00.000Z"),
      records: [
        {
          repo: "/repo",
          file: "src/a.ts",
          source: "inline",
          chars: 4,
          lines: 1,
          time: Date.parse("2026-07-09T11:30:00.000Z"),
        },
        {
          repo: "/repo",
          file: "src/a.ts",
          source: "agent",
          chars: 3,
          lines: 1,
          time: Date.parse("2026-07-09T11:40:00.000Z"),
        },
      ],
    })

    expect(payload).toEqual({
      commit_hash: "abc",
      commit_whole_lines: 1,
      inline_lines: 1,
      agent_lines: 1,
      ask_lines: 0,
      ai_percent: 70,
      inline_percent: 40,
      agent_percent: 30,
      ask_percent: 0,
      analyzer_version: 1,
    })
  })

  it("matches hashed ai chunks against the final commit patch", () => {
    const payload = build({
      commit: commit({ hash: "abc" }),
      patch: diff("kept generated"),
      from: Date.parse("2026-07-09T11:00:00.000Z"),
      records: [
        {
          repo: "/repo",
          file: "src/a.ts",
          source: "agent",
          chars: 14,
          lines: 1,
          time: Date.parse("2026-07-09T11:30:00.000Z"),
          chunks: chunks("kept generated"),
        },
        {
          repo: "/repo",
          file: "src/a.ts",
          source: "agent",
          chars: 17,
          lines: 1,
          time: Date.parse("2026-07-09T11:40:00.000Z"),
          chunks: chunks("removed generated"),
        },
      ],
    })

    expect(payload).toMatchObject({
      commit_hash: "abc",
      commit_whole_lines: 1,
      agent_lines: 1,
      agent_percent: 100,
      ai_percent: 100,
    })
  })

  it("filters old commits and commits from other authors", async () => {
    const reset = workspace("/repo")
    const captures: unknown[] = []
    const ctx = context({ "kilo.aiRatio.cutoff": Date.parse("2026-07-09T10:00:00.000Z") })
    const log = [
      "old\tKilo User\tkilo@example.com\t2026-07-09T09:00:00.000Z",
      "other\tOther\tother@example.com\t2026-07-09T12:00:00.000Z",
      "valid\tKilo User\tkilo@example.com\t2026-07-09T12:00:00.000Z",
    ].join("\n")
    const calc = new CommitAiRatioCalculator(
      ctx,
      { capture: (_event: string, props?: Record<string, unknown>) => captures.push(props) } as never,
      fake({ log, diffs: { valid: diff() } }),
    )
    try {
      await calc.run()

      expect(captures).toHaveLength(1)
      expect(captures[0]).toMatchObject({ commit_hash: "valid" })
    } finally {
      calc.dispose()
      reset()
    }
  })

  it("deduplicates by commit hash and patch hash but recalculates amended patches", async () => {
    const reset = workspace("/repo")
    const captures: unknown[] = []
    const ctx = context({ "kilo.aiRatio.cutoff": Date.parse("2026-07-09T10:00:00.000Z") })
    const log = "same\tKilo User\tkilo@example.com\t2026-07-09T12:00:00.000Z"
    const first = fake({ log, diffs: { same: diff("one") } })
    const second = fake({ log, diffs: { same: diff("two lines") } })
    const calc = new CommitAiRatioCalculator(
      ctx,
      { capture: (_event: string, props?: Record<string, unknown>) => captures.push(props) } as never,
      first,
    )
    try {
      await calc.run()
      await calc.run()
      expect(captures).toHaveLength(1)

      const amended = new CommitAiRatioCalculator(
        ctx,
        { capture: (_event: string, props?: Record<string, unknown>) => captures.push(props) } as never,
        second,
      )
      await amended.run()

      expect(captures).toHaveLength(2)
      expect(Object.keys(ctx.globalState.data["kilo.aiRatio.processed"] as object)).toEqual([
        `same:${hash(diff("one"))}`,
        `same:${hash(diff("two lines"))}`,
      ])
    } finally {
      calc.dispose()
      reset()
    }
  })

  it("uses recorded inline contributions when analyzing a later commit", async () => {
    const reset = workspace("/repo")
    const captures: unknown[] = []
    const ctx = context({ "kilo.aiRatio.cutoff": Date.parse("2026-07-09T10:00:00.000Z") })
    const log = "abc\tKilo User\tkilo@example.com\t2026-07-09T12:00:00.000Z"
    const calc = new CommitAiRatioCalculator(
      ctx,
      { capture: (_event: string, props?: Record<string, unknown>) => captures.push(props) } as never,
      fake({ log, diffs: { abc: diff("1234567890") } }),
    )
    try {
      await calc.record({
        file: "/repo/src/a.ts",
        source: "inline",
        chars: 5,
        lines: 1,
        time: Date.parse("2026-07-09T11:30:00.000Z"),
      })
      await calc.run()

      expect(captures[0]).toMatchObject({
        commit_hash: "abc",
        commit_whole_lines: 1,
        inline_lines: 1,
        inline_percent: 50,
        ai_percent: 50,
      })
    } finally {
      calc.dispose()
      reset()
    }
  })

  it("uses agent contributions persisted in the git directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-ratio-"))
    await fs.mkdir(path.join(root, ".git"))
    await fs.writeFile(
      path.join(root, ".git", "kilo-ai-contributions.json"),
      JSON.stringify([
        {
          repo: root.replace(/\\/g, "/"),
          file: "src/a.ts",
          source: "agent",
          chars: 5,
          lines: 1,
          time: Date.parse("2026-07-09T11:30:00.000Z"),
        },
      ]),
    )
    const reset = workspace(root)
    const captures: unknown[] = []
    const ctx = context({ "kilo.aiRatio.cutoff": Date.parse("2026-07-09T10:00:00.000Z") })
    const log = "abc\tKilo User\tkilo@example.com\t2026-07-09T12:00:00.000Z"
    const calc = new CommitAiRatioCalculator(
      ctx,
      { capture: (_event: string, props?: Record<string, unknown>) => captures.push(props) } as never,
      fakeRoot(root, { log, diffs: { abc: diff("1234567890") } }),
    )
    try {
      await calc.run()

      expect(captures[0]).toMatchObject({
        commit_hash: "abc",
        agent_lines: 1,
        agent_percent: 50,
        ai_percent: 50,
      })
    } finally {
      calc.dispose()
      reset()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
