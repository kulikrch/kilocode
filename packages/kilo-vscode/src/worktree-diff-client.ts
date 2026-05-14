import type { GitOps } from "./agent-manager/GitOps"

/**
 * A worktree target: the working directory and the base branch we diff
 * against (usually the tracking branch).
 */
export type DiffTarget = { directory: string; baseBranch: string }

export type DiffStatus = "added" | "deleted" | "modified"
export type StatusResolver = (target: DiffTarget, file: string) => Promise<DiffStatus | undefined>

/**
 * Thin coordinator that wraps local diff status lookup with GitOps revert
 * behavior used by the Changes panel and Agent Manager.
 */
export class WorktreeDiffReverter {
  constructor(
    private readonly git: GitOps,
    private readonly status: StatusResolver,
    private readonly log: (...args: unknown[]) => void,
  ) {}

  async fileStatus(target: DiffTarget, file: string): Promise<DiffStatus | undefined> {
    try {
      return await this.status(target, file)
    } catch (err) {
      this.log("Failed to look up file status for revert:", err)
      return undefined
    }
  }

  async revertFile(target: DiffTarget, file: string): Promise<{ ok: boolean; message: string }> {
    const status = await this.fileStatus(target, file)
    return this.git.revertFile(target.directory, target.baseBranch, file, status)
  }
}
