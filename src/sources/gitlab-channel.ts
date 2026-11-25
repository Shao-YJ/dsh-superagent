/** GitLab outbound channel: posts Issue or Merge Request notes and discussion replies under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { gitlabPage, NoteSchema, type GitlabKind } from './gitlab-trigger.ts'

const ProjectSchema = z.looseObject({ id: z.number() })
const DiscussionSchema = z.looseObject({ notes: z.array(NoteSchema) })
const subjectPath = (kind: GitlabKind, iid: number) => `${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
/** True when the Issue/MR no longer exists but the project is still readable; a lost project access is retryable. */
async function gone(host: Pick<SourceContext, 'commands'>, error: unknown, iid: number, kind: GitlabKind, discussion?: string): Promise<boolean> {
  if (!(error instanceof CliError) || error.code !== 404) return false
  await host.commands.gitlabApi(ProjectSchema, '')
  const target = await host.commands.gitlabApi(z.unknown(), discussion
    ? `${subjectPath(kind, iid)}/discussions/${encodeURIComponent(discussion)}` : subjectPath(kind, iid)).catch((check: unknown) => {
    if (check instanceof CliError && check.code === 404) return undefined
    throw check
  })
  return target === undefined
}
/** Posts a note with an embedded HTML marker so retries do not create duplicate notes. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { gitlab } = commands.deployment
  if (!gitlab) throw new Error('This installation has no GitLab account')
  const kind = message.channel.address.kind === 'mr' ? 'mr' : 'issue'
  const iid = Number(message.channel.address.iid)
  if (!iid) throw new Error('Missing GitLab reply target')
  const discussion = message.channel.address.discussion
  const marker = `<!-- dsh-superagent:${message.id} -->`
  const body = `${message.text}\n\n${marker}`
  try {
    if (discussion) {
      const found = await commands.gitlabApi(DiscussionSchema, `${subjectPath(kind, iid)}/discussions/${encodeURIComponent(discussion)}`)
      if (found.notes.some(note => note.body.includes(marker))) return 'sent'
      await commands.gitlabApi(z.unknown(), `${subjectPath(kind, iid)}/discussions/${encodeURIComponent(discussion)}/notes`,
        '--method', 'POST', '--raw-field', `body=${body}`)
    } else {
      const notes = await commands.gitlabPages(NoteSchema, `${subjectPath(kind, iid)}/notes?order_by=created_at&sort=asc`)
      if (notes.some(note => note.body.includes(marker))) return 'sent'
      await commands.gitlabApi(z.unknown(), `${subjectPath(kind, iid)}/notes`, '--method', 'POST', '--raw-field', `body=${body}`)
    }
    return 'sent'
  } catch (error) {
    if (await gone(host, error, iid, kind, discussion)) return 'gone'
    throw error
  }
}
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const kind: GitlabKind = address.kind === 'mr' ? 'mr' : 'issue'
  const iid = Number(address.iid)
  const number = kind === 'mr' ? `!${iid}` : `#${iid}`
  const url = address.url || (links.gitlab ? gitlabPage({ gitlab: links.gitlab }, kind, iid) : '')
  return { url, label: address.discussion
    ? { zh: `GitLab ${number} 的讨论`, en: `Discussion on GitLab ${number}` }
    : { zh: `GitLab ${number}`, en: `GitLab ${number}` } }
}