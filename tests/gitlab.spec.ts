import { describe, expect, it, vi } from 'vitest'
import type { ChannelRef, OutboundMessage, Ticket, Trigger } from '../src/core/index.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { Deployment } from '../src/deployment.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { GitlabConfigSchema, gitlabKind, pollRound } from '../src/sources/gitlab.ts'
import { gitlabAddress, gitlabThread, noteTrigger, subjectTrigger } from '../src/sources/gitlab-trigger.ts'
import { claimMergeRequest, mergeRequestsOf, type MergeRequest } from '../src/sources/gitlab-mr.ts'
import { readGitlab, readGitlabRepositoryPath } from '../src/sources/gitlab-read.ts'
import { gitlabLink, sendGitlab } from '../src/sources/gitlab-channel.ts'
import { gitlabReview } from '../src/sources/gitlab-review.ts'
import { reviewEndNotices } from '../src/app/reviews.ts'
import { reviewOfThread, REVIEW_THREAD } from '../src/sources/review.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

const deployment = testDeployment({ gitlab: { baseUrl: 'https://gitlab.example.com', cli: '/bin/false', login: 'agent-bot', id: 7,
  commitEmail: '7+agent-bot@users.noreply.gitlab.example.com', project: 'team/app', projectId: 9 } })
const MR: MergeRequest = { id: 1, iid: 7, title: 'Add support', description: 'A change.', state: 'opened',
  author: { username: 'alice', name: 'Alice' }, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z',
  web_url: 'https://gitlab.example.com/team/app/-/merge_requests/7', source_branch: 'agent/ticket-1', target_branch: 'main',
  source_project_id: 9, target_project_id: 9, draft: false }
const note = (id: number, from: string, text: string, at = '2026-09-09T00:05:00Z') => ({ id, body: text, author: { username: from },
  created_at: at, system: false })

