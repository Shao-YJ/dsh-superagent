# 009 GitLab support

Status: Phase 1 implemented. The Source, deployment and review seams described here are in the code; CI parity, webhooks and GitHub parity beyond the core loop remain future work.

## Implementation status

Phase 1 implements the core loop: a GitLab project can be the deployment's only forge, or run beside GitHub; the Source reads the agent's to-dos, the project events feed, the notes and discussions of subscribed Threads, and polls Merge Request state. A to-do or a subscribed conversation becomes a Trigger; an MR opened from the ticket branch binds to its Ticket, and its merge or close ends the Ticket through the generic review contract. The GitLab Channel replies with idempotent marker notes and discussion replies.

Login uses a GitLab personal or project access token supplied through `tokenFile`. Setup writes a `gitlab-cli` wrapper that reads the token on every invocation, and a `gitlab-credential` helper that answers git's credential prompt; the token appears in neither the worker environment nor this repository. The account must be a Developer of the project and the project must not be archived. `GITLAB_HOST`, `GITLAB_API_HOST`, `GITLAB_TOKEN` and `GITLAB_ACCESS_TOKEN` reach commands through the wrapper, so an internal self-managed instance works without its OAuth flow being reachable from here.

The review path is forge-neutral: `src/sources/review.ts` defines `BoundReview` and `ReviewSource`; `github-review.ts` and `gitlab-review.ts` implement it; `src/app/reviews.ts` produces end notices for the other Channels. Executor tools keep the `pr_number` argument and add optional `review_source: 'github'|'gitlab'`; it is needed to choose GitLab when both forges are configured.

Verification uses fake `glab` scripts and in-memory Source contexts. This checkout has no reachable internal GitLab instance or token, so Phase 1 has not been validated against a live self-managed GitLab; that validation remains with the deployment operator.

## Summary

dsh-superagent is source-neutral in its domain: a Trigger, Thread, Ticket, Assignment and Policy do not depend on GitHub. Before Phase 1, GitHub was the only implemented code-review Source, and a set of generic modules assumed it. Adding GitLab was therefore feasible without changing the domain model, but it was not a single plugin file: it took a new Source plus a bounded multi-forge change to deployment, credentials, review binding, resources and prompts.

The recommendation is:

- implement GitLab as a second forge Source named `gitlab`, with the same one-project-per-deployment assumption the GitHub Source uses for one repository;
- use the GitLab CLI (`glab`) as the account and credential adapter, as `gh` does for GitHub;
- make the GitHub deployment block optional, so a GitLab-only installation can start;
- ingest events by polling the project's events, the agent's mention to-dos, and the notes and discussions of subscribed threads, with Merge Request state and CI reconciled separately;
- add an optional webhook receiver later, because GitLab has no complete notification inbox comparable to `gh api notifications`;
- keep every GitLab write inside GitLab, and keep auto-merge off.

GitLab can play two roles: the Source that receives requests, and the code host that workers clone and open Merge Requests against. Most teams want both, and Phase 1 delivers both together. A hybrid — GitHub or Feishu for requests, GitLab only as the code host — is a deployment variant of the same work: the GitLab account and prepare variables must be available even when the GitLab Source is switched off. Section 8 treats that as a condition on the deployment change, not as a separate Source.

Approximate size: roughly 1,000–1,500 lines of new Source code, plus tests and docs, and 800–1,200 lines of changes in generic modules, prompts and configuration. A first end-to-end version is a multi-day effort, not a small ticket; a GitLab-only installation additionally requires lifting the assumption that the deployment always has a GitHub account.

## 1. What the current code already provides

The extension seam is documented in [008 Cookbook](008-cookbook.md), and the GitHub implementation in `src/sources/github*.ts` is the reference.

| Facility | Where | Reusable for GitLab |
| --- | --- | --- |
| Source kind contract (`schema`, `fields`, `scope`, `channel`, `threadContext`, `find`, `policy`, `environment`, `health`) | `src/sources/kind.ts` | Yes, plus an optional `review` capability (section 7.2); the review lifecycle is the one Source concern the current contract does not name |
| Registration, settings validation, Policy parts, admission rows, Channels, Thread context | `src/sources/registry.ts` | Yes, plus a `review(source)`/`reviewOfThread(thread)` lookup |
| Trigger, Thread, Ticket, Assignment, Decision, admission, Evals | `src/core` | Yes, unchanged |
| Outbox, effect queue, retries, health | `src/app` | Yes; only Channel behaviour is Source-specific |
| Source settings form generated from `fields` | `src/client/settings-kit.tsx` | Yes; no panel code per kind |
| Test harness with a real Store and a stand-in Source context | `tests/sources.spec.ts`, `tests/registry.spec.ts` | Yes; new fixtures for a fake `glab` |

The domain work is therefore mostly translation, not new concepts.

## 2. What was GitHub-specific before Phase 1

The code index in [007 Architecture](007-architecture.md) names these couplings; Phase 1 addressed each one.

| Area | Current code | Consequence for GitLab |
| --- | --- | --- |
| Deployment identity | `Deployment.repository` and `github` are required, and `resolveDeployment` throws without a GitHub repository and CLI (`src/deployment.ts`, `src/app/setup.ts`) | A GitLab-only installation cannot start |
| API transport | `Commands.api`, `Commands.gh` and `Commands.pages` always call the agent's GitHub CLI on `repos/<repository>/…` (`src/infra/commands.ts`) | GitLab calls need their own host and project restriction |
| Worker credentials | `worker-bin` writes a `gh` shim unconditionally; `worker-gitconfig` adds a GitHub credential helper and rewrites GitHub SSH URLs; `verifyEnvironment` checks only github.com (`src/infra/environment.ts`) | GitLab push and `glab` would not work in worker shells, and a GitLab-only setup would throw while writing the `gh` shim |
| Review binding | `orchestrator_report` takes `pr_number` and calls GitHub's `readPull`/`claimPull`; the ticket card renders `pullOf`, and `github-pull.ts` parses `pullNumber` with `Number(thread.slice('github:'.length))` (`src/app/tools/executor.ts`, `src/app/cards.ts`, `src/sources/github-pull.ts`) | Merge Requests cannot bind to Tickets, so merge and close cannot end them; changing the thread id to `gitlab:mr:12` would also produce `NaN` in every follow-based rule |
| End notices | `pullEndNotices` formats “PR #n” and skips only GitHub channels (`src/sources/github-pull.ts`) | IM threads would receive nothing when an MR merges or closes |
| Repository reads | `MasterAssessor` reads files through GitHub's contents API (`src/app/assessment.ts`, `src/sources/github-read.ts`) | Assessments cannot read a GitLab project's files |
| Source resources | `orchestrator_read` routes only `feishu/` and `github/` originals (`src/app/resources.ts`) | New `gitlab/…` records have no reader |
| Skills and prompts | Bundled skills are typed as `feishu`/`github`; worker prompts say “use gh for ALL GitHub operations”; README and SETUP describe one GitHub repository | GitLab workers would follow the wrong tool and credential rules |
| Panel copy | `source.github`, `health.github`, setup-problem keys and the glossary name GitHub explicitly (`src/client/locales.ts`) | GitLab needs its own labels and setup messages |

