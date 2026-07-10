import { describe, expect, it } from "bun:test"
import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import {
  CommitAiRatioCalculator,
  chunks,
  hash,
  type Contribution,
  type Payload,
  type Source,
} from "../../src/services/telemetry/commit-ai-ratio"

type State = { [key: string]: unknown }

const exec = promisify(execFile)
const cutoff = Date.parse("2026-07-10T10:00:00.000Z")

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

function workspace(...roots: string[]) {
  const previous = vscode.workspace.workspaceFolders
  ;(vscode.workspace as { workspaceFolders: typeof previous }).workspaceFolders = roots.map((root) => ({
    uri: { fsPath: root },
  })) as never
  return () => {
    ;(vscode.workspace as { workspaceFolders: typeof previous }).workspaceFolders = previous
  }
}

async function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = await exec("git", args, {
    cwd: dir,
    windowsHide: true,
    env: { ...process.env, ...env },
  })
  return result.stdout.trim()
}

async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-ratio-e2e-"))
  await git(root, ["init"])
  await git(root, ["config", "user.name", "Kilo User"])
  await git(root, ["config", "user.email", "kilo@example.com"])
  await write(root, "README.md", "base\n")
  await commit(root, "base", "2026-07-10T09:00:00.000Z")
  return root
}

async function write(root: string, file: string, text: string) {
  const target = path.join(root, ...file.split("/"))
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, text)
}

async function commit(root: string, msg: string, time: string, author?: { name: string; email: string }) {
  await git(root, ["add", "-A"])
  await git(root, ["commit", "-m", msg], {
    GIT_AUTHOR_DATE: time,
    GIT_COMMITTER_DATE: time,
    GIT_AUTHOR_NAME: author?.name ?? "Kilo User",
    GIT_AUTHOR_EMAIL: author?.email ?? "kilo@example.com",
  })
  return git(root, ["rev-parse", "HEAD"])
}

async function amend(root: string, time: string) {
  await git(root, ["add", "-A"])
  await git(root, ["commit", "--amend", "--no-edit", `--date=${time}`], {
    GIT_AUTHOR_DATE: time,
    GIT_COMMITTER_DATE: time,
  })
  return git(root, ["rev-parse", "HEAD"])
}

function contribution(root: string, file: string, source: Source, text: string, time: string): Contribution {
  const parts = chunks(text)
  return {
    repo: root.replace(/\\/g, "/"),
    file,
    source,
    chars: parts.reduce((sum, part) => sum + part.chars, 0),
    lines: parts.length,
    time: Date.parse(time),
    beforeHash: hash(""),
    afterHash: hash(text),
    patchHash: hash(text),
    chunks: parts,
  }
}

async function disk(root: string, records: Contribution[] | string) {
  const dir = path.join(root, ".git")
  const text = typeof records === "string" ? records : JSON.stringify(records)
  await fs.writeFile(path.join(dir, "kilo-ai-contributions.json"), text)
}

function calc(ctx: ReturnType<typeof context>, captures: Payload[]) {
  return new CommitAiRatioCalculator(
    ctx,
    {
      capture: (_event: string, props?: Record<string, unknown>) => {
        if (props) captures.push(props as Payload)
      },
    } as never,
  )
}

async function run(roots: string[], ctx = context({ "kilo.aiRatio.cutoff": cutoff })) {
  const reset = workspace(...roots)
  const captures: Payload[] = []
  const worker = calc(ctx, captures)
  try {
    await worker.run()
    return { captures, ctx, worker }
  } finally {
    worker.dispose()
    reset()
  }
}

async function cleanup(...roots: string[]) {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true })
}