describe('GitLab thread keys and triggers', () => {
  it('names an MR or Issue without a numeric parse of the whole thread key', () => {
    expect(gitlabThread('mr', 7)).toBe('gitlab:mr:7')
    expect(reviewOfThread('gitlab:mr:7')).toEqual({ source: 'gitlab', number: 7 })
    expect(reviewOfThread('github:7')).toEqual({ source: 'github', number: 7 })
    expect(reviewOfThread('gitlab:issue:7')).toBeUndefined()
    expect(REVIEW_THREAD.gitlab!(7)).toBe('gitlab:mr:7')
  })
  it('parses a self-managed URL and marks mentions and assignments addressed', () => {
    expect(gitlabAddress('https://gitlab.example.com/team/app/-/merge_requests/7#note_55', deployment))
      .toEqual({ kind: 'mr', iid: 7, note: 55 })
    expect(gitlabAddress('https://gitlab.example.com/team/app/-/issues/8', deployment)).toEqual({ kind: 'issue', iid: 8 })
    // Another project or instance is not this deployment's.
    expect(gitlabAddress('https://gitlab.example.com/other/app/-/issues/8', deployment)).toBeUndefined()
    expect(gitlabAddress('https://github.com/team/app/issues/8', deployment)).toBeUndefined()
    const mention = noteTrigger('mr', 7, note(55, 'alice', '@agent-bot please review'), MR, 'agent-bot', 'disc1')
    expect(mention).toMatchObject({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'mr:7' }], addressed: 'mention',
      human: true, channel: { source: 'gitlab', thread: 'gitlab:mr:7', address: { kind: 'mr', iid: '7', discussion: 'disc1' } } })
    expect(noteTrigger('mr', 7, note(56, 'agent-bot', 'done'), MR, 'agent-bot').human).toBe(false)
    const ownNote = noteTrigger('mr', 7, note(57, 'agent-bot', 'please fix'), MR, 'agent-bot', undefined, true)
    expect(ownNote).toMatchObject({ human: true })
    expect(ownNote.addressed).toBeUndefined()
    expect(noteTrigger('mr', 7, note(58, 'agent-bot', '@agent-bot please fix'), MR, 'agent-bot', undefined, true))
      .toMatchObject({ human: true, addressed: 'mention' })
    expect(subjectTrigger('mr', MR, 'assigned', deployment, 'agent-bot')).toMatchObject({ addressed: 'direct', human: true })
    expect(subjectTrigger('mr', MR, 'assigned', deployment, 'agent-bot', { id: 9, username: 'lead' }))
      .toMatchObject({ actor: { source: 'gitlab', id: 'lead' }, addressed: 'direct' })
    expect(subjectTrigger('mr', MR, 'assigned', deployment, 'agent-bot', { id: 9, username: 'lead' }, 1).id)
      .not.toBe(subjectTrigger('mr', MR, 'assigned', deployment, 'agent-bot', { id: 9, username: 'lead' }, 2).id)
    expect(subjectTrigger('mr', MR, 'assigned', deployment, 'agent-bot', { id: 7, username: 'agent-bot' }, undefined, true))
      .toMatchObject({ human: true, addressed: 'direct' })
    const issue = { ...MR, iid: 8, title: 'Bug', state: 'opened', author: { username: 'agent-bot' } }
    const ownIssue = subjectTrigger('issue', issue, 'opened', deployment, 'agent-bot', undefined, undefined, true)
    expect(ownIssue).toMatchObject({ human: true })
    expect(ownIssue.addressed).toBeUndefined()
    expect(subjectTrigger('issue', { ...issue, description: '@agent-bot please fix' }, 'opened', deployment, 'agent-bot', undefined, undefined, true))
      .toMatchObject({ human: true, addressed: 'mention' })
    expect(subjectTrigger('issue', issue, 'opened', deployment, 'agent-bot').threads).toEqual([{ source: 'gitlab', id: 'issue:8' }])
  })
  it('finds bare numbers and GitLab page URLs but not a GitHub Issue URL', () => {
    expect(gitlabKind.find!('!7').threads).toEqual(['gitlab:mr:7'])
    expect(gitlabKind.find!('https://gitlab.example.com/team/app/-/issues/8').threads).toEqual(['gitlab:issue:8'])
    expect(gitlabKind.find!('https://github.com/team/app/issues/8').threads).toEqual([])
  })
  it('exposes the GitLab account variables while the GitLab Source is switched off', () => {
    const settings = SettingsSchema.parse({ sources: { gitlab: { enabled: false, config: { project: 'team/app',
      baseUrl: 'https://gitlab.example.com', cli: '/bin/false' } } } })
    const sources = new SourceRegistry(() => settings); sources.register(gitlabKind)
    const variables = environmentOf({ deployment, sources, settings })
    expect(variables.filter(variable => variable.key === 'DSH_SUPERAGENT_GITLAB_URL')).toHaveLength(1)
    expect(variables).toContainEqual(expect.objectContaining({ key: 'DSH_SUPERAGENT_GITLAB_URL', value: 'https://gitlab.example.com' }))
    expect(variables).toContainEqual(expect.objectContaining({ key: 'DSH_SUPERAGENT_GITLAB_PROJECT', value: 'team/app' }))
  })
  it('links an MR through the configured instance and project', () => {
    expect(gitlabLink({ kind: 'mr', iid: '7' }, { gitlab: deployment.gitlab })).toEqual({ url: MR.web_url,
      label: { zh: 'GitLab !7', en: 'GitLab !7' } })
    expect(gitlabLink({ kind: 'issue', iid: '8', discussion: 'd1' }, {})).toMatchObject({ url: '', label: { zh: 'GitLab #8 的讨论' } })
  })
  it('scopes notes to observed comments and subject bodies to their own row', () => {
    const config = GitlabConfigSchema.parse({ project: 'team/app', cli: 'glab', observeIssues: true, observeComments: false })
    expect(gitlabKind.scope!({ meta: { kind: 'issue' } }, config)).toMatchObject({ listened: true, observed: true, row: 'issues' })
    expect(gitlabKind.scope!({ meta: { kind: 'mr' } }, config)).toMatchObject({ observed: false, row: 'mergeRequests' })
    expect(gitlabKind.scope!({ meta: { kind: 'mr', noteId: 1 } }, config)).toMatchObject({ observed: false, row: 'comments' })
    expect(gitlabKind.policy!.rows!({ ...config, observeComments: true }).find(row => row.id === 'comments')!.cells)
      .toEqual({ listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true })
  })
})

