import { evaluateExitLens } from '../lib/evaluate.mjs';
import {
  CONTRACTS,
  LiveObservationError,
  decodeAddress,
  decodeQuote,
  decodeUint,
  encodeAddressCall,
  encodeQuote,
  encodeUintCall,
  normalizeAddress
} from './contracts.mjs';
import {
  exitObservationFromContext,
  readRpcBatch,
  requiredRpcResult,
  resolveTokenContext,
  validateContextBlock
} from './context.mjs';

const HUMAN_AMOUNT = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;
const PRESETS = Object.freeze([
  Object.freeze({ id: 'small', label: '0.1% of supply', numerator: 1n, denominator: 1000n }),
  Object.freeze({ id: 'medium', label: '1% of supply', numerator: 1n, denominator: 100n }),
  Object.freeze({ id: 'large', label: '5% of supply', numerator: 1n, denominator: 20n })
]);
const SECTION_KEYS = ['exit_ladder', 'lp_custody', 'fee_split_redirect', 'graduation_restrictions'];

function unavailableSection(code, message, extra = {}) {
  return {
    state: 'unavailable',
    failure: { code, message },
    ...extra
  };
}

function unavailableDossier(tokenAddress, code, message, context) {
  return {
    schema_version: 1,
    status: 'unavailable',
    token_address: normalizeAddress(tokenAddress) ?? null,
    failure: { code, message },
    ...(context ? { context } : {}),
    sections: Object.fromEntries(
      SECTION_KEYS.map((key) => [
        key,
        unavailableSection(code, 'This section has no verified current evidence.')
      ])
    )
  };
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
  const digits = value.toString().padStart(decimals + 1, '0');
  const whole = decimals === 0 ? digits : digits.slice(0, -decimals);
  const fraction = decimals === 0 ? '' : digits.slice(-decimals).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

function quotePlans(context, customAmount) {
  const supply = BigInt(context.token.total_supply_base_units);
  const plans = PRESETS.map((preset) => {
    const amount = supply * preset.numerator / preset.denominator;
    return {
      id: preset.id,
      label: preset.label,
      amount,
      human_amount: formatUnits(amount, context.token.decimals),
      preset: true
    };
  });
  if (customAmount !== undefined && String(customAmount).trim() !== '') {
    const value = String(customAmount).trim();
    const amount = parseUnits(value, context.token.decimals);
    plans.push({
      id: 'custom',
      label: 'Custom amount',
      amount,
      human_amount: value,
      preset: false
    });
  }
  return plans;
}

function addRead(reads, label, method, params) {
  reads.push({ label, method, params });
}

function resultMap(reads, results) {
  return new Map(reads.map((read, index) => [read.label, results[index]]));
}

function availableQuote(context, plan, rawResult) {
  if (plan.amount === null) {
    return unavailableSection(
      'invalid_custom_amount',
      'The custom amount is invalid.',
      { id: plan.id, label: plan.label, human_amount: plan.human_amount }
    );
  }
  if (plan.amount > BigInt(context.token.total_supply_base_units)) {
    return unavailableSection(
      'amount_exceeds_supply',
      'The custom amount exceeds token supply.',
      { id: plan.id, label: plan.label, human_amount: plan.human_amount }
    );
  }
  if (rawResult instanceof Error) {
    return unavailableSection(
      'quote_unavailable',
      'The current quote is unavailable.',
      { id: plan.id, label: plan.label, human_amount: plan.human_amount }
    );
  }
  try {
    const quote = decodeQuote(rawResult);
    const observations = exitObservationFromContext(context, [{
      state: 'available',
      token_in: context.token.address,
      token_out: normalizeAddress(CONTRACTS.weth),
      chain_id: context.chain_id,
      pool_address: context.pool.address,
      block_number: context.observation.block_number,
      block_hash: context.observation.block_hash,
      observed_at: context.observation.observed_at,
      input_amount_base_units: plan.amount.toString(),
      output_amount_wei: quote.amountOut.toString(),
      source: 'Uniswap V3 Quoter V2',
      source_address: normalizeAddress(CONTRACTS.quoterV2)
    }]);
    const evaluated = evaluateExitLens({
      tokenAddress: context.token.address,
      amount: plan.human_amount,
      observations
    });
    if (evaluated.status !== 'available') {
      return unavailableSection(
        evaluated.failure?.code ?? 'quote_unavailable',
        evaluated.failure?.message ?? 'The current quote is unavailable.',
        { id: plan.id, label: plan.label, human_amount: plan.human_amount }
      );
    }
    return {
      state: 'available',
      id: plan.id,
      label: plan.label,
      human_amount: plan.human_amount,
      amount_base_units: plan.amount.toString(),
      spot_marked_weth: evaluated.values.spot_marked.display,
      exit_quote_weth: evaluated.values.exit_quote.display,
      realization_gap_percent: evaluated.values.realization_gap.display
    };
  } catch {
    return unavailableSection(
      'quote_unavailable',
      'The current quote is malformed or unavailable.',
      { id: plan.id, label: plan.label, human_amount: plan.human_amount }
    );
  }
}

async function sha256Bytecode(bytecode) {
  if (typeof bytecode !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(bytecode)) {
    throw new TypeError('malformed_bytecode');
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(bytecode.toLowerCase())
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function mechanicsIdentity(context, byLabel, hashBytecode) {
  try {
    const [factoryHash, lockerHash] = await Promise.all([
      hashBytecode(requiredRpcResult(byLabel.get('code:factory'))),
      hashBytecode(requiredRpcResult(byLabel.get('code:locker')))
    ]);
    const resolvedLocker = decodeAddress(requiredRpcResult(byLabel.get('mechanics:locker')));
    return {
      verified: factoryHash === context.generation.expected_code_identities.factory.digest
        && lockerHash === context.generation.expected_code_identities.locker.digest
        && resolvedLocker === context.generation.locker,
      resolved_locker: resolvedLocker
    };
  } catch {
    return { verified: false, resolved_locker: null };
  }
}

function lpCustodySection(context, byLabel, identity) {
  if (!context.generation.supported_features.includes('lp_custody')) {
    return unavailableSection(
      'generation_feature_unavailable',
      'LP custody mechanics are not verified for this generation.'
    );
  }
  try {
    const owner = decodeAddress(requiredRpcResult(byLabel.get('lp:owner')));
    if (!identity.verified || owner !== identity.resolved_locker) {
      throw new Error('custody_mismatch');
    }
    return {
      state: 'available',
      statement: `Pons-locked at block ${context.observation.block_number}.`,
      position_id: context.launch.position_id,
      position_manager: context.launch.position_manager,
      locker: identity.resolved_locker,
      owner,
      block_number: context.observation.block_number,
      block_hash: context.observation.block_hash
    };
  } catch {
    return unavailableSection(
      'lp_custody_unverified',
      'Current LP custody could not be verified.'
    );
  }
}

function feeSplitSection(context, byLabel, identity) {
  if (!context.generation.supported_features.includes('fee_split_redirect')) {
    return unavailableSection(
      'generation_feature_unavailable',
      'Fee split and redirect mechanics are not verified for this generation.'
    );
  }
  try {
    const protocol = decodeUint(requiredRpcResult(byLabel.get('fee:protocol_share')));
    const redirect = decodeAddress(requiredRpcResult(byLabel.get('fee:redirect')));
    if (!identity.verified || protocol > 100n) throw new Error('fee_mechanics_mismatch');
    return {
      state: 'available',
      protocol_share_percent: protocol.toString(),
      creator_share_percent: (100n - protocol).toString(),
      redirect,
      token_snapshot_selector: context.generation.selectors.tokenProtocolFeeShares,
      redirect_selector: context.generation.selectors.feeRedirects,
      block_number: context.observation.block_number,
      block_hash: context.observation.block_hash
    };
  } catch {
    return unavailableSection(
      'fee_split_redirect_unverified',
      'Current fee split or redirect evidence is unavailable.'
    );
  }
}

function restrictions(context) {
  const head = BigInt(context.observation.block_number);
  const end = BigInt(context.launch.restrictions_end_block);
  return {
    state: 'available',
    end_block: end.toString(),
    horizon: head < end ? 'active' : 'ended',
    blocks_remaining: head < end ? (end - head).toString() : '0'
  };
}

function decodeGraduationStatus(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{192}$/.test(value)) {
    throw new Error('malformed_graduation_status');
  }
  const words = [0, 1, 2].map((index) => (
    BigInt(`0x${value.slice(2 + index * 64, 66 + index * 64)}`)
  ));
  if (words[2] !== 0n && words[2] !== 1n) {
    throw new Error('malformed_graduation_status');
  }
  const isGraduated = words[2] === 1n;
  const headroom = words[0] < words[1] ? words[1] - words[0] : 0n;
  return {
    state: 'available',
    paired_principal_wei: words[0].toString(),
    threshold_wei: words[1].toString(),
    headroom_wei: headroom.toString(),
    is_graduated: isGraduated,
    dynamic_and_reversible: true,
    ...(
      isGraduated === (words[0] >= words[1])
        ? {}
        : {
            annotation: isGraduated
              ? 'graduated_flag_latched_below_threshold'
              : 'above_threshold_without_graduated_flag'
          }
    )
  };
}

function graduationSection(context, byLabel) {
  const restrictionEvidence = restrictions(context);
  if (!context.generation.supported_features.includes('graduation_status')) {
    return unavailableSection(
      'generation_feature_unavailable',
      'Graduation status is not verified for this generation.',
      {
        graduation: { state: 'unavailable' },
        restrictions: restrictionEvidence
      }
    );
  }
  try {
    return {
      state: 'available',
      graduation: decodeGraduationStatus(requiredRpcResult(byLabel.get('graduation:status'))),
      restrictions: restrictionEvidence,
      block_number: context.observation.block_number,
      block_hash: context.observation.block_hash
    };
  } catch {
    return unavailableSection(
      'graduation_status_unavailable',
      'Current graduation status is unavailable.',
      {
        graduation: { state: 'unavailable' },
        restrictions: restrictionEvidence
      }
    );
  }
}

export async function buildCurrentDossier({
  tokenAddress,
  customAmount,
  request,
  now,
  maxAgeSeconds,
  hashBytecode = sha256Bytecode
}) {
  let context;
  try {
    context = await resolveTokenContext({
      tokenAddress,
      request,
      ...(now ? { now } : {}),
      ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds })
    });
  } catch (error) {
    if (!(error instanceof LiveObservationError)) throw error;
    return unavailableDossier(tokenAddress, error.code, error.message);
  }
  if (context.observation.freshness !== 'fresh') {
    return unavailableDossier(
      tokenAddress,
      'stale_observation',
      'The pinned chain head is stale, so no current dossier claim is available.',
      context
    );
  }

  const plans = quotePlans(context, customAmount);
  const reads = [];
  for (const plan of plans) {
    if (plan.amount === null || plan.amount > BigInt(context.token.total_supply_base_units)) continue;
    addRead(
      reads,
      `quote:${plan.id}`,
      'eth_call',
      [{
        to: CONTRACTS.quoterV2,
        data: encodeQuote(
          context.token.address,
          CONTRACTS.weth,
          plan.amount,
          CONTRACTS.poolFee
        )
      }, context.observation.block_tag]
    );
  }

  const supportsMechanics = context.generation.supported_features.includes('lp_custody')
    || context.generation.supported_features.includes('fee_split_redirect');
  if (supportsMechanics) {
    addRead(
      reads,
      'code:factory',
      'eth_getCode',
      [context.generation.factory, context.observation.block_tag]
    );
    addRead(
      reads,
      'code:locker',
      'eth_getCode',
      [context.generation.locker, context.observation.block_tag]
    );
    addRead(
      reads,
      'mechanics:locker',
      'eth_call',
      [{
        to: context.generation.factory,
        data: context.generation.selectors.locker
      }, context.observation.block_tag]
    );
  }
  if (context.generation.supported_features.includes('lp_custody')) {
    addRead(
      reads,
      'lp:owner',
      'eth_call',
      [{
        to: context.launch.position_manager,
        data: encodeUintCall(
          context.generation.selectors.ownerOf,
          context.launch.position_id
        )
      }, context.observation.block_tag]
    );
  }
  if (context.generation.supported_features.includes('fee_split_redirect')) {
    addRead(
      reads,
      'fee:protocol_share',
      'eth_call',
      [{
        to: context.generation.locker,
        data: encodeAddressCall(
          context.generation.selectors.tokenProtocolFeeShares,
          context.token.address
        )
      }, context.observation.block_tag]
    );
    addRead(
      reads,
      'fee:redirect',
      'eth_call',
      [{
        to: context.generation.locker,
        data: encodeAddressCall(
          context.generation.selectors.feeRedirects,
          context.token.address
        )
      }, context.observation.block_tag]
    );
  }
  if (context.generation.supported_features.includes('graduation_status')) {
    addRead(
      reads,
      'graduation:status',
      'eth_call',
      [{
        to: context.generation.factory,
        data: encodeAddressCall(
          context.generation.selectors.graduationStatus,
          context.token.address
        )
      }, context.observation.block_tag]
    );
  }
  addRead(
    reads,
    'confirmation',
    'eth_getBlockByNumber',
    [context.observation.block_tag, false]
  );

  let byLabel;
  try {
    const results = await readRpcBatch(
      request,
      reads.map(({ method, params }) => ({ method, params }))
    );
    byLabel = resultMap(reads, results);
    const confirmed = validateContextBlock(
      requiredRpcResult(byLabel.get('confirmation')),
      context.observation.block_tag
    );
    if (confirmed.hash.toLowerCase() !== context.observation.block_hash) {
      throw new LiveObservationError(
        'reorg_detected',
        'The observation block changed during dossier reads.'
      );
    }
  } catch (error) {
    if (error instanceof LiveObservationError) {
      return unavailableDossier(tokenAddress, error.code, error.message, context);
    }
    throw error;
  }

  const rows = plans.map((plan) => (
    availableQuote(context, plan, byLabel.get(`quote:${plan.id}`))
  ));
  const presetRows = rows.filter((row) => row.id !== 'custom');
  const exitLadder = presetRows.every((row) => row.state === 'available')
    ? {
        state: 'available',
        rows,
        source: 'Uniswap V3 Quoter V2',
        block_number: context.observation.block_number,
        block_hash: context.observation.block_hash
      }
    : unavailableSection(
        'exit_ladder_incomplete',
        'One or more preset exit quotes are unavailable.',
        { rows }
      );

  const identity = supportsMechanics
    ? await mechanicsIdentity(context, byLabel, hashBytecode)
    : { verified: false, resolved_locker: null };

  return {
    schema_version: 1,
    status: 'available',
    token_address: context.token.address,
    context,
    sections: {
      exit_ladder: exitLadder,
      lp_custody: lpCustodySection(context, byLabel, identity),
      fee_split_redirect: feeSplitSection(context, byLabel, identity),
      graduation_restrictions: graduationSection(context, byLabel)
    }
  };
}
