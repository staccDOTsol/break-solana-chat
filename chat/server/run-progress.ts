import { DIM, FFN, LAYERS, VOCAB, type Header } from "../src/chain/layout.ts";

export type Pace = Record<number, { samples: number; milliseconds: number }>;
type Job = {
  input: number[]; processed: number; generated: number[]; maximum: number;
  pending?: { countBefore: number }; baseCount?: number;
  pace?: Pace; measuredAt?: string;
};
type Work = { waves: number; transactions: number };
type Plan = Record<number, Work>;
export type RunProgress = {
  percent: number;
  completedWork: number;
  totalWork: number;
  nextToken: { lowSeconds: number; highSeconds: number } | null;
  finish: { lowSeconds: number; highSeconds: number } | null;
  estimateState: "learning" | "rough" | "measured" | "paused" | "waiting" | "done";
  measuredAt?: string;
};

const layerPhases = [2, 3, 4, 5, 15, 6, 7, 8, 9, 16, 10, 11];
const matrixPhases = [3, 6, 8, 10, 13];
const controlPhases = [1, 2, 4, 7, 11, 12, 15, 16];
const add = (to: Plan, from: Plan, scale = 1) => {
  for (const [phase, work] of Object.entries(from)) {
    const target = to[Number(phase)] ??= { waves: 0, transactions: 0 };
    target.waves += work.waves * scale; target.transactions += work.transactions * scale;
  }
  return to;
};
const transactions = (plan: Plan) => Object.values(plan).reduce((sum, w) => sum + w.transactions, 0);

/** Remaining scheduler work, including its merge/collection barriers. Cursor
 * is an on-chain checkpoint, not a count of submitted or retried transactions. */
function phaseWork(phase: number, position: number, independent: boolean, cursor = 0): Plan {
  let waves: number, tx: number;
  if (matrixPhases.includes(phase) || phase === 5 || phase === 9) {
    const rows = phase === 3 ? 6144 : phase === 8 ? 2 * FFN : phase === 9 ? FFN :
      phase === 13 ? VOCAB : phase === 5 ? 32 * Math.ceil((position + 1) / 16) : DIM;
    const stride = phase === 5 ? 1 : 128;
    let remaining = Math.max(0, rows - cursor); waves = 0; tx = 0;
    while (remaining > 0) {
      const laneCount = Math.min(16, Math.ceil(remaining / stride));
      let slices = 0;
      for (let lane = 0; lane < laneCount; lane++) {
        const n = Math.min(stride, remaining - lane * stride);
        slices += Math.ceil(n / (phase === 10 ? 8 : phase === 5 ? 1 : phase === 9 ? 128 : 24));
      }
      tx += (phase === 9 ? Math.ceil(laneCount / 4) : slices) + 1;
      if (independent && matrixPhases.includes(phase)) tx += laneCount;
      waves++; remaining -= laneCount * stride;
    }
  } else {
    waves = phase === 2 || phase === 12 ? Math.ceil((5 - cursor) / 2) :
      phase === 7 ? (cursor === 0 ? 3 : Math.ceil((5 - cursor) / 2)) :
      phase === 4 ? 7 - cursor : phase === 15 || phase === 16 ?
        Math.ceil(((phase === 15 ? DIM : FFN) - cursor) / 2048) : 1;
    waves = Math.max(0, waves); tx = waves;
  }
  return { [phase]: { waves, transactions: tx } };
}

function tokenPlan(position: number, emit: boolean, independent: boolean, header?: Header): Plan {
  if (header && [0, 14].includes(header.phase)) return {};
  const plan: Plan = {};
  const layer = header?.layer ?? 0, phase = header?.phase ?? 0;
  if (!header) add(plan, phaseWork(0, position, independent)); // Start-token transaction.
  if (!header || phase === 1) add(plan, phaseWork(1, position, independent));
  const fullLayer: Plan = {};
  for (const p of layerPhases) add(fullLayer, phaseWork(p, position, independent));
  if (!header || phase === 1) add(plan, fullLayer, LAYERS);
  else if (layerPhases.includes(phase)) {
    for (const p of layerPhases.slice(layerPhases.indexOf(phase)))
      add(plan, phaseWork(p, position, independent, p === phase ? header.cursor : 0));
    add(plan, fullLayer, Math.max(0, LAYERS - layer - 1));
  }
  if (emit) {
    if (phase !== 13) add(plan, phaseWork(12, position, independent, phase === 12 ? header!.cursor : 0));
    add(plan, phaseWork(13, position, independent, phase === 13 ? header!.cursor : 0));
  }
  return plan;
}

