/** GitLab's review adapter: merge-request reads, ticket claiming, and terminal notices behind the forge-neutral contract. */
import type { OutboundMessage, Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceContext } from './host.ts'
import { endedMergeRequest, claimMergeRequest, mrNoticeKey, mrNumber, readMergeRequest, reviewUrl, type ClaimCandidate } from './gitlab-mr.ts'
import { REVIEW_THREAD, type BoundReview, type ReviewSource } from './review.ts'

const asClaim = (review: BoundReview): ClaimCandidate => ({ iid: review.number,
  state: review.state === 'open' ? 'opened' : review.state === 'merged' ? 'merged' : 'closed',
  author: { username: review.author }, source_branch: review.sourceBranch,
  source_project_id: review.sourceProjectId, target_project_id: review.targetProjectId, web_url: review.url })
/** Chinese when the request has Han characters and no kana, as the notices of both forges do. */
const chinese = (request: string): boolean => /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
/**
 * Reports a merged or closed MR once to the ticket's non-GitLab conversations. GitLab's own timeline already shows the merge or
 * closure, and a private note must not become a comment on another forge.
 */
export function mergeRequestEndNotices(ticket: Ticket, request: string, deployment: Deployment): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follow = endedMergeRequest(ticket)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const number = mrNumber(follow.thread)!
  const url = reviewUrl(deployment, number)
  const text = chinese(request)
    ? outcome === 'merged' ? `[MR !${number}](${url}) 已合并。` : `[MR !${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${number}](${url}) has merged.` : `[MR !${number}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== 'gitlab').map(channel => ({
    id: mrNoticeKey(ticket, follow, `${channel.source}:${JSON.stringify(channel.address)}`), channel, text, kind: 'notice', ticketId: ticket.id }))
}
export const gitlabReview: ReviewSource = {
  kind: 'gitlab',
  thread: number => REVIEW_THREAD.gitlab!(number),
  number: mrNumber,
  read: async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<BoundReview> => {
    const mr = await readMergeRequest(ctx, number, signal)
    return { source: 'gitlab', number: mr.iid, state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
      url: mr.web_url, author: mr.author.username, sourceBranch: mr.source_branch, targetBranch: mr.target_branch,
      sourceProjectId: mr.source_project_id ?? undefined, targetProjectId: mr.target_project_id ?? undefined }
  },
  claim: (ctx, ticketId, review) => claimMergeRequest(ctx, ticketId, asClaim(review)),
  endNotices: mergeRequestEndNotices,
}