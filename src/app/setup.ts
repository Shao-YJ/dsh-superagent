/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, resolveGitlab, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupPlace, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  /**
   * Setup failures by the place that owns them. A failed forge check that leaves another forge usable is reported on that Source,
   * while `problem` is only the failure that halts the deployment.
   */
  problems: Partial<Record<SetupPlace, SetupProblem>> = {}
  /** The failure that halts startup: a machine problem, or a forge check when no configured forge resolved. */
  get problem(): SetupProblem | undefined {
    return this.problems.deployment ?? (this.resolved ? undefined : this.problems.github ?? this.problems.gitlab)
  }
  get githubProblem(): SetupProblem | undefined { return this.problems.github }
  get gitlabProblem(): SetupProblem | undefined { return this.problems.gitlab }
  get feishuProblem(): SetupProblem | undefined { return this.problems.feishu }
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  private failures: Partial<Record<SetupPlace, SetupError>> = {}
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures by place and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    this.problems = {}
    this.failures = {}
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problems[error.place] = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and every configured forge and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.problems.feishu && !this.problems.github && !this.problems.gitlab) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const probe = this.probe()
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, probe)
      : block === 'source:gitlab' ? resolveGitlab(machine, settings.sources.gitlab?.config, probe)
        : resolveDeployment(machine, settings.sources.github?.config, probe)
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  /** Runs one account check, recording a `SetupError` on its place instead of failing the others. */
  private async attempt<T>(place: SetupPlace, check: Promise<T>): Promise<T | undefined> {
    try { return await check }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.failures[place] = error
      this.problems[place] = error.problem
      if (place !== 'feishu') this.host.context.logger.warn('dsh-superagent leaves %s out: %s', place, error.message)
      return undefined
    }
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const github = await this.attempt('github', resolveDeployment(machine, settings.sources.github?.config, probe))
    const gitlab = await this.attempt('gitlab', resolveGitlab(machine, settings.sources.gitlab?.config, probe))
    const feishu = await this.attempt('feishu', resolveFeishuBot(machine, settings.sources.feishu?.config, probe))
    if (!github && !gitlab) {
      // A source check that failed is the actionable problem; two unconfigured forges are not.
      const failure = this.failures.github ?? this.failures.gitlab
      if (failure) throw failure
      throw new SetupError('forgeUnset')
    }
    const resolved: Deployment = { ...machine,
      ...github ? { repository: github.repository, github: github.github } : {},
      ...gitlab ? { gitlab } : {}, ...feishu ? { feishu } : {} }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
