import {
  CONTRACTS,
  LiveObservationError,
  decodeQuote,
  encodeQuote,
  normalizeAddress
} from './contracts.mjs';
import {
  exitObservationFromContext,
  resolveTokenContext,
  resolveTokenContextWith
} from './context.mjs';

const HUMAN_AMOUNT = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;

function parseUnits(value, decimals) {
  if (typeof value !== 'string' || !Number.isSafeInteger(decimals) || decimals < 0) return null;
  const match = HUMAN_AMOUNT.exec(value);
  if (!match || (match[1]?.length ?? 0) > decimals) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
  return amount > 0n ? amount : null;
}

export async function observeRobinhoodExit(input) {
  let amountBaseUnits;
  const { context, extra_results: [quoteResult] } = await resolveTokenContextWith(
    input,
    ({ token, decimals, totalSupply, blockTag }) => {
      amountBaseUnits = parseUnits(input.amount, decimals);
      if (amountBaseUnits === null) {
        throw new LiveObservationError('invalid_amount', 'The token amount is invalid.');
      }
      if (amountBaseUnits > totalSupply) {
        throw new LiveObservationError(
          'amount_exceeds_supply',
          'The token amount exceeds the recorded token supply.'
        );
      }
      return [{
      method: 'eth_call',
      params: [{
        to: CONTRACTS.quoterV2,
        data: encodeQuote(
          token,
          CONTRACTS.weth,
          amountBaseUnits,
          CONTRACTS.poolFee
        )
      }, blockTag]
      }];
    }
  );

  let quote = null;
  if (quoteResult instanceof Error) {
    if (!(quoteResult instanceof LiveObservationError)
      || !['rpc_failure', 'rpc_call_error'].includes(quoteResult.code)) {
      throw quoteResult;
    }
  } else {
    quote = decodeQuote(quoteResult);
  }

  const quotes = quote
    ? [{
        state: 'available',
        token_in: context.token.address,
        token_out: normalizeAddress(CONTRACTS.weth),
        chain_id: context.chain_id,
        pool_address: context.pool.address,
        block_number: context.observation.block_number,
        block_hash: context.observation.block_hash,
        observed_at: context.observation.observed_at,
        input_amount_base_units: amountBaseUnits.toString(),
        output_amount_wei: quote.amountOut.toString(),
        source: 'Uniswap V3 Quoter V2',
        source_address: normalizeAddress(CONTRACTS.quoterV2)
      }]
    : [];
  return exitObservationFromContext(context, quotes);
}

export { resolveTokenContext };
