// Compare exported runs of the SAME acceptance task, using at least three trials per policy.
// This tool makes no model calls. Both groups must have completed validation and review.
import { readFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const split = args.indexOf('--optimized');
if (split < 3 || args.length - split - 1 < 3) {
  throw new Error(
    'Usage: node scripts/compare-costs.mjs baseline1.json baseline2.json baseline3.json --optimized optimized1.json optimized2.json optimized3.json',
  );
}
const groups = await Promise.all(
  [args.slice(0, split), args.slice(split + 1)].map(async (paths) =>
    Promise.all(
      paths.map(async (path) => {
        const value = JSON.parse(await readFile(path, 'utf8'));
        const { task, usage, artifacts } = value;
        if (!task.validatedHash || task.validatedHash !== task.reviewedHash || task.reviewBlocking)
          throw new Error(`${path}: missing successful validation and review`);
        if (!usage?.length || usage.some((row) => row.costUsd == null))
          throw new Error(`${path}: cost is incomplete`);
        const validation = artifacts
          .filter((a) => a.kind === 'validation' && a.sourceHash === task.validatedHash)
          .at(-1);
        if (!validation) throw new Error(`${path}: missing validation artifact`);
        const checks = JSON.parse(validation.content);
        if (!checks.results.length || checks.results.some((r) => r.code !== 0))
          throw new Error(`${path}: acceptance failed`);
        return {
          path,
          acceptance: task.acceptance,
          commands: JSON.stringify(checks.commands),
          cost: usage.reduce((n, u) => n + u.costUsd, 0),
          tokens: usage.some((u) =>
            ['input', 'cached', 'cacheWrite', 'output'].some((key) => u[key] == null),
          )
            ? null
            : usage.reduce(
                (n, u) =>
                  n + (u.input ?? 0) + (u.cached ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0),
                0,
              ),
        };
      }),
    ),
  ),
);
const all = groups.flat();
if (
  !all[0].acceptance ||
  all.some((row) => row.acceptance !== all[0].acceptance || row.commands !== all[0].commands)
)
  throw new Error('Compare the same acceptance criteria and validation commands.');
const mean = (rows, key) =>
  rows.some((row) => row[key] === null) ? null : rows.reduce((n, r) => n + r[key], 0) / rows.length;
const baseline = {
  trials: groups[0].length,
  cost: mean(groups[0], 'cost'),
  tokens: mean(groups[0], 'tokens'),
};
const optimized = {
  trials: groups[1].length,
  cost: mean(groups[1], 'cost'),
  tokens: mean(groups[1], 'tokens'),
};
const report = {
  measuredAt: new Date().toISOString(),
  baseline,
  optimized,
  costReduction: baseline.cost ? 1 - optimized.cost / baseline.cost : null,
  tokenReduction:
    baseline.tokens && optimized.tokens !== null ? 1 - optimized.tokens / baseline.tokens : null,
  acceptancePassed: true,
  trials: groups,
  note: 'A small sample is evidence for this task only. Manually assess review quality and repeat across representative tasks before enabling worker routing. Estimates are not invoices.',
};
await writeFile('cost-comparison.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
