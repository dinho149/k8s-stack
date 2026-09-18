import type { Project, ModelRole, Usage, Price } from '../shared';
import { Store, id, now } from './store';

type Reservation = { id: string; taskId: string; projectId: string; amount: number; at: string };
export class BudgetExceeded extends Error {}
export class UsageLedger {
  constructor(readonly store: Store) {}
  record(value: Omit<Usage, 'id' | 'createdAt'>) {
    // Provider notifications may be cumulative. Upsert the same request/turn instead of adding it twice.
    const key = `${value.runId}:${value.requestId}`;
    const rates = this.store
      .settings()
      .prices.find((p) => p.provider === value.provider && p.model === value.model);
    let usage: Usage = { ...value, id: key, createdAt: now() };
    if (usage.costUsd === null && rates && usage.input !== null && usage.output !== null) {
      usage = {
        ...usage,
        costUsd: estimate(
          rates,
          usage.input,
          usage.cached ?? 0,
          usage.cacheWrite ?? 0,
          usage.output,
        ),
        costKind: 'estimated',
        pricingDate: rates.date,
      };
    }
    const previous = this.store.get<Usage>('usage', key);
    if (previous) usage.createdAt = previous.createdAt;
    return this.store.put('usage', key, usage);
  }
  repriceUnknown() {
    for (const usage of this.store.all<Usage>('usage'))
      if (usage.costUsd === null && usage.input !== null && usage.output !== null)
        this.record(usage);
  }
  totals(taskId?: string, projectId?: string, today = false) {
    const date = new Date().toLocaleDateString('en-CA');
    const rows = this.store
      .all<Usage>('usage')
      .filter(
        (u) =>
          (!taskId || u.taskId === taskId) &&
          (!projectId || u.projectId === projectId) &&
          (!today || new Date(u.createdAt).toLocaleDateString('en-CA') === date),
      );
    return {
      cost: rows.reduce((sum, u) => sum + (u.costUsd ?? 0), 0),
      unknown: rows.some((u) => u.costUsd === null),
      input: rows.reduce((n, u) => n + (u.input ?? 0) + (u.cached ?? 0) + (u.cacheWrite ?? 0), 0),
      output: rows.reduce((n, u) => n + (u.output ?? 0), 0),
    };
  }
}
export function estimate(
  price: Price,
  uncached: number,
  cached: number,
  writes: number,
  output: number,
) {
  return (
    (uncached * price.input +
      cached * price.cached +
      writes * price.cacheWrite +
      output * price.output) /
    1_000_000
  );
}
export class BudgetGuard {
  constructor(
    readonly store: Store,
    readonly ledger: UsageLedger,
  ) {}
  check(project: Project, taskId: string, additional = 0) {
    const task = this.ledger.totals(taskId),
      day = this.ledger.totals(undefined, project.id, true);
    const reservations = this.store.all<Reservation>('reservations');
    const taskReserved = reservations
      .filter((r) => r.taskId === taskId)
      .reduce((n, r) => n + r.amount, 0);
    const date = new Date().toLocaleDateString('en-CA');
    const dayReserved = reservations
      .filter(
        (r) => r.projectId === project.id && new Date(r.at).toLocaleDateString('en-CA') === date,
      )
      .reduce((n, r) => n + r.amount, 0);
    const { taskBudgetUsd, dailyBudgetUsd } = project.config.costs;
    if ((taskBudgetUsd && task.unknown) || (dailyBudgetUsd && day.unknown))
      throw new BudgetExceeded(
        'Cost is unknown for a previous request. Supply matching rates or remove the monetary limit before resuming.',
      );
    if (
      (taskBudgetUsd && task.cost + taskReserved + additional >= taskBudgetUsd) ||
      (dailyBudgetUsd && day.cost + dayReserved + additional >= dailyBudgetUsd)
    )
      throw new BudgetExceeded(
        'Budget reached. Progress is saved. Increase the limit or continue manually.',
      );
  }
  reserve(project: Project, taskId: string, role: ModelRole, prompt: string, outputLimit = 4096) {
    if (!project.config.costs.approvedHarnesses.includes(role.harness))
      throw new Error('This harness is not approved for the project.');
    const rate = this.store
      .settings()
      .prices.find((p) => p.provider === role.harness && p.model === role.model);
    const capped = project.config.costs.taskBudgetUsd || project.config.costs.dailyBudgetUsd;
    if (capped && !rate)
      throw new BudgetExceeded(
        'Set dated pricing for this model in Connections before running with a dollar budget. External harness limits are observed, not exact billing caps.',
      );
    const amount = rate ? estimate(rate, Math.ceil(prompt.length / 3), 0, 0, outputLimit) : 0;
    this.check(project, taskId, amount);
    const key = id();
    this.store.put('reservations', key, {
      id: key,
      projectId: project.id,
      taskId,
      amount,
      at: now(),
    });
    return key;
  }
  release(key: string) {
    this.store.delete('reservations', key);
  }
  warning(project: Project, taskId: string) {
    const cap = project.config.costs.taskBudgetUsd;
    return !!cap && this.ledger.totals(taskId).cost >= cap * 0.8;
  }
}