The important consequence is that GitLab cannot be added as an isolated, opt-in plugin without either (a) also configuring a GitHub Source, or (b) changing the deployment and worker environment to carry more than one forge. Option (b) is the right one; the rest of this document bounds it.

## 3. GitLab capabilities that must map to the domain

| Domain concept | GitHub today | GitLab mechanism |
| --- | --- | --- |
| Work item | Issue or Pull Request, identified by its number | Issue or Merge Request, identified by the project and the IID |
| Conversation | Issue/PR comments and review threads | Notes on an Issue/MR, and discussions (threaded notes) on an MR |
| Addressed to the agent | `@login` | `@username` |
| Actor | `user.login`; `[bot]` or `type` marks bots | `author.username`; the User API's `bot` flag marks bot users |
| Reply destination | Issue comment, or review-thread reply | Issue/MR note, or a reply in a discussion |
| Review state | PR open/merged/closed, auto-merge, approvals | MR open/merged/closed, `detailed_merge_status`, approvals |
| CI | Check runs and commit statuses | Pipelines, jobs and commit statuses; MR `head_pipeline` |
| Notification | GitHub notifications to the account | To-do items (`GET /todos`), project events, and webhooks |
| Repository read | Contents API | Repository files API |
| Link and reference | `#12`, `https://github.com/…/pull/12` | `#12`, `!12`, `https://gitlab…/-/merge_requests/12` |

The domain mapping is direct, but four GitLab properties matter more than the field names:

1. **Merge Requests are not Issues.** GitLab has separate endpoints, discussions and pipelines for them. The Source must decide from `meta.isMr` which reader and Channel to use.
2. **Issue and Merge Request IIDs are separate sequences.** Unlike GitHub, where Issues and pull requests share one number space, a GitLab project can have Issue `#12` and Merge Request `!12` at the same time. A Thread key cannot be just the number: use `gitlab:issue:<iid>` and `gitlab:mr:<iid>`.
3. **A discussion is a thread of notes.** A reply must go to the right discussion, not just to the MR. GitHub's review-thread handling has a close analogue, but GitLab identifies the discussion with its own string id.
4. **GitLab has no single notification inbox.** This is the main design decision, covered next.

## 4. Ingestion: the main design decision

The GitHub Source has two discovery paths: the account's notification inbox, and optional repository-wide event streams. GitLab offers neither equivalent in full:

- `GET /todos` is personal and covers mentions, assignments, review requests and approvals. It has no `since` cursor. It is an inbox, not a change feed. A mention in an Issue or MR description is documented as `directly_addressed`, a different action from `mentioned`; poll both.
- `GET /projects/:id/events` returns project activity, including note events, but it documents that some merge-request discussion notes use a note type (`DiscussionNote`) it does not return. It is not a complete feed for MR discussions. Only the project-level endpoint carries Merge Request events; the user-level `/events` endpoint excludes them.
- The Issue and MR list endpoints support `updated_after`, but an Issue's `updated_at` is not reliably changed by comments; GitLab's tracker has a closed 2018 report that the first comment did not update it. Treat that as a precaution to verify against the target instance, not as proof of current behaviour. Relying on it would miss the first comment on an Issue.
- This design assumes no conditional-request shortcut (ETag) that these list endpoints guarantee, so polling cost grows with the number of changed resources.

The feasible options:

| Option | Completeness | Latency and cost | Deployment cost | Verdict |
| --- | --- | --- | --- | --- |
| A. Project webhook receiver | Complete: Issue, MR, note (including discussion notes), pipeline, push events | Immediate; one request per event | Needs an endpoint reachable by GitLab and a shared signing token; inbound HTTP is new to the application | Best long-term, but a separate architecture change |
| B. Events + to-dos + subscribed-thread polling | Near-complete for the normal loop; known gaps in some discussion notes | One minute by default; O(subscribed threads) list calls per round | No inbound endpoint; uses the existing CLI and polling model | Recommended for the first version |
| C. Full scan of every Issue/MR and its notes | Complete only if the scan covers everything | Proportional to project size; likely to hit rate limits | No new endpoint | Not recommended |

Option B is the recommended first version because it fits the existing polling architecture, needs no public ingress, and can be upgraded to A without changing Trigger translation. Concretely:

