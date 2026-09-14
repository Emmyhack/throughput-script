import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  concatHex,
  createPublicClient,
  defineChain,
  formatEther,
  formatGwei,
  http,
  keccak256,
  toHex,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Config: CLI flag > env var > default
// ---------------------------------------------------------------------------

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return undefined;
}

function pick(flagName: string, envName: string, def: string): string {
  return flag(flagName) ?? process.env[envName] ?? def;
}

function pickInt(flagName: string, envName: string, def: number): number {
  const v = Number(pick(flagName, envName, String(def)));
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${flagName}/${envName} must be a positive number`);
  return Math.floor(v);
}

const mode = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "load") as
  | "load"
  | "observe";

const cfg = {
  rpcUrl: pick("rpc", "RPC_URL", ""),
  chainId: Number(pick("chain-id", "CHAIN_ID", "")) || undefined,
  privateKey: pick("key", "PRIVATE_KEY", "") as Hex,
  txCount: pickInt("tx-count", "TX_COUNT", 1000),
  concurrency: pickInt("concurrency", "CONCURRENCY", 20),
  blocks: pickInt("blocks", "BLOCKS", 50),
  timeoutSec: pickInt("timeout", "TIMEOUT_SEC", 120),
  feeMultiplier: pickInt("fee-multiplier", "FEE_MULTIPLIER", 2),
  pollMs: pickInt("poll-ms", "POLL_MS", 200),
  follow: process.argv.includes("--follow"),
  out: pick("out", "OUT_DIR", "results"),
};

if (!cfg.rpcUrl || cfg.rpcUrl.includes("YOUR-")) {
  console.error("RPC_URL is not set. Put the node's HTTP RPC endpoint in .env or pass --rpc <url>.");
  process.exit(1);
}

const chain = defineChain({
  id: cfg.chainId ?? 0,
  name: "target",
  nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpcUrl] } },
});

// Reads may retry. Sends must not: a retried eth_sendRawTransaction hides real failures.
// cacheTime: 0 so getBlockNumber() is not served from viem's 4s cache while we poll for inclusion.
const pub = createPublicClient({ chain, cacheTime: 0, transport: http(cfg.rpcUrl, { timeout: 30_000, retryCount: 2 }) });
const raw = createPublicClient({ chain, transport: http(cfg.rpcUrl, { timeout: 30_000, retryCount: 0 }) });

const GAS_TRANSFER = 21_000n;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round(n: number, d = 2): number {
  return Number.isFinite(n) ? Number(n.toFixed(d)) : n;
}

function shortErr(e: unknown): string {
  const any = e as { details?: string; shortMessage?: string; message?: string };
  return (any.details ?? any.shortMessage ?? any.message ?? String(e)).split("\n")[0].slice(0, 100);
}

function deriveWorkerKey(master: Hex, index: number): Hex {
  return keccak256(concatHex([master, toHex(index, { size: 32 })]));
}

function distribute(total: number, buckets: number): number[] {
  const base = Math.floor(total / buckets);
  const rem = total % buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < rem ? 1 : 0));
}

function saveReport(name: string, data: unknown): string {
  mkdirSync(cfg.out, { recursive: true });
  const file = `${cfg.out}/${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  return file;
}

// Some nodes (seen on a CometBFT-based EVM under load) fail eth_getBlockByNumber while their
// tx indexer lags behind the block. Keep retrying until the deadline instead of aborting the run.
let blockFetchRetries = 0;
async function getBlockRetry(blockNumber: bigint, deadline: number) {
  let warned = false;
  for (;;) {
    try {
      return await pub.getBlock({ blockNumber });
    } catch (e) {
      blockFetchRetries++;
      if (!warned) {
        console.log(`  (block ${blockNumber} not readable yet: ${shortErr(e)}; retrying)`);
        warned = true;
      }
      if (performance.now() > deadline) throw e;
      await sleep(Math.min(2000, cfg.pollMs * 4));
    }
  }
}

interface BlockStat {
  number: number;
  timestamp: number;
  blockTimeSec: number;
  txCount: number;
  ourTxCount: number;
  gasUsed: number;
  gasLimit: number;
  utilizationPct: number;
  baseFeeGwei: number | null;
}

async function fetchBlockStat(n: bigint, prevTimestamp: bigint | null, ours?: Set<Hash>): Promise<BlockStat> {
  const b = await getBlockRetry(n, performance.now() + cfg.timeoutSec * 1000);
  const hashes = b.transactions as Hash[];
  return {
    number: Number(b.number),
    timestamp: Number(b.timestamp),
    blockTimeSec: prevTimestamp === null ? NaN : Number(b.timestamp - prevTimestamp),
    txCount: hashes.length,
    ourTxCount: ours ? hashes.filter((h) => ours.has(h)).length : 0,
    gasUsed: Number(b.gasUsed),
    gasLimit: Number(b.gasLimit),
    utilizationPct: round((Number(b.gasUsed) / Number(b.gasLimit)) * 100),
    baseFeeGwei: b.baseFeePerGas == null ? null : round(Number(formatGwei(b.baseFeePerGas)), 4),
  };
}

function summarizeBlocks(blocks: BlockStat[]) {
  const nonEmpty = blocks.filter((b) => b.txCount > 0);
  const spanSec = blocks.length > 1 ? blocks[blocks.length - 1].timestamp - blocks[0].timestamp : 0;
  const totalTx = blocks.reduce((s, b) => s + b.txCount, 0);
  const totalGas = blocks.reduce((s, b) => s + b.gasUsed, 0);
  const times = blocks.map((b) => b.blockTimeSec).filter((t) => Number.isFinite(t));
  const peak = blocks.reduce(
    (best, b) => {
      const tps = Number.isFinite(b.blockTimeSec) && b.blockTimeSec > 0 ? b.txCount / b.blockTimeSec : NaN;
      return tps > best.tps ? { tps, block: b.number } : best;
    },
    { tps: 0, block: 0 },
  );
  return {
    blocks: blocks.length,
    firstBlock: blocks[0]?.number,
    lastBlock: blocks[blocks.length - 1]?.number,
    spanSec,
    totalTx,
    totalGas,
    avgTps: spanSec > 0 ? round(totalTx / spanSec) : null,
    avgGasPerSec: spanSec > 0 ? Math.round(totalGas / spanSec) : null,
    avgBlockTimeSec: times.length ? round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    avgTxPerBlock: round(totalTx / Math.max(1, blocks.length)),
    maxTxInBlock: Math.max(0, ...blocks.map((b) => b.txCount)),
    avgUtilizationPct: round(blocks.reduce((s, b) => s + b.utilizationPct, 0) / Math.max(1, blocks.length)),
    emptyBlocks: blocks.length - nonEmpty.length,
    peakBlockTps: round(peak.tps),
    peakBlock: peak.block,
  };
}

// ---------------------------------------------------------------------------
// observe: passive throughput from recent blocks
// ---------------------------------------------------------------------------

async function runObserve() {
  const chainId = await pub.getChainId();
  const head = await pub.getBlockNumber();
  const from = head - BigInt(cfg.blocks) + 1n > 0n ? head - BigInt(cfg.blocks) + 1n : 0n;
  console.log(`chain ${chainId} @ ${cfg.rpcUrl}`);
  console.log(`observing blocks ${from} .. ${head} (${Number(head - from) + 1} blocks)\n`);

  // Fetch one extra block before `from` so the first block gets a block time.
  const numbers: bigint[] = [];
  for (let n = from > 0n ? from - 1n : from; n <= head; n++) numbers.push(n);
  const rawBlocks = [];
  for (let i = 0; i < numbers.length; i += 20) {
    const deadline = performance.now() + cfg.timeoutSec * 1000;
    rawBlocks.push(...(await Promise.all(numbers.slice(i, i + 20).map((n) => getBlockRetry(n, deadline)))));
  }
  const blocks: BlockStat[] = [];
  for (let i = 0; i < rawBlocks.length; i++) {
    const b = rawBlocks[i];
    if (b.number! < from) continue;
    const prev = i > 0 ? rawBlocks[i - 1].timestamp : null;
    blocks.push({
      number: Number(b.number),
      timestamp: Number(b.timestamp),
      blockTimeSec: prev === null ? NaN : Number(b.timestamp - prev),
      txCount: b.transactions.length,
      ourTxCount: 0,
      gasUsed: Number(b.gasUsed),
      gasLimit: Number(b.gasLimit),
      utilizationPct: round((Number(b.gasUsed) / Number(b.gasLimit)) * 100),
      baseFeeGwei: b.baseFeePerGas == null ? null : round(Number(formatGwei(b.baseFeePerGas)), 4),
    });
  }

  const summary = summarizeBlocks(blocks);
  console.table(blocks.slice(-25).map(({ ourTxCount: _o, ...rest }) => rest));
  console.log("\nsummary");
  console.table(summary);
  const file = saveReport("observe", { mode: "observe", rpcUrl: cfg.rpcUrl, chainId, summary, blocks });
  console.log(`report written to ${file}`);

  if (!cfg.follow) return;
  console.log("\nfollowing new blocks (ctrl-c to stop)\n");
  let last = head;
  let prevTs = BigInt(blocks[blocks.length - 1]?.timestamp ?? 0);
  for (;;) {
    const cur = await pub.getBlockNumber();
    while (last < cur) {
      last++;
      const s = await fetchBlockStat(last, prevTs);
      prevTs = BigInt(s.timestamp);
      const tps = s.blockTimeSec > 0 ? round(s.txCount / s.blockTimeSec) : "n/a";
      console.log(
        `block ${s.number}  +${s.blockTimeSec}s  txs=${s.txCount}  tps=${tps}  gas=${s.gasUsed}/${s.gasLimit} (${s.utilizationPct}%)`,
      );
    }
    await sleep(cfg.pollMs);
  }
}

// ---------------------------------------------------------------------------
// load: submit TX_COUNT transfers from CONCURRENCY funded workers, measure inclusion
// ---------------------------------------------------------------------------

async function runLoad() {
  if (!/^0x[0-9a-fA-F]{64}$/.test(cfg.privateKey)) {
    throw new Error("PRIVATE_KEY must be a 0x-prefixed 32-byte hex key (funded account on the target chain)");
  }
  const chainId = await pub.getChainId();
  if (cfg.chainId && cfg.chainId !== chainId) {
    throw new Error(`CHAIN_ID=${cfg.chainId} but the node reports chain id ${chainId}`);
  }

  const startBlock = await pub.getBlock();
  const eip1559 = startBlock.baseFeePerGas != null;
  let priority = 1_000_000_000n;
  try {
    priority = await pub.estimateMaxPriorityFeePerGas();
  } catch {
    /* node has no eth_maxPriorityFeePerGas; keep 1 gwei */
  }
  const gasPrice = await pub.getGasPrice();
  const mult = BigInt(cfg.feeMultiplier);
  const fees = eip1559
    ? { type: "eip1559" as const, maxFeePerGas: startBlock.baseFeePerGas! * mult + priority, maxPriorityFeePerGas: priority }
    : { type: "legacy" as const, gasPrice: gasPrice * mult };
  const feeCap = eip1559 ? fees.maxFeePerGas! : fees.gasPrice!;
  const perTxCost = GAS_TRANSFER * feeCap;

  const master = privateKeyToAccount(cfg.privateKey);
  const workers: PrivateKeyAccount[] = Array.from({ length: cfg.concurrency }, (_, i) =>
    privateKeyToAccount(deriveWorkerKey(cfg.privateKey, i)),
  );
  const counts = distribute(cfg.txCount, cfg.concurrency);

  console.log(`chain ${chainId} @ ${cfg.rpcUrl}`);
  console.log(`head block ${startBlock.number}, gasLimit ${startBlock.gasLimit}, ${eip1559 ? "EIP-1559" : "legacy"} fees`);
  console.log(`fee cap ${formatGwei(feeCap)} gwei/gas, ${formatEther(perTxCost)} per tx (cap)`);
  console.log(`master ${master.address}`);
  console.log(`plan: ${cfg.txCount} native transfers across ${cfg.concurrency} workers (${counts[0]} each)\n`);

  // -- 1. fund workers -------------------------------------------------------
  const balances = await Promise.all(workers.map((w) => pub.getBalance({ address: w.address })));
  const needs = workers.map((_, i) => {
    const need = (perTxCost * BigInt(counts[i]) * 12n) / 10n; // 20% headroom
    return need > balances[i] ? need - balances[i] : 0n;
  });
  const totalNeed = needs.reduce((a, b) => a + b, 0n);
  const fundingTxs = needs.filter((n) => n > 0n).length;
  const masterBal = await pub.getBalance({ address: master.address });
  const required = totalNeed + perTxCost * BigInt(fundingTxs);
  if (masterBal < required) {
    throw new Error(
      `master balance ${formatEther(masterBal)} is below the ${formatEther(required)} needed to fund ${fundingTxs} workers`,
    );
  }

  if (fundingTxs > 0) {
    console.log(`funding ${fundingTxs} workers with ${formatEther(totalNeed)} total ...`);
    let nonce = await pub.getTransactionCount({ address: master.address, blockTag: "pending" });
    const hashes: Hash[] = [];
    for (let i = 0; i < workers.length; i++) {
      if (needs[i] === 0n) continue;
      const signed = await master.signTransaction({
        chainId,
        nonce: nonce++,
        to: workers[i].address,
        value: needs[i],
        gas: GAS_TRANSFER,
        ...fees,
      });
      hashes.push(await raw.request({ method: "eth_sendRawTransaction", params: [signed] }));
    }
    await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash, timeout: cfg.timeoutSec * 1000 })));
    console.log("workers funded\n");
  } else {
    console.log("workers already funded from a previous run\n");
  }

  // -- 2. pre-sign everything so signing cost is excluded from the measurement
  const nonces = await Promise.all(
    workers.map((w) => pub.getTransactionCount({ address: w.address, blockTag: "pending" })),
  );
  const tSign = performance.now();
  const signed: Hex[][] = await Promise.all(
    workers.map(async (w, i) => {
      const out: Hex[] = [];
      for (let k = 0; k < counts[i]; k++) {
        out.push(
          await w.signTransaction({ chainId, nonce: nonces[i] + k, to: w.address, value: 0n, gas: GAS_TRANSFER, ...fees }),
        );
      }
      return out;
    }),
  );
  console.log(`pre-signed ${cfg.txCount} txs in ${round((performance.now() - tSign) / 1000)}s`);

  // -- 3. submit and watch concurrently. The block watcher starts before the first
  //       send so inclusion latency is measured from the moment each tx is submitted,
  //       not from the moment the last one is.
  const sendFrom = await pub.getBlock();
  const submitted = new Map<Hash, number>();
  const errors = new Map<string, number>();
  const included = new Map<Hash, { block: number; seenAt: number }>();
  const blocks: BlockStat[] = [];
  let submitIdx = 0;
  let submitDone = false;
  let tSubmitEnd = NaN;
  let tLastInclusion = NaN;

  const t0 = performance.now();

  const submitAll = Promise.all(
    signed.map(async (txs) => {
      for (const tx of txs) {
        try {
          const h = await raw.request({ method: "eth_sendRawTransaction", params: [tx] });
          submitted.set(h, performance.now());
        } catch (e) {
          const msg = shortErr(e);
          errors.set(msg, (errors.get(msg) ?? 0) + 1);
        }
        submitIdx++;
        if (submitIdx % 500 === 0) console.log(`  submitted ${submitIdx}/${cfg.txCount}`);
      }
    }),
  ).then(() => {
    submitDone = true;
    tSubmitEnd = performance.now();
    const submitSec = (tSubmitEnd - t0) / 1000;
    console.log(`submitted ${submitted.size} accepted, ${cfg.txCount - submitted.size} rejected in ${round(submitSec)}s`);
    console.log(`  -> submission rate ${round(submitted.size / submitSec)} tx/s (RPC + mempool acceptance)`);
  });

  // -- 4. watch blocks until every accepted tx is included or we time out after submission
  const watch = (async () => {
    let next = sendFrom.number! + 1n;
    let prevTs = sendFrom.timestamp;
    const allIncluded = () => submitDone && included.size >= submitted.size;
    const timedOut = () => submitDone && performance.now() > tSubmitEnd + cfg.timeoutSec * 1000;
    while (!allIncluded() && !timedOut()) {
      const head = await pub.getBlockNumber();
      while (next <= head) {
        const b = await getBlockRetry(next, performance.now() + cfg.timeoutSec * 1000);
        const seenAt = performance.now();
        let mine = 0;
        for (const h of b.transactions as Hash[]) {
          if (submitted.has(h) && !included.has(h)) {
            included.set(h, { block: Number(next), seenAt });
            mine++;
          }
        }
        if (mine > 0) tLastInclusion = seenAt;
        const stat: BlockStat = {
          number: Number(b.number),
          timestamp: Number(b.timestamp),
          blockTimeSec: Number(b.timestamp - prevTs),
          txCount: b.transactions.length,
          ourTxCount: mine,
          gasUsed: Number(b.gasUsed),
          gasLimit: Number(b.gasLimit),
          utilizationPct: round((Number(b.gasUsed) / Number(b.gasLimit)) * 100),
          baseFeeGwei: b.baseFeePerGas == null ? null : round(Number(formatGwei(b.baseFeePerGas)), 4),
        };
        blocks.push(stat);
        prevTs = b.timestamp;
        console.log(
          `  block ${stat.number}  +${stat.blockTimeSec}s  ours=${mine}  total=${stat.txCount}  gas ${stat.utilizationPct}%  (${included.size}/${submitted.size} included)`,
        );
        next++;
      }
      if (!allIncluded()) await sleep(cfg.pollMs);
    }
  })();

  await Promise.all([submitAll, watch]);
  const submitSec = (tSubmitEnd - t0) / 1000;

  // -- 5. metrics ------------------------------------------------------------
  const inclusionBlocks = blocks.filter((b) => b.ourTxCount > 0);
  const chainSpanSec = inclusionBlocks.length
    ? inclusionBlocks[inclusionBlocks.length - 1].timestamp - Number(sendFrom.timestamp)
    : 0;
  const wallSec = Number.isFinite(tLastInclusion) ? (tLastInclusion - t0) / 1000 : NaN;
  const latencies = [...submitted.entries()]
    .filter(([h]) => included.has(h))
    .map(([h, sentAt]) => (included.get(h)!.seenAt - sentAt) / 1000)
    .sort((a, b) => a - b);

  const summary = {
    txPlanned: cfg.txCount,
    txAccepted: submitted.size,
    txRejected: cfg.txCount - submitted.size,
    txIncluded: included.size,
    txPending: submitted.size - included.size,
    workers: cfg.concurrency,
    submitSec: round(submitSec),
    submissionRateTps: round(submitted.size / submitSec),
    inclusionBlocks: inclusionBlocks.length,
    firstInclusionBlock: inclusionBlocks[0]?.number ?? null,
    lastInclusionBlock: inclusionBlocks[inclusionBlocks.length - 1]?.number ?? null,
    chainTimeSpanSec: chainSpanSec,
    chainTimeTps: chainSpanSec > 0 ? round(included.size / chainSpanSec) : null,
    wallClockSec: round(wallSec),
    wallClockTps: wallSec > 0 ? round(included.size / wallSec) : null,
    peakBlockTps: summarizeBlocks(blocks).peakBlockTps,
    peakBlock: summarizeBlocks(blocks).peakBlock,
    maxOurTxInBlock: Math.max(0, ...blocks.map((b) => b.ourTxCount)),
    avgUtilizationPct: summarizeBlocks(inclusionBlocks).avgUtilizationPct,
    blockFetchRetries,
    latencySecP50: round(percentile(latencies, 50)),
    latencySecP90: round(percentile(latencies, 90)),
    latencySecP99: round(percentile(latencies, 99)),
    latencySecMax: round(latencies[latencies.length - 1] ?? NaN),
  };

  console.log(`\nblocks touched during the run${blocks.length > 40 ? " (last 40 shown; all are in the JSON report)" : ""}`);
  console.table(blocks.slice(-40));
  if (errors.size) {
    console.log("\nrejections");
    console.table([...errors.entries()].map(([error, count]) => ({ error, count })));
  }
  console.log("\nsummary");
  console.table(summary);
  console.log(
    "\nchainTimeTps uses block timestamps (what the chain itself sustained); wallClockTps and latencies include RPC and polling delay.",
  );
  if (chainSpanSec === 0 && included.size > 0) {
    console.log("all txs landed in one block; raise TX_COUNT to measure a sustained rate.");
  }
  if (summary.txPending > 0) {
    console.log(`${summary.txPending} txs were still pending after ${cfg.timeoutSec}s (see TIMEOUT_SEC).`);
  }

  const file = saveReport("load", {
    mode: "load",
    rpcUrl: cfg.rpcUrl,
    chainId,
    config: { txCount: cfg.txCount, concurrency: cfg.concurrency, feeMultiplier: cfg.feeMultiplier, eip1559 },
    summary,
    rejections: Object.fromEntries(errors),
    blocks,
  });
  console.log(`report written to ${file}`);
}

// ---------------------------------------------------------------------------

(mode === "observe" ? runObserve() : runLoad()).catch((e) => {
  console.error(`\nerror: ${shortErr(e)}`);
  process.exit(1);
});