export function recordPace(job: Job, phase: number, milliseconds: number, at = Date.now()) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || ![...layerPhases, 1, 12, 13].includes(phase)) return;
  const pace = job.pace ??= {}, previous = pace[phase];
  // A small moving average follows changing RPC/confirmation speed without
  // treating paused time, restarts or setup as model execution time.
  const weight = previous ? 1 / Math.min(previous.samples + 1, 16) : 1;
  pace[phase] = { samples: (previous?.samples ?? 0) + 1,
    milliseconds: previous ? previous.milliseconds * (1 - weight) + milliseconds * weight : milliseconds };
  job.measuredAt = new Date(at).toISOString();
}

export function runProgress(job: Job, header: Header | undefined, stage: string, independent = false, at = Date.now()): RunProgress {
  const prompt = job.input.length, shown = job.generated.length;
  const completedTokens = job.processed < prompt ? job.processed : prompt + shown - Number(!!job.pending);
  const base = job.baseCount ?? Math.max(0, job.pending ? job.pending.countBefore - completedTokens : (header?.count ?? 0) - completedTokens);
  const total: Plan = {}, remaining: Plan = {}, untilNext: Plan = {};
  const nextIndex = shown === 0 ? prompt - 1 : prompt + shown - 1;
  for (let i = 0; i < prompt + job.maximum; i++) {
    const emit = i >= prompt - 1, position = base + i;
    add(total, tokenPlan(position, emit, independent));
    if (i < completedTokens) continue;
    const current = i === completedTokens && job.pending && header?.count === job.pending.countBefore + 1 ? header : undefined;
    const rest = tokenPlan(position, emit, independent, current);
    add(remaining, rest);
    if (i <= nextIndex && shown < job.maximum) add(untilNext, rest);
  }
  const totalWork = transactions(total);
  const completedWork = stage === "done" ? totalWork : Math.max(0, totalWork - transactions(remaining));
  const result: RunProgress = { percent: stage === "done" ? 100 : Math.min(99.99, 100 * completedWork / Math.max(1, totalWork)),
    totalWork, completedWork, nextToken: null, finish: null, estimateState: "learning", measuredAt: job.measuredAt };
  if (stage === "done") { result.estimateState = "done"; result.finish = { lowSeconds: 0, highSeconds: 0 }; return result; }
  if (["paused", "error"].includes(stage)) { result.estimateState = "paused"; return result; }
  if (stage !== "running") return result;
  const pace = job.pace ?? {}, values = Object.values(pace);
  const samples = values.reduce((sum, value) => sum + value.samples, 0);
  const matrices = [3, 6, 8, 13].filter(p => pace[p]);
  // Wait for actual matrix work; a quick setup or normalization phase gives a
  // wildly optimistic estimate for the thousands of matrix waves ahead.
  if (samples < 8 || matrices.reduce((sum, p) => sum + pace[p].samples, 0) < 3) return result;
  const controls = controlPhases.filter(p => pace[p]);
  const average = (phases: number[]) => phases.reduce((sum, p) => sum + pace[p].milliseconds, 0) / phases.length;
  const matrix = average(matrices), control = controls.length ? average(controls) : matrix / 5;
  const milliseconds = (phase: number) => pace[phase]?.milliseconds ??
    (phase === 10 ? matrix * 2.5 : matrixPhases.includes(phase) ? matrix : [5, 9].includes(phase) ? control * 2 : control);
  const coverage = Object.entries(remaining).filter(([, w]) => w.waves > 0).every(([p]) => Number(p) === 0 || (pace[Number(p)]?.samples ?? 0) >= 2);
  const lastWave = Math.max(...values.map(value => value.milliseconds));
  if (!job.measuredAt || at - Date.parse(job.measuredAt) > Math.max(60_000, lastWave * 3)) {
    result.estimateState = "waiting"; return result;
  }
  result.estimateState = coverage ? "measured" : "rough";
  // These are deliberately broad projections, not statistical confidence
  // intervals. Future congestion and early end-of-sequence remain unknown.
  const estimate = (plan: Plan) => {
    const seconds = Object.entries(plan).reduce((sum, [p, w]) => sum + w.waves * milliseconds(Number(p)), 0) / 1000;
    return { lowSeconds: Math.round(seconds * (coverage ? 0.75 : 0.5)), highSeconds: Math.ceil(seconds * (coverage ? 1.5 : 2)) };
  };
  if (shown < job.maximum) result.nextToken = estimate(untilNext);
  result.finish = estimate(remaining);
  return result;
}
