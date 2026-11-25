/** Normalizes GitLab issues, merge requests, notes and to-dos into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger, type ThreadRef } from '../core/index.ts'
import { escapeRegExp } from '../infra/text.ts'
import type { Deployment } from '../deployment.ts'

export const SOURCE = 'gitlab'
/** A GitLab conversation kind; issues and merge requests use their IID in thread keys and URLs. */
export type GitlabKind = 'issue' | 'mr'
export const gitlabThread = (kind: GitlabKind, iid: number): string => `gitlab:${kind}:${iid}`
export const gitlabRef = (kind: GitlabKind, iid: number): ThreadRef => ({ source: SOURCE, id: `${kind}:${iid}` })
export const gitlabPage = (deployment: Pick<Deployment, 'gitlab'>, kind: GitlabKind, iid: number): string =>
  deployment.gitlab ? `${deployment.gitlab.baseUrl}/${deployment.gitlab.project}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}` : ''
/** GitLab reply address: the Issue or Merge Request conversation, or one discussion in it. */
export const gitlabChannel = (kind: GitlabKind, iid: number, discussion?: string): ChannelRef =>
  ({ source: SOURCE, thread: gitlabThread(kind, iid), address: { kind, iid: String(iid), ...(discussion ? { discussion } : {}) } })
/**
 * Parses a GitLab web URL for an Issue or Merge Request in the configured project, including a `#note_` or
 * `#discussion_` anchor; returns undefined for another project or instance.
 */
export function gitlabAddress(url: string, deployment: Pick<Deployment, 'gitlab'>): { kind: GitlabKind; iid: number; discussion?: string; note?: number } | undefined {
  const { gitlab } = deployment
  if (!gitlab) return undefined
  const page = `${escapeRegExp(gitlab.baseUrl)}/${escapeRegExp(gitlab.project)}/-/(issues|merge_requests)/(\\d+)`
  const match = new RegExp(`^${page}/?(?:#(?:note_(\\d+)|discussion_([\\w-]+)))?$`, 'i').exec(url)
  if (!match) return undefined
  return { kind: match[1]!.toLowerCase() === 'issues' ? 'issue' : 'mr', iid: Number(match[2]),
    ...match[3] ? { note: Number(match[3]) } : {}, ...match[4] ? { discussion: match[4] } : {} }
}
/** GitLab users carry an explicit `bot` flag; an automation account without it is treated as a person, as policy decides. */
export const UserSchema = z.looseObject({ id: z.number().optional(), username: z.string(), name: z.string().nullish(), bot: z.boolean().nullish() })
export type GitlabUser = z.infer<typeof UserSchema>
export const isHumanUser = (user: GitlabUser): boolean => user.bot !== true && !/\[bot\]$/i.test(user.username)
/** A note as `/notes` returns it; `system` notes are state changes and never requests. */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string(), author: UserSchema, created_at: z.string(), updated_at: z.string().nullish(),
  system: z.boolean().nullish(), noteable_type: z.string().nullish(), noteable_iid: z.number().nullish(),
  resolvable: z.boolean().nullish(), resolved: z.boolean().nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
export const DiscussionSchema = z.looseObject({ id: z.string(), individual_note: z.boolean().nullish(), notes: z.array(NoteSchema) })
export type GitlabDiscussion = z.infer<typeof DiscussionSchema>
export const IssueSchema = z.looseObject({
  id: z.number(), iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(),
  author: UserSchema, created_at: z.string(), updated_at: z.string().nullish(), web_url: z.string(), project_id: z.number().nullish(),
  confidential: z.boolean().nullish(), labels: z.array(z.unknown()).nullish(),
})
export type GitlabIssue = z.infer<typeof IssueSchema>
export const MergeRequestSchema = z.looseObject({
  id: z.number(), iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(),
  author: UserSchema, created_at: z.string(), updated_at: z.string().nullish(), web_url: z.string(),
  source_branch: z.string(), target_branch: z.string(), source_project_id: z.number().nullish(), target_project_id: z.number().nullish(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), draft: z.boolean().nullish(), work_in_progress: z.boolean().nullish(),
})
export type GitlabMergeRequest = z.infer<typeof MergeRequestSchema>
/** A to-do of the agent account; `target_url` points at the Issue, Merge Request or note that needs attention. */
export const TodoSchema = z.looseObject({
  id: z.number(), action_name: z.string(), target_type: z.string().nullish(), target_url: z.string().nullish(),
  body: z.string().nullish(), state: z.string(), created_at: z.string(), updated_at: z.string().nullish(),
  project: z.looseObject({ id: z.number().nullish(), path_with_namespace: z.string().nullish() }).nullish(),
  target: z.looseObject({ iid: z.number().nullish(), title: z.string().nullish() }).nullish(),
  author: UserSchema.nullish(),
})
export type GitlabTodo = z.infer<typeof TodoSchema>
export const EventSchema = z.looseObject({
  id: z.number(), action_name: z.string().nullish(), target_iid: z.number().nullish(), target_type: z.string().nullish(),
  target_title: z.string().nullish(), created_at: z.string(), author: UserSchema.nullish(),
  note: NoteSchema.nullish(),
})
export type GitlabEvent = z.infer<typeof EventSchema>