describe('GitLab polling', () => {
  it('reads a to-do mention\'s discussion, receives only the new note, and completes the to-do', async () => {
    const received: Trigger[] = [], done: number[] = []
    const patches: [string, Record<string, unknown>][] = []
    const store = new Map<string, unknown>()
    const todo = { id: 3, action_name: 'mentioned', target_type: 'MergeRequest', state: 'pending',
      target_url: 'https://gitlab.example.com/team/app/-/merge_requests/7#note_55',
      project: { path_with_namespace: 'team/app' }, created_at: '2026-09-09T00:05:00Z' }
    const commands = {
      withSignal: () => commands,
      // Fails if the Source passes the wrong item schema to the to-do reader, as the real Commands would skip every to-do.
      gitlabTodos: vi.fn(async (schema: { parse(value: unknown): unknown }) => [schema.parse(todo)]),
      gitlabTodoDone: vi.fn(async (id: number) => { done.push(id) }),
      gitlabApi: vi.fn(async (first: unknown, path?: string) => {
        const resource = typeof first === 'string' ? first : path
        if (resource?.startsWith('events')) return []
        if (resource?.startsWith('merge_requests?')) return []
        if (resource === 'merge_requests/7') return MR
        if (resource?.startsWith('merge_requests/7/discussions')) return [{ id: 'disc1', notes: [
          { ...note(40, 'bob', 'earlier'), created_at: '2026-09-09T00:00:00Z' }, note(55, 'alice', '@agent-bot please review')] }]
        throw new Error(`unexpected GitLab call ${String(resource)}`)
      }),
    } as unknown as Commands
    const context = fakeContext({ commands, store, received, patches })
    await pollRound(context)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ meta: { noteId: 55, discussionId: 'disc1', kind: 'mr' }, addressed: 'mention' })
    expect(done).toEqual([3])
    expect(store.get('gitlab-cursor:gitlab:mr:7')).toEqual(expect.any(String))
    expect(patches.some(([key, meta]) => key === 'gitlab:mr:7' && meta.title === 'Add support')).toBe(true)
  })
  it('accepts only mentions of the monitored account in own-account mode, including its own mentions', async () => {
    const received: Trigger[] = []
    const at = new Date(Date.now() + 3_600_000).toISOString()
    const issue = (iid: number, description: string) => ({ id: 80 + iid, iid, title: 'Bug', description, state: 'opened',
      author: { username: 'agent-bot' }, created_at: at, updated_at: at,
      web_url: `https://gitlab.example.com/team/app/-/issues/${iid}` })
    const self = (id: number, text: string) => ({ ...note(id, 'agent-bot', text, at), noteable_type: 'MergeRequest', noteable_iid: 7 })
    const other = (id: number, text: string) => ({ ...note(id, 'alice', text, at), noteable_type: 'MergeRequest', noteable_iid: 7 })
    const events = [
      { id: 1, action_name: 'opened', target_type: 'Issue', target_iid: 8, target_title: 'Bug', created_at: at,
        author: { username: 'agent-bot' } },
      { id: 2, action_name: 'opened', target_type: 'Issue', target_iid: 9, target_title: 'Bug', created_at: at,
        author: { username: 'agent-bot' } },
      { id: 3, action_name: 'created', target_type: 'Note', target_iid: 7, target_title: 'Add support', created_at: at,
        author: { username: 'agent-bot' }, note: self(56, 'please fix') },
      { id: 4, action_name: 'created', target_type: 'Note', target_iid: 7, target_title: 'Add support', created_at: at,
        author: { username: 'agent-bot' }, note: self(58, '@agent-bot please fix') },
      { id: 5, action_name: 'created', target_type: 'Note', target_iid: 7, target_title: 'Add support', created_at: at,
        author: { username: 'agent-bot' }, note: self(57, '@agent-bot done\n\n<!-- dsh-superagent:agent-reply -->') },
      { id: 6, action_name: 'created', target_type: 'Note', target_iid: 7, target_title: 'Add support', created_at: at,
        author: { username: 'alice' }, note: other(59, '@agent-bot please review') },
      { id: 7, action_name: 'created', target_type: 'Note', target_iid: 7, target_title: 'Add support', created_at: at,
        author: { username: 'alice' }, note: other(60, 'just a note') },
    ]
    const commands = {
      withSignal: () => commands,
      gitlabTodos: vi.fn(async () => []),
      gitlabApi: vi.fn(async (first: unknown, path?: string) => {
        const resource = typeof first === 'string' ? first : path
        if (resource?.startsWith('events')) return events
        if (resource === 'issues/8') return issue(8, 'Fix it.')
        if (resource === 'issues/9') return issue(9, '@agent-bot please fix')
        if (resource === 'merge_requests/7') return MR
        if (resource?.startsWith('merge_requests?')) return []
        throw new Error(`unexpected GitLab call ${String(resource)}`)
      }),
    } as unknown as Commands
    const context = fakeContext({ commands, received,
      config: { ownAccount: true, observeIssues: false, observeMergeRequests: false, observeComments: false } })
    await pollRound(context)
    expect(received).toHaveLength(3)
    expect(received[0]).toMatchObject({ meta: { kind: 'issue', iid: 9 }, human: true, addressed: 'mention' })
    expect(received[1]).toMatchObject({ meta: { kind: 'mr', noteId: 58 }, human: true, addressed: 'mention' })
    expect(received[2]).toMatchObject({ meta: { kind: 'mr', noteId: 59 }, human: true, addressed: 'mention' })
    expect(received.some(trigger => trigger.meta.noteId === 60)).toBe(false)
  })
  it('binds an MR that is the ticket origin, refuses a foreign one, and reports its merge only to non-GitLab channels', () => {
    const bound: [string, string, boolean][] = []
    const patches: [string, Record<string, unknown>][] = []
    const store = new Map<string, unknown>()
    const ticket: Ticket = { id: 't1', title: 'Add support', decisionId: 'd1', channels: [], inputs: [], undelivered: [],
      mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed', sender: 'alice' }, actor: { source: 'gitlab', id: 'alice' }, scope: 'small' },
      assignments: [], createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
      origin: { triggerId: 'origin', triggerIds: ['origin'] }, execution: { name: 'ticket-1', directory: '/tmp/t1', assignment: 'Do it.' },
      follows: [] }
    const context = fakeContext({ commands: {} as Commands, store, patches, tickets: [ticket], bound,
      triggers: { origin: { id: 'origin', source: 'gitlab', meta: { kind: 'mr', iid: 7 } } as unknown as Trigger } })
    expect(claimMergeRequest(context, 't1', MR)).toBeUndefined()
    expect(bound).toEqual([['t1', 'mr:7', false]])
    expect(mergeRequestsOf(ticket, true)).toEqual([7])
    expect(patches.some(([key, meta]) => key === 'gitlab:mr:7' && meta.url === MR.web_url)).toBe(true)
    const other: Ticket = { ...ticket, id: 't2', origin: { triggerId: 'other', triggerIds: ['other'] }, follows: [] }
    context.tickets.open = () => [ticket, other]
    context.tickets.get = (id: string) => [ticket, other].find(item => item.id === id)
    const agentMr = { ...MR, author: { username: 'agent-bot' } }
    expect(claimMergeRequest(context, 't2', agentMr)).toContain('already belongs')
    expect(claimMergeRequest(context, 't2', { ...agentMr, iid: 70, source_project_id: 10, target_project_id: 10 }))
      .toContain('does not belong to this ticket')
    const ended: Ticket = { ...ticket, ended: { at: '2026-09-09T01:00:00Z', by: 'executor', outcome: 'merged' },
      follows: [{ thread: 'gitlab:mr:7', own: true, closed: { at: '2026-09-09T01:00:00Z', outcome: 'merged' } }],
      channels: [{ source: 'gitlab', thread: 'gitlab:mr:7', address: { kind: 'mr', iid: '7' } },
        { source: 'feishu', thread: 'feishu:oc_1:om_1', address: { chatId: 'oc_1', messageId: 'om_1' } }] as ChannelRef[] }
    const notices = reviewEndNotices(ended, '请实现 GitLab 支持', deployment, [gitlabReview])
    expect(notices).toHaveLength(1)
    expect(notices[0]!.text).toContain('MR !7')
    expect(notices[0]!.text).toContain('已合并')
  })
})