1. **Mentions.** Poll `GET /todos?state=pending&action=mentioned` and `action=directly_addressed` (optionally filtered by project), and keep the seen to-do ids in `KV`. Resolve each to-do to its Issue or MR note: parse the note anchor from `target_url` when it names one; otherwise read the thread's recent notes and match author, body and time. A to-do that cannot be resolved is counted as unreadable, not silently dropped. After the Trigger is durably stored, mark the agent's own to-do done so the pending list stays bounded; if marking fails, retain the seen id and retry next round. The to-do is a notification, not the system of record — the Trigger is — so marking it done does not lose work. This catches mentions in Issue notes, MR notes and MR discussions, including the `DiscussionNote` cases that the projects events API may omit.
2. **Repository-wide observation.** When `observeIssues`, `observeMergeRequests`, `observeComments` or `observePipelines` is on, poll `GET /projects/:id/events?after=<cursor>&sort=asc` once per `target_type`. The query values are lowercase (`issue`, `merge_request`, `note`) even though the response fields are capitalised (`Issue`, `MergeRequest`, `Note`). Convert those events to Triggers. Record the event id and the note id so a later per-thread poll does not duplicate a Trigger.
3. **Subscribed threads.** For every Thread the Store says is subscribed, poll its Issue/MR notes with `order_by=updated_at&sort=asc&activity_filter=only_comments` and filter locally by the Thread's cursor. For an MR, also read its discussions whole and filter their notes locally, because the discussions endpoint has no `updated_after`; use `order_by=updated_at` and drop `system: true` notes. This costs at least one notes request and one discussions request per subscribed MR per round, so it is O(threads), not “a few calls”. Reuse the `polled`/horizon helper in `src/sources/poll.ts`; `github.ts`'s `pollThreads` is only its wrapper.
4. **Merge Request state.** Poll the MRs that open Tickets follow. For each open Ticket, also query `GET /projects/:id/merge_requests?state=opened&author_username=<agent>&source_branch=agent/<ticket>` to discover an MR the agent opened but has not reported; this is best-effort and must not replace `orchestrator_report`. Read `state`, `merged_at`, `closed_at` and `detailed_merge_status`. Report open, merged and closed through `ctx.tickets.bindThread` and `ctx.tickets.threadClosed`, as the GitHub Source does.
5. **CI.** Read commit statuses for a commit (`GET /projects/:id/repository/commits/:sha/statuses`) and, for an MR, `head_pipeline`. A pipeline's status is coarser than GitHub's checks, so the summary should name failed jobs and the pipeline, not invent per-check counts. Failed and canceled jobs count as failures, as do jobs whose status is `failed` with `failure_reason: job_execution_timeout`; GitLab has no `timed_out` status. `skipped`, `manual` and `success` do not count. `allow_failure` jobs are not failures. `head_pipeline` is present only when the token can view pipelines for the project, so a `null` pipeline is “unknown”, not “passing”.
6. **Pipelines on the default branch.** Poll the latest pipeline for the default branch, or the commit statuses of its head, and emit a Trigger only when the failure set changes after a baseline, as `pollBranchCi` does for GitHub.
7. **Cursor and dedupe.** Every date-based cursor keeps a small overlap (two minutes is enough for the one-minute poll) and deduplicates by event or note id, so an event on the boundary is replayed rather than lost.

The GitLab skill should teach workers how to read a failed job's log (`glab ci trace <job>` or `/projects/:id/jobs/:job_id/trace`) so a CI Trigger leads to a diagnosis rather than a blind retry.

The Source keeps a separate cursor family in `KV`, for example `gitlab-since`, `gitlab-cursor:<kind>:<iid>`, `gitlab-note-seen:<kind>:<iid>`, `gitlab-todo-seen`, `gitlab-mr-ci:<iid>` and `gitlab-branch-ci`, where `<kind>` is `issue` or `mr`. Cursors advance only after every covered Trigger is stored, and all trigger ids are derived from stable GitLab ids so replay is safe. Each date-based cursor keeps a small overlap window and deduplicates by event or note id, so an event on the boundary is replayed rather than lost.

### 4.1 Optional webhook receiver

Once option B works, a webhook can replace the discovery part without changing translation:

- register a route such as `POST /orchestrator/gitlab/webhook` outside the loopback-only management API;
- verify the `webhook-signature` HMAC-SHA256 over `webhook-id`, `webhook-timestamp` and the raw body with a signing token (or the legacy `X-Gitlab-Token` header, which GitLab no longer recommends), reject stale timestamps, cap the body size, and deduplicate by `webhook-id`;
- use the event payload for the Trigger, and keep the poller as reconciliation for missed deliveries and for MR/CI state.

This is deliberately a second phase: it adds an internet-facing endpoint, secret rotation and a deployment prerequisite, while the polling design already delivers the core loop.

## 5. Source identity, configuration and mapping

### 5.1 Configuration

The kind is `gitlab`. It uses the same one-project assumption as the GitHub Source: one GitLab project per deployment, with its own settings block `source:gitlab`.

| Field | Default | Purpose |
| --- | --- | --- |
| `baseUrl` | `https://gitlab.com` | GitLab.com or a self-managed instance; also selects the credential host |
| `project` | empty | `namespace/project`, including subgroups, URL-encoded for API paths |
| `cli` | empty | A `glab` wrapper signed in to the agent account on `baseUrl` |
| `pollSeconds` | 60 | Minimum 60, consistent with GitHub; GitLab.com rate limits win |
| `failuresBeforeError` | 3 | Consecutive failed rounds before Source health turns to `error` |
| `observeIssues` | false | New Issues, including those without a mention |
| `observeMergeRequests` | false | New Merge Requests |
| `observeComments` | false | Notes and discussions without a mention |
| `observePipelines` | false | Default-branch CI transitions |

`fields` uses the same generic controls as GitHub: `text`, `number`, `switch`, `rows`. The project path is not a `choose` list initially; validating it during setup is enough. The kind claims `health: ['gitlab']`, and a separate `gitlab-ci` entry for the pipeline loop, so the panel can show a failing poll and a failing CI loop independently.

### 5.2 Domain mapping

| Field | GitLab value |
| --- | --- |
| `source` | `gitlab` |
| Thread id | `issue:<iid>` for an Issue and `mr:<iid>` for a Merge Request, so the Thread keys are `gitlab:issue:<iid>` and `gitlab:mr:<iid>`; a branch CI Thread is `ci:<branch>`, as in GitHub |
| Trigger id | `key('gitlab-note', projectId, noteId, updatedAt)` for a note; `key('gitlab-issue', projectId, iid)` for an Issue body; `key('gitlab-mr', projectId, iid)` for an MR body; `key('gitlab-pipeline', projectId, sha, revision)` for CI |
| Actor | `{ source: 'gitlab', id: username }`; `human` is false for the User API's bot users and for the agent itself |
| `addressed` | `mention` when the text contains `@username`, using the same boundary rule as GitHub |
| Channel | `{ source: 'gitlab', thread: 'gitlab:<kind>:<iid>', address: { project, kind, iid, …(noteId ? { note: noteId } : {}), …(discussionId ? { discussion: discussionId } : {}), url } }` |
| `meta` | `project`, `projectId`, `iid`, `isMr`, `kind` (`issue`, `note`, `discussion`, `pipeline`), `noteId`, `discussionId`, `path`, `line`, `sha`, `revision`; Source-owned and never used as authorization |

The Channel address carries the project, the issue-or-MR kind and the IID, so a future multi-project version does not need to reinterpret stored addresses. For the first version a single configured project is still required, and `allowed(address, config)` checks that the address names that project.

Links should come from the API's `web_url` where the response has one. Notes do not: a note's URL is the parent Issue/MR `web_url` plus the anchor `#note_<id>`. That anchor is a UI convention, not an API field, so construct it centrally in one helper and mark it as computed; do not rebuild the project URL from `baseUrl`, since a self-managed GitLab can live under a relative path.

