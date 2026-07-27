import { ROBINHOOD_CHAIN } from './robinhood-chain.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;
const HUMAN_AMOUNT = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;
const UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/;
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const Q192 = 1n << 192n;

const EXPECTED = Object.freeze({
  chainId: ROBINHOOD_CHAIN.chainId,
  factories: Object.freeze(Object.fromEntries(
    ROBINHOOD_CHAIN.factories.map(({ generation, address }) => [generation, address])
  )),
  weth: ROBINHOOD_CHAIN.weth,
  quoter: ROBINHOOD_CHAIN.quoterV2,
  poolFee: ROBINHOOD_CHAIN.poolFee,
  tokenDecimals: ROBINHOOD_CHAIN.tokenDecimals
});

const REQUIRED_EVIDENCE = ['pons', 'token', 'pool', 'factory', 'block'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAddress(value) {
  return typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUnsignedInteger(value) {
  return typeof value === 'string' && UNSIGNED_INTEGER.test(value);
}

function isPositiveInteger(value) {
  return isUnsignedInteger(value) && value !== '0';
}

function isBoundedUnsigned(value, bits) {
  return isUnsignedInteger(value) && BigInt(value) < (1n << BigInt(bits));
}

function isBoundedPositive(value, bits) {
  return isBoundedUnsigned(value, bits) && value !== '0';
}

function isExactInstant(value) {
  return typeof value === 'string'
    && ISO_MILLISECONDS.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function parsePublicUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function evidencePath(parsed) {
  return parsed.pathname.replace(/\/+$/, '').toLowerCase();
}

function hasBoundEvidence(urls, token, pool, factory, blockNumber) {
  if (!isRecord(urls)
    || Object.keys(urls).length !== REQUIRED_EVIDENCE.length
    || REQUIRED_EVIDENCE.some((name) => !Object.hasOwn(urls, name))) {
    return false;
  }

  const parsed = Object.fromEntries(
    REQUIRED_EVIDENCE.map((name) => [name, parsePublicUrl(urls[name])])
  );
  if (REQUIRED_EVIDENCE.some((name) => parsed[name] === null)) return false;

  return parsed.pons.hostname === 'www.ponsfamily.com'
    && evidencePath(parsed.pons) === `/launchpad/${token}`
    && parsed.token.hostname === 'robinhoodchain.blockscout.com'
    && evidencePath(parsed.token) === `/token/${token}`
    && parsed.pool.hostname === 'robinhoodchain.blockscout.com'
    && evidencePath(parsed.pool) === `/address/${pool}`
    && parsed.factory.hostname === 'robinhoodchain.blockscout.com'
    && evidencePath(parsed.factory) === `/address/${factory}`
    && parsed.block.hostname === 'robinhoodchain.blockscout.com'
    && evidencePath(parsed.block) === `/block/${blockNumber}`;
}

function parseUnits(value, decimals) {
  if (typeof value !== 'string' || !Number.isSafeInteger(decimals) || decimals < 0) return null;
  const match = HUMAN_AMOUNT.exec(value);
  if (!match || (match[1]?.length ?? 0) > decimals) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
  return amount > 0n ? amount : null;
}

function formatUnits(value, decimals) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = decimals === 0 ? digits : digits.slice(0, -decimals);
  const fraction = decimals === 0 ? '' : digits.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function roundRatio(numerator, denominator) {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

function toValue(state) {
  return typeof state === 'string' ? { state } : state;
}

/**
 * @param {string | {spot_marked: string | object, exit_quote: string | object, realization_gap: string | object}} valueStates
 */
export function createExitLensFailure(
  code,
  message,
  valueStates = 'unknown',
  status = 'unavailable',
  context = {}
) {
  const states = typeof valueStates === 'string'
    ? {
        spot_marked: valueStates,
        exit_quote: valueStates,
        realization_gap: valueStates
      }
    : valueStates;

  return {
    status,
    failure: { code, message },
    values: {
      spot_marked: toValue(states.spot_marked),
      exit_quote: toValue(states.exit_quote),
      realization_gap: toValue(states.realization_gap)
    },
    ...context
  };
}

function invalidObservation() {
  return createExitLensFailure(
    'invalid_observation',
    'The recorded observation is invalid.'
  );
}

function observationContext(observations) {
  return {
    token: {
      address: observations.token.address,
      name: observations.token.name,
      symbol: observations.token.symbol
    },
    factory: {
      address: observations.factory.address,
      generation: observations.factory.generation
    },
    pool: {
      address: observations.pool.address,
      fee: observations.token.pool_fee
    },
    observation: {
      chain_id: observations.chain_id,
      block_number: observations.observation.block_number,
      block_hash: observations.observation.block_hash,
      observed_at: observations.observation.observed_at,
      freshness: observations.observation.freshness
    },
    sources: {
      launch: observations.factory.source,
      spot: observations.pool.source
    },
    evidence_urls: { ...observations.evidence_urls }
  };
}

function validateObservation(observations, normalizedToken) {
  const factoryGeneration = observations?.factory?.generation;
  const expectedFactory = Object.hasOwn(EXPECTED.factories, factoryGeneration)
    ? EXPECTED.factories[factoryGeneration]
    : undefined;
  if (isRecord(observations)
    && isRecord(observations.factory)
    && typeof factoryGeneration === 'string'
    && expectedFactory === undefined) {
    return { state: 'unsupported_factory' };
  }
  if (isRecord(observations)
    && isRecord(observations.token)
    && Number.isSafeInteger(observations.token.decimals)
    && observations.token.decimals !== EXPECTED.tokenDecimals) {
    return { state: 'unsupported_decimals' };
  }
  if (!isRecord(observations)
    || observations.schema_version !== 1
    || observations.chain_id !== EXPECTED.chainId
    || !isRecord(observations.factory)
    || expectedFactory === undefined
    || normalizeAddress(observations.factory.address) !== expectedFactory
    || observations.factory.launch_exists !== true
    || !isNonEmptyString(observations.factory.source)
    || !isRecord(observations.token)
    || !isNonEmptyString(observations.token.name)
    || !isNonEmptyString(observations.token.symbol)
    || normalizeAddress(observations.token.address) === null
    || observations.token.decimals !== EXPECTED.tokenDecimals
    || !isBoundedPositive(observations.token.total_supply_base_units, 256)
    || normalizeAddress(observations.token.paired_token) !== EXPECTED.weth
    || normalizeAddress(observations.token.liquidity_pool) === null
    || typeof observations.token.is_token0 !== 'boolean'
    || observations.token.pool_fee !== EXPECTED.poolFee) {
    return { state: 'invalid' };
  }

  const recordedToken = normalizeAddress(observations.token.address);
  if (recordedToken !== normalizedToken) return { state: 'unsupported' };

  if (!isRecord(observations.pool) || observations.pool.address === null) {
    return { state: 'missing_pool' };
  }

  const poolAddress = normalizeAddress(observations.pool.address);
  const expectedPool = normalizeAddress(observations.token.liquidity_pool);
  const expectedToken0 = observations.token.is_token0 ? recordedToken : EXPECTED.weth;
  const expectedToken1 = observations.token.is_token0 ? EXPECTED.weth : recordedToken;
  if (poolAddress === null
    || poolAddress !== expectedPool
    || normalizeAddress(observations.pool.token0) !== expectedToken0
    || normalizeAddress(observations.pool.token1) !== expectedToken1
    || !isBoundedPositive(observations.pool.sqrt_price_x96, 160)
    || !isBoundedUnsigned(observations.pool.liquidity, 128)
    || !['available', 'unavailable'].includes(observations.pool.state)
    || !isNonEmptyString(observations.pool.source)
    || !isRecord(observations.observation)
    || !isPositiveInteger(observations.observation.block_number)
    || typeof observations.observation.block_hash !== 'string'
    || !BLOCK_HASH.test(observations.observation.block_hash)
    || !isExactInstant(observations.observation.observed_at)
    || !['fresh', 'stale'].includes(observations.observation.freshness)
    || !hasBoundEvidence(
      observations.evidence_urls,
      recordedToken,
      poolAddress,
      expectedFactory,
      observations.observation?.block_number
    )
    || !Array.isArray(observations.quotes)) {
    return { state: 'invalid' };
  }

  const seenQuoteInputs = new Set();
  for (const quote of observations.quotes) {
    if (!isRecord(quote)
      || quote.state !== 'available'
      || normalizeAddress(quote.token_in) !== recordedToken
      || normalizeAddress(quote.token_out) !== EXPECTED.weth
      || quote.chain_id !== observations.chain_id
      || normalizeAddress(quote.pool_address) !== poolAddress
      || quote.block_number !== observations.observation.block_number
      || typeof quote.block_hash !== 'string'
      || !BLOCK_HASH.test(quote.block_hash)
      || quote.block_hash.toLowerCase() !== observations.observation.block_hash.toLowerCase()
      || quote.observed_at !== observations.observation.observed_at
      || !isBoundedPositive(quote.input_amount_base_units, 256)
      || !isBoundedUnsigned(quote.output_amount_wei, 256)
      || !isNonEmptyString(quote.source)
      || normalizeAddress(quote.source_address) !== EXPECTED.quoter) {
      return { state: 'invalid' };
    }
    if (seenQuoteInputs.has(quote.input_amount_base_units)) {
      return { state: 'invalid' };
    }
    seenQuoteInputs.add(quote.input_amount_base_units);
  }

  if (observations.pool.state === 'unavailable' || observations.pool.liquidity === '0') {
    return { state: 'no_liquidity', context: observationContext(observations) };
  }

  return {
    state: 'valid',
    recordedToken,
    poolAddress,
    context: observationContext(observations)
  };
}

/**
 * @param {{tokenAddress?: any, amount?: any, observations?: any}} [input]
 */
export function evaluateExitLens({ tokenAddress, amount, observations } = {}) {
  const normalizedToken = normalizeAddress(tokenAddress);
  if (!normalizedToken) {
    return createExitLensFailure('invalid_token_address', 'The token address is invalid.');
  }

  const validation = validateObservation(observations, normalizedToken);
  if (validation.state === 'invalid') return invalidObservation();
  if (validation.state === 'unsupported_factory') {
    return createExitLensFailure(
      'unsupported_factory_generation',
      'This pons factory generation is not supported.'
    );
  }
  if (validation.state === 'unsupported_decimals') {
    return createExitLensFailure(
      'unsupported_token_decimals',
      'This lens reads only 18-decimal pons tokens.'
    );
  }
  if (validation.state === 'unsupported') {
    return createExitLensFailure(
      'unsupported_token',
      'This is not a supported token in this recorded pons observation.'
    );
  }
  if (validation.state === 'missing_pool') {
    return createExitLensFailure(
      'missing_canonical_pool',
      'The canonical pool is unavailable in this recorded observation.',
      'unavailable'
    );
  }
  if (validation.state === 'no_liquidity') {
    return createExitLensFailure(
      'no_usable_liquidity',
      'The canonical pool has no usable liquidity in this recorded observation.',
      'unavailable',
      'unavailable',
      validation.context
    );
  }

  const amountBaseUnits = parseUnits(amount, observations.token.decimals);
  if (amountBaseUnits === null) {
    return createExitLensFailure('invalid_amount', 'The token amount is invalid.');
  }

  if (amountBaseUnits > BigInt(observations.token.total_supply_base_units)) {
    return createExitLensFailure(
      'amount_exceeds_supply',
      'The token amount exceeds the recorded token supply.'
    );
  }

  const quote = observations.quotes.find((candidate) => (
    candidate.input_amount_base_units === amountBaseUnits.toString()
  ));
  const resultContext = quote
    ? {
        ...validation.context,
        sources: {
          ...validation.context.sources,
          quote: quote.source
        }
      }
    : validation.context;

  if (observations.observation.freshness === 'stale') {
    return createExitLensFailure(
      'stale_observation',
      'The recorded observation is stale.',
      'stale',
      'stale',
      resultContext
    );
  }

  const sqrtPriceX96 = BigInt(observations.pool.sqrt_price_x96);
  const squaredPrice = sqrtPriceX96 * sqrtPriceX96;
  const spotNumerator = observations.token.is_token0
    ? amountBaseUnits * squaredPrice
    : amountBaseUnits * Q192;
  const spotDenominator = observations.token.is_token0
    ? Q192
    : squaredPrice;
  const spotMarkedWei = spotNumerator / spotDenominator;
  const spotMarkedValue = {
    state: 'available',
    amount_wei: spotMarkedWei.toString(),
    display: formatUnits(spotMarkedWei, 18)
  };

  if (!quote) {
    return createExitLensFailure(
      'quote_unavailable',
      'The exit quote is unavailable for this recorded amount.',
      {
        spot_marked: spotMarkedValue,
        exit_quote: 'unavailable',
        realization_gap: 'unknown'
      },
      'unavailable',
      resultContext
    );
  }

  const exitQuoteWei = BigInt(quote.output_amount_wei);
  const gapWei = spotMarkedWei - exitQuoteWei;
  const gapNumerator = spotNumerator - exitQuoteWei * spotDenominator;
  const gapBps = roundRatio(gapNumerator * 10_000n, spotNumerator);

  return {
    status: 'available',
    factory: validation.context.factory,
    token: {
      address: observations.token.address,
      name: observations.token.name,
      symbol: observations.token.symbol,
      decimals: observations.token.decimals,
      amount,
      amount_base_units: amountBaseUnits.toString()
    },
    pool: validation.context.pool,
    observation: validation.context.observation,
    values: {
      spot_marked: spotMarkedValue,
      exit_quote: {
        state: 'available',
        amount_wei: exitQuoteWei.toString(),
        display: formatUnits(exitQuoteWei, 18),
        source: quote.source,
        source_address: quote.source_address
      },
      realization_gap: {
        state: 'available',
        amount_wei: gapWei.toString(),
        display: formatUnits(gapWei, 18),
        percentage_state: 'available',
        percentage_bps: gapBps.toString(),
        percentage: formatUnits(gapBps, 2)
      }
    },
    sources: {
      ...resultContext.sources
    },
    evidence_urls: validation.context.evidence_urls
  };
}
