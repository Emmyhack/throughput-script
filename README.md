# konstellation-throughput

Throughput benchmark for any EVM JSON-RPC node, written for a local
[Konstellation](https://tsionark.mintlify.site/concepts/multi-chain) node
(the Scriipture docs point it at `http://127.0.0.1:8545`; there is no public RPC yet).

Two modes:

| mode      | what it measures                                                                  | needs key |
| --------- | --------------------------------------------------------------------------------- | --------- |
| `load`    | Sends `TX_COUNT` native transfers from `CONCURRENCY` worker accounts and tracks inclusion | yes       |
| `observe` | Reads the last `BLOCKS` blocks and reports the chain's actual TPS, block time, gas use | no        |

## Setup

```bash
npm install
cp .env.example .env   # then fill in RPC_URL and PRIVATE_KEY
```

`PRIVATE_KEY` must hold enough native token to fund the workers. Worker keys are
derived deterministically from it, so re-runs reuse the same accounts and only
top them up when needed. Never point this at a mainnet key.

## Run

```bash
npm run bench                       # load test with .env settings
npm run bench -- --tx-count 5000 --concurrency 50
npm run observe                     # sample recent blocks
npm run observe -- --blocks 200 --follow   # then tail new blocks live
```

Every env var has a CLI flag with the same name (`--rpc`, `--chain-id`, `--key`,
`--tx-count`, `--concurrency`, `--blocks`, `--timeout`, `--fee-multiplier`,
`--poll-ms`, `--out`). Flags override `.env`.

## How `load` works

1. Reads the head block to pick EIP-1559 or legacy fees. Fee cap is
   `baseFee * FEE_MULTIPLIER + priority tip`.
2. Funds `CONCURRENCY` derived worker accounts from `PRIVATE_KEY` and waits for
   those receipts.
3. Pre-signs every transaction so signing time is excluded from the measurement.
4. Each worker streams its share in nonce order; all workers submit in parallel.
   Submissions are not retried, so every RPC rejection is counted.
5. Polls new blocks until every accepted hash is included or `TIMEOUT_SEC` passes.

## Reading the summary

- `submissionRateTps`: how fast the RPC accepted transactions into the mempool.
- `chainTimeTps`: included txs divided by the block-timestamp span from the block
  before submission to the last block that included one of ours. This is the
  number the chain itself sustained.
- `wallClockTps`: same count over wall-clock seconds from first submit to the
  moment the last inclusion was observed. Includes RPC and polling delay.
- `peakBlockTps`: best single block, txs divided by that block's time.
- `latencySecP50/P90/P99`: submit-to-observed-inclusion, sampled at `POLL_MS`.
- `avgUtilizationPct`: gas used over gas limit for the blocks that carried our txs.
  Near 100% means the gas limit, not the node, is the ceiling: max tx/block is
  `gasLimit / 21000` for plain transfers.

Each run also writes a full JSON report (config, summary, per-block stats,
rejection reasons) to `results/`.
