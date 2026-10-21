import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { Server } from '@stellar/stellar-sdk/rpc'
import type { RouteDockLogger } from '../../internal/logger.js'

export interface VaultSettlementAddresses {
  payer: string
  payee: string
}

/**
 * Return correctly attributed vault-event participants, or null when the
 * payer could not be extracted. Publishing no audit event is safer than
 * knowingly attributing the provider as both sides of the settlement.
 */
export function resolveVaultSettlementAddresses(
  payer: string | null,
  payee: string,
): VaultSettlementAddresses | null {
  if (!payer) return null
  return { payer, payee }
}

/**
 * Build the `record_session_settlement` transaction for a closed channel.
 *
 * The transaction source is the payee, because the vault authorizes the record
 * with the allowlisted payee's own signature — never the vault admin's. The
 * source-account credential added by `prepareTransaction` therefore satisfies
 * `payee.require_auth()` on the contract, so a provider never needs the admin
 * secret to emit `session_settled`.
 *
 * Kept free of RPC calls so it is unit-testable without a network round trip.
 */
/**
 * Explicit, per-handler configuration for recording `session_settled` on the
 * agent vault. Replaces the SDK's former process-wide `AGENT_VAULT_CONTRACT`
 * env lookup, which was unreachable on Workers and untestable per handler.
 */
export interface VaultSettlementOptions {
  /** Deployed agent-vault contract ID (C...). */
  contract: string
  /** Soroban RPC endpoint. Defaults to the public endpoint for the network. */
  rpcUrl?: string
}

const DEFAULT_RPC_URLS = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://mainnet.sorobanrpc.com',
}

/** Outcome of a `record_session_settlement` submission, never thrown. */
export interface SessionSettlementOutcome {
  status: 'confirmed' | 'failed' | 'timeout'
  /** Transaction hash, present once the submission returned one. */
  txHash?: string
  /** Human-readable failure reason when status !== 'confirmed'. */
  reason?: string
}

export interface RecordSessionSettlementParams {
  options: VaultSettlementOptions
  /** Channel contract whose session was closed. */
  channelId: string
  /** Distinctly attributed payer/payee addresses (null payer aborts first). */
  addresses: VaultSettlementAddresses
  /** Cumulative closing amount in stroops. */
  amount: bigint
  /** Number of vouchers in the settled session. */
  voucherCount: number
  network: 'testnet' | 'mainnet'
  /** Payee keypair — the transaction source and its only signer. */
  sourceKeypair: Keypair
  logger: RouteDockLogger
}

/**
 * Build, sign, send and confirm one `record_session_settlement` call.
 *
 * Never throws: every failure (send error, FAILED transaction, RPC error,
 * confirm timeout) is logged with the transaction hash when available and
 * reported through the returned {@link SessionSettlementOutcome}, so a vault
 * outage can never break (or throw into) the channel-close response a caller
 * is building.
 */
export async function recordSessionSettlement(
  params: RecordSessionSettlementParams,
): Promise<SessionSettlementOutcome> {
  const { options, logger } = params
  const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URLS[params.network]
  const networkPassphrase = params.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET
  try {
    const server = new Server(rpcUrl)
    const sourceAccount = await server.getAccount(params.sourceKeypair.publicKey())
    const tx = buildSessionSettlementTransaction(
      sourceAccount,
      options.contract,
      params.channelId,
      params.addresses,
      params.amount,
      params.voucherCount,
      networkPassphrase,
    )
    const preparedTx = await server.prepareTransaction(tx)
    preparedTx.sign(params.sourceKeypair)

    const sent = await server.sendTransaction(preparedTx)
    const txHash = sent.hash
    if (sent.status === 'ERROR') {
      const reason = JSON.stringify((sent as { errorResult?: unknown }).errorResult ?? sent.status)
      logger('error', '[vault] record_session_settlement tx rejected', { txHash, error: reason })
      return { status: 'failed', txHash, reason: `send error: ${reason}` }
    }

    // Confirm: poll getTransaction until it is no longer pending, bounded so a
    // stuck RPC can hold neither a Node process nor a Worker's waitUntil open.
    const deadline = Date.now() + 30_000
    for (;;) {
      const result = await server.getTransaction(txHash)
      if (result.status === 'SUCCESS') {
        return { status: 'confirmed', txHash }
      }
      if (result.status === 'FAILED') {
        logger('error', '[vault] record_session_settlement tx failed on-chain', { txHash })
        return { status: 'failed', txHash, reason: 'transaction FAILED' }
      }
      if (Date.now() >= deadline) {
        logger('error', '[vault] record_session_settlement confirmation timed out', { txHash })
        return { status: 'timeout', txHash, reason: 'confirmation timed out' }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  } catch (err) {
    logger('error', '[vault] record_session_settlement submission failed', { error: err })
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Translate a non-confirmed outcome into the callback-error surface. */
export function settlementOutcomeError(outcome: SessionSettlementOutcome): Error {
  const hash = outcome.txHash ? ` (tx ${outcome.txHash})` : ''
  return new Error(`record_session_settlement did not confirm${hash}: ${outcome.reason ?? outcome.status}`)
}

export function buildSessionSettlementTransaction(
  source: Account,
  vaultContractId: string,
  channelId: string,
  addresses: VaultSettlementAddresses,
  amount: bigint,
  voucherCount: number,
  networkPassphrase: string,
): Transaction {
  const vault = new Contract(vaultContractId)
  const op = vault.call(
    'record_session_settlement',
    nativeToScVal(channelId, { type: 'address' }),
    nativeToScVal(addresses.payer, { type: 'address' }),
    nativeToScVal(addresses.payee, { type: 'address' }),
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(voucherCount, { type: 'u32' }),
  )
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
}