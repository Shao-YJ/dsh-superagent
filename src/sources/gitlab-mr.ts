/** Merge request binding, lifecycle observation, and review facts for GitLab. */
import { key, liveTicket, type Follow, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceContext } from './host.ts'
import { gitlabPage, MergeRequestSchema, SOURCE, type GitlabMergeRequest } from './gitlab-trigger.ts'

export type MergeRequest = GitlabMergeRequest & { iid: number }
export const readMergeRequest = async (ctx: SourceContext, iid: number, signal?: AbortSignal): Promise<MergeRequest> =>
  ctx.commands.withSignal(signal).gitlabApi(MergeRequestSchema, `merge_requests/${iid}`) as Promise<MergeRequest>
/** The IID of a followed Merge Request Thread; `gitlab:mr:12` rather than a numeric parse of the whole key. */
export const mrNumber = (thread: string): number | undefined => {
  if (!thread.startsWith(`${SOURCE}:mr:`)) return undefined
  const number = Number(thread.slice(`${SOURCE}:mr:`.length))
  return Number.isInteger(number) && number > 0 ? number : undefined
}
export const mergeRequestsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => mrNumber(item.thread) ?? [])
export const mergeRequestOf = (ticket: Pick<Ticket, 'follows'>): number | undefined =>
  mergeRequestsOf(ticket, true).at(-1) ?? mergeRequestsOf(ticket).at(-1)
/** The fields the claiming rules need, which a bounded review or a full MR read both supply. */
export interface ClaimCandidate {
  iid: number
  state: string
  author: { username: string }
  source_branch: string
  source_project_id?: number | null
  target_project_id?: number | null
  title?: string
  web_url?: string
}
/** True when the MR was opened by the agent account in the configured project; a fork MR is not the agent's MR. */
export const agentMergeRequest = (mr: Pick<ClaimCandidate, 'author' | 'source_project_id' | 'target_project_id'>,
  deployment: Pick<Deployment, 'gitlab'>): boolean => !!deployment.gitlab
  && mr.author.username === deployment.gitlab.login
  && mr.source_project_id === deployment.gitlab.projectId && mr.target_project_id === deployment.gitlab.projectId
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const DRAFT_ON: ThreadFact = { label: { zh: '草稿', en: 'Draft' }, value: { zh: '是', en: 'yes' } }
/**
 * Validates and binds an open Merge Request to a ticket when it is either the ticket's origin MR or an agent-authored MR on the
 * ticket's branch, enforcing that one MR binds to at most one open ticket.
 * @returns an error message when binding is rejected, or undefined when bound or not open.
 */
export function claimMergeRequest(ctx: SourceContext, ticketId: string, mr: ClaimCandidate): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its Merge Request was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.kind === 'mr' && source.meta.iid === mr.iid
  const opened = agentMergeRequest(mr, ctx.deployment) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const login = ctx.deployment.gitlab?.login ?? 'the agent'
    return `Merge Request does not belong to this ticket: use the source MR or an MR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no MR exists`
  }
  const owner = ctx.tickets.open().find(item => mergeRequestsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'Merge Request already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:mr:${mr.iid}`)
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}
/**
 * Reconciles a polled MR's open/merged/closed state and draft fact with any bound or branch-matching ticket.
 * An open agent MR auto-binds to the single open ticket on its branch unless that ticket already follows another open MR.
 * @returns whether the MR has ended.
 */
export async function observeMergeRequest(ctx: SourceContext, mr: MergeRequest): Promise<boolean> {
  const ended = mr.state === 'merged' || mr.state === 'closed'
  if (ended) {
    // The MR may merge between polls, before it was ever bound; bind it by the same branch rule so the ticket can end.
    const candidates = agentMergeRequest(mr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    const followed = ticket?.follows?.some(item => item.thread === `${SOURCE}:mr:${mr.iid}`)
    if (ticket && !followed && mergeRequestsOf(ticket, true).every(number => number === mr.iid)) bind(ctx, ticket.id, mr, true)
    closeMergeRequest(ctx, mr)
  } else {
    const candidates = agentMergeRequest(mr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:mr:${mr.iid}` && item.closed)
    if (ticket && (reopened || mergeRequestsOf(ticket, true).every(number => number === mr.iid))) claimMergeRequest(ctx, ticket.id, mr)
  }
  ctx.threads.describe(`${SOURCE}:mr:${mr.iid}`, { facts: { draft: !ended && (mr.draft === true || mr.work_in_progress === true) ? DRAFT_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, mr: ClaimCandidate, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: `mr:${mr.iid}` }, own)
    ctx.threads.patch(`${SOURCE}:mr:${mr.iid}`, { kind: 'mr', iid: mr.iid, isMr: true,
      url: mr.web_url ?? reviewUrl(ctx.deployment, mr.iid), author: mr.author.username, ...mr.title ? { title: mr.title } : {} })
  })
}
/** Reports a merged or closed MR once to the open tickets that follow it, whose end the core decides. */
function closeMergeRequest(ctx: SourceContext, mr: MergeRequest): void {
  if (!ctx.tickets.open().some(ticket => mergeRequestsOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: `mr:${mr.iid}` }, mr.state === 'merged' ? 'merged' : 'closed', at)
}
/** The canonical web URL of an MR, or its origin Thread URL when the deployment is gone. */
export function reviewUrl(deployment: Pick<Deployment, 'gitlab'>, iid: number): string { return gitlabPage(deployment, 'mr', iid) }
/** Selects the last-closed MR of a Ticket, preferring the one the ticket opened. */
export function endedMergeRequest(ticket: Ticket): Follow | undefined {
  const follows = (ticket.follows ?? []).filter(item => item.closed && mrNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  return latest(follows.filter(item => item.own)) ?? latest(follows)
}
/** Idempotency key prefix of GitLab end notices; the generic review notices own their shape. */
export const mrNoticeKey = (ticket: Ticket, follow: Follow, channel: string): string =>
  key('mr-terminal', String(mrNumber(follow.thread)), channel, ticket.id)