Replies:

- an Issue comment: `POST /projects/:id/issues/:iid/notes` with the message as `body`;
- an MR comment: `POST /projects/:id/merge_requests/:iid/notes`;
- a discussion reply: `POST /projects/:id/merge_requests/:iid/discussions/:discussion_id/notes`.

Idempotency uses the same hidden marker as GitHub: append `<!-- dsh-superagent:<message id> -->` to the body, and before posting, read the recent notes/discussion notes and return `sent` if the marker is already present with the agent as author. GitLab normalizes note bodies (it strips trailing whitespace and applies quick actions), so the marker must be a trailing HTML comment that no quick action touches, and the check should search for the marker anywhere in the body. This detail needs a live test before it is trusted.

Permanent failures: GitLab answers `404` for a missing project/Issue and `403` for a forbidden write. As with GitHub, do not treat every `404` as gone while a private project may have revoked access; return `gone` only for a confirmed deletion or a locked Issue/MR that no longer accepts notes, and throw otherwise.

### 5.3 Thread context

`threadContext.read` serves the assessment window and the worker's original-record reader:

- an Issue: the description followed by pages of notes with `activity_filter=only_comments`, skipping system notes;
- an MR: the description followed by notes and discussion notes; use `activity_filter=only_comments` and drop `system: true`; a review discussion is read as its own page, with `position.new_path` and `position.new_line` (or the old side) mapped to `path` and `line`;
- a pipeline Trigger: the Trigger text is the context, with no conversation, as branch CI does on GitHub;
- `messageId(trigger)` returns the note's URL or id, matching the ids emitted in `ContextMessage`;
- `read` returns `next` as a page cursor while more notes follow;
- `find` maps `#12` to `gitlab:issue:12`, `!12` to `gitlab:mr:12`, and a GitLab Issue or MR URL to the matching Thread; it should reject URLs for another project or instance.

Message ids should be the note ids, because they are stable across edits; include `updated_at` in the Trigger id so an edited note becomes a new event, while the stored message id stays the same. A message link is the constructed `<noteable web_url>#note_<id>` described above.

## 6. Authorization

The Policy part follows the GitHub shape:

- `allowed` is a list of GitLab usernames, compared case-insensitively.
- `bots` lists bot usernames eligible for inferred candidacy; GitLab's User API `bot` flag is the primary signal, and the configured list is an explicit override for project/group bot users.
- `explicit` says that an allowed username mentions the agent's username in an Issue, MR or note.
- `rows` exposes admission scopes `issues`, `merge_requests`, `comments` and `pipelines`. As on GitHub, `pipelines` has no sender, so only the unlisted and unaddressed cell applies; `comments` is available when `observeComments` is on, and the other rows when their observation switch is on.

Identities are not mapped across Sources: a GitHub login and a GitLab username are separate people even if they spell the same name. That is an existing Policy rule, not a GitLab-specific change.

Bot detection needs an extra lookup. GitLab note payloads carry only a `UserBasic` author (`id`, `username`, `name`, `state`), with no `bot` flag; the `bot` flag is on `GET /users/:id`. The Source resolves each new author id once, caches `{ id, username, bot }` in `KV`, and reuses it. If the lookup fails, the actor is **unverified**, not human: an unverified actor cannot satisfy `explicit`, and its note is surfaced as context but does not authorize work. This is deliberately fail-closed, because GitLab bot users (project/group access-token bots, service accounts) are otherwise indistinguishable from people in the note payload. The configured `bots` list is an override for instances where the User API is not readable with the agent's token.

Self-managed instances add one authorization consideration: the agent's token can read other projects on the same instance. The Source must restrict every API path to the configured host and project id or path, and the setup check should fail if the token's project access is below Developer. Confidential Issues and internal notes are readable context but private; they must not be copied into another Source. The existing rule that Feishu content never goes to GitHub becomes “no Source's private content goes to another Source”.

## 7. Reviews, Tickets and CI parity

### 7.1 Binding a Merge Request

The GitHub rules in `src/sources/github-pull.ts` translate as follows:

- the Ticket's origin is an MR, or the MR was opened by the agent account from a branch in the same project whose last path segment is the Ticket's short name (`agent/$DSH_SUPERAGENT_NAME`);
- a fork MR is not the agent's MR: `source_project_id` must equal the configured project id and `target_project_id` must too, because the agent pushes branches to the target project; an MR whose `source_project_id` differs is ignored for binding;
- one open Merge Request may bind to at most one open Ticket;
- an open MR is followed (`own` when the Ticket opened it), as Thread `gitlab:mr:<iid>`; `merged` or `closed` calls `threadClosed` once, and the Ticket's own end logic decides the outcome;
- a reopened MR is followed again, as with a reopened PR.

The Source reads MR state in `src/sources/gitlab-mr.ts`, analogous to `github-pull.ts`.

### 7.2 The report field and the review adapter

The Executor's report tool currently accepts `pr_number` and calls GitHub's `readPull` and `claimPull`. Keeping the argument name is fine, but the behaviour must not stay GitHub-shaped. Introduce one small adapter that both forges implement, owned by the Source kind:

```ts
export interface BoundReview {
  source: 'github' | 'gitlab'
  number: number                  // PR number or MR IID
  state: 'open' | 'merged' | 'closed'
  url: string
  author: string
  sourceBranch: string
  targetBranch: string
  sourceProjectId?: string | number
  targetProjectId?: string | number
}

export interface ReviewSource {
  kind: 'github' | 'gitlab'
  thread(number: number): string                  // github:<n> / gitlab:mr:<iid>
  number(thread: string): number | undefined      // never Number(thread.slice(...))
  read(ctx: SourceContext, number: number): Promise<BoundReview | undefined>
  claim(ctx: SourceContext, ticket: Ticket, review: BoundReview): string | undefined
  endNotices(ctx: SourceContext, ticket: Ticket, request: string): OutboundMessage[]
}
```

`SourceKind` gains an optional `review?: ReviewSource`, implemented by `src/sources/github-review.ts` and `src/sources/gitlab-review.ts`; the registry exposes `review(source)` and `reviewOfThread(thread)`. The Runtime currently constructs exactly one `github` context (`src/app/runtime.ts:163`) and the Executor host holds it (`src/app/tools/executor.ts:18-19,82-91`); both change to “all enabled forge contexts + a review resolver”. `src/app/reviews.ts` becomes the generic end-notice builder and the place that maps a Ticket's `follows` to a `BoundReview`.

