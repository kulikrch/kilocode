import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions" // kilocode_change
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config"
import { Effect } from "effect"
import { KiloTask } from "../kilocode/tool/task" // kilocode_change
import { KiloCostPropagation } from "../kilocode/session/cost-propagation" // kilocode_change
import { errorMessage } from "@/util/error" // kilocode_change

export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

// kilocode_change start - reusable Task output wrapper with resumable task_id
function output(sessionID: SessionID, text: string) {
  return [
    `task_id: ${sessionID} (for resuming to continue this task if needed)`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}
// kilocode_change end

// kilocode_change start - tell the parent agent how to resume a stopped/failed subagent
function resumeHint(sessionID: SessionID) {
  return [
    `This subagent session can be resumed: call the task tool again with task_id="${sessionID}"`,
    `and a prompt describing how to continue or recover. Its prior context is preserved.`,
  ].join(" ")
}
// kilocode_change end

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("TaskTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }
      // kilocode_change start — reject primary agents; only subagent/all modes allowed
      KiloTask.validate(next, params.subagent_type)
      const canTask = KiloTask.nestedTask()
      // kilocode_change end

      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

      // kilocode_change start — inherit edit/bash/MCP restrictions from calling agent
      const caller = yield* agent.get(ctx.agent)
      const parent = yield* sessions.get(ctx.sessionID)
      const rules = KiloTask.inherited({ caller, session: parent, mcp: cfg.mcp })
      // kilocode_change end

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`, // kilocode_change
          permission: [ // kilocode_change
            // kilocode_change start - preserve subagent policy while inheriting parent deny ceilings
            ...deriveSubagentSessionPermission({
              parentSessionPermission: parent.permission ?? [],
              parentAgent: caller,
              subagent: next,
            }),
            // kilocode_change end
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
            // kilocode_change start — deny task + propagate caller restrictions
            ...KiloTask.permissions(rules),
            // kilocode_change end
          ],
        }))

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })) // kilocode_change
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message")) // kilocode_change

      // kilocode_change start — prefer valid subagent overrides, safely inheriting when overrides go stale
      const selected = yield* KiloTask.resolveModel({
        name: next.name,
        agent: next,
        config: cfg,
        parent: {
          modelID: msg.info.modelID,
          providerID: msg.info.providerID,
        },
        variant: msg.info.variant,
      })
      const model = selected.model
      const variant = selected.variant
      // kilocode_change end

      // kilocode_change start - include task session/model metadata consistently
      const metadata = {
        sessionId: nextSession.id,
        model,
        variant, // kilocode_change
      }
      // kilocode_change end

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps // kilocode_change
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra")) // kilocode_change

      function cancel() { // kilocode_change
        ops.cancel(nextSession.id) // kilocode_change
      } // kilocode_change

      // kilocode_change start - run subagents with direct child safeguards
      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant, // kilocode_change
          agent: next.name,
          tools: {
            question: false, // kilocode_change - subagents cannot prompt the user directly
            ...(canTodo ? {} : { todowrite: false }),
            ...(canTask ? {} : { task: false }),
            ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          },
          parts,
        })
        // kilocode_change start - expose terminal child assistant errors through the task tool boundary.
        if (result.info.role === "assistant" && result.info.error) {
          return yield* Effect.fail(new Error(`${errorMessage(result.info.error)}\n${resumeHint(nextSession.id)}`))
        }
        // kilocode_change end
        return result.parts.findLast((item) => item.type === "text")?.text ?? "" // kilocode_change
      })
      // kilocode_change end

      return yield* Effect.acquireUseRelease(
        // kilocode_change start - snapshot child cost so we propagate only the delta on resume
        Effect.gen(function* () {
          ctx.abort.addEventListener("abort", cancel)
          return yield* KiloCostPropagation.childCost(sessions, nextSession.id)
        }),
        // kilocode_change end
        () =>
          Effect.gen(function* () { // kilocode_change
            const text = yield* runTask() // kilocode_change
            return { // kilocode_change
              title: params.description,
              metadata, // kilocode_change
              output: output(nextSession.id, text), // kilocode_change
            }
          }), // kilocode_change
        // kilocode_change start - propagate subagent cost delta to parent on every exit path
        (costBefore) =>
          Effect.gen(function* () {
            ctx.abort.removeEventListener("abort", cancel)
            const costAfter = yield* KiloCostPropagation.childCost(sessions, nextSession.id)
            yield* KiloCostPropagation.propagate(sessions, ctx.sessionID, ctx.messageID, costAfter - costBefore)
          }),
        // kilocode_change end
      )
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
