// kilocode_change - new file
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { generateCommitMessage, NoChangesError } from "../../commit-message"
import { Config } from "../../../config"
import { lazy } from "../../../util/lazy"
import { errors } from "../../../server/error"

export const CommitMessageRoutes = lazy(() =>
  new Hono().post(
    "/",
    describeRoute({
      summary: "Generate commit message",
      description: "Generate a commit message using AI based on the current git diff.",
      operationId: "commitMessage.generate",
      responses: {
        200: {
          description: "Generated commit message",
          content: {
            "application/json": {
              schema: resolver(z.object({ message: z.string() })),
            },
          },
        },
        422: {
          description: "CommitMessageNoChangesError",
          content: {
            "application/json": {
              schema: resolver(z.object({ message: z.string() })),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        path: z.string().meta({ description: "Workspace/repo path" }),
        selectedFiles: z.array(z.string()).optional().meta({ description: "Optional subset of files to include" }),
        previousMessage: z
          .string()
          .optional()
          .meta({ description: "Previously generated message — triggers regeneration with a different result" }),
        language: z
          .string()
          .optional()
          .meta({
            description: "Target language for the generated commit message (e.g. zh, en). Falls back to English.",
          }),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      const config = await Config.get()
      const prompt = config.commit_message?.prompt || undefined
      try {
        const result = await generateCommitMessage({ ...body, prompt })
        return c.json({ message: result.message })
      } catch (err) {
        if (err instanceof NoChangesError) {
          return c.json({ message: err.message }, 422)
        }
        throw err
      }
    },
  ),
)