This is not cosmetic. `src/sources/github-pull.ts:18-21` parses `pullNumber` with `Number(thread.slice('github:'.length))`; `src/app/cards.ts:30` and `claimPull`/`closePull`/`pullEndNotices` consume that number. `Number('mr:12')` is `NaN`, so `gitlab:mr:12` would silently break every follow-based rule. Replace the numeric parse with `ReviewSource.number(thread)`, and the card/notice paths with the adapter. Then:

- the tool keeps `pr_number` and gains optional `review_source` (`github` or `gitlab`), defaulting to the only configured forge, or to `github` when both exist and the worker omits it; this keeps existing Feishu Tickets working;
- the tool description names both meanings: a PR number on GitHub, an MR IID on GitLab, and explains that a Feishu-origin Ticket can target either forge;
- the handler resolves the adapter for `review_source` and refuses a number that does not belong to it;
- the ticket card exposes `review_number`, `review_source` and `review_url`, so the panel does not label an MR “PR”;
- the same adapter supplies `claim`, `close` and end notices; there is no second GitHub-specific code path.

Do not rename the argument in Phase 1: stored sessions and prompts use `pr_number`, and an alias would be one more compatibility surface. The adapter is the compatibility layer; a later rename is a separate decision.

### 7.3 End notices

`pullEndNotices` becomes the generic `reviewEndNotices` in `src/app/reviews.ts`, which calls the bound `ReviewSource.endNotices`:

- GitHub keeps its current “PR #n has merged” text and skips GitHub channels;
- GitLab says “MR !n has merged” or “was closed without merging”, links to the MR, and skips GitLab channels;
- both keep the existing rule that follows the request's language, and neither posts the notice to another forge's channel: the forge's own timeline already shows the merge or closure, and a private GitLab note must not become a GitHub comment. The Outbox delivers to the remaining non-forge channels, such as Feishu.

The ticket outcome (`merged`, `closed`) and the one-notice-per-ticket rules stay in the core.

### 7.4 Repository reads for assessments

Assessments read repository files through `readRepositoryPath`. Add a source-aware reader:

- GitHub: the existing contents API;
- GitLab: resolve the branch once from `GET /projects/:id` (`default_branch`), then read a file through `GET /projects/:id/repository/files/<url-encoded path>/raw?ref=<branch>`, which returns text. The JSON form of the same path returns `{ encoding: "base64", content }`; if the implementation uses it, decode before returning, never feed base64 to an assessment. Read a directory through `GET /projects/:id/repository/tree?path=<dir>&ref=<branch>&per_page=100`, following pagination;
- keep the same restrictions: no hidden paths, no `node_modules`, no `..`;
- if both Sources are configured, resolve the reader from the Trigger's Source, not from a global repository field.

The worker's own repository checkout is independent of this reader; the prepare command clones the configured GitLab project.

### 7.5 Execution environment

The GitLab kind declares:

| Variable | Value |
| --- | --- |
| `DSH_SUPERAGENT_GITLAB_URL` | The configured `baseUrl`; empty for a GitHub-origin Ticket |
| `DSH_SUPERAGENT_GITLAB_PROJECT` | The configured project path |
| `DSH_SUPERAGENT_GITLAB_ACCOUNT` | The agent's GitLab username |
| `DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL` | The account's `commit_email` from `GET /user` |
| `DSH_SUPERAGENT_GITLAB_IID` | The Issue or MR IID that started the Ticket |
| `DSH_SUPERAGENT_GITLAB_MR_IID` | The MR IID when the Ticket started from an MR |

The values are empty for Tickets from another Source, as the GitHub contract requires. The prompt section explains which forge the Ticket came from and which CLI to use. No token or secret is ever exported. The Executor should also expose the origin Source kind as `DSH_SUPERAGENT_SOURCE`, because a deployment with both forges needs one prepare command to choose between them.

## 8. Deployment and worker credentials

### 8.1 Multi-forge deployment

The current `Deployment` requires GitHub. The change should make each forge optional, with at least one configured:

```ts
interface Deployment extends Machine {
  repository?: string              // GitHub canonical repository
  github?: { cli: string; login: string; noreply: string }
  gitlab?: { baseUrl: string; cli: string; login: string; id: number; commitEmail: string; project: string; projectId: number }
  feishu?: FeishuBot
}
```

A GitLab-only installation then starts without `gh`. Existing installations keep `github` configured; the stored Settings shape does not change, and the resolver reports a setup problem only when no forge is configured at all. The prepare command and the prompt choose the configured forge; a deployment with both is allowed but each Source still watches one project. The alternative — a generic `Forge` interface with one implementation per host — is cleaner long-term but would rewrite the existing GitHub path, the worker environment and the review tooling in one step. That refactor is not justified by this feature; a narrow review/forge adapter (see section 7) gives most of the benefit with far less risk.

For the hybrid case, the GitLab account and project must be part of the resolved deployment even when the GitLab Source is disabled. Today `environmentOf` only exposes enabled Sources' variables; the change should add configured forge accounts as deployment-level variables, so the prepare command can clone GitLab while GitHub or Feishu supplies the requests.

### 8.2 Setup

Add `GitlabAccountsSchema` and `SETUP_FIELDS.gitlab`, and a `resolveGitlab` function next to `resolveDeployment`:

1. Resolve the configured `glab` executable, with `GLAB_CONFIG_DIR` pointing at the agent's isolated configuration. The wrapper must set `GITLAB_HOST` (or pass `--hostname`) so calls made outside a Git checkout use the configured instance; inside the worker's checkout, the Git remote already names it.
2. Run `glab api user` and read `id`, `username`, `commit_email`; if `commit_email` is absent on an older instance, use a configured commit email or the account's primary email and show it on the setup card. Fail if the account is not signed in, as GitHub's `agentCliNoAccount` does. The agent's token needs `api` and `write_repository`; document that in the accounts section rather than asking the operator to guess.
3. Read the project through `glab api projects/<url-encoded project>` and use `path_with_namespace` as the canonical project. Check `permissions.project_access.access_level` or `permissions.group_access.access_level` for Developer or higher, and fail with a dedicated setup problem if the project is missing, archived or read-only.
4. Store the base URL and the canonical project so renamed projects and subgroup paths are handled consistently.
5. Do not require a GitHub CLI when GitLab is the only forge; keep the existing GitHub checks when the GitHub Source is enabled.

