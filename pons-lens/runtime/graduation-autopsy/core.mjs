export const ACTIVE = Object.freeze({
  chainId: '4663', token: '0xb1f161a45e9f745412e5b10407463fb3fc7e46f9', statusTarget: '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb', selector: '0x98d652f1', threshold: '4200000000000000000', launchTime: '2026-07-23T00:07:39.000Z'
});

const launch = { transactionHash: '0x1303594f76dd57827434e6e2ddc36839e1d0cc1b06b6931af3b3a88f1b344ebf', blockNumber: '16844159', blockHash: '0x1178f578e6a239bce284285c1dd75573fb576779349fb5fa44127de2b5c0d8e0', initialBuy: '30000000000000000', blockTime: ACTIVE.launchTime, factory: ACTIVE.statusTarget, locker: '0x736d76699c26d0d966744cae304c000d471f7f35', pool: '0x5b5ed5ea70a4d226e1850e0e5ba94eaaf3d9b418', positionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3', positionId: '326508' };
const raw = (principal, graduated = false) => `0x${BigInt(principal).toString(16).padStart(64, '0')}${BigInt(ACTIVE.threshold).toString(16).padStart(64, '0')}${graduated ? '1'.padStart(64, '0') : '0'.padStart(64, '0')}`;
const observation = (blockNumber, blockHash, blockTime, pairedPrincipal) => ({ token: ACTIVE.token, target: ACTIVE.statusTarget, selector: ACTIVE.selector, calldata: `${ACTIVE.selector}${ACTIVE.token.slice(2).padStart(64, '0')}`, chainId: ACTIVE.chainId, blockTag: `0x${BigInt(blockNumber).toString(16)}`, blockNumber, blockHash, blockTime, rawReturn: raw(pairedPrincipal), sourceLocator: `https://robinhoodchain.blockscout.com/block/${blockNumber}`, retrieval: { method: 'eth_call', retrievedAt: blockTime, blockHashPinned: true }, abiDigest: '571a59cd7f32b5a82a34d37e5314dc8bd731229b2e5c4435d380fc4b97cbfe68' });
export const RECORDED = Object.freeze({ launch, observations: Object.freeze([
  observation('16844159', '0x1178f578e6a239bce284285c1dd75573fb576779349fb5fa44127de2b5c0d8e0', '2026-07-23T00:07:39.000Z', '29699999999999999'),
  observation('16880055', '0x41be52fe17a15796823daa0cff60dbb779c0560f080245e65974ce637008d22a', '2026-07-23T01:07:39.000Z', '384976015624844197'),
  observation('17706019', '0x7bd11364a2c48fe4e0fc6746532223e6d071cb0031c098f9b2eb280be74ea955', '2026-07-24T00:07:39.000Z', '460801873350026010'),
  observation('18838223', '0x4c9bc8129a97c6f727786fc79078e84ffa5931d5506dbb73f3e744f0ad044e3f', '2026-07-25T07:41:02.000Z', '1109486051095723301')
]) });

export function decodeStatus(rawReturn) {
  if (typeof rawReturn !== 'string' || !/^0x[0-9a-f]{192}$/i.test(rawReturn) || rawReturn.length !== 194) throw Error('malformed_status');
  const pairedPrincipal = BigInt(`0x${rawReturn.slice(2, 66)}`); const threshold = BigInt(`0x${rawReturn.slice(66, 130)}`); const isGraduated = BigInt(`0x${rawReturn.slice(130, 194)}`);
  if (isGraduated !== 0n && isGraduated !== 1n || (isGraduated === 1n) !== (pairedPrincipal >= threshold)) throw Error('malformed_status');
  return { pairedPrincipal: pairedPrincipal.toString(), threshold: threshold.toString(), isGraduated: isGraduated === 1n };
}
export const blockscout = block => `https://robinhoodchain.blockscout.com/block/${block}`;
export function crossing(observations) {
  for (let index = 1; index < observations.length; index += 1) {
    const lowerObservation = observations[index - 1];
    const upperObservation = observations[index];
    const lowerStatus = decodeStatus(lowerObservation.rawReturn);
    const upperStatus = decodeStatus(upperObservation.rawReturn);

    if (!lowerStatus.isGraduated && upperStatus.isGraduated) {
      return {
        valueState: 'derived',
        lowerObservation,
        upperObservation,
        statement: 'crossing may be bracketed; first-ever crossing is not proven'
      };
    }
  }

  return null;
}
export function evaluateRecorded({ now = new Date().toISOString(), observations = RECORDED.observations } = {}) {
  const current = decodeStatus(observations.at(-1).rawReturn); const bracket = crossing(observations); const plus7d = new Date(Date.parse(ACTIVE.launchTime) + 7 * 86400_000).toISOString();
  return { launch: RECORDED.launch, observations, current: { ...current, status: current.isGraduated ? 'above_threshold' : 'below_threshold' }, crossing: bracket ? 'bracketed' : 'none_observed', bracket, outcomes: { graduationBlock: 'unavailable', graduationTime: 'unavailable', timeToGraduation: 'unavailable', postGraduationRetention: 'not_applicable_yet', plus7d: Date.parse(now) < Date.parse(plus7d) ? 'future_horizon' : 'unavailable' } };
}
