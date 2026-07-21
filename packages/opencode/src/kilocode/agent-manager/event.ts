// kilocode_change - new file
import { BusEvent } from "@/bus/bus-event"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionID } from "@/session/schema"
import z from "zod"

export const AgentManagerTask = z.object({
  prompt: z.string().optional(),
  name: z.string().optional(),
  branchName: z.string().optional(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  variant: z.string().optional(),
})
export type AgentManagerTask = z.infer<typeof AgentManagerTask>

export const AgentManagerMode = z.enum(["worktree", "local"])

export const AgentManagerStart = z.object({
  requestID: z.string(),
  sessionID: SessionID.zod,
  mode: AgentManagerMode,
  versions: z.boolean().optional(),
  tasks: z.array(AgentManagerTask).min(1).max(20),
})
export type AgentManagerStart = z.infer<typeof AgentManagerStart>

export const AgentManagerEvent = {
  Start: BusEvent.define("kilocode.agent_manager.start", AgentManagerStart),
}