Setup problems need their own fixed codes and panel copy: `gitlabCliUnset`, `gitlabCliMissing`, `gitlabCliSignedOut`, `gitlabCliNoAccount`, `gitlabProjectUnreadable`, `gitlabProjectReadOnly`, `forgeUnset`, and the shared `environmentFailed`. A failed GitLab check must not disable a healthy GitHub Source or vice versa, and that requires a structural change, not just new error codes:

- `Setup` currently has one `problem` plus `feishuProblem`, and `run()` returns false on any `SetupError` (`src/app/setup.ts:26-31,45-57`). Replace that with `problems: Record<SetupPlace, SetupProblem | undefined>` keyed by `github | gitlab | feishu | environment`.
- `checkAccounts` currently maps `source:feishu` to Feishu and *everything else* to GitHub (`l.61-66`); branch on `source:gitlab` explicitly.
- `SourceContext.problem` currently searches the two old fields (`src/app/source-context.ts:45`); it must look up its own Source's entry.
- The management API and the panel's problem projection (`src/app/api.ts`, `src/client/locales.ts`) must carry the per-Source key so a GitLab-only failure shows a GitLab fix.
- `check()` must allow restart when the only failure is a forge the deployment does not use.

### 8.3 Worker shell and git

The current code writes the `gh` shim and the `https://github.com` credential block unconditionally, and `verifyEnvironment` always checks the GitHub helper (`src/infra/environment.ts:79-112,138-142`). Making `github` optional without changing those paths means a GitLab-only installation throws in `writeEnvironment` before setup finishes. The change is:

- Make `writeEnvironment` accept optional `github`, `gitlab` and `repository`; write the `gh` shim only when `github` exists and the `glab` shim only when `gitlab` exists. `WORKER_COMMANDS` can list both CLIs for blocked-command filtering; that is harmless, but the shim writer must not resolve an absent one.
- Make the blocked-command shim message source-aware: it currently advises “use gh”, which is wrong in a GitLab-only installation; it should name the configured forge's CLI and account.
- Write per-forge credential and URL blocks into `worker-gitconfig`: the existing GitHub block only when `github` exists, and a GitLab block only when `gitlab` exists. The GitLab helper should be `credential.<host>.helper = !<glab> auth git-credential`, mirroring `credentialHelper()`; the earlier draft's `glab auth login --setup-git-credential-helper` flag is version-dependent and unnecessary here, so write the helper directly and verify the subcommand on the installed version.
- Rewrite `git@<host>:` and `ssh://git@<host>/` to HTTPS for the GitLab host, as the GitHub setup does.
- Clear `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN` and `OAUTH_TOKEN` (the token variables `glab` reads) from worker environments, in addition to the existing `GH_TOKEN`/`GITHUB_TOKEN` removals.
- Extend `verifyEnvironment` to check only the configured forges' helpers; `github` is optional. When neither forge is configured, fail with a dedicated `forgeUnset` setup problem instead of dereferencing `github.cli`.
- The worker's commit identity comes from the prompt's Delivery requirements, defaulting to the GitLab account's `commit_email`; do not guess a noreply address, because GitLab's private commit email domain differs between GitLab.com and self-managed instances.

### 8.4 Prepare command

The GitHub prepare command in [006 Deployment](006-deployment.md) uses `DSH_SUPERAGENT_GITHUB_REPOSITORY` and `refs/pull/<number>/head`. A GitLab prepare command is the same shape with GitLab variables:

```sh
ref="${DSH_SUPERAGENT_GITLAB_MR_IID:+refs/merge-requests/$DSH_SUPERAGENT_GITLAB_MR_IID/head}"
git -C /home/me/src/widgets fetch --no-tags \
  "$DSH_SUPERAGENT_GITLAB_URL/$DSH_SUPERAGENT_GITLAB_PROJECT.git" \
  "${ref:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
```

This is a starting point, not a promise that `refs/merge-requests/<iid>/head` exists on every GitLab instance; the implementation should verify the ref and fall back to the target branch. The `ref:-HEAD` fallback is what makes an Issue-origin ticket, which has no MR IID, fetch the default branch instead of an empty refspec.

With both forges configured, one prepare command must choose between GitHub and GitLab. Expose the origin Source as `DSH_SUPERAGENT_SOURCE` and branch on it, or use one dsh-superagent profile per forge. The GitLab-only profile is the recommended first deployment because it avoids the ambiguity entirely.

## 9. Changes outside the Source

