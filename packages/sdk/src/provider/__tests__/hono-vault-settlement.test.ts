/**
 * Hono mpp-session: session_settled must be recorded on the agent vault
 * configured via the explicit `vaultSettlement` option (issue #555) — not
 * through a process-wide env var, which is unreachable on Workers. Covers:
 * option unset (no vault call), option set (the tx carries the right channel,
 * payer, payee, amount and voucher count), a send that returns ERROR (logged
 * with the tx hash and reason, never thrown into the close response), and a
 * FAILED on-chain confirmation.
 *
 * '@stellar/mpp/channel/server' and '../mppCompatibility.js' are mocked the
 * same way as hono-verified-voucher.test.ts; '@stellar/stellar-sdk/rpc' is
 * mocked so the real contract-call transaction the helper builds can be
 * inspected from its XDR.
 * Hono mpp-session: session_settled is recorded on the agent vault after a
 * clean close (issue #555).
 *
 * `recordSessionSettlement` talks to a Soroban RPC through the dynamically
 * imported `@stellar/stellar-sdk/rpc` Server — this file mocks that module
 * (plus `@stellar/mpp/channel/server`) so the whole build/prepare/sign/send/
 * confirm flow runs without a network round trip, in its own process, leaving
 * the real hono.test.ts unaffected.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Account, Keypair, Networks, TransactionBuilder, scValToNative, StrKey } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import type { RouteDockLogger } from '../../internal/logger.js'
import {
  Account,
  Keypair,
  Networks,
  scValToNative,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import type { RouteDockLogLevel, RouteDockLogFields } from '../../internal/logger.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const payerKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
// `new Contract()` rejects malformed ids, so derive a valid contract id.
const VAULT_CONTRACT = StrKey.encodeContract(Keypair.random().rawPublicKey())

const closeCalls: Array<{ amount: bigint }> = []
// `new Contract()` rejects account (G...) addresses, so mint a contract id.
const VAULT = StrKey.encodeContract(Keypair.random().rawPublicKey())

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

// ---------------------------------------------------------------------------
// @stellar/mpp/channel/server mock — close always succeeds, the channel
// method is never reached (only the DELETE path runs here).
// ---------------------------------------------------------------------------

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => {
        const m = new Map<string, unknown>()
        return {
          async get(k: string) { return m.get(k) },
          async put(k: string, v: unknown) { m.set(k, v) },
          async delete(k: string) { m.delete(k) },
          update(k: string, fn: (v: unknown) => unknown) { m.set(k, fn(m.get(k))) },
        }
      },
    },
    close: async (opts: { amount: bigint }) => {
      closeCalls.push({ amount: opts.amount })
      return 'mock-close-tx-hash'
    },
    close: async () => 'mock-close-tx-hash',
    stellar: () => [],
  },
})

const actualCompat = await import('../mppCompatibility.js')
type Commit = (credential: { payload?: unknown; source?: string }) => void | Promise<void>
let lastCommit: Commit | null = null
// Capture `commit` so the test can feed in verified vouchers without building
// a full signed credential (same trick as hono-orphan-close.test.ts).
const actualCompat = await import('../mppCompatibility.js')
type Commit = (credential: { payload?: unknown; source?: string }) => void | Promise<void>
let capturedCommit: Commit | null = null
mock.module('../mppCompatibility.js', {
  namedExports: {
    channelAuthorizer: actualCompat.channelAuthorizer,
    withTypedChannelErrors: actualCompat.withTypedChannelErrors,
    formatMppError: actualCompat.formatMppError,
    onVerifiedCredential: (method: unknown, commit: Commit) => {
      lastCommit = commit
      capturedCommit = commit
      return method
    },
  },
})

interface MockRpcState {
  sendReturnsError: boolean
  getTransactionStatus: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'
}

const rpc: MockRpcState = { sendReturnsError: false, getTransactionStatus: 'SUCCESS' }
const sentTransactions: Array<{ toXDR(): string }> = []

mock.module('@stellar/stellar-sdk/rpc', {
  namedExports: {
    // '@stellar/stellar-sdk' re-exports the rpc subpath's named exports, so
    // the mock must cover the ones anything imports; only Server is replaced.
    Api: {},
    assembleTransaction: (tx: { toXDR(): string }) => tx,
    Server: class {
      async getAccount(publicKey: string) { return new Account(publicKey, '100') }
      async prepareTransaction(tx: { toXDR(): string }) { return tx }
      async sendTransaction(tx: { toXDR(): string }) {
        sentTransactions.push(tx)
        return rpc.sendReturnsError
          ? { status: 'ERROR', hash: 'settle-hash-1', errorResult: { code: 'SW_AUTH_FAILED' } }
          : { status: 'PENDING', hash: 'settle-hash-1' }
      }
      async getTransaction(hash: string) {
        if (rpc.sendReturnsError) {
          return { status: 'FAILED', hash }
        }
        return { status: rpc.getTransactionStatus, hash }
      }
// ---------------------------------------------------------------------------
// @stellar/stellar-sdk/rpc mock — records every call the settlement helper
// makes and returns the statuses each test configures.
// ---------------------------------------------------------------------------

interface RpcState {
  urls: string[]
  getAccountCalls: string[]
  preparedTx: Transaction | null
  sentTx: Transaction | null
  sendStatus: 'PENDING' | 'ERROR'
  sendErrorResult: unknown
  txStatus: string
}

const rpc: RpcState = {
  urls: [],
  getAccountCalls: [],
  preparedTx: null,
  sentTx: null,
  sendStatus: 'PENDING',
  sendErrorResult: undefined,
  txStatus: 'SUCCESS',
}

function resetRpc(): void {
  rpc.urls = []
  rpc.getAccountCalls = []
  rpc.preparedTx = null
  rpc.sentTx = null
  rpc.sendStatus = 'PENDING'
  rpc.sendErrorResult = undefined
  rpc.txStatus = 'SUCCESS'
}

class MockSorobanServer {
  async getAccount(publicKey: string): Promise<Account> {
    rpc.getAccountCalls.push(publicKey)
    return new Account(publicKey, '0')
  }
  async prepareTransaction(tx: Transaction): Promise<Transaction> {
    rpc.preparedTx = tx
    return tx
  }
  async sendTransaction(tx: Transaction): Promise<{ status: string; hash: string; errorResult?: unknown }> {
    rpc.sentTx = tx
    return {
      status: rpc.sendStatus,
      hash: tx.hash().toString('hex'),
      ...(rpc.sendErrorResult !== undefined ? { errorResult: rpc.sendErrorResult } : {}),
    }
  }
  async getTransaction(): Promise<{ status: string }> {
    return { status: rpc.txStatus }
  }
}

// The settlement helper builds its RPC client through the internal vaultRpc
// seam — mock that instead of @stellar/stellar-sdk/rpc itself, whose CJS
// exports node:test module mocks cannot redefine.
mock.module('../internal/vaultRpc.js', {
  namedExports: {
    createSorobanRpcServer: async (rpcUrl: string) => {
      rpc.urls.push(rpcUrl)
      return new MockSorobanServer()
    },
  },
})

const { routedockHono } = await import('../hono.js')
const { settlementOutcomeError } = await import('../internal/vaultSettlement.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Vault Settlement Test',

// The deprecated env fallback must never fire unless a test asks for it.
delete process.env.AGENT_VAULT_CONTRACT
delete process.env.AGENT_VAULT_CONTRACT_ID

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Vault Settlement Test Service',
  description: 'Unit test provider',
  modes: ['mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

/**
 * Re-parse a sent transaction and return the invoked contract function name
 * and decoded args of its single operation (same approach as
 * vault-settlement.test.ts).
 */
