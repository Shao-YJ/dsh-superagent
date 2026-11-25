/** Forge-neutral review binding: the small contract every review Source implements, and thread-key parsing shared by cards and notices. */
import type { OutboundMessage, Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceContext } from './host.ts'

export interface BoundReview {
  source: string
  number: number
  state: 'open' | 'merged' | 'closed'
  url: string
  author: string
  sourceBranch: string
  targetBranch: string
  /** The repository the head branch lives in; a fork is never the agent's review. */
  sourceRepo?: string
  targetRepo?: string
  sourceProjectId?: number
  targetProjectId?: number
}
/**
 * The review lifecycle a forge Source contributes: reading a PR/MR, claiming it for a Ticket, and the end notices a Ticket
 * sends when its review merges or closes. The Executor tool and the end-notice builder both go through it.
 */
export interface ReviewSource {
  readonly kind: string
  thread(number: number): string
  /** The PR number or MR IID a Thread key names, never a numeric parse of the whole key. */
  number(thread: string): number | undefined
  read(ctx: SourceContext, number: number, signal?: AbortSignal): Promise<BoundReview | undefined>
  claim(ctx: SourceContext, ticketId: string, review: BoundReview): string | undefined
  endNotices(ticket: Ticket, request: string, deployment: Deployment): OutboundMessage[]
}
/** Thread key of each forge's review; GitLab prefixes the MR IID with `mr:` so `Number(thread.slice(...))` cannot work. */
export const REVIEW_THREAD: Readonly<Record<string, (number: number) => string>> = {
  github: number => `github:${number}`,
  gitlab: number => `gitlab:mr:${number}`,
}
/** Builds the review Thread key of a forge and number, such as `github:12` or `gitlab:mr:7`. */
export const reviewThread = (source: string, number: number): string | undefined => REVIEW_THREAD[source]?.(number)
/** Parses the review a Thread key names, such as `github:12` or `gitlab:mr:7`; other Threads (issues, chats) have none. */
export function reviewOfThread(thread: string): { source: string; number: number } | undefined {
  for (const [source, key] of Object.entries(REVIEW_THREAD)) {
    const prefix = key(0).slice(0, -1)
    if (!thread.startsWith(prefix)) continue
    const rest = thread.slice(prefix.length)
    if (!/^[1-9]\d*$/.test(rest)) return undefined
    return { source, number: Number(rest) }
  }
  return undefined
}