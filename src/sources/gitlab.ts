/** GitLab source kind definition, to-do, event, note and merge-request polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GitlabAccountsSchema } from '../deployment.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import { agentNote, DiscussionSchema, EventSchema, gitlabAddress, gitlabThread, IssueSchema, mentions, MergeRequestSchema, NoteSchema, noteTrigger, SOURCE,
  subjectTrigger, TodoSchema, type GitlabDiscussion, type GitlabIssue, type GitlabKind, type GitlabMergeRequest, type GitlabNote } from './gitlab-trigger.ts'
import { observeMergeRequest, readMergeRequest, mergeRequestsOf, ticketBranch } from './gitlab-mr.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { gitlabReview } from './gitlab-review.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind, VariableSpec } from './kind.ts'

export const GitlabConfigSchema = GitlabAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observeMergeRequests: z.boolean().default(false),
  observeComments: z.boolean().default(false),
  // The configured account belongs to the person using the agent, as on a GitLab instance that allows one account per person.
  ownAccount: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', mergeRequests: 'observeMergeRequests', comments: 'observeComments' } as const
type ScopeRow = keyof typeof OBSERVED
/** A note belongs to the comments row; an Issue or MR body to its own row. */
function scopeOf(meta: Record<string, unknown>): ScopeRow | undefined {
  if (meta.noteId !== undefined) return 'comments'
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mr') return 'mergeRequests'
  return undefined
}
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收内部 GitLab 里发给它的待办、已订阅 Issue 与 MR 的讨论，以及 MR 的合并和关闭。可用自建实例和访问令牌登录。',
    en: 'The agent\'s GitLab account; receives to-dos addressed to it on a self-managed GitLab, discussion on subscribed Issues and Merge Requests, and MR merge or close. A self-managed instance and access token may sign it in.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'baseUrl', type: 'text', pattern: 'https?://.+', label: { zh: 'GitLab 地址', en: 'GitLab base URL' },
      hint: { zh: '内部自建 GitLab 的根地址，例如 https://gitlab.example.com；也可以带相对路径，例如 https://example.com/gitlab。', en: 'The root URL of the GitLab instance, such as https://gitlab.example.com; a relative path such as https://example.com/gitlab is allowed.' } },
    { key: 'project', type: 'text', pattern: '[\\w.-]+(/[\\w.-]+)+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 group/project。这个来源接收这个项目里发给智能体的待办和讨论；保存时检查智能体账号能否推送到它，然后重启 dsh-superagent。', en: 'Written group/project. This Source receives to-dos and discussion addressed to the agent in this project; saving checks that the agent account can push to it, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是 glab。它没有登录时用下面的令牌文件：dsh-superagent 会生成一个包装脚本，只在调用 glab 时读取令牌。保存时检查账号和项目权限，然后重启。', en: 'A command name or absolute path, usually glab. When it is not signed in itself, use the token file below: dsh-superagent writes a wrapper that reads the token only while calling glab. Saving checks the account and project access, then restarts.' } },
    { key: 'tokenFile', type: 'text', label: { zh: 'GitLab 令牌文件', en: 'GitLab token file' },
      hint: { zh: '可选，绝对路径。文件里是内部软件完成 OAuth 后签发的 GitLab 访问令牌（api 与 write_repository 权限）。setup 用它验证账号和项目权限；令牌只在 glab 子进程里出现，不进入 worker 环境。', en: 'Optional absolute path. The file holds a GitLab access token issued after the internal OAuth login (api and write_repository scopes). Setup verifies the account and project access with it; the token appears only in a glab subprocess, never in a worker environment.' } },
    { key: 'commitEmail', type: 'text', label: { zh: '提交邮箱', en: 'Commit email' },
      hint: { zh: '可选。智能体账号的提交邮箱；留空时用 GitLab 返回的 commit_email 或 email。', en: 'Optional commit email of the agent account; when empty, the commit_email or email GitLab returns is used.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'ownAccount', type: 'switch', label: { zh: '账号是本人账号', en: 'The account belongs to the person using the agent' },
      hint: { zh: '当内部 GitLab 每人只有一个账号时打开。来源把配置的账号当作监听账号：任何人在 Issue、MR、评论中 @ 到该账号（或被指派）时视为请求；本人未被 @ 的内容不触发，智能体自己的标记回复也不会触发。提交和 MR 会记在这个人名下。', en: 'Turn on when the internal GitLab allows one account per person. The Source treats the configured account as the monitored person: an Issue, merge request or comment that mentions the account, from anyone including that person, is a request; its own unmentioned content does not trigger, and marked agent replies are skipped. Commits and merge requests are attributed to that person.' }, },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的新 MR', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 MR 也会收到，由策略的接收表决定是否成为候选。', en: 'Merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the project' },
      hint: { zh: '打开后，Issue 和 MR 上没有 @ 智能体的评论和代码讨论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments and review discussions on Issues and Merge Requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
  ],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  // `!12` and an MR URL name an MR; `#12` and an Issue URL name an Issue.
  find: query => {
    const text = query.trim()
    const mr = /^!([1-9]\d*)$/.exec(text)?.[1]
      ?? deploymentPath(text, 'merge_requests')
    if (mr) return { threads: [gitlabThread('mr', Number(mr))], terms: [] }
    const issue = /^#?([1-9]\d*)$/.exec(text)?.[1] ?? deploymentPath(text, 'issues')
    return { threads: issue ? [gitlabThread('issue', Number(issue))] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号的评论在来源收到时成为推断的候选；它们不能发起明确的请求，也不能停止工单。', en: 'A comment of a bot account on this list becomes an inferred candidate when the Source receives it; it never makes an explicit request or stops a ticket.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue、MR 或评论里 @ 智能体的账号，或把 Issue、MR 指派给智能体。', en: 'An account on the list mentions the agent in an Issue, Merge Request or comment, or assigns an Issue or Merge Request to the agent.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: ScopeRow, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('mergeRequests', { zh: '新 MR', en: 'New merge requests' }),
        row('comments', { zh: '评论', en: 'Comments' })]
    },
  },
  environment: {
    variables: gitlabVariables(),
    values: ({ deployment, trigger }) => {
      const account = deployment.gitlab
      const iid = trigger?.threads[0]?.source === SOURCE && typeof trigger.meta.iid === 'number' ? trigger.meta.iid : 0
      return { DSH_SUPERAGENT_GITLAB_URL: account?.baseUrl ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: account?.project ?? '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: account?.login ?? '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: account?.commitEmail ?? '',
        DSH_SUPERAGENT_GITLAB_IID: iid ? String(iid) : '', DSH_SUPERAGENT_GITLAB_KIND: iid ? String(trigger?.meta.kind ?? '') : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
    project: deployment.gitlab.project,
  } : {},
  review: gitlabReview,
}
function gitlabVariables(): { key: string; description: Localized }[] {
  return [
    { key: 'DSH_SUPERAGENT_GITLAB_URL', description: { zh: '这个来源监听的 GitLab 实例根地址', en: 'Root URL of the GitLab instance this Source watches' } },
    { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的项目，group/project。智能体在这里开的 MR，分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单',
      en: 'The project this Source watches, as group/project. An MR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
    { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，除合并外的 GitLab 操作都用 glab，不用其他账号或凭据',
      en: 'The agent\'s GitLab account. glab acts as it; use glab for every GitLab operation except merging, and never another account or credential' } },
    { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的 GitLab 提交邮箱；这里的 git 没有身份，按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱',
      en: 'Commit email of the agent\'s GitLab account. git has no identity here: commit as the author the instructions name, or as the agent account with this email when they name none' } },
    { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 Issue 或 MR 的编号；工单不是从 GitLab 来的时为空', en: 'IID of the Issue or Merge Request that started the ticket; empty when the ticket did not start on GitLab' } },
    { key: 'DSH_SUPERAGENT_GITLAB_KIND', description: { zh: '接下工单的是 issue 还是 mr；不是从 GitLab 来的时为空', en: 'Whether the ticket started from `issue` or `mr`; empty when it did not start on GitLab' } },
  ] satisfies VariableSpec[]
}
/** Extracts the number of an Issue/MR URL under the configured project without needing a deployment, used by `find`. */
function deploymentPath(text: string, section: 'issues' | 'merge_requests'): string | undefined {
  // GitLab page URLs carry `/-/`; a GitHub `/issues/12` URL must not become a GitLab Thread.
  return new RegExp(`/-/${section}/([1-9]\\d*)/?$`).exec(text)?.[1]
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report('gitlab', { state: 'error', detail: String(error) })
    })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured() || ctx.problem || !ctx.deployment.gitlab) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(60, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string
  signal?: AbortSignal | undefined
  subjects: Map<string, Promise<GitlabIssue | GitlabMergeRequest>>
  read: Set<string>
  failures: string[]
  tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, subjects: new Map(), read: new Set(), failures: [],
  tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
const subjectPath = (kind: GitlabKind, iid: number): string => `${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
/** Reads the Issue or Merge Request an event or note names, once per round. */
function subjectOf(ctx: SourceContext, round: Round, kind: GitlabKind, iid: number): Promise<GitlabIssue | GitlabMergeRequest> {
  const cache = `${kind}:${iid}`
  let read = round.subjects.get(cache)
  if (!read) {
    const commands = ctx.commands.withSignal(round.signal)
    read = kind === 'mr' ? commands.gitlabApi(MergeRequestSchema, subjectPath(kind, iid)) : commands.gitlabApi(IssueSchema, subjectPath(kind, iid))
    round.subjects.set(cache, read)
  }
  return read
}
/** Names a Thread and records the metadata replies and review binding need. */
function nameThread(ctx: SourceContext, kind: GitlabKind, iid: number, subject: GitlabIssue | GitlabMergeRequest): void {
  const thread = gitlabThread(kind, iid)
  ctx.threads.patch(thread, { kind, iid, isMr: kind === 'mr', url: subject.web_url, title: subject.title })
  ctx.threads.describe(thread, { label: `${kind === 'mr' ? 'MR !' : 'Issue #'}${iid} ${subject.title}`,
    facts: { number: { value: `${kind === 'mr' ? '!' : '#'}${iid}` } } })
}
/**
 * One polling round: the agent's to-dos, observed project events, merge requests of open tickets and authored by the agent,
 * then subscribed Threads. Each step and each MR or Thread fails independently so one unreadable conversation does not stop the rest.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const round = newRound(signal)
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  if (!ctx.deployment.gitlab) throw new Error('The GitLab Source has no resolved account')
  const step = async (name: string, run: () => Promise<void>) => {
    if (stopped(ctx, round)) return
    try { await run() }
    catch (error) { if (stopped(ctx, round)) throw error; round.failures.push(`${name}: ${String(error)}`) }
  }
  await step('to-dos', () => pollTodos(ctx, round))
  await step('events', () => pollEvents(ctx, round))
  await step('merge requests', () => pollMergeRequests(ctx, round))
  await step('threads', () => pollThreads(ctx, round))
  if (signal?.aborted) return
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  if (ctx.config(SOURCE)) ctx.report('gitlab', { state: 'ready', detail: `Next poll ≥ ${config.pollSeconds}s; ${round.tally.skipped} unreadable items skipped`,
    at: round.started })
}
/**
 * Reads pending to-dos addressed to the agent in this project. A mention reads the named note's discussion (or the newest notes
 * of its conversation), and an assignment reads the Issue or MR body; the to-do is marked done once its Trigger was received.
 * Failure leaves it pending so the next round retries.
 */
async function pollTodos(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  const { login } = ctx.deployment.gitlab!
  const own = config.ownAccount === true
  const todos = await ctx.commands.withSignal(round.signal).gitlabTodos(TodoSchema)
  for (const todo of todos) {
    if (stopped(ctx, round)) return
    const project = todo.project?.path_with_namespace
    if (project && project !== config.project) continue
    if (!project && !(todo.target_url && gitlabAddress(todo.target_url, ctx.deployment))) continue
    if (!['mentioned', 'directly_addressed', 'assigned'].includes(todo.action_name)) continue
    const address = todo.target_url ? gitlabAddress(todo.target_url, ctx.deployment) : undefined
    const kind: GitlabKind | undefined = address?.kind ?? (todo.target_type === 'MergeRequest' ? 'mr' : todo.target_type === 'Issue' ? 'issue' : undefined)
    const iid = address?.iid ?? todo.target?.iid
    if (!kind || !iid) continue
    const subject = await subjectOf(ctx, round, kind, iid)
    nameThread(ctx, kind, iid, subject)
    if (kind === 'issue' || address?.note === undefined) {
      if (todo.action_name === 'assigned') {
        await ctx.receive(subjectTrigger(kind, subject, 'assigned', ctx.deployment, login, todo.author ?? undefined, todo.id, own))
      } else await ingestNotes(ctx, round, kind, iid, sinceFor(ctx, kind, iid, todo.created_at), subject, own)
    } else if (address.note !== undefined) {
      // Keep the to-do pending when its discussion fell outside the bounded recent pages, so a later round can still find it.
      if (!await ingestDiscussionNote(ctx, round, iid, address.note, subject, sinceFor(ctx, kind, iid, todo.created_at), own)) continue
    }
    await ctx.commands.withSignal(round.signal).gitlabTodoDone(todo.id)
  }
}
/** The later of the stored thread cursor and a to-do's timestamp, stepped back five seconds for clock skew. */
function sinceFor(ctx: SourceContext, kind: GitlabKind, iid: number, at: string): string {
  const stored = ctx.state.get(KV.gitlab.cursor(gitlabThread(kind, iid)))
  const candidate = cursorAt(at)
  return stored && stored > candidate ? stored : candidate
}
/**
 * Polls project events since the stored cursor for the observed kinds. Each kind starts when it was switched on; a switched-off
 * stream is reset. Own-account mode also reads the account's own content. Trigger IDs deduplicate events also read from a to-do or
 * thread poll.
 */
async function pollEvents(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  const own = config.ownAccount === true
  // In own-account mode the account is monitored for mentions even when the broad observation switches are off.
  const kinds = (Object.keys(OBSERVED) as ScopeRow[]).filter(kind => own || config[OBSERVED[kind]])
  if (!kinds.length) { ctx.state.set(KV.gitlab.events, undefined); return }
  const { login } = ctx.deployment.gitlab!
  const stored = ctx.state.get(KV.gitlab.events)
  const before = stored?.started ?? {}
  const started = Object.fromEntries(kinds.map(kind => [kind, before[kind] ?? round.started]))
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), horizon)).toISOString()
  const events: unknown[] = []
  for (let page = 1; page <= 5; page++) {
    const listed = await ctx.commands.withSignal(round.signal).gitlabApi(z.array(z.unknown()), `events?after=${since.slice(0, 10)}&sort=asc&per_page=100&page=${page}`)
    const batch = validItems(EventSchema, listed, round.tally)
    events.push(...batch)
    if (listed.length < 100) break
  }
  const fresh = (at: string, kind: ScopeRow) => Date.parse(at) >= Math.max(Date.parse(started[kind]!), horizon)
  for (const event of validItems(EventSchema, events, round.tally)) {
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    if (Date.parse(event.created_at) < Date.parse(since)) continue
    const author = event.author?.username
    if (author === login && !own) continue
    if (event.target_type === 'Issue' && (config.observeIssues || own) && fresh(event.created_at, 'issues') && event.target_iid) {
      const issue = await subjectOf(ctx, round, 'issue', event.target_iid)
      const self = own && issue.author.username === login
      const asked = own && mentions(`${issue.title}\n${issue.description ?? ''}`, login)
      // In own-account mode the account is a person: only content that mentions it is a request, even when it is their own;
      // other people's unmentioned Issues still follow the observation switch.
      if (self && !asked) continue
      if (!config.observeIssues && !asked) continue
      if (event.action_name === 'opened') { nameThread(ctx, 'issue', issue.iid, issue); await ctx.receive(subjectTrigger('issue', issue, 'opened', ctx.deployment, login, undefined, undefined, own)) }
      continue
    }
    if (event.target_type === 'MergeRequest' && (config.observeMergeRequests || own) && fresh(event.created_at, 'mergeRequests') && event.target_iid) {
      const mr = await subjectOf(ctx, round, 'mr', event.target_iid) as GitlabMergeRequest
      // A dedicated agent account never treats its own merge requests as requests; own-account mode does only when the MR mentions the account, except for open-ticket output.
      if (!own && (author === login || mr.author.username === login)) continue
      const self = own && (author === login || mr.author.username === login)
      const asked = own && mentions(`${mr.title}\n${mr.description ?? ''}`, login)
      // A merge request the agent opened for an open ticket is output, not a new request.
      if (self && ctx.tickets.open().some(ticket => ticketBranch(ticket, mr.source_branch))) continue
      if (self && !asked) continue
      if (!config.observeMergeRequests && !asked) continue
      if (event.action_name === 'opened') {
        nameThread(ctx, 'mr', mr.iid, mr)
        await ctx.receive(subjectTrigger('mr', mr, 'opened', ctx.deployment, login, undefined, undefined, own))
      }
      continue
    }
    if (event.target_type === 'Note' && (config.observeComments || own) && event.note && fresh(event.created_at, 'comments')) {
      const kind: GitlabKind = event.note.noteable_type === 'MergeRequest' ? 'mr' : 'issue'
      const iid = event.note.noteable_iid ?? event.target_iid
      if (!iid) continue
      const note = event.note
      if (note.system) continue
      const self = own && note.author.username === login
      const asked = own && mentions(note.body, login)
      // The person's own unmentioned notes are not requests; mentions from anyone are, without needing the broad switch.
      if (self && !asked) continue
      if (!config.observeComments && !asked) continue
      if (self && agentNote(note)) continue
      const subject = await subjectOf(ctx, round, kind, iid)
      await ctx.receive(noteTrigger(kind, iid, note, subject, login, undefined, own))
    }
  }
  ctx.atomic(() => ctx.state.set(KV.gitlab.events, { since: cursorAt(round.started), started }))
}
/**
 * Reads notes of an Issue (newest first, so a long history costs one page) or discussions of a Merge Request, receiving the notes
 * created since `since` oldest first. A system note is skipped; a self note is skipped unless own-account mode and it mentions
 * the monitored account.
 */
async function ingestNotes(ctx: SourceContext, round: Round, kind: GitlabKind, iid: number, since: string,
  subject: GitlabIssue | GitlabMergeRequest, own = false): Promise<void> {
  const { login } = ctx.deployment.gitlab!
  const notes: { note: GitlabNote; discussion?: string }[] = []
  if (kind === 'issue') {
    for (let page = 1; page <= 5; page++) {
      const listed = await ctx.commands.withSignal(round.signal).gitlabApi(z.array(z.unknown()), `${subjectPath(kind, iid)}/notes?order_by=created_at&sort=desc&per_page=100&page=${page}`)
      const batch = validItems(NoteSchema, listed, round.tally)
      notes.push(...batch.map(note => ({ note })))
      if (batch.some(note => Date.parse(note.created_at) < Date.parse(since))) break
      if (listed.length < 100) break
    }
  } else {
    for (let page = 1; page <= 3; page++) {
      const listed = await ctx.commands.withSignal(round.signal).gitlabApi(z.array(z.unknown()), `${subjectPath(kind, iid)}/discussions?per_page=100&page=${page}`)
      for (const discussion of validItems(DiscussionSchema, listed, round.tally)) {
        for (const note of discussion.notes) notes.push({ note, discussion: discussion.id })
      }
      if (listed.length < 100) break
    }
  }
  const fresh = notes.filter(({ note }) => !note.system && (note.author.username !== login || (own && !agentNote(note) && mentions(note.body, login))) && Date.parse(note.created_at) >= Date.parse(since))
  fresh.sort((a, b) => a.note.created_at.localeCompare(b.note.created_at))
  for (const { note, discussion } of fresh) {
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    await ctx.receive(noteTrigger(kind, iid, note, subject, login, discussion, own))
  }
  ctx.state.set(KV.gitlab.cursor(gitlabThread(kind, iid)), cursorAt(round.started))
}
/** Finds one review note's discussion in recent pages and ingests that note; used by a to-do that names the note directly. */
async function ingestDiscussionNote(ctx: SourceContext, round: Round, iid: number, noteId: number,
  subject: GitlabIssue | GitlabMergeRequest, since: string, own = false): Promise<boolean> {
  const { login } = ctx.deployment.gitlab!
  for (let page = 1; page <= 10; page++) {
    const listed = await ctx.commands.withSignal(round.signal).gitlabApi(z.array(z.unknown()), `merge_requests/${iid}/discussions?per_page=100&page=${page}`)
    const discussions: GitlabDiscussion[] = validItems(DiscussionSchema, listed, round.tally)
    const found = discussions.find(item => item.notes.some(note => note.id === noteId))
    if (found) {
      const notes = found.notes.filter(note => !note.system && (note.author.username !== login || (own && !agentNote(note) && mentions(note.body, login))) && Date.parse(note.created_at) >= Date.parse(since))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
      for (const note of notes) await ctx.receive(noteTrigger('mr', iid, note, subject, login, found.id, own))
      ctx.state.set(KV.gitlab.cursor(gitlabThread('mr', iid)), cursorAt(round.started))
      return true
    }
    if (listed.length < 100) return false
  }
  return false
}
/** Reads and observes the MRs of open tickets and the agent's own open MRs, binding branch matches as they appear. */
async function pollMergeRequests(ctx: SourceContext, round: Round): Promise<void> {
  const { login } = ctx.deployment.gitlab!
  const numbers = new Set(ctx.tickets.open().flatMap(ticket => mergeRequestsOf(ticket, true)))
  const read = new Set<number>()
  for (const iid of numbers) {
    if (stopped(ctx, round)) return
    try { await observeMergeRequest(ctx, await readMergeRequest(ctx, iid, round.signal)); read.add(iid) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`MR !${iid}: ${String(error)}`) }
  }
  const listed = await ctx.commands.withSignal(round.signal).gitlabApi(z.array(z.unknown()),
    `merge_requests?state=opened&author_username=${encodeURIComponent(login)}&order_by=updated_at&sort=desc&per_page=100`)
  for (const mr of validItems(MergeRequestSchema, listed, round.tally)) {
    if (read.has(mr.iid)) continue
    if (stopped(ctx, round)) return
    try { await observeMergeRequest(ctx, { ...mr, iid: mr.iid }) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`MR !${mr.iid}: ${String(error)}`) }
  }
}
/** Polls subscribed Issue and MR Threads not already read in this round. */
async function pollThreads(ctx: SourceContext, round: Round): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    const parsed = /^gitlab:(issue|mr):([1-9]\d*)$/.exec(thread.key)
    if (!parsed) throw new Error('Subscribed thread has no GitLab Issue or MR number')
    if (round.read.has(thread.key)) return
    round.read.add(thread.key)
    const kind = parsed[1] as GitlabKind
    const iid = Number(parsed[2])
    const subject = await subjectOf(ctx, round, kind, iid)
    nameThread(ctx, kind, iid, subject)
    const since = ctx.state.get(KV.gitlab.cursor(thread.key)) ?? thread.createdAt
    await ingestNotes(ctx, round, kind, iid, since, subject, ctx.config<GitlabConfig>(SOURCE)?.ownAccount === true)
    ctx.threads.patch(thread.key, { pollError: undefined })
  }, thread => round.read.has(thread.key))
}
