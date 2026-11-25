/** GitHub's review adapter: pull-request reads, ticket claiming, and terminal notices behind the forge-neutral contract. */
import type { OutboundMessage, Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { claimPull, pullEndNotices, pullNumber, readPull, type Pull } from './github-pull.ts'
import type { SourceContext } from './host.ts'
import { REVIEW_THREAD, type BoundReview, type ReviewSource } from './review.ts'

/** Reconstructs enough of a pull-request record for the claiming rules from a bounded review. */
const asPull = (review: BoundReview): Pull => ({
  number: review.number, state: review.state === 'open' ? 'open' : 'closed', html_url: review.url,
  user: { login: review.author }, head: { sha: '', ref: review.sourceBranch, repo: { full_name: review.sourceRepo ?? '' } },
  merged: review.state === 'merged', merged_at: review.state === 'merged' ? new Date().toISOString() : null,
  closed_at: review.state === 'open' ? null : new Date().toISOString(),
})
export const githubReview: ReviewSource = {
  kind: 'github',
  thread: number => REVIEW_THREAD.github!(number),
  number: pullNumber,
  read: async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<BoundReview> => {
    const pr = await readPull(ctx, number, signal)
    return { source: 'github', number: pr.number, state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
      url: pr.html_url, author: pr.user.login, sourceBranch: pr.head.ref, targetBranch: pr.base?.ref ?? 'HEAD',
      sourceRepo: pr.head.repo?.full_name, targetRepo: ctx.deployment.repository }
  },
  claim: (ctx, ticketId, review) => claimPull(ctx, ticketId, asPull(review)),
  endNotices: (ticket: Ticket, request: string, deployment: Deployment): OutboundMessage[] =>
    pullEndNotices(ticket, request, deployment.repository ?? ''),
}