function hostCall(
  tx: { toXDR(): string },
): { fn: string; args: unknown[] } {
  const parsed = TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET)
  assert.equal(parsed.operations.length, 1, 'exactly one operation expected')
  const op = parsed.operations[0] as unknown as {
    type?: string
    func?: { invokeContract(): { functionName(): string | Buffer; args(): Array<Parameters<typeof scValToNative>[0]> } }
  }
  assert.equal(op.type, 'invokeHostFunction')
  const invoke = op.func!.invokeContract()
interface LogLine {
  level: RouteDockLogLevel
  message: string
  fields?: RouteDockLogFields | undefined
}

function makeApp(
  extra: {
    vaultSettlement?: { contract: string; rpcUrl?: string }
    waitUntil?: (p: Promise<unknown>) => void
    onCallbackError?: (err: unknown, cbName: string) => void
    logs?: LogLine[]
  } = {},
): Hono {
  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      ...(extra.logs
        ? { logger: (level, message, fields) => { extra.logs!.push({ level, message, fields }) } }
        : {}),
      ...(extra.vaultSettlement ? { vaultSettlement: extra.vaultSettlement } : {}),
      ...(extra.waitUntil ? { waitUntil: extra.waitUntil } : {}),
      ...(extra.onCallbackError ? { onCallbackError: extra.onCallbackError } : {}),
    }),
  )
  return app
}

