import { createExitLensFailure, evaluateExitLens } from '../lib/evaluate.mjs';
import { renderExitLensHtml } from '../lib/render.mjs';
import { LiveObservationError } from './contracts.mjs';
import { CONTRACTS, normalizeAddress } from './contracts.mjs';
import { observeRobinhoodExit, resolveTokenContext } from './robinhood.mjs';

const FAILURE_MESSAGES = Object.freeze({
  invalid_token_address: 'The token address is invalid.',
  invalid_amount: 'The token amount is invalid.',
  amount_exceeds_supply: 'The token amount exceeds the token supply.',
  wrong_chain: 'RPC is not connected to Robinhood Chain.',
  rpc_failure: 'Robinhood Chain data is temporarily unavailable.',
  rpc_call_error: 'A required Robinhood Chain contract read returned an error.',
  malformed_rpc_response: 'Robinhood Chain returned malformed observation data.',
  invalid_observation: 'The live observation is incomplete or inconsistent.',
  clock_skew: 'This device clock disagrees with Robinhood Chain block time, so freshness cannot be judged.',
  reorg_detected: 'The observation block changed during the read.',
  unsupported_token: 'This token was not found in a supported pons factory.',
  unsupported_factory_generation: 'This pons factory generation is not supported.',
  missing_canonical_pool: 'The supported pons token has no canonical Uniswap V3 pool.',
  spoofed_pool_relationship: 'The token, pons launch, and canonical pool relationship is inconsistent.'
});

function failureFrom(error) {
  const code = error.code;
  return createExitLensFailure(
    code,
    FAILURE_MESSAGES[code] ?? 'The live observation is unavailable.'
  );
}

async function usdSupplement(usdAdapter, context) {
  if (!usdAdapter) return { state: 'unknown' };
  try {
    const value = await usdAdapter.getWethUsd(context);
    if (value?.state === 'unknown') return { state: 'unknown' };
    if (value?.state === 'unavailable') return { state: 'unavailable' };
    if (!value
      || !['available', 'stale'].includes(value.state)
      || typeof value.price_usd !== 'string'
      || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.price_usd)
      || !/[1-9]/.test(value.price_usd)
      || typeof value.source !== 'string'
      || value.source.trim().length === 0
      || typeof value.observed_at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observed_at)
      || Number.isNaN(Date.parse(value.observed_at))
      || new Date(value.observed_at).toISOString() !== value.observed_at) {
      return { state: 'unavailable' };
    }
    return {
      state: value.state,
      price_usd: value.price_usd,
      source: value.source.trim(),
      observed_at: value.observed_at
    };
  } catch {
    return { state: 'unavailable' };
  }
}

export async function buildLiveExitLensArtifact(input) {
  let result;
  try {
    const observations = await observeRobinhoodExit(input);
    const evaluated = evaluateExitLens({
      tokenAddress: input.tokenAddress,
      amount: input.amount,
      observations
    });
    result = {
      ...evaluated,
      supplemental: {
        usd: await usdSupplement(
          input.usdAdapter,
          'observation' in evaluated ? evaluated.observation : null
        )
      }
    };
  } catch (error) {
    if (!(error instanceof LiveObservationError)) throw error;
    result = {
      ...failureFrom(error),
      supplemental: { usd: { state: 'unknown' } }
    };
  }

  return {
    result,
    get html() {
      return renderExitLensHtml(result);
    }
  };
}

function codeIsPresent(value) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new LiveObservationError(
      'malformed_rpc_response',
      'RPC returned malformed contract bytecode.'
    );
  }
  return value !== '0x' && !/^0x(?:00)*$/.test(value);
}

function smokeFailureArtifact(liveResult, code, message) {
  const result = {
    ...createExitLensFailure(code, message),
    factory: liveResult.factory,
    token: liveResult.token,
    pool: liveResult.pool,
    observation: liveResult.observation,
    sources: liveResult.sources,
    evidence_urls: liveResult.evidence_urls,
    supplemental: liveResult.supplemental
  };
  return { result, html: renderExitLensHtml(result) };
}