describe('GitLab reads and replies', () => {
  it('keeps a discussion\'s root note as reply_to and uses a raw field for a repository file', async () => {
    let rawArgs: string[] = []
    const commands = {
      withSignal: () => commands,
      gitlabApi: vi.fn(async (first: unknown, path?: string, ...flags: string[]) => {
        const resource = typeof first === 'string' ? first : path
        if (resource === '') return { default_branch: 'main' }
        if (resource === 'merge_requests/7') return MR
        if (resource?.startsWith('merge_requests/7/discussions')) return [{ id: 'disc1', notes: [
          note(40, 'bob', 'root'), note(41, 'alice', 'reply')] }]
        if (resource?.startsWith('merge_requests/7/notes')) return []
        if (typeof resource === 'string' && resource.startsWith('repository/files/')) { rawArgs = [path ?? '', ...flags]; return 'file text' }
        throw new Error(`unexpected GitLab call ${String(resource)}`)
      }),
    } as unknown as Commands
    const read = await readGitlab(commands, 'gitlab/merge_requests/7/discussions/1') as { messages: { id: string; reply_to?: string }[] }
    expect(read.messages.map(message => message.id)).toEqual(['40', '41'])
    expect(read.messages[1]!.reply_to).toBe('40')
    expect(await readGitlabRepositoryPath(commands, 'src/index.ts', 'file')).toBe('file text')
    expect(rawArgs).toEqual(['--raw-field', 'ref=main'])
  })
  it('does not post a note whose marker already exists', async () => {
    const marker = '<!-- dsh-superagent:reply-1 -->'
    const commands = {
      deployment,
      gitlabPages: vi.fn(async () => [{ ...note(1, 'agent-bot', `Done\n\n${marker}`) }]),
      gitlabApi: vi.fn(async () => { throw new Error('must not post twice') }),
    } as unknown as Commands
    const message: OutboundMessage = { id: 'reply-1', channel: { source: 'gitlab', thread: 'gitlab:issue:8', address: { kind: 'issue', iid: '8' } },
      text: 'Done', kind: 'reply' }
    expect(await sendGitlab({ commands }, message)).toBe('sent')
    expect(commands.gitlabApi).not.toHaveBeenCalled()
  })
})