| File or area | Change |
| --- | --- |
| `src/deployment.ts` | Optional `github`; add `gitlab`; `GITLAB` accounts schema; `SETUP_FIELDS`; setup problems; `glab` resolution |
| `src/app/setup.ts` | Replace one `problem`/`feishuProblem` with a per-place problem map; resolve and check both forges independently; map `source:gitlab`; a missing forge is `forgeUnset` |
| `src/app/source-context.ts` | `problem` looks up its own Source's entry instead of searching GitHub/Feishu fields |
| `src/app/api.ts` | Per-Source problem projection and setup-fix key in the management API |
| `src/app/execution-environment.ts` | Add the origin Source kind as a variable so a multi-forge prepare command can choose |
| `src/infra/environment.ts` | Write `gh`/`glab` shims and credential blocks only for configured forges; optional `github` in `verifyEnvironment`; `forgeUnset` when neither exists; clear GitLab tokens |
| `src/infra/commands.ts` | Add a GitLab API client restricted to the configured host and project; do not make `api` silently mean GitHub. `glab api` has `--paginate` but no `--slurp`, and its `--field`/`--raw-field` semantics differ from `gh -f`, so `Commands.pages` cannot be reused; add a GitLab pagination helper and use raw fields for note bodies |
| `src/sources/gitlab.ts`, `gitlab-trigger.ts`, `gitlab-read.ts`, `gitlab-channel.ts`, `gitlab-mr.ts`, optional webhook module | New Source, roughly mirroring the GitHub modules |
| `src/kv.ts` | New cursor/seen families for GitLab |
| `src/sources/kind.ts` | Optional `review?: ReviewSource` capability, so a Source owns its review semantics instead of the application branching on `github` |
| `src/sources/github-review.ts`, `src/sources/gitlab-review.ts` | Implement `ReviewSource` on top of the existing GitHub helpers and the new GitLab MR reader |
| `src/app/reviews.ts` | Generic `BoundReview` projection, `reviewOfThread`, claim/close delegation, and `reviewEndNotices` |
| `src/sources/github-pull.ts` | Replace `pullNumber(thread)` with the adapter's `number(thread)`; no `Number(thread.slice('github:'.length))` |
| `src/app/tools/executor.ts` | Resolve the review adapter for `review_source`; keep `pr_number` compatible |
| `src/app/cards.ts` | Use `reviewOfThread` and the generic bound-review projection |
| `src/client/ticket.tsx` | Source-aware review icon and label instead of treating every bound thread as a GitHub pull request |
| `src/app/runtime.ts` | Build all enabled forge Source contexts and pass a review resolver to the executor, cards and notices |
| `src/app/resources.ts` | `gitlab/…` original records, documented by the GitLab skill |
| `src/app/assessment.ts` | Source-aware repository reader |
| `src/app/context.ts`, `src/app/skill-files.ts`, `src/app/sessions.ts` | Add the `gitlab` bundled skill to the typed maps and registration condition |
| `src/app/migration.ts` | Add the `gitlab` place to any schema migration that enumerates source/skill records; no data rewrite is expected |
| `prompts/worker.md`, `prompts/cli.md`, `prompts/dispatch.md`, `prompts/replies.md`, `prompts/work.md`, `prompts/orchestrator.md`, `prompts/subscriptions.md`, `prompts/handoff.md`, `prompts/handoff-worker.md`, `prompts/team/delivery.md`, `prompts/team/communication.md`, `prompts/team/scope.md` | Say “the Source's forge” and name `glab`/MRs when the Ticket is from GitLab; keep GitHub wording when it is from GitHub. The PR-binding, GitHub-account, auto-merge/close and merge-ends-ticket sentences are load-bearing, not cosmetic |
| `src/client/locales.ts` | GitLab source, health, setup and prompt-part copy; add `problemSetupFix.gitlab`; generic “review” wording in ticket cards |
| `package.json`, `locale/en.json`, `locale/zh.json` | Plugin description and translations that currently say “one GitHub repository” |
| `skills/dsh-superagent-gitlab/SKILL.md` | Read GitLab originals and reply/resolve discussions with `glab api` |
| `docs/006-deployment.md`, `docs/007-architecture.md`, `docs/008-cookbook.md`, `SETUP.md`, `README.md` | Accounts, settings, module and test tables, setup questions, and the “one GitHub repository” statement |
| `tsdown.config.ts`, `package.json`, `cordis.patch.yml` | Build entry `gitlab-watch`, export, and a disabled plugin insert like Feishu |

The model-facing surface is a size budget (`tests/model-surface.spec.ts`). Adding a GitLab skill and forge-neutral wording will require checking that the composed prompts still fit; that test is the guardrail.

## 10. Staged implementation

### Phase 1: the core loop (recommended first)

Goal: an allowed GitLab user can mention the agent on an Issue or MR, the agent can work and reply in that conversation, and an MR can end the Ticket.

- optional GitHub deployment and a GitLab-only setup path, with per-Source setup problems, a conditional `gh`/`glab` worker environment, and `forgeUnset` when neither forge is configured;
- `glab` shim, per-forge credential helper and verification;
- GitLab kind with configuration, policy, admission rows and environment variables;
- Trigger translation for Issues, MRs, notes and discussions, with stable ids;
- mention to-dos (both `mentioned` and `directly_addressed`), project events for the observation switches, and subscribed-thread note/discussion polling;
- the `ReviewSource` adapter and thread-id parsing, so review binding, cards and end notices are not GitHub-number-only;
- Channel replies with idempotent markers;
- Thread context, `find`, and the `gitlab/…` resource reader;
- MR binding, merge/close lifecycle, end notices, and the source-aware report field;
- GitLab bundled skill, prompt wording, locales and execution environment;
- an end-to-end test against a fake `glab` CLI, plus unit tests for translation, cursors, replies and policy.

Acceptance: on a test project, a mention produces a Ticket; the acknowledgement and result appear in the right Issue/MR thread; an MR opened by the worker binds and merges; merging ends the Ticket; a merged or closed MR does not leave an open Ticket.

### Phase 2: review and CI parity

- commit statuses, `head_pipeline`, pipeline summaries and CI Thread facts;
- approvals and `detailed_merge_status`;
- inline discussion positions and reply-to roots;
- default-branch pipeline transitions;
- optional webhook receiver with HMAC verification, as a hardening path rather than a replacement for polling.

Acceptance: CI failures and recoveries produce Triggers once per change; a failed job summary names the job and pipeline; an approval or a requested change reaches the Ticket; a webhook delivery and the same event from polling produce one Trigger.

### Phase 3: scale and polish

- more than one project per deployment (a Source instance or a project list), if the team needs it;
- GitLab groups and inherited membership for the allowed list;
- review-bot conventions specific to GitLab;
- panel filters and search terms for GitLab references.

Acceptance: docs and tests describe the supported scope; no GitHub-only wording remains in model-facing text for GitLab Tickets.

Rough estimate for Phase 1: 7–12 engineer-days for a developer who already knows the codebase, plus review and a test project. The range is wider than the first draft because the environment, setup-problem and review-adapter work is real code, not just new Source modules. Phase 2 adds 3–6 days. These estimates exclude the optional webhook deployment and any self-managed instance quirks.

## 11. Test plan

