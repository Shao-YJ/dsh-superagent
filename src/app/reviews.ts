/** Forge-neutral review notices and the resolver the Executor tool uses to read and claim a PR or MR. */
import type { Follow, OutboundMessage, Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceContext } from '../sources/host.ts'
import { reviewOfThread, type ReviewSource } from '../sources/review.ts'

/** A review adapter together with the Source context its API calls run in. */
export interface ReviewTarget { review: ReviewSource; context: SourceContext }
/**
 * Resolves the forge a worker's `pr_number` names. A ticket on a Feishu thread can target either configured forge; the tool's
 * argument stays `pr_number` in this phase, and this resolver supplies the meaning.
 */
export interface ReviewResolver {
  /** Configured forge kinds, in preference order. */
  names(): string[]
  /** The account login the agent acts as on a forge, for the tool description. */
  login(source: string): string | undefined
  /** The default forge when the worker omits `review_source`: the only configured one, or GitHub when both are. */
  defaultSource(): string | undefined
  /** The adapter and context for a named forge, or the default one when `source` is omitted; undefined when unavailable. */
  resolve(source?: string): ReviewTarget | undefined
}

/** The last-closed review a Ticket followed, preferring the one it opened. */
function endedReview(ticket: Ticket): Follow | undefined {
  const closed = (ticket.follows ?? []).filter(item => item.closed && reviewOfThread(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  return latest(closed.filter(item => item.own)) ?? latest(closed)
}
/**
 * Builds idempotent notices for a Ticket that ended with its review, delegating the text, URL and own-forge skip to the review
 * Source that owns the followed Thread. A Source without a review adapter, or an outcome that is not a review end, yields none.
 */
export function reviewEndNotices(ticket: Ticket, request: string, deployment: Deployment, reviews: readonly ReviewSource[]): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  if (outcome !== 'merged' && outcome !== 'closed') return []
  const follow = endedReview(ticket)
  const found = follow && reviewOfThread(follow.thread)
  if (!found) return []
  return reviews.find(review => review.kind === found.source)?.endNotices(ticket, request, deployment) ?? []
}