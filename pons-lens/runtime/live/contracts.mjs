import { ROBINHOOD_CHAIN } from '../lib/robinhood-chain.mjs';

const HEX = /^0x[0-9a-fA-F]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD_HEX_LENGTH = 64;

export const CONTRACTS = Object.freeze({
  chainId: BigInt(ROBINHOOD_CHAIN.chainId),
  weth: ROBINHOOD_CHAIN.weth,
  v3Factory: ROBINHOOD_CHAIN.v3Factory,
  quoterV2: ROBINHOOD_CHAIN.quoterV2,
  poolFee: BigInt(ROBINHOOD_CHAIN.poolFee),
  factories: ROBINHOOD_CHAIN.factories
});

export const SELECTORS = Object.freeze({
  getLaunchedToken: '0x3cf28b5a',
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
  liquidityPool: '0x665a11ca',
  getPool: '0x1698ee82',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  liquidity: '0x1a686502',
  slot0: '0x3850c7bd',
  quoteExactInputSingle: '0xc6a5026a'
});

export class LiveObservationError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LiveObservationError';
    this.code = code;
  }
}

function malformed(message) {
  throw new LiveObservationError('malformed_rpc_response', message);
}

export function normalizeAddress(value) {
  return typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : null;
}

function word(value, bits = 256) {
  if (typeof value !== 'bigint' || value < 0n || value >= (1n << BigInt(bits))) {
    throw new TypeError(`ABI integer must fit uint${bits}`);
  }
  return value.toString(16).padStart(WORD_HEX_LENGTH, '0');
}

function addressWord(value) {
  const normalized = normalizeAddress(value);
  if (!normalized) throw new LiveObservationError('invalid_token_address', 'The token address is invalid.');
  return normalized.slice(2).padStart(WORD_HEX_LENGTH, '0');
}

export function encodeAddressCall(selector, address) {
  return `${selector}${addressWord(address)}`;
}

export function encodeUintCall(selector, value) {
  return `${selector}${word(BigInt(value))}`;
}

export function encodeGetPool(token, pairedToken, fee) {
  return `${SELECTORS.getPool}${addressWord(token)}${addressWord(pairedToken)}${word(fee)}`;
}

export function encodeQuote(token, pairedToken, amountIn, fee) {
  return `${SELECTORS.quoteExactInputSingle}${addressWord(token)}${addressWord(pairedToken)}${word(amountIn)}${word(fee)}${word(0n)}`;
}

function body(value) {
  if (typeof value !== 'string' || !HEX.test(value) || value.length < 2 || value.length % 2 !== 0) {
    malformed('RPC returned malformed ABI hex.');
  }
  return value.slice(2);
}

function words(value, minimum) {
  const data = body(value);
  if (data.length < minimum * WORD_HEX_LENGTH || data.length % WORD_HEX_LENGTH !== 0) {
    malformed('RPC returned a truncated ABI result.');
  }
  return Array.from(
    { length: data.length / WORD_HEX_LENGTH },
    (_, index) => data.slice(index * WORD_HEX_LENGTH, (index + 1) * WORD_HEX_LENGTH)
  );
}

function exactWords(value, count) {
  const decoded = words(value, count);
  if (decoded.length !== count) malformed('RPC returned an ABI result with trailing words.');
  return decoded;
}

function uintFromWord(value, bits = 256, label = `uint${bits}`) {
  const decoded = BigInt(`0x${value}`);
  if (decoded >= (1n << BigInt(bits))) {
    malformed(`RPC returned an out-of-range ${label}.`);
  }
  return decoded;
}

function addressFromWord(value) {
  if (!/^0{24}/.test(value)) malformed('RPC returned a non-canonical address word.');
  const address = `0x${value.slice(-40)}`;
  return normalizeAddress(address) ?? malformed('RPC returned an invalid address word.');
}

function boolFromWord(value) {
  const decoded = uintFromWord(value);
  if (decoded !== 0n && decoded !== 1n) malformed('RPC returned an invalid boolean word.');
  return decoded === 1n;
}

export function decodeUint(value, bits = 256, label = `uint${bits}`) {
  return uintFromWord(exactWords(value, 1)[0], bits, label);
}

export function decodeAddress(value) {
  return addressFromWord(exactWords(value, 1)[0]);
}

export function decodeString(value) {
  const data = body(value);
  if (data.length < WORD_HEX_LENGTH * 2) malformed('RPC returned a truncated string result.');
  const offset = Number(uintFromWord(data.slice(0, WORD_HEX_LENGTH)));
  if (!Number.isSafeInteger(offset) || offset !== 32) malformed('RPC returned an invalid string offset.');
  const lengthOffset = offset * 2;
  if (lengthOffset + WORD_HEX_LENGTH > data.length) malformed('RPC returned an invalid string offset.');
  const length = Number(uintFromWord(data.slice(lengthOffset, lengthOffset + WORD_HEX_LENGTH)));
  if (!Number.isSafeInteger(length)) malformed('RPC returned an oversized string.');
  const stringStart = lengthOffset + WORD_HEX_LENGTH;
  const stringEnd = stringStart + length * 2;
  if (stringEnd > data.length) malformed('RPC returned a truncated string.');
  const expectedEnd = stringStart + Math.ceil(length / 32) * WORD_HEX_LENGTH;
  if (data.length !== expectedEnd || /[^0]/.test(data.slice(stringEnd))) {
    malformed('RPC returned a non-canonical string result.');
  }
  try {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Number.parseInt(data.slice(stringStart + index * 2, stringStart + index * 2 + 2), 16);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes
    );
  } catch (error) {
    throw new LiveObservationError('malformed_rpc_response', 'RPC returned invalid UTF-8 metadata.', error);
  }
}

export function decodeLaunch(value) {
  const decoded = exactWords(value, 13);
  return {
    token: addressFromWord(decoded[0]),
    deployer: addressFromWord(decoded[1]),
    pairedToken: addressFromWord(decoded[2]),
    positionManager: addressFromWord(decoded[3]),
    positionId: uintFromWord(decoded[4]),
    dexId: uintFromWord(decoded[5]),
    launchConfigId: uintFromWord(decoded[6]),
    restrictionsEndBlock: uintFromWord(decoded[7]),
    supply: uintFromWord(decoded[8]),
    isToken0: boolFromWord(decoded[9]),
    poolFee: uintFromWord(decoded[10], 24, 'pool fee'),
    exists: boolFromWord(decoded[11]),
    initialBuyAmount: uintFromWord(decoded[12])
  };
}

export function decodeSlot0(value) {
  const decoded = exactWords(value, 7);
  return {
    sqrtPriceX96: uintFromWord(decoded[0], 160, 'sqrtPriceX96'),
    unlocked: boolFromWord(decoded[6])
  };
}

export function decodeQuote(value) {
  const decoded = exactWords(value, 4);
  const quote = {
    amountOut: uintFromWord(decoded[0]),
    sqrtPriceX96After: uintFromWord(decoded[1], 160, 'sqrtPriceX96After'),
    initializedTicksCrossed: uintFromWord(decoded[2], 32, 'initializedTicksCrossed'),
    gasEstimate: uintFromWord(decoded[3])
  };
  if (quote.sqrtPriceX96After === 0n) {
    malformed('RPC returned an impossible zero post-quote price.');
  }
  return quote;
}