- **Translation:** note/discussion/MR/Issue payloads become Triggers with stable ids, correct Thread keys, actor and `addressed`, and no Trigger for the agent's own notes.
- **Feeds:** a project event, a to-do and a subscribed-thread note that describe the same comment produce one Trigger; a to-do from a description mention (`directly_addressed`) is caught; a marked-done to-do does not reappear; a cursor advances only after every Trigger is stored; an aborted round keeps its cursor.
- **Channel:** posting an Issue note, an MR note and a discussion reply; an existing marker returns `sent`; a deleted target returns `gone`; other failures throw.
- **Context:** pages of notes and discussions, review positions, system notes omitted, `next` on a full page.
- **MR binding:** origin MR, agent branch, fork refusal (`source_project_id`/`target_project_id`), two Tickets, open/merged/closed, reopened; the per-open-ticket author/source-branch lookup finds an unreported MR.
- **Review adapter:** `number(thread)` round-trips both `github:<n>` and `gitlab:mr:<iid>`; a GitLab review is not parsed with `Number(...)`; claim/close/end notices dispatch to the right adapter.
- **Policy:** allowed names, bot inference with a missing User API lookup failing closed, admission rows, source-local identity.
- **Setup:** fake `glab` output for a valid account, a missing CLI, a signed-out account, a read-only project, and a GitLab-only deployment with no GitHub settings; a GitLab failure leaves a healthy GitHub Source alone and vice versa.
- **Environment:** `gh` is absent and not written in a GitLab-only setup; per-forge credential blocks; GitLab token removal; `forgeUnset` when no forge is configured.
- **Prepare:** an Issue-origin ticket fetches `HEAD`; an MR-origin ticket fetches and checks out `refs/merge-requests/<iid>/head`; a self-managed `baseUrl` with a relative path keeps the URL intact.
- **Model surface:** the new skill and prompt wording fit the budget; the docs and module/test tables are complete.
- **Manual:** a disposable GitLab project on GitLab.com and, if available, one self-managed instance, because URL encoding, base URL and version differences are exactly where a fake CLI cannot help.

## 12. Risks and open questions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Incomplete event feed for MR discussions | A mention or reply in some review threads may be missed until the thread is polled | To-dos cover mentions; per-thread polling covers subscribed MRs; webhooks in Phase 2 close the gap |
| `updated_at` does not move on the first comment | A comment-driven poll would miss a new comment | Do not use Issue/MR `updated_at` as the comment feed; use to-dos, events and thread notes |
| Rate limits and poll cost | Slow or failed rounds on large projects | One project, 60-second floor, failure backoff, and an explicit error after consecutive failures. The To-Do List API is limited to roughly 300 requests/minute per user; the notes/discussions endpoints have no `updated_after`, so each round costs O(subscribed threads) requests — use `order_by=updated_at`, `activity_filter=only_comments`, a per-thread horizon, and mark processed to-dos done to bound the pending list |
| Self-managed version differences | Endpoints and fields such as `head_pipeline`, signing tokens and `commit_email` vary by version | Probe the instance during setup; document the minimum version; degrade CI to commit statuses when `head_pipeline` is absent. `head_pipeline` is also exposed only with pipeline visibility permission, so `null` means unknown, not passing |
| Protected branches and push rules | Developer access is necessary but not sufficient; a protected default branch can still reject the agent's push | Check the project's push rules during setup where the API exposes them, document the branch-protection requirement, and let the worker report the real push error rather than retrying |
| Note body normalization | The idempotency marker may be stripped or rewritten | Test against a live project; fall back to a visible footer plus a local receipt if the hidden marker is unreliable |
| Credential leakage | A GitLab token could reach a worker or another Source | Only `glab` holds the token; the environment exports none; clear GitLab/GitHub token variables; keep API paths project-restricted |
| Private content crossing Sources | A private GitLab note could be posted to GitHub/Feishu | Keep the existing “no private content on another Source” rule and add a GitLab-specific check in replies and notices |
| Changing `baseUrl` or `project` | Existing Threads and Triggers name the old project; a new project with the same IIDs could be misread | Document that a project change is a reconfiguration of the Source, not a rename; keep `projectId` in Trigger metadata and reject a Trigger whose project no longer matches the configuration |
| GitHub regressions | Making `github` optional touches setup, prompts and the executor tool | Keep GitHub defaults and tests; a GitLab-only path is additive; run the full suite and a GitHub smoke test |
| Scope creep | “GitLab support” can mean CI, approvals, groups, wikis and epics | Fix the Phase 1 contract above; treat the rest as later tickets |

Decisions the owner should settle before Phase 1 starts:

1. **GitLab.com, self-managed, or both?** Support both in the schema, but validate only the instance in use. Recommendation: both, with `baseUrl` required.
2. **One project or several?** The current deployment is one project per Source. Recommendation: one for Phase 1; multi-project later, since it changes Thread keys and the prepare command.
3. **Polling or webhooks first?** Recommendation: polling for Phase 1; webhooks in Phase 2.
4. **Personal access token or OAuth?** Recommendation: a dedicated agent account and a `glab` wrapper with a token, mirroring the `gh` wrapper; OAuth only if the instance disables personal access tokens. If the team will not add `glab`, a thin REST client reading the same token from a protected file keeps the rest of the design unchanged, at the cost of implementing credential storage and git-credential configuration.
5. **Auto-merge?** Keep it off, as the current delivery rules do. GitLab approvals and merge trains are not a drop-in equivalent of GitHub auto-merge.
6. **`pr_number` or `review_number`?** Recommendation: keep `pr_number` as the tool argument and add optional `review_source` in Phase 1; the ticket card already uses generic `review_number`/`review_source` for display. Renaming the tool argument is a separate compatibility decision, not part of the first implementation.

## References

GitLab documentation used for the API and deployment assumptions above:

- [Issues API](https://docs.gitlab.com/api/issues/) — `updated_after`, `order_by=updated_at`
- [Merge requests API](https://docs.gitlab.com/api/merge_requests/) — `updated_after`, `state`, `merged_at`, `detailed_merge_status`, `head_pipeline`
- [Notes API](https://docs.gitlab.com/api/notes/) — Issue/MR notes, `order_by=updated_at`, system notes
- [Discussions API](https://docs.gitlab.com/api/discussions/) — threaded notes, `resolvable`, review positions
- [To-Do List API](https://docs.gitlab.com/api/todos/) — mentions and other personal to-dos
- [Events API](https://docs.gitlab.com/api/events/) — project events and their limitations for some discussion notes
- [GitLab issue #5076](https://gitlab.com/gitlab-org/gitlab/-/issues/5076) — a closed 2018 report that an Issue's `updated_at` did not change for the first comment; cited as a precaution, not as proof of current behaviour
- [Pipelines API](https://docs.gitlab.com/api/pipelines/) and [Commits API](https://docs.gitlab.com/api/commits/) — pipeline and commit statuses
- [Webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/) and [webhook events](https://docs.gitlab.com/user/project/integrations/webhook_events/) — event payloads, signing token and secret token
- [Users API](https://docs.gitlab.com/api/users/) — `bot` and `commit_email`
- [GitLab CLI `glab api`](https://docs.gitlab.com/cli/api/) and [configuration](https://docs.gitlab.com/cli/configuration/) — API calls, `GITLAB_HOST`, `GITLAB_TOKEN`, `GLAB_CONFIG_DIR`