describe("commit ai ratio calculator e2e scenarios", () => {
  it("S01 reports only post-cutoff commits", async () => {
    const root = await repo()
    try {
      await disk(root, [contribution(root, "src/a.ts", "agent", "export const agent = 1", "2026-07-10T10:10:00.000Z")])
      await write(root, "src/a.ts", "export const agent = 1\n")
      await commit(root, "agent", "2026-07-10T10:20:00.000Z")

      const result = await run([root])

      expect(result.captures).toHaveLength(1)
      expect(result.captures[0]).toMatchObject({ agent_lines: 1, ai_percent: 100 })
    } finally {
      await cleanup(root)
    }
  })

  it("S02 ignores commits from another author", async () => {
    const root = await repo()
    try {
      await write(root, "src/other.ts", "export const other = 1\n")
      await commit(root, "other", "2026-07-10T10:20:00.000Z", {
        name: "Other User",
        email: "other@example.com",
      })

      const result = await run([root])

      expect(result.captures).toEqual([])
    } finally {
      await cleanup(root)
    }
  })

  it("S03 counts agent tool output committed by the user", async () => {
    const root = await repo()
    try {
      const text = "export function agent() { return 1 }"
      await disk(root, [contribution(root, "src/agent.ts", "agent", text, "2026-07-10T10:10:00.000Z")])
      await write(root, "src/agent.ts", `${text}\n`)
      await commit(root, "agent output", "2026-07-10T10:20:00.000Z")

      const result = await run([root])

      expect(result.captures[0]).toMatchObject({ agent_lines: 1, inline_lines: 0, ai_percent: 100 })
    } finally {
      await cleanup(root)
    }
  })

  it("S04 counts inline completion committed by the user", async () => {
    const root = await repo()
    const reset = workspace(root)
    const captures: Payload[] = []
    const ctx = context({ "kilo.aiRatio.cutoff": cutoff })
    const worker = calc(ctx, captures)
    try {
      await write(root, "src/inline.ts", "export const inline = 1\n")
      await worker.record({
        file: path.join(root, "src", "inline.ts"),
        source: "inline",
        chars: "export const inline = 1".length,
        lines: 1,
        time: Date.parse("2026-07-10T10:10:00.000Z"),
        chunks: chunks("export const inline = 1"),
      })
      await commit(root, "inline output", "2026-07-10T10:20:00.000Z")
      await worker.run()

      expect(captures[0]).toMatchObject({ inline_lines: 1, agent_lines: 0, ai_percent: 100 })
    } finally {
      worker.dispose()
      reset()
      await cleanup(root)
    }
  })

  it("S05 splits mixed inline, agent, and manual additions", async () => {
    const root = await repo()
    const ctx = context({ "kilo.aiRatio.cutoff": cutoff })
    const reset = workspace(root)
    const captures: Payload[] = []
    const worker = calc(ctx, captures)
    try {
      await disk(root, [contribution(root, "src/mixed.ts", "agent", "export const agent = 1", "2026-07-10T10:10:00.000Z")])
      await write(
        root,
        "src/mixed.ts",
        ["export const agent = 1", "export const inline = 1", "export const manual = 1", ""].join("\n"),
      )
      await worker.record({
        file: path.join(root, "src", "mixed.ts"),
        source: "inline",
        chars: "export const inline = 1".length,
        lines: 1,
        time: Date.parse("2026-07-10T10:12:00.000Z"),
        chunks: chunks("export const inline = 1"),
      })
      await commit(root, "mixed", "2026-07-10T10:20:00.000Z")
      await worker.run()

      expect(captures[0]).toMatchObject({ agent_lines: 1, inline_lines: 1, ask_lines: 0 })
      expect(captures[0]!.ai_percent).toBeGreaterThan(50)
      expect(captures[0]!.ai_percent).toBeLessThan(100)
    } finally {
      worker.dispose()
      reset()
      await cleanup(root)
    }
  })

  it("S06 ignores generated lines deleted before commit", async () => {
    const root = await repo()
    try {
      await disk(root, [
        contribution(root, "src/keep.ts", "agent", "export const kept = 1", "2026-07-10T10:10:00.000Z"),
        contribution(root, "src/keep.ts", "agent", "export const removed = 1", "2026-07-10T10:11:00.000Z"),
      ])
      await write(root, "src/keep.ts", "export const kept = 1\n")
      await commit(root, "keep only", "2026-07-10T10:20:00.000Z")

      const result = await run([root])

      expect(result.captures[0]).toMatchObject({ agent_lines: 1, ai_percent: 100 })
    } finally {
      await cleanup(root)
    }
  })

  it("S07 reports only the final reachable commit after reset before worker run", async () => {
    const root = await repo()
    try {
      await disk(root, [
        contribution(root, "src/reset.ts", "agent", "export const first = 1", "2026-07-10T10:10:00.000Z"),
        contribution(root, "src/reset.ts", "agent", "export const final = 1", "2026-07-10T10:30:00.000Z"),
      ])
      await write(root, "src/reset.ts", "export const first = 1\n")
      await commit(root, "temporary", "2026-07-10T10:20:00.000Z")
      await git(root, ["reset", "--soft", "HEAD~1"])
      await write(root, "src/reset.ts", "export const final = 1\n")
      const final = await commit(root, "final", "2026-07-10T10:40:00.000Z")

      const result = await run([root])

      expect(result.captures).toHaveLength(1)
      expect(result.captures[0]).toMatchObject({ commit_hash: final, agent_lines: 1 })
    } finally {
      await cleanup(root)
    }
  })

  it("S08 reports amended commits again with a new commit/patch key", async () => {
    const root = await repo()
    const ctx = context({ "kilo.aiRatio.cutoff": cutoff })
    const reset = workspace(root)
    const captures: Payload[] = []
    const worker = calc(ctx, captures)
    try {
      await disk(root, [
        contribution(root, "src/amend.ts", "agent", "export const one = 1", "2026-07-10T10:10:00.000Z"),
        contribution(root, "src/amend.ts", "agent", "export const two = 2", "2026-07-10T10:30:00.000Z"),
      ])
      await write(root, "src/amend.ts", "export const one = 1\n")
      const first = await commit(root, "amend", "2026-07-10T10:20:00.000Z")
      await worker.run()
      await write(root, "src/amend.ts", "export const one = 1\nexport const two = 2\n")
      const second = await amend(root, "2026-07-10T10:40:00.000Z")
      await worker.run()

      expect(captures).toHaveLength(2)
      expect(captures.map((item) => item.commit_hash)).toEqual([first, second])
      expect(captures[1]).toMatchObject({ agent_lines: 2 })
    } finally {
      worker.dispose()
      reset()
      await cleanup(root)
    }
  })

  it("S09 attributes records to the right commit window", async () => {
    const root = await repo()
    try {
      await disk(root, [
        contribution(root, "src/one.ts", "agent", "export const one = 1", "2026-07-10T10:10:00.000Z"),
        contribution(root, "src/two.ts", "agent", "export const two = 2", "2026-07-10T10:30:00.000Z"),
      ])
      await write(root, "src/one.ts", "export const one = 1\n")
      const one = await commit(root, "one", "2026-07-10T10:20:00.000Z")
      await write(root, "src/two.ts", "export const two = 2\n")
      const two = await commit(root, "two", "2026-07-10T10:40:00.000Z")

      const result = await run([root])

      expect(result.captures.map((item) => item.commit_hash)).toEqual([one, two])
      expect(result.captures).toEqual([
        expect.objectContaining({ agent_lines: 1, ai_percent: 100 }),
        expect.objectContaining({ agent_lines: 1, ai_percent: 100 }),
      ])
    } finally {
      await cleanup(root)
    }
  })

  it("S10 ignores revert deletion commits after the original AI commit was reported", async () => {
    const root = await repo()
    const ctx = context({ "kilo.aiRatio.cutoff": cutoff })
    const reset = workspace(root)
    const captures: Payload[] = []
    const worker = calc(ctx, captures)
    try {
      await disk(root, [contribution(root, "src/revert.ts", "agent", "export const revertable = 1", "2026-07-10T10:10:00.000Z")])
      await write(root, "src/revert.ts", "export const revertable = 1\n")
      await commit(root, "ai", "2026-07-10T10:20:00.000Z")
      await worker.run()
      await git(root, ["revert", "--no-edit", "HEAD"], {
        GIT_AUTHOR_DATE: "2026-07-10T10:40:00.000Z",
        GIT_COMMITTER_DATE: "2026-07-10T10:40:00.000Z",
      })
      await worker.run()

      expect(captures).toHaveLength(1)
      expect(captures[0]).toMatchObject({ agent_lines: 1 })
    } finally {
      worker.dispose()
      reset()
      await cleanup(root)
    }
  })

  it("S11 counts duplicated generated lines once per surviving addition", async () => {
    const root = await repo()
    try {
      await disk(root, [
        contribution(root, "src/dup.ts", "agent", "export const duplicate = 1\nexport const duplicate = 1", "2026-07-10T10:10:00.000Z"),
      ])
      await write(root, "src/dup.ts", "export const duplicate = 1\nexport const duplicate = 1\n")
      await commit(root, "duplicates", "2026-07-10T10:20:00.000Z")

      const result = await run([root])

      expect(result.captures[0]).toMatchObject({ agent_lines: 2, ai_percent: 100 })
    } finally {
      await cleanup(root)
    }
  })

  it("S12 reports commits from multiple workspace repositories", async () => {
    const one = await repo()
    const two = await repo()
    try {
      await disk(one, [contribution(one, "src/one.ts", "agent", "export const one = 1", "2026-07-10T10:10:00.000Z")])
      await disk(two, [contribution(two, "src/two.ts", "agent", "export const two = 2", "2026-07-10T10:10:00.000Z")])
      await write(one, "src/one.ts", "export const one = 1\n")
      await write(two, "src/two.ts", "export const two = 2\n")
      const first = await commit(one, "one", "2026-07-10T10:20:00.000Z")
      const second = await commit(two, "two", "2026-07-10T10:20:00.000Z")

      const result = await run([one, two])

      expect(result.captures.map((item) => item.commit_hash).sort()).toEqual([first, second].sort())
    } finally {
      await cleanup(one, two)
    }
  })

  it("S13 ignores corrupted disk attribution and still reports manual additions", async () => {
    const root = await repo()
    try {
      await disk(root, "{not json")
      await write(root, "src/manual.ts", "export const manual = 1\n")
      await commit(root, "manual", "2026-07-10T10:20:00.000Z")

      const result = await run([root])

      expect(result.captures[0]).toMatchObject({ inline_lines: 0, agent_lines: 0, ai_percent: 0 })
    } finally {
      await cleanup(root)
    }
  })

  it("S14 ignores records for files not changed by the commit", async () => {
    const root = await repo()
    try {
      await disk(root, [contribution(root, "src/other.ts", "agent", "export const other = 1", "2026-07-10T10:10:00.000Z")])
      await write(root, "src/actual.ts", "export const actual = 1\n")
      await commit(root, "actual", "2026-07-10T10:20:00.000Z")

      const result = await run([root])

      expect(result.captures[0]).toMatchObject({ agent_lines: 0, ai_percent: 0 })
    } finally {
      await cleanup(root)
    }
  })

  it("S15 reports manual-only commits with zero AI percentages", async () => {
    const root = await repo()
    try {
      await write(root, "src/manual.ts", "export const manual = 1\n")
      await commit(root, "manual", "2026-07-10T10:20:00.000Z")

      const result = await run([root])

      expect(result.captures[0]).toMatchObject({
        commit_whole_lines: 1,
        inline_lines: 0,
        agent_lines: 0,
        ask_lines: 0,
        ai_percent: 0,
      })
    } finally {
      await cleanup(root)
    }
  })

  it("S16 reports unchanged commits only once across repeated worker runs", async () => {
    const root = await repo()
    const ctx = context({ "kilo.aiRatio.cutoff": cutoff })
    const reset = workspace(root)
    const captures: Payload[] = []
    const worker = calc(ctx, captures)
    try {
      await write(root, "src/once.ts", "export const once = 1\n")
      await commit(root, "once", "2026-07-10T10:20:00.000Z")
      await worker.run()
      await worker.run()

      expect(captures).toHaveLength(1)
    } finally {
      worker.dispose()
      reset()
      await cleanup(root)
    }
  })
})