function validateConfirmationBlock(block, blockTag, expectedHash) {
  if (block === null
    || typeof block !== 'object'
    || Array.isArray(block)
    || typeof block.number !== 'string'
    || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(block.number)
    || BigInt(block.number) !== BigInt(blockTag)
    || typeof block.hash !== 'string'
    || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) {
    throw new LiveObservationError(
      'malformed_rpc_response',
      'RPC returned an invalid smoke-confirmation block.'
    );
  }
  if (block.hash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new LiveObservationError(
      'reorg_detected',
      'The observation block changed during bytecode verification.'
    );
  }
}

function smokeReportContext(liveResult, contracts) {
  return {
    chain_id: liveResult.observation.chain_id,
    block_number: liveResult.observation.block_number,
    block_hash: liveResult.observation.block_hash,
    observed_at: liveResult.observation.observed_at,
    token: liveResult.token.address,
    pool: liveResult.pool.address,
    factory: liveResult.factory,
    quote: {
      input_amount_base_units: liveResult.token.amount_base_units,
      output_amount_wei: liveResult.values.exit_quote.amount_wei,
      source: liveResult.values.exit_quote.source,
      source_address: liveResult.values.exit_quote.source_address,
      pipeline_consistency: 'exact_decoded_output'
    },
    contracts
  };
}

function smokeFailureResult(liveResult, error, contracts = []) {
  const failure = { code: error.code, message: error.message };
  return {
    artifact: smokeFailureArtifact(liveResult, failure.code, failure.message),
    report: {
      ok: false,
      read_only: true,
      status: 'unavailable',
      failure,
      ...smokeReportContext(liveResult, contracts)
    }
  };
}

async function executeLiveExitLensSmoke(input) {
  let artifact = await buildLiveExitLensArtifact(input);
  const liveResult = artifact.result;
  if (liveResult.status !== 'available' || !('observation' in liveResult)) {
    return {
      artifact,
      report: {
        ok: false,
        read_only: true,
        status: liveResult.status,
        failure: 'failure' in liveResult
          ? liveResult.failure
          : {
              code: 'invalid_observation',
              message: 'Live observation did not produce a complete result.'
            }
      }
    };
  }

  const blockTag = `0x${BigInt(liveResult.observation.block_number).toString(16)}`;
  const requiredContracts = [
    ['pons_factory', liveResult.factory.address],
    ['token', liveResult.token.address],
    ['pool', liveResult.pool.address],
    ['v3_factory', normalizeAddress(CONTRACTS.v3Factory)],
    ['quoter_v2', normalizeAddress(CONTRACTS.quoterV2)],
    ['weth', normalizeAddress(CONTRACTS.weth)]
  ];
  let contracts = [];
  try {
    contracts = await Promise.all(requiredContracts.map(async ([label, address]) => {
      let code;
      try {
        code = await input.request('eth_getCode', [address, blockTag]);
      } catch (error) {
        if (error instanceof LiveObservationError) throw error;
        throw new LiveObservationError('rpc_failure', 'Contract bytecode read failed.', error);
      }
      return {
        label,
        address,
        code_present: codeIsPresent(code)
      };
    }));
    if (!contracts.every((contract) => contract.code_present)) {
      throw new LiveObservationError(
        'missing_contract_code',
        'Required contract bytecode is unavailable at the observation block.'
      );
    }

    let confirmationBlock;
    try {
      confirmationBlock = await input.request('eth_getBlockByNumber', [blockTag, false]);
    } catch (error) {
      if (error instanceof LiveObservationError) throw error;
      throw new LiveObservationError('rpc_failure', 'Block confirmation read failed.', error);
    }
    validateConfirmationBlock(
      confirmationBlock,
      blockTag,
      liveResult.observation.block_hash
    );
  } catch (error) {
    if (!(error instanceof LiveObservationError)) throw error;
    return smokeFailureResult(liveResult, error, contracts);
  }

  return {
    artifact,
    report: {
      ok: true,
      read_only: true,
      status: 'available',
      ...smokeReportContext(liveResult, contracts)
    }
  };
}

export async function runLiveExitLensSmoke(input) {
  const { report } = await executeLiveExitLensSmoke(input);
  return report;
}

export { executeLiveExitLensSmoke };
export { observeRobinhoodExit };
export { resolveTokenContext };
export { buildCurrentDossier } from './dossier.mjs';
export {
  createFallbackRpcRequest,
  createJsonRpcRequest,
  PUBLIC_ROBINHOOD_RPC
} from './rpc.mjs';