const user = (candidate: GitlabUser): Trigger['actor'] => ({ source: SOURCE, id: candidate.username })
const author = (candidate: GitlabUser, agent: string, own = false): { actor: Trigger['actor']; human: boolean } =>
  ({ actor: user(candidate), human: isHumanUser(candidate) && (own || candidate.username !== agent) })
/** True when a note carries the host's or a worker's agent marker; such a note is output, never a request. */
export const agentNote = (note: Pick<GitlabNote, 'body'>): boolean => /<!--\s*dsh-superagent:/i.test(note.body)
/** True when `text` mentions `@login` as a whole username. */
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const title = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 120)
const opened = (kind: GitlabKind, iid: number, subject: { title: string; description?: string | null }, author: GitlabUser): string =>
  `@${author.username} opened ${kind === 'mr' ? 'merge request' : 'issue'} ${kind === 'mr' ? '!' : '#'}${iid} "${subject.title}"${subject.description ? `\n\n${subject.description}` : ''}`
const assigned = (kind: GitlabKind, iid: number, subject: { title: string; description?: string | null }, author: GitlabUser): string =>
  `@${author.username} assigned ${kind === 'mr' ? 'merge request' : 'issue'} ${kind === 'mr' ? '!' : '#'}${iid} "${subject.title}" to the agent${subject.description ? `\n\n${subject.description}` : ''}`
/** Builds the Trigger for an Issue or Merge Request being opened or assigned to the agent. */
export function subjectTrigger(kind: GitlabKind, subject: GitlabIssue | GitlabMergeRequest, action: 'opened' | 'assigned',
  deployment: Pick<Deployment, 'gitlab'>, agent: string, actor?: GitlabUser, ref?: number, own = false): Trigger {
  const iid = subject.iid
  const who = actor ?? subject.author
  // Use the event or to-do id when there is one, so a later re-assignment is a new Trigger; an opened subject falls back to its creation time.
  const identity = ref !== undefined ? String(ref) : action === 'opened' ? subject.created_at : subject.updated_at ?? subject.created_at
  const self = own && who.username === agent
  return { id: key('gitlab-subject', `${kind}:${iid}:${action}:${who.username}`, identity), source: SOURCE,
    threads: [gitlabRef(kind, iid)], ...author(who, agent, self), at: subject.updated_at ?? subject.created_at,
    text: action === 'opened' ? opened(kind, iid, subject, who) : assigned(kind, iid, subject, who),
    ...action === 'assigned' || self ? { addressed: 'direct' as const }
      : mentions(`${subject.title}\n${subject.description ?? ''}`, agent) ? { addressed: 'mention' as const } : {},
    channel: gitlabChannel(kind, iid), url: subject.web_url || gitlabPage(deployment, kind, iid),
    meta: { kind, iid, author: who.username, title: title(subject.title), action } }
}
/** Builds the Trigger for a Note on an Issue or Merge Request; `discussion` carries an MR code review thread. */
export function noteTrigger(kind: GitlabKind, iid: number, note: GitlabNote, subject: { title: string; web_url: string }, agent: string,
  discussion?: string, own = false): Trigger {
  const url = `${subject.web_url}#note_${note.id}`
  const self = own && note.author.username === agent
  return { id: key('gitlab-note', `${kind}:${iid}`, String(note.id)), source: SOURCE, threads: [gitlabRef(kind, iid)],
    ...author(note.author, agent, self), at: note.created_at, text: note.body, channel: gitlabChannel(kind, iid, discussion), url,
    ...self || mentions(note.body, agent) ? { addressed: self ? 'direct' as const : 'mention' as const } : {},
    meta: { kind, iid, noteId: note.id, discussionId: discussion, author: note.author.username, title: title(subject.title) } }
}
/** Builds a Trigger from a project event that carries an Issue, Merge Request or Note. */
export function eventTrigger(event: GitlabEvent, deployment: Pick<Deployment, 'gitlab'>, agent: string, own = false): Trigger | undefined {
  const type = event.target_type
  const author = event.author ?? event.note?.author
  if (!author || !event.target_iid) return undefined
  const titleText = event.target_title ?? ''
  if (type === 'Note' && event.note) {
    const note = event.note
    const noteable = note.noteable_type === 'MergeRequest' ? 'mr' : 'issue'
    const iid = note.noteable_iid ?? event.target_iid
    const subject = { title: titleText, web_url: `${gitlabPage(deployment, noteable, iid)}` }
    return noteTrigger(noteable, iid, note, subject, agent, undefined, own)
  }
  if ((type === 'Issue' || type === 'MergeRequest') && (event.action_name === 'opened' || event.action_name === 'assigned')) {
    const kind: GitlabKind = type === 'Issue' ? 'issue' : 'mr'
    const subject = { iid: event.target_iid, title: titleText, description: null, author, created_at: event.created_at,
      updated_at: event.created_at, web_url: gitlabPage(deployment, kind, event.target_iid), state: 'opened' }
    return subjectTrigger(kind, subject as GitlabIssue, event.action_name === 'assigned' ? 'assigned' : 'opened', deployment, agent, author, event.id, own)
  }
  return undefined
}
