// kilocode_change - new file
import type { Agent } from "@/agent/agent"
import type { Config } from "@/config"
import type { MCP } from "@/mcp"
import type { Skill } from "@/skill"
import { NamedError } from "@opencode-ai/shared/util/error"
import { Cause, Effect, Exit } from "effect"
import z from "zod"

const Name = z.string().min(1).max(128).refine((value) => /\S/.test(value), "Required")
const ExtensionID = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

export const VSCodeExtension = z.object({
  name: Name,
  id: ExtensionID,
})
export type VSCodeExtension = z.infer<typeof VSCodeExtension>

export const Requirements = z
  .object({
    skills: z.array(Name).min(1).max(20).optional(),
    mcps: z.array(Name).min(1).max(20).optional(),
    vscode_extensions: z.array(VSCodeExtension).min(1).max(20).optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.skills && !input.mcps && !input.vscode_extensions) {
      ctx.addIssue({ code: "custom", message: "At least one requirement group is required" })
    }
    for (const group of ["skills", "mcps"] as const) {
      const seen = new Set<string>()
      for (const [index, value] of (input[group] ?? []).entries()) {
        if (seen.has(value)) ctx.addIssue({ code: "custom", path: [group, index], message: `Duplicate ${group}` })
        seen.add(value)
      }
    }
    const seen = new Set<string>()
    for (const [index, extension] of (input.vscode_extensions ?? []).entries()) {
      if (seen.has(extension.id)) {
        ctx.addIssue({ code: "custom", path: ["vscode_extensions", index, "id"], message: "Duplicate extension" })
      }
      seen.add(extension.id)
    }
  })
  .meta({ ref: "AgentRequirements" })
export type Requirements = z.infer<typeof Requirements>

export const SkillItem = z.object({
  name: z.string(),
  status: z.enum(["ready", "missing", "error"]),
  message: z.string().optional(),
})
export type SkillItem = z.infer<typeof SkillItem>

export const MCPItem = z.object({
  name: z.string(),
  status: z.enum(["ready", "missing", "error"]),
  message: z.string().optional(),
})
export type MCPItem = z.infer<typeof MCPItem>

export const Result = z
  .object({
    agent: z.string(),
    directory: z.string(),
    enabled: z.boolean(),
    state: z.enum(["disabled", "ready", "blocked", "error"]),
    skills: z.array(SkillItem),
    mcps: z.array(MCPItem),
    vscode_extensions: z.array(VSCodeExtension),
    error: z
      .object({
        code: z.enum(["unknown_agent", "malformed_declaration", "discovery_failed", "mcp_status_failed"]),
        message: z.string(),
      })
      .optional(),
  })
  .meta({ ref: "AgentRequirementResult" })
export type Result = z.infer<typeof Result>

export const BlockedError = NamedError.create(
  "AgentRequirementError",
  z.object({
    message: z.string(),
    agent: z.string(),
    directory: z.string(),
    state: z.enum(["blocked", "error"]),
    skills: z.array(SkillItem),
    mcps: z.array(MCPItem),
    vscode_extensions: z.array(VSCodeExtension),
  }),
)

type AgentInfo = Pick<Agent.Info, "name"> & { requirements?: unknown }

type Services = {
  config: Pick<Config.Interface, "get">
  agents: { get: (agent: string) => Effect.Effect<AgentInfo | undefined> }
  skills: Pick<Skill.Interface, "all">
  mcp: Pick<MCP.Interface, "status">
}

function enabled(cfg: Config.Info) {
  return cfg.experimental?.agent_requirements === true
}

function empty(input: { agent: string; directory: string; enabled: boolean }): Result {
  return {
    ...input,
    state: input.enabled ? "ready" : "disabled",
    skills: [],
    mcps: [],
    vscode_extensions: [],
  }
}

function malformed(agent: AgentInfo, directory: string, message: string): Result {
  return {
    agent: agent.name,
    directory,
    enabled: true,
    state: "error",
    skills: [],
    mcps: [],
    vscode_extensions: [],
    error: { code: "malformed_declaration", message },
  }
}

function decode(agent: AgentInfo, directory: string): Requirements | Result {
  if (agent.requirements === undefined) return empty({ agent: agent.name, directory, enabled: true })
  const decoded = Requirements.safeParse(agent.requirements)
  if (!decoded.success) return malformed(agent, directory, z.prettifyError(decoded.error))
  return decoded.data
}

function item(name: string, status: MCP.Status | undefined): MCPItem {
  if (status?.status === "connected") return { name, status: "ready" }
  if (status?.status === "failed" || status?.status === "needs_client_registration") {
    return { name, status: "error", message: status.error }
  }
  return { name, status: "missing" }
}

function message(exit: Exit.Exit<unknown, unknown>) {
  return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined
}

