// kilocode_change - new file
import { Bus } from "@/bus"
import { AgentManagerEvent, type AgentManagerTask } from "@/kilocode/agent-manager/event"
import { Provider } from "@/provider"
import { Tool } from "@/tool"
import { Effect } from "effect"
import z from "zod"
import DESCRIPTION from "./agent-manager.txt"
import { matchesQuery } from "./model-search"

const Task = z
  .object({
    prompt: z.string().optional().describe("Initial prompt to send to the new session"),
    name: z.string().optional().describe("Short display name for the Agent Manager card"),
    branchName: z.string().optional().describe("Git branch name seed for worktree mode"),
    model: z
      .string()
      .optional()
      .describe(
        "Optional model override from agent_manager_models. Omit unless the user requests a different model.",
      ),
    variant: z
      .string()
      .optional()
      .describe(
        "Optional reasoning variant override from agent_manager_models. Specify it without model to override the inherited model's variant.",
      ),
  })
  .superRefine((task, ctx) => {
    if (!task.prompt?.trim() && !task.name?.trim() && !task.branchName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each task must include prompt, name, or branchName",
      })
    }
    if (task.model?.trim() && !task.prompt?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A task model requires an initial prompt" })
    }
    if (task.variant?.trim() && !task.prompt?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A task variant requires an initial prompt" })
    }
  })

export const Params = z.object({
  mode: z.enum(["worktree", "local"]).describe("Use worktree for isolated git worktrees, or local for same-directory sessions"),
  versions: z
    .boolean()
    .optional()
    .describe("Set true only when tasks are alternative versions of the same work to compare"),
  tasks: z.array(Task).min(1).max(20).describe("Agent Manager sessions to start"),
})

type Input = z.infer<typeof Task>
type Candidate = { providerID: string; model: Provider.Info["models"][string] }
type Selected = { task?: AgentManagerTask; error?: string }
type Source = { model: NonNullable<AgentManagerTask["model"]>; variant?: string }

function candidates(providers: Record<string, Provider.Info>): Candidate[] {
  return Object.values(providers).flatMap((provider) =>
    Object.values(provider.models).map((model) => ({ providerID: provider.id, model })),
  )
}

function latest(messages: Tool.Context["messages"]): Source | undefined {
  const msg = messages
    .filter((item) => item.info.role === "user")
    .sort((a, b) => b.info.time.created - a.info.time.created)[0]
  if (!msg || msg.info.role !== "user") return undefined
  return {
    model: {
      providerID: msg.info.model.providerID,
      modelID: msg.info.model.modelID,
    },
    ...(msg.info.model.variant ? { variant: msg.info.model.variant } : {}),
  }
}

function lookup(all: Candidate[], value: string): { pool: Candidate[]; names: string[] } {
  const query = value.toLowerCase()
  const exact = all.filter((item) => `${item.providerID}/${item.model.id}`.toLowerCase() === query)
  const named = exact.length ? exact : all.filter((item) => item.model.name.toLowerCase() === query)
  const pool = named.length
    ? named
    : all.filter((item) => matchesQuery([item.model.name, `${item.providerID}/${item.model.id}`], value))
  const names = [...new Set(pool.map((item) => item.model.name))]
  return { pool, names }
}