function deleteClose(): Request {
  return new Request('http://localhost/price', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: '5000', signature: 'ff'.repeat(32) }),
  })
}

/**
 * Re-parse a built transaction so its operations carry decoded `type`/`func`
 * fields, then return the contract function name and args of the only
 * operation. Built (non-parsed) operations leave `func` unpopulated.
 */
function hostCall(tx: Transaction): { fn: string; args: unknown[] } {
  const parsed = TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET)
  assert.equal(parsed.operations.length, 1, 'exactly one operation expected')

  const op = parsed.operations[0] as unknown as {
    type?: string
    func?: { invokeContract(): unknown }
  }
  assert.equal(op.type, 'invokeHostFunction')

  const func = op.func
  assert.ok(func, 'operation should carry a host function')
  const invoke = func.invokeContract() as unknown as {
    functionName(): string | Buffer
    args(): Array<Parameters<typeof scValToNative>[0]>
  }
  const rawName = invoke.functionName()
  return {
    fn: typeof rawName === 'string' ? rawName : Buffer.from(rawName).toString(),
    args: invoke.args().map(a => scValToNative(a)),
  }
}

interface CapturedLogLine { level: string; message: string; meta: unknown }

/**
 * Test logger capturing structured lines.
 */
function captureLogger(logs: CapturedLogLine[]): RouteDockLogger {
  return (level: string, message: string, meta: unknown) => {
    logs.push({ level, message, meta })
  }
}