export function evaluate(input: {
  agent: AgentInfo
  directory: string
  enabled: boolean
  requirements: Requirements
  discovered?: ReadonlySet<string>
  discoveryError?: string
  mcp?: Readonly<Record<string, MCP.Status>>
  mcpError?: string
}): Result {
  if (!input.enabled) return empty({ agent: input.agent.name, directory: input.directory, enabled: false })

  const skills = (input.requirements.skills ?? []).map((skill) => ({
    name: skill,
    status: input.discoveryError ? ("error" as const) : input.discovered?.has(skill) ? ("ready" as const) : ("missing" as const),
    ...(input.discoveryError ? { message: input.discoveryError } : {}),
  }))
  const mcps = (input.requirements.mcps ?? []).map((name) => {
    if (input.mcpError) return { name, status: "error" as const, message: input.mcpError }
    return item(name, input.mcp?.[name])
  })
  const common = {
    agent: input.agent.name,
    directory: input.directory,
    enabled: true,
    skills,
    mcps,
    vscode_extensions: input.requirements.vscode_extensions ?? [],
  }

  if (input.discoveryError) {
    return {
      ...common,
      state: "error",
      error: { code: "discovery_failed", message: input.discoveryError },
    }
  }
  if (input.mcpError) {
    return {
      ...common,
      state: "error",
      error: { code: "mcp_status_failed", message: input.mcpError },
    }
  }

  const valid = skills.every((skill) => skill.status === "ready") && mcps.every((mcp) => mcp.status === "ready")
  return { ...common, state: valid ? "ready" : "blocked" }
}

export const status = Effect.fn("AgentRequirements.status")(function* (
  input: Services & { name: string; directory: string },
) {
  const cfg = yield* input.config.get()
  const active = enabled(cfg)
  if (!active) return empty({ agent: input.name, directory: input.directory, enabled: false })

  const agent = yield* input.agents.get(input.name)
  if (!agent) {
    return {
      agent: input.name,
      directory: input.directory,
      enabled: true,
      state: "error",
      skills: [],
      mcps: [],
      vscode_extensions: [],
      error: { code: "unknown_agent", message: `Agent not found: ${input.name}` },
    } satisfies Result
  }

  const requirements = decode(agent, input.directory)
  if ("state" in requirements) return requirements

  const skillEffect = requirements.skills?.length ? input.skills.all() : Effect.succeed([])
  const mcpEffect = requirements.mcps?.length ? input.mcp.status() : Effect.succeed({})
  const [skillExit, mcpExit] = yield* Effect.all([Effect.exit(skillEffect), Effect.exit(mcpEffect)])
  const discovered = Exit.isSuccess(skillExit) ? new Set(skillExit.value.map((skill) => skill.name)) : undefined

  return evaluate({
    agent,
    directory: input.directory,
    enabled: active,
    requirements,
    discovered,
    discoveryError: message(skillExit),
    mcp: Exit.isSuccess(mcpExit) ? mcpExit.value : undefined,
    mcpError: message(mcpExit),
  })
})

export const guard = Effect.fn("AgentRequirements.guard")(function* (
  input: Services & { agent: AgentInfo; directory: string },
) {
  const result = yield* status({ ...input, name: input.agent.name })
  const unsupported = result.vscode_extensions.length > 0 && process.env["KILO_CLIENT"] !== "vscode"
  if (result.state !== "blocked" && result.state !== "error" && !unsupported) return
  throw new BlockedError({
    message: format(result),
    agent: result.agent,
    directory: result.directory,
    state: result.state === "error" ? "error" : "blocked",
    skills: result.skills,
    mcps: result.mcps,
    vscode_extensions: result.vscode_extensions,
  })
})

export function format(result: Result) {
  const lines = [`Agent requirements are not met for "${result.agent}".`]
  if (result.error?.message) lines.push(result.error.message)
  if (result.vscode_extensions.length > 0) {
    lines.push("VS Code extensions:")
    for (const item of result.vscode_extensions) lines.push(`- ${item.name} (${item.id})`)
    if (process.env["KILO_CLIENT"] !== "vscode") lines.push("Use the Kilo VS Code extension instead.")
  }
  const skills = result.skills.filter((item) => item.status !== "ready")
  if (skills.length > 0) {
    lines.push("Skills:")
    for (const item of skills) lines.push(`- ${item.name} (${item.status}${item.message ? `: ${item.message}` : ""})`)
  }
  const mcps = result.mcps.filter((item) => item.status !== "ready")
  if (mcps.length > 0) {
    lines.push("MCP servers:")
    for (const item of mcps) lines.push(`- ${item.name} (${item.status}${item.message ? `: ${item.message}` : ""})`)
  }
  if (skills.length > 0 || mcps.length > 0) {
    lines.push("Install the required skills and configure or connect the required MCP servers, then retry.")
  }
  return lines.join("\n")
}
