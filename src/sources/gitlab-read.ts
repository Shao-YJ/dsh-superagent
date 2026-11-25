/** Read-only GitLab project, conversation, discussion and merge request inspection for assessments, resources and workers. */
import { z } from 'zod'
import { validItems, type Commands } from '../infra/commands.ts'
import {
  IssueSchema, isHumanUser, MergeRequestSchema, NoteSchema, DiscussionSchema, gitlabChannel, gitlabPage,
  type GitlabIssue, type GitlabMergeRequest, type GitlabNote,
} from './gitlab-trigger.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'
import type { Trigger } from '../core/index.ts'

const PAGE = 20
const SubjectSchema = z.union([IssueSchema, MergeRequestSchema])
const TreeSchema = z.array(z.looseObject({ name: z.string(), type: z.string(), path: z.string() }))
const ProjectSchema = z.looseObject({ default_branch: z.string().nullish() })

/** Formats a note as a model-facing message, marking bot accounts because their words never authorize work. */
function noteMessage(note: GitlabNote, url: string, threadRoot?: number): ContextMessage {
  return { id: String(note.id), from: note.author.username, at: note.created_at, text: note.body,
    ...!isHumanUser(note.author) ? { bot: true } : {}, url: `${url}#note_${note.id}`,
    ...threadRoot !== undefined && threadRoot !== note.id ? { reply_to: String(threadRoot) } : {} }
}
/** True when the selected kind matches the resource's kind, so an issue resource cannot read MR discussions. */
const kinds: Record<string, 'issue' | 'mr'> = { issues: 'issue', merge_requests: 'mr' }
const subjectPath = (kind: 'issue' | 'mr', iid: number): string => `${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
/**
 * Reads an Issue or Merge Request, a page of its notes or discussions, or the project tree/default-branch file as
 * model-facing messages rather than raw GitLab API records.
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const match = /^gitlab\/(issues|merge_requests)\/([1-9]\d*)(?:\/(notes|discussions)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) throw new Error('Use gitlab/issues/<iid>, gitlab/merge_requests/<iid>, or append /notes/<page> or /discussions/<page>')
  const [, path, rawIid, section, rawPage = '1'] = match
  const kind = kinds[path!]!
  const iid = Number(rawIid)
  const page = Number(rawPage)
  if (section === 'discussions' && kind !== 'mr') throw new Error('Discussions require a merge request')
  const subject = await commands.gitlabApi((kind === 'mr' ? MergeRequestSchema : IssueSchema), subjectPath(kind, iid)) as GitlabIssue | GitlabMergeRequest
  const subjectUrl = subject.web_url || gitlabPage(commands.deployment, kind, iid)
  if (!section) {
    const listed = await commands.gitlabApi(z.array(z.unknown()), `${subjectPath(kind, iid)}/notes?order_by=created_at&sort=asc&per_page=${PAGE}&page=1`)
    const tally = { skipped: 0 }
    const notes = validItems(NoteSchema, listed, tally).filter(note => note.system !== true)
    const root: ContextMessage = { id: subjectUrl, from: subject.author.username, at: subject.created_at,
      text: `${subject.title}\n\n${subject.description ?? ''}`, ...!isHumanUser(subject.author) ? { bot: true } : {}, url: subjectUrl }
    return { iid, title: subject.title, state: subject.state,
      ...kind === 'mr' ? { source_branch: (subject as GitlabMergeRequest).source_branch, target_branch: (subject as GitlabMergeRequest).target_branch } : {},
      messages: [root, ...notes.map(note => noteMessage(note, subjectUrl))], ...tally.skipped ? { skipped: tally.skipped } : {},
      ...listed.length === PAGE ? { next_resource: `gitlab/${path}/${iid}/notes/2` } : {} }
  }
  const listed = await commands.gitlabApi(z.array(z.unknown()), `${subjectPath(kind, iid)}/${section}?per_page=${PAGE}&page=${page}`)
  const tally = { skipped: 0 }
  if (section === 'discussions') {
    const discussions = validItems(DiscussionSchema, listed, tally)
    const messages = discussions.flatMap(item => {
      const notes = item.notes.filter(note => note.system !== true)
      const root = notes[0]?.id
      return notes.map(note => noteMessage(note, subjectUrl, root))
    })
    return { messages, ...tally.skipped ? { skipped: tally.skipped } : {},
      ...listed.length === PAGE ? { next_resource: `gitlab/${path}/${iid}/discussions/${page + 1}` } : {} }
  }
  const notes = validItems(NoteSchema, listed, tally).filter(note => note.system !== true)
  return { messages: notes.map(note => noteMessage(note, subjectUrl)), ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listed.length === PAGE ? { next_resource: `gitlab/${path}/${iid}/notes/${page + 1}` } : {} }
}
/** One discussion's notes as messages, oldest first; the first note is the thread root. */
async function discussion(commands: Commands, iid: number, id: string): Promise<{ notes: GitlabNote[]; url: string }> {
  const mr = await commands.gitlabApi(MergeRequestSchema, subjectPath('mr', iid)) as GitlabMergeRequest
  const found = await commands.gitlabApi(DiscussionSchema, `${subjectPath('mr', iid)}/discussions/${encodeURIComponent(id)}`)
  return { notes: found.notes.filter(note => note.system !== true), url: mr.web_url || gitlabPage(commands.deployment, 'mr', iid) }
}
/**
 * Context reader for a GitLab Trigger: the discussion of an MR code review note (whose first note is its root and parent),
 * or the Issue/Merge Request conversation by page otherwise (whose first page is its root and parent).
 */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: (trigger: Trigger) => typeof trigger.meta.noteId === 'number' ? String(trigger.meta.noteId) : trigger.url ?? '',
  read: async (commands, trigger, part, cursor) => {
    const iid = Number(trigger.meta.iid)
    const kind = trigger.meta.kind === 'mr' ? 'mr' : 'issue'
    if (trigger.meta.discussionId !== undefined && kind === 'mr') {
      const { notes, url } = await discussion(commands, iid, String(trigger.meta.discussionId))
      const root = notes[0]?.id
      const messages = notes.map(note => noteMessage(note, url, root))
      const read = part === 'thread' ? messages : messages.slice(0, 1)
      return { messages: read, body: { status: 'discussion', messages: read }, status: 'discussion' }
    }
    const page = Number(cursor ?? '1')
    return conversationPage(commands, kind, iid, page, part)
  },
}
/** Reads one page of an Issue or MR conversation (with the description first on page 1). */
async function conversationPage(commands: Commands, kind: 'issue' | 'mr', iid: number, page: number, part: string): Promise<ContextPart> {
  const messages: ContextMessage[] = []
  const subject = await commands.gitlabApi((kind === 'mr' ? MergeRequestSchema : IssueSchema), subjectPath(kind, iid)) as GitlabIssue | GitlabMergeRequest
  const url = subject.web_url || gitlabPage(commands.deployment, kind, iid)
  if (page === 1) messages.push({ id: url, from: subject.author.username, at: subject.created_at, text: `${subject.title}\n\n${subject.description ?? ''}`,
    ...!isHumanUser(subject.author) ? { bot: true } : {}, url })
  const listed = await commands.gitlabApi(z.array(z.unknown()), `${subjectPath(kind, iid)}/notes?order_by=created_at&sort=asc&per_page=100&page=${page}`)
  const tally = { skipped: 0 }
  messages.push(...validItems(NoteSchema, listed, tally).filter(note => note.system !== true).map(note => noteMessage(note, url)))
  const read = part === 'thread' ? messages : messages.slice(0, 1)
  return { messages: read, next: listed.length === 100 ? String(page + 1) : undefined,
    body: { status: 'conversation', messages: read, ...tally.skipped ? { skipped: tally.skipped } : {} } }
}
/** Reads a non-hidden file or directory listing from the project's default branch; hidden entries and `node_modules` are rejected. */
export async function readGitlabRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) {
    throw new Error('Only non-hidden repository source paths are available')
  }
  const project = await commands.gitlabApi(ProjectSchema, '')
  const ref = project.default_branch ?? 'HEAD'
  if (kind === 'file') {
    return commands.gitlabApi(`repository/files/${encodeURIComponent(parts.join('/'))}/raw`, '--raw-field', `ref=${encodeURIComponent(ref)}`)
  }
  const entries = await commands.gitlabApi(TreeSchema, `repository/tree?path=${encodeURIComponent(parts.join('/'))}&ref=${encodeURIComponent(ref)}&per_page=100`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules')
    .sort().join('\n')
}
/** The channel of a GitLab conversation, used by generic reply routing. */
export const gitlabConversationChannel = gitlabChannel