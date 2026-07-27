import {
  CONTRACTS,
  LiveObservationError,
  SELECTORS,
  decodeAddress,
  decodeLaunch,
  decodeSlot0,
  decodeString,
  decodeUint,
  encodeAddressCall,
  encodeGetPool,
  normalizeAddress
} from './contracts.mjs';

const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const CLOCK_SKEW_TOLERANCE_SECONDS = 300;

export function parseRpcQuantity(value, label) {
  if (typeof value !== 'string' || !HEX_QUANTITY.test(value)) {
    throw new LiveObservationError('malformed_rpc_response', `RPC returned an invalid ${label}.`);
  }
  return BigInt(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateContextBlock(value, expectedNumber) {
  if (!isRecord(value)
    || typeof value.number !== 'string'
    || !HEX_QUANTITY.test(value.number)
    || BigInt(value.number) !== BigInt(expectedNumber)
    || typeof value.hash !== 'string'
    || !BLOCK_HASH.test(value.hash)) {
    throw new LiveObservationError('malformed_rpc_response', 'RPC returned an invalid observation block.');
  }
  return value;
}

async function rpcRequest(request, method, params) {
  try {
    return await request(method, params);
  } catch (error) {
    if (error instanceof LiveObservationError || error instanceof TypeError) throw error;
    throw new LiveObservationError('rpc_failure', `Robinhood Chain RPC failed during ${method}.`, error);
  }
}

export async function readRpcBatch(request, calls) {
  if (typeof request.batch !== 'function') {
    const results = [];
    for (const { method, params } of calls) {
      try {
        results.push(await rpcRequest(request, method, params));
      } catch (error) {
        results.push(error);
      }
    }
    return results;
  }
  try {
    return await request.batch(calls);
  } catch (error) {
    if (error instanceof LiveObservationError || error instanceof TypeError) throw error;
    throw new LiveObservationError('rpc_failure', 'Robinhood Chain RPC batch failed.', error);
  }
}

export function requiredRpcResult(value) {
  if (value instanceof Error) throw value;
  return value;
}

export function requiredEthCallResult(value) {
  const result = requiredRpcResult(value);
  if (typeof result !== 'string' || result === '0x') {
    throw new LiveObservationError('malformed_rpc_response', 'RPC returned an empty contract-read result.');
  }
  return result;
}

async function resolveRemainingLaunch(request, factories, tokenAddress, blockTag) {
  if (factories.length === 0) {
    throw new LiveObservationError(
      'unsupported_token',
      'This token was not found in a supported pons factory.'
    );
  }
  const results = await readRpcBatch(
    request,
    factories.map((factory) => ({
      method: 'eth_call',
      params: [{
        to: factory.address,
        data: encodeAddressCall(factory.selectors.getLaunchedToken, tokenAddress)
      }, blockTag]
    }))
  );
  for (const [index, value] of results.entries()) {
    const launch = decodeLaunch(requiredEthCallResult(value));
    if (launch.exists) return { profile: factories[index], launch };
  }
  throw new LiveObservationError(
    'unsupported_token',
    'This token was not found in a supported pons factory.'
  );
}

function evidenceUrls(token, pool, factory, blockNumber) {
  return {
    pons: `https://www.ponsfamily.com/launchpad/${token}`,
    token: `https://robinhoodchain.blockscout.com/token/${token}`,
    pool: `https://robinhoodchain.blockscout.com/address/${pool}`,
    factory: `https://robinhoodchain.blockscout.com/address/${factory}`,
    block: `https://robinhoodchain.blockscout.com/block/${blockNumber}`
  };
}

function publicGenerationProfile(profile) {
  return {
    id: profile.generation,
    factory: normalizeAddress(profile.address),
    deployment_block: profile.deploymentBlock,
    locker: normalizeAddress(profile.locker),
    locker_deployment_block: profile.lockerDeploymentBlock,
    selectors: { ...profile.selectors },
    launch_event: {
      name: profile.launchEvent.name,
      topic0: profile.launchEvent.topic0,
      token_topic_index: profile.launchEvent.tokenTopicIndex
    },
    expected_code_identities: {
      factory: { ...profile.expectedCodeIdentities.factory },
      locker: { ...profile.expectedCodeIdentities.locker }
    },
    supported_features: [...profile.supportedFeatures]
  };
}

export async function resolveTokenContextWith({
  tokenAddress,
  request,
  now = () => new Date(),
  maxAgeSeconds = 300
}, extendPoolReads = () => []) {
  const token = normalizeAddress(tokenAddress);
  if (!token) throw new LiveObservationError('invalid_token_address', 'The token address is invalid.');
  if (typeof request !== 'function') {
    throw new TypeError('request must be a JSON-RPC request function');
  }

  const [chainIdResult, blockTagResult] = await readRpcBatch(request, [
    { method: 'eth_chainId', params: [] },
    { method: 'eth_blockNumber', params: [] }
  ]);
  const chainId = parseRpcQuantity(requiredRpcResult(chainIdResult), 'chain ID');
  if (chainId !== CONTRACTS.chainId) {
    throw new LiveObservationError('wrong_chain', 'RPC is not connected to Robinhood Chain.');
  }

  const blockTag = requiredRpcResult(blockTagResult);
  parseRpcQuantity(blockTag, 'block number');
  const firstProfile = CONTRACTS.factories[0];
  const discovery = await readRpcBatch(request, [
    { method: 'eth_getBlockByNumber', params: [blockTag, false] },
    {
      method: 'eth_call',
      params: [{
        to: firstProfile.address,
        data: encodeAddressCall(firstProfile.selectors.getLaunchedToken, token)
      }, blockTag]
    },
    { method: 'eth_call', params: [{ to: token, data: SELECTORS.name }, blockTag] },
    { method: 'eth_call', params: [{ to: token, data: SELECTORS.symbol }, blockTag] },
    { method: 'eth_call', params: [{ to: token, data: SELECTORS.decimals }, blockTag] },
    { method: 'eth_call', params: [{ to: token, data: SELECTORS.totalSupply }, blockTag] },
    { method: 'eth_call', params: [{ to: token, data: SELECTORS.liquidityPool }, blockTag] },
    {
      method: 'eth_call',
      params: [{
        to: CONTRACTS.v3Factory,
        data: encodeGetPool(token, CONTRACTS.weth, CONTRACTS.poolFee)
      }, blockTag]
    }
  ]);

  const block = validateContextBlock(requiredRpcResult(discovery[0]), blockTag);
  const blockNumber = parseRpcQuantity(block.number, 'block number');
  const blockTimestamp = parseRpcQuantity(block.timestamp, 'block timestamp');
  const observedAt = new Date(Number(blockTimestamp) * 1000);
  if (Number.isNaN(observedAt.getTime())) {
    throw new LiveObservationError('malformed_rpc_response', 'RPC returned an invalid observation time.');
  }
  const currentTime = now();
  if (!(currentTime instanceof Date) || Number.isNaN(currentTime.getTime())) {
    throw new TypeError('now must return a valid Date');
  }
  const clockOffsetMs = currentTime.getTime() - observedAt.getTime();
  if (clockOffsetMs < -CLOCK_SKEW_TOLERANCE_SECONDS * 1000) {
    throw new LiveObservationError(
      'clock_skew',
      'This device clock is behind Robinhood Chain block time, so freshness cannot be judged.'
    );
  }
  const freshness = clockOffsetMs > (maxAgeSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) * 1000
    ? 'stale'
    : 'fresh';

  const firstLaunch = decodeLaunch(requiredEthCallResult(discovery[1]));
  const { profile, launch } = firstLaunch.exists
    ? { profile: firstProfile, launch: firstLaunch }
    : await resolveRemainingLaunch(
      request,
      CONTRACTS.factories.slice(1),
      token,
      blockTag
    );
  const name = decodeString(requiredEthCallResult(discovery[2]));
  const symbol = decodeString(requiredEthCallResult(discovery[3]));
  const decimals = Number(decodeUint(
    requiredEthCallResult(discovery[4]),
    8,
    'token decimals'
  ));
  const totalSupply = decodeUint(requiredEthCallResult(discovery[5]));
  const tokenPool = decodeAddress(requiredEthCallResult(discovery[6]));
  const canonicalPool = decodeAddress(requiredEthCallResult(discovery[7]));
  if (tokenPool === '0x0000000000000000000000000000000000000000'
    || canonicalPool === '0x0000000000000000000000000000000000000000') {
    throw new LiveObservationError(
      'missing_canonical_pool',
      'The supported pons token has no canonical Uniswap V3 pool.'
    );
  }
  if (tokenPool !== canonicalPool) {
    throw new LiveObservationError(
      'spoofed_pool_relationship',
      'Token and Uniswap V3 factory disagree on the canonical pool.'
    );
  }

  const extraCalls = extendPoolReads({
    token,
    decimals,
    totalSupply,
    blockTag
  });
  if (!Array.isArray(extraCalls)) {
    throw new TypeError('extendPoolReads must return an array');
  }
  const poolResults = await readRpcBatch(request, [
    { method: 'eth_call', params: [{ to: canonicalPool, data: SELECTORS.token0 }, blockTag] },
    { method: 'eth_call', params: [{ to: canonicalPool, data: SELECTORS.token1 }, blockTag] },
    { method: 'eth_call', params: [{ to: canonicalPool, data: SELECTORS.liquidity }, blockTag] },
    { method: 'eth_call', params: [{ to: canonicalPool, data: SELECTORS.slot0 }, blockTag] },
    ...extraCalls,
    { method: 'eth_getBlockByNumber', params: [blockTag, false] }
  ]);
  const poolToken0 = decodeAddress(requiredEthCallResult(poolResults[0]));
  const poolToken1 = decodeAddress(requiredEthCallResult(poolResults[1]));
  const liquidity = decodeUint(requiredEthCallResult(poolResults[2]), 128, 'pool liquidity');
  const slot0 = decodeSlot0(requiredEthCallResult(poolResults[3]));
  const expectedToken0 = launch.isToken0 ? token : normalizeAddress(CONTRACTS.weth);
  const expectedToken1 = launch.isToken0 ? normalizeAddress(CONTRACTS.weth) : token;
  if (poolToken0 !== expectedToken0
    || poolToken1 !== expectedToken1
    || launch.token !== token
    || launch.pairedToken !== normalizeAddress(CONTRACTS.weth)
    || launch.poolFee !== CONTRACTS.poolFee
    || launch.supply !== totalSupply) {
    throw new LiveObservationError(
      'spoofed_pool_relationship',
      'The recorded pons launch and canonical pool relationship is inconsistent.'
    );
  }

  const confirmedBlock = validateContextBlock(requiredRpcResult(poolResults.at(-1)), blockTag);
  if (confirmedBlock.hash.toLowerCase() !== block.hash.toLowerCase()) {
    throw new LiveObservationError(
      'reorg_detected',
      'The observation block changed while contract reads were in progress.'
    );
  }

  const factoryAddress = normalizeAddress(profile.address);
  const poolAddress = normalizeAddress(canonicalPool);
  const context = {
    schema_version: 1,
    chain_id: chainId.toString(),
    generation: publicGenerationProfile(profile),
    launch: {
      token: launch.token,
      deployer: launch.deployer,
      paired_token: launch.pairedToken,
      position_manager: launch.positionManager,
      position_id: launch.positionId.toString(),
      dex_id: launch.dexId.toString(),
      launch_config_id: launch.launchConfigId.toString(),
      restrictions_end_block: launch.restrictionsEndBlock.toString(),
      supply_base_units: launch.supply.toString(),
      is_token0: launch.isToken0,
      pool_fee: launch.poolFee.toString(),
      exists: launch.exists,
      initial_buy_amount_wei: launch.initialBuyAmount.toString()
    },
    token: {
      address: token,
      name,
      symbol,
      decimals,
      total_supply_base_units: totalSupply.toString(),
      paired_token: normalizeAddress(CONTRACTS.weth),
      liquidity_pool: poolAddress
    },
    pool: {
      address: poolAddress,
      token0: poolToken0,
      token1: poolToken1,
      sqrt_price_x96: slot0.sqrtPriceX96.toString(),
      liquidity: liquidity.toString(),
      state: liquidity === 0n || !slot0.unlocked ? 'unavailable' : 'available'
    },
    observation: {
      block_tag: blockTag,
      block_number: blockNumber.toString(),
      block_hash: block.hash.toLowerCase(),
      observed_at: observedAt.toISOString(),
      freshness
    },
    evidence_urls: evidenceUrls(
      token,
      poolAddress,
      factoryAddress,
      blockNumber.toString()
    )
  };
  return {
    context,
    extra_results: poolResults.slice(4, -1)
  };
}

export async function resolveTokenContext(input) {
  const { context } = await resolveTokenContextWith(input);
  return context;
}

export function exitObservationFromContext(context, quotes = []) {
  return {
    schema_version: 1,
    chain_id: context.chain_id,
    factory: {
      address: context.generation.factory,
      generation: context.generation.id,
      launch_exists: true,
      source: `pons ${context.generation.id} factory getLaunchedToken`
    },
    token: {
      address: context.token.address,
      name: context.token.name,
      symbol: context.token.symbol,
      decimals: context.token.decimals,
      total_supply_base_units: context.token.total_supply_base_units,
      paired_token: context.token.paired_token,
      liquidity_pool: context.pool.address,
      is_token0: context.launch.is_token0,
      pool_fee: context.launch.pool_fee
    },
    pool: {
      address: context.pool.address,
      token0: context.pool.token0,
      token1: context.pool.token1,
      sqrt_price_x96: context.pool.sqrt_price_x96,
      liquidity: context.pool.liquidity,
      state: context.pool.state,
      source: 'canonical Uniswap V3 pool slot0'
    },
    observation: {
      block_number: context.observation.block_number,
      block_hash: context.observation.block_hash,
      observed_at: context.observation.observed_at,
      freshness: context.observation.freshness
    },
    quotes,
    evidence_urls: { ...context.evidence_urls }
  };
}