/** Minimal Source context for polling and binding tests. */
function fakeContext(input: { commands: Commands; store?: Map<string, unknown>; received?: Trigger[];
  patches?: [string, Record<string, unknown>][]; tickets?: Ticket[]; bound?: [string, string, boolean][];
  triggers?: Record<string, Trigger>; config?: Record<string, unknown> }) {
  const store = input.store ?? new Map<string, unknown>()
  const patches = input.patches ?? []
  const bound = input.bound ?? []
  const received = input.received ?? []
  const tickets = input.tickets ?? []
  const config = GitlabConfigSchema.parse({ project: 'team/app', cli: 'glab', baseUrl: 'https://gitlab.example.com',
    observeIssues: true, observeMergeRequests: true, observeComments: true, ...input.config })
  const patch = (ticket: Ticket, thread: string, own: boolean) => {
    if (!ticket.follows) ticket.follows = []
    ticket.follows.push({ thread: `gitlab:${thread}`, own })
  }
  const context = {
    deployment: deployment as Deployment, commands: input.commands, ready: Promise.resolve(), configured: () => true,
    config: () => config,
    receive: async (trigger: Trigger) => { received.push(trigger) },
    atomic: <T>(work: () => T): T => work(),
    state: { get: (key: string) => store.get(key), set: (key: string, value: unknown) => { if (value === undefined) store.delete(key); else store.set(key, value) },
      keys: () => [] },
    threads: { get: () => undefined, subscribed: () => [], describe: () => {}, patch: (key: string, meta: Record<string, unknown>) => { patches.push([key, meta]) } },
    tickets: { get: (id: string) => tickets.find(ticket => ticket.id === id), open: () => tickets.filter(ticket => !ticket.ended),
      bindThread: (id: string, ref: { id: string }, own: boolean) => { const ticket = tickets.find(item => item.id === id); if (ticket) patch(ticket, ref.id, own); bound.push([id, ref.id, own]) },
      threadClosed: () => {} },
    triggers: { get: (id: string) => input.triggers?.[id], latest: () => undefined },
    notify: () => {}, report: () => {},
  } as unknown as SourceContext
  return context
}