describe('routedockHono — vault settlement (issue #555)', () => {
  it('records no session_settled when the vaultSettlement option is unset', async () => {
    closeCalls.length = 0
    sentTransactions.length = 0
    const app = new Hono()
    app.use(
      '*',
      routedockHono({
        asset: 'USDC',
        assetContract: ASSET_CONTRACT,
        payee: payeeKeypair.publicKey(),
        network: 'testnet',
        payeeSecretKey: payeeKeypair.secret(),
        commitmentPublicKey: commitKeypair.publicKey(),
        manifest,
        modes: ['mpp-session'],
        pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      }),
    )
    const commit = lastCommit!
    await commit({ payload: { amount: '1000', signature: 'aa'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '1000', signature: 'aa'.repeat(32) }),
    })
    assert.equal(res.status, 200)
    assert.equal(closeCalls.length, 1)
    // Allow any background work to run.
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sentTransactions.length, 0, 'no vault tx without the vaultSettlement option')
  })

  it('records session_settled with the right channel, payer, payee, amount and voucher count', async () => {
    closeCalls.length = 0
    sentTransactions.length = 0
    rpc.sendReturnsError = false
    const waited: Promise<unknown>[] = []
    const app = new Hono()
    app.use(
      '*',
      routedockHono({
        asset: 'USDC',
        assetContract: ASSET_CONTRACT,
        payee: payeeKeypair.publicKey(),
        network: 'testnet',
        payeeSecretKey: payeeKeypair.secret(),
        commitmentPublicKey: commitKeypair.publicKey(),
        manifest,
        modes: ['mpp-session'],
        pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
        vaultSettlement: { contract: VAULT_CONTRACT },
        waitUntil: (promise) => { waited.push(promise) },
      }),
    )
    const commit = lastCommit!
    await commit({ payload: { amount: '1000', signature: 'aa'.repeat(32) }, source: payerKeypair.publicKey() })
    await commit({ payload: { amount: '5000', signature: 'bb'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '5000', signature: 'bb'.repeat(32) }),
    })
    assert.equal(res.status, 200)
    assert.equal(closeCalls.length, 1)

    // The close response must not have waited for the vault: the settlement
    // is background (held alive via waitUntil), so finish it and assert.
    assert.equal(waited.length, 1, 'vault settlement must be kept alive through waitUntil')
    await waited[0]

    assert.equal(sentTransactions.length, 1)
    const sent = sentTransactions[0]!
    const parsed = TransactionBuilder.fromXDR(sent.toXDR(), Networks.TESTNET)
    assert.equal((parsed as unknown as { source: string }).source, payeeKeypair.publicKey())
    const { fn, args } = hostCall(sent)
    assert.equal(fn, 'record_session_settlement')
describe('routedockHono — vault session settlement on clean close', () => {
  it('#given no vaultSettlement option #when a session closes cleanly #then no vault RPC call is made', async () => {
    resetRpc()
    const waits: Promise<unknown>[] = []
    const app = makeApp({ waitUntil: (p) => { waits.push(p) } })

    assert.ok(capturedCommit, 'onVerifiedCredential mock should have captured commit')
    await capturedCommit!({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request(deleteClose())
    assert.equal(res.status, 200)
    const body = (await res.json()) as { closeTxHash: string | null }
    assert.equal(body.closeTxHash, 'mock-close-tx-hash')

    assert.equal(waits.length, 0, 'no background settlement promise should exist')
    assert.equal(rpc.urls.length, 0, 'no RPC client should have been constructed')
    assert.equal(rpc.getAccountCalls.length, 0)
    assert.equal(rpc.preparedTx, null)
    assert.equal(rpc.sentTx, null)
  })

  it('#given the vaultSettlement option #when a session closes cleanly #then record_session_settlement is built with the session\'s channel, payer, payee, amount and voucher count', async () => {
    resetRpc()
    const waits: Promise<unknown>[] = []
    const app = makeApp({
      vaultSettlement: { contract: VAULT },
      waitUntil: (p) => { waits.push(p) },
    })

    // Two verified vouchers — the record must carry voucher count 2.
    await capturedCommit!({ payload: { amount: '3000', signature: 'aa'.repeat(32) }, source: payerKeypair.publicKey() })
    await capturedCommit!({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request(deleteClose())
    assert.equal(res.status, 200)

    assert.equal(waits.length, 1, 'settlement promise must be handed to waitUntil')
    await waits[0]

    assert.deepEqual(rpc.urls, ['https://soroban-testnet.stellar.org'], 'default testnet RPC endpoint')
    assert.deepEqual(rpc.getAccountCalls, [payeeKeypair.publicKey()], 'tx sourced from the payee')
    assert.ok(rpc.preparedTx, 'settlement transaction should have been prepared')
    assert.equal(rpc.sentTx, rpc.preparedTx, 'the prepared transaction should be the one sent')

    const { fn, args } = hostCall(rpc.preparedTx)
    assert.equal(fn, 'record_session_settlement')
    // (channel_id, payer, payee, cumulative_amount, voucher_count)
    assert.deepEqual(args, [
      CHANNEL_CONTRACT,
      payerKeypair.publicKey(),
      payeeKeypair.publicKey(),
      5000n,
      2,
    ])
  })

  it('a send that returns ERROR is logged with the tx hash and never throws into the response', async () => {
    closeCalls.length = 0
    sentTransactions.length = 0
    rpc.sendReturnsError = true
    const logs: CapturedLogLine[] = []
    const callbackErrors: Array<{ err: unknown; cb: string }> = []
    const waited: Promise<unknown>[] = []
    const app = new Hono()
    app.use(
      '*',
      routedockHono({
        asset: 'USDC',
        assetContract: ASSET_CONTRACT,
        payee: payeeKeypair.publicKey(),
        network: 'testnet',
        payeeSecretKey: payeeKeypair.secret(),
        commitmentPublicKey: commitKeypair.publicKey(),
        manifest,
        modes: ['mpp-session'],
        pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
        vaultSettlement: { contract: VAULT_CONTRACT },
        logger: captureLogger(logs),
        onCallbackError: (err, cb) => { callbackErrors.push({ err, cb }) },
        waitUntil: (promise) => { waited.push(promise) },
      }),
    )
    const commit = lastCommit!
    await commit({ payload: { amount: '1000', signature: 'aa'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '1000', signature: 'aa'.repeat(32) }),
    })
    assert.equal(res.status, 200, 'a failed vault record must not fail the close response')
    const json = await res.json() as { closeTxHash?: unknown }
    assert.equal(json.closeTxHash, 'mock-close-tx-hash')

    await Promise.all(waited)
    assert.equal(sentTransactions.length, 1)
    const errorLogs = logs.filter((l) => l.level === 'error' && /record_session_settlement/.test(l.message))
    assert.equal(errorLogs.length, 1)
    const errorMeta = errorLogs[0]!.meta as { txHash: string; error: string }
    assert.equal(errorMeta.txHash, 'settle-hash-1', 'error log must carry the tx hash')
    assert.ok(errorMeta.error.includes('SW_AUTH_FAILED'), 'error log must carry the reason')
    assert.equal(callbackErrors.length, 1, 'a failed settlement must report through onCallbackError')
    assert.equal(callbackErrors[0]!.cb, 'sessionSettlement')
    const errText = String(callbackErrors[0]!.err)
    assert.ok(errText.includes('settle-hash-1'), 'error must carry the tx hash')
  })

  it('settlementOutcomeError carries both the tx hash and the reason', () => {
    const err = settlementOutcomeError({ status: 'failed', txHash: 'hash-9', reason: 'transaction FAILED' })
    assert.ok(err.message.includes('hash-9'))
    assert.ok(err.message.includes('transaction FAILED'))
  it('#given a sendTransaction that returns ERROR #when the settlement is recorded #then the failure is logged with tx hash and reason without throwing into the close response', async () => {
    resetRpc()
    rpc.sendStatus = 'ERROR'
    rpc.sendErrorResult = {
      result: () => ({ switch: () => ({ name: 'txInsufficientBalance' }) }),
    }

    const waits: Promise<unknown>[] = []
    const logs: LogLine[] = []
    const callbacks: string[] = []
    const app = makeApp({
      vaultSettlement: { contract: VAULT },
      waitUntil: (p) => { waits.push(p) },
      logs,
      onCallbackError: (_err, cbName) => { callbacks.push(cbName) },
    })

    await capturedCommit!({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request(deleteClose())
    assert.equal(res.status, 200)
    const body = (await res.json()) as { closeTxHash: string | null }
    assert.equal(body.closeTxHash, 'mock-close-tx-hash', 'close response is unaffected by the vault failure')

    assert.equal(waits.length, 1)
    await waits[0]

    const errorLine = logs.find(
      (l) => l.level === 'error' && l.message.includes('failed to record session_settled'),
    )
    assert.ok(errorLine, `expected an error log, got ${JSON.stringify(logs)}`)
    assert.match(String(errorLine.fields?.txHash), /^[0-9a-f]{64}$/, 'failure must carry the tx hash')
    assert.match(String(errorLine.fields?.reason), /txInsufficientBalance/, 'failure must carry the reason')
    assert.equal(errorLine.fields?.channelId, CHANNEL_CONTRACT)

    assert.deepEqual(callbacks, ['vaultSettlement'], 'failure must be reported through onCallbackError')
  })

  it('#given a settlement transaction that fails on-chain #when confirmation returns FAILED #then the failure is logged with the tx hash and reason', async () => {
    resetRpc()
    rpc.txStatus = 'FAILED'

    const waits: Promise<unknown>[] = []
    const logs: LogLine[] = []
    const app = makeApp({
      vaultSettlement: { contract: VAULT },
      waitUntil: (p) => { waits.push(p) },
      logs,
    })

    await capturedCommit!({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request(deleteClose())
    assert.equal(res.status, 200)

    assert.equal(waits.length, 1)
    await waits[0]

    const errorLine = logs.find(
      (l) => l.level === 'error' && l.message.includes('failed to record session_settled'),
    )
    assert.ok(errorLine, `expected an error log, got ${JSON.stringify(logs)}`)
    assert.match(String(errorLine.fields?.txHash), /^[0-9a-f]{64}$/)
    assert.equal(errorLine.fields?.reason, 'transaction failed on-chain')
  })

  it('#given no waitUntil #when a session closes cleanly #then settlement still runs as a background promise', async () => {
    resetRpc()
    const app = makeApp({ vaultSettlement: { contract: VAULT } })

    await capturedCommit!({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request(deleteClose())
    assert.equal(res.status, 200)
    const body = (await res.json()) as { closeTxHash: string | null }
    assert.equal(body.closeTxHash, 'mock-close-tx-hash')

    // No waitUntil handle — poll for the background settlement to complete.
    const deadline = Date.now() + 2000
    while (rpc.sentTx === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(rpc.sentTx, 'background settlement should still have sent the transaction')
  })
})