function suggest(all: Candidate[], value: string): string[] {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (tokens.length === 0) return []
  const scored = new Map<string, number>()
  for (const item of all) {
    const text = `${item.model.name} ${item.providerID}/${item.model.id}`.toLowerCase().replace(/[^a-z0-9]+/g, "")
    const score = tokens.filter((token) => text.includes(token)).length
    if (score > 0) scored.set(item.model.name, Math.max(scored.get(item.model.name) ?? 0, score))
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map((entry) => entry[0])
}

function rank(providerID: string, preferred: string | undefined): number {
  if (providerID === preferred) return 0
  if (providerID === "kilo") return 1
  return 2
}

function select(task: Input, all: Candidate[], preferred: string | undefined, source: Source | undefined, index: number): Selected {
  const base = {
    ...(task.prompt !== undefined ? { prompt: task.prompt } : {}),
    ...(task.name !== undefined ? { name: task.name } : {}),
    ...(task.branchName !== undefined ? { branchName: task.branchName } : {}),
  }
  const value = task.model?.trim()
  const variant = task.variant?.trim()
  if (!value) {
    if (!variant) {
      if (!task.prompt?.trim() || !source) return { task: base }
      return { task: { ...base, ...source } }
    }
    if (!source) return { error: `Task ${index + 1} variant override requires an available current model.` }
    const active = all.find(
      (item) => item.providerID === source.model.providerID && item.model.id === source.model.modelID,
    )
    if (!active) {
      return {
        error: `Task ${index + 1} current model is no longer available: ${source.model.providerID}/${source.model.modelID}. Specify a model override.`,
      }
    }
    if (!active.model.variants || !Object.hasOwn(active.model.variants, variant)) {
      const available = Object.keys(active.model.variants ?? {})
      return {
        error: `Task ${index + 1} variant "${variant}" is not available for ${active.model.name}. Available variants: ${available.join(", ") || "none"}`,
      }
    }
    return { task: { ...base, model: source.model, variant } }
  }

  const { pool, names } = lookup(all, value)
  if (pool.length === 0) {
    const close = suggest(all, value)
    const hint = close.length ? ` Closest matches: ${close.join(", ")}.` : ""
    return {
      error: `Task ${index + 1} model is not available: ${value}.${hint} Use agent_manager_models to search models.`,
    }
  }
  if (names.length > 1) {
    return {
      error: `Task ${index + 1} model "${value}" is ambiguous and matches several models: ${names.slice(0, 5).join(", ")}. Use a more specific name.`,
    }
  }

  const eligible = variant
    ? pool.filter((item) => item.model.variants && Object.hasOwn(item.model.variants, variant))
    : pool
  if (variant && eligible.length === 0) {
    const available = [...new Set(pool.flatMap((item) => Object.keys(item.model.variants ?? {})))]
    return {
      error: `Task ${index + 1} variant "${variant}" is not available for ${names[0]}. Available variants: ${available.join(", ") || "none"}`,
    }
  }

  const chosen = [...eligible].sort(
    (a, b) =>
      rank(a.providerID, preferred) - rank(b.providerID, preferred) ||
      a.providerID.localeCompare(b.providerID) ||
      a.model.id.localeCompare(b.model.id),
  )[0]!
  return {
    task: {
      ...base,
      model: { providerID: chosen.model.providerID, modelID: chosen.model.id },
      ...(variant ? { variant } : {}),
    },
  }
}

export const AgentManagerTool = Tool.define<
  typeof Params,
  { requestID?: string; count: number },
  Bus.Service | Provider.Service,
  "agent_manager"
>(
  "agent_manager",
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const provider = yield* Provider.Service
    return {
      description: DESCRIPTION,
      parameters: Params,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const source = latest(ctx.messages)
          const need = params.tasks.some((task) => task.model?.trim() || task.variant?.trim())
          const all = need ? candidates(yield* provider.list()) : []
          const preferred = need
            ? (source?.model.providerID ??
              (yield* provider.defaultModel().pipe(
                Effect.map((model) => model.providerID as string),
                Effect.catch(() => Effect.succeed(undefined)),
              )))
            : undefined
          const selected = params.tasks.map((task, index) => select(task, all, preferred, source, index))
          const errors = selected.flatMap((item) => (item.error ? [item.error] : []))
          if (errors.length > 0) {
            return {
              title: "Invalid Agent Manager model selection",
              output: [
                "No Agent Manager sessions were requested.",
                ...errors,
                "Use agent_manager_models to find available model names and reasoning variants.",
              ].join("\n"),
              metadata: { count: 0 },
            }
          }
          const tasks = selected.flatMap((item) => (item.task ? [item.task] : []))

          yield* ctx.ask({
            permission: "agent_manager",
            patterns: [params.mode],
            always: [params.mode],
            metadata: { mode: params.mode, count: tasks.length },
          })

          const requestID = `am-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          yield* bus.publish(AgentManagerEvent.Start, {
            requestID,
            sessionID: ctx.sessionID,
            mode: params.mode,
            versions: params.versions,
            tasks,
          })

          const resolved = tasks.flatMap((task, index) => {
            if (!params.tasks[index]?.model?.trim() || !task.model) return []
            const name = all.find(
              (item) => item.providerID === task.model!.providerID && item.model.id === task.model!.modelID,
            )?.model.name
            const label = task.name?.trim() || task.branchName?.trim() || "session"
            const variant = task.variant ? ` - ${task.variant}` : ""
            return [`- ${label}: ${name ?? task.model.modelID} (${task.model.providerID})${variant}`]
          })

          return {
            title: `Requested ${tasks.length} Agent Manager ${params.mode === "worktree" ? "worktree" : "local"} session${tasks.length === 1 ? "" : "s"}`,
            output: [
              `Requested ${tasks.length} Agent Manager ${params.mode === "worktree" ? "worktree" : "local"} session${tasks.length === 1 ? "" : "s"}.`,
              `request_id: ${requestID}`,
              ...(resolved.length ? ["Resolved models:", ...resolved] : []),
              "The VS Code extension will create the sessions asynchronously and show progress in Agent Manager.",
            ].join("\n"),
            metadata: { requestID, count: tasks.length },
          }
        }),
    }
  }),
)
