import { ACTIVE, buildFeeLedger, digest, evidenceUrls } from './core.mjs';

const HEX = value => `0x${BigInt(value).toString(16)}`;
const word = value => (typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.slice(2) : BigInt(value).toString(16)).padStart(64, '0');
const selector = (id, ...values) => `0x${id}${values.map(word).join('')}`;
const EXPECTED = Object.freeze({ locker: '0435c0624330dd5488860aa53c9228af0d49289cfb10cf1f17cc7a7f79b497f8', factory: '22d0b4a1c81871e657494c418f002cba04134b7a67c05a45f53d87c7a9398fb9' });
const calls = Object.freeze([['factory.locker',ACTIVE.factory,'0xd7b96d4e'],['locker.feeRedirects',ACTIVE.locker,selector('dce780c2',ACTIVE.token)],['locker.protocolFeeRecipient',ACTIVE.locker,'0x64df049e'],['locker.protocolFeeShare',ACTIVE.locker,'0x960b26a2'],['locker.tokenProtocolFeeShares',ACTIVE.locker,selector('f1c8f3c0',ACTIVE.token)],['factory.getLaunchedToken',ACTIVE.factory,selector('3cf28b5a',ACTIVE.token)],['v3Factory.getPool',ACTIVE.v3Factory,selector('1698ee82',ACTIVE.weth,ACTIVE.token,'10000')],['positionManager.ownerOf',ACTIVE.positionManager,selector('6352211e',ACTIVE.positionId)],['pool.token0',ACTIVE.pool,'0x0dfe1681'],['pool.token1',ACTIVE.pool,'0xd21220a7'],['pool.fee',ACTIVE.pool,'0xddca3f43']]);
const failed = code => ({ status: 'unavailable', failure: { code }, range: { fromBlock: ACTIVE.fromBlock, toBlock: ACTIVE.toBlock, toBlockHash: ACTIVE.toBlockHash }, toBlockHash: ACTIVE.toBlockHash, evidenceUrls: evidenceUrls(), values: { claimed: { state: 'unavailable' }, unclaimed: { state: 'unavailable' }, feeOrigin: { state: 'unproven' } } });
const address = raw => /^0x0{24}[0-9a-f]{40}$/i.test(raw ?? '') ? `0x${raw.slice(-40).toLowerCase()}` : /^0x(?:[0-9a-f]{64}){13}$/i.test(raw ?? '') ? launchTuple(raw) : null;
const uint = raw => /^0x[0-9a-f]{64}$/i.test(raw ?? '') ? BigInt(raw).toString() : null;
const rawLog = log => ({ chainId: ACTIVE.chainId, address: log.address, topics: log.topics, data: log.data, transactionHash: log.transactionHash, logIndex: BigInt(log.logIndex).toString(), blockNumber: BigInt(log.blockNumber).toString(), blockHash: log.blockHash });
const launchTuple = raw => {
  if (!/^0x(?:[0-9a-f]{64}){13}$/i.test(raw ?? '')) return null;
  const words = Array.from({ length: 13 }, (_, i) => `0x${raw.slice(2 + i * 64, 66 + i * 64)}`);
  const values = { token: address(words[0]), deployer: address(words[1]), pairedToken: address(words[2]), positionManager: address(words[3]), positionId: uint(words[4]), dexId: uint(words[5]), launchConfigId: uint(words[6]), restrictionsEndBlock: uint(words[7]), supply: uint(words[8]), isToken0: words[9] === `0x${'0'.repeat(63)}1`, poolFee: uint(words[10]), exists: words[11] === `0x${'0'.repeat(63)}1`, initialBuyAmount: uint(words[12]) };
  return Object.values(values).some(value => value === null) || values.token !== ACTIVE.token || values.deployer !== ACTIVE.redirect || values.pairedToken !== ACTIVE.weth || values.positionManager !== ACTIVE.positionManager || values.positionId !== ACTIVE.positionId || values.dexId !== '0' || values.launchConfigId !== '0' || values.restrictionsEndBlock !== '25591747' || values.supply !== '1000000000000000000000000000' || values.isToken0 !== false || values.poolFee !== '10000' || values.exists !== true || values.initialBuyAmount !== '30000000000000000' ? null : values;
};
export async function sha256Bytecode(bytecode) { if (typeof bytecode !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(bytecode)) throw Error('malformed_bytecode'); const result = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytecode.toLowerCase())); return [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join(''); }
async function rpcMany(rpc, requests) {
  if (typeof rpc.batch === 'function') return rpc.batch(requests);
  const results = [];
  for (const [method, params] of requests) results.push(await rpc(method, params));
  return results;
}
export async function observeFeeLedger({ rpc, now = () => new Date(), hashBytecode = sha256Bytecode } = {}) {
  try {
    if (typeof rpc !== 'function') {
      return failed('unexpected_chain');
    }

    const tag = HEX(ACTIVE.toBlock);
    const preflight = await rpcMany(rpc, [
      ['eth_chainId', []],
      ['eth_getBlockByNumber', [tag, false]],
      ['eth_getBlockByNumber', [tag, false]],
      ['eth_getCode', [ACTIVE.locker, tag]],
      ['eth_getCode', [ACTIVE.factory, tag]],
      ...calls.map(([, target, calldata]) => ['eth_call', [{ to: target, data: calldata }, tag]]),
    ]);
    const [chainId, terminal, before, lockerCode, factoryCode, ...mechanicsResults] = preflight;
    if (chainId !== '0x1237') {
      return failed('unexpected_chain');
    }
    if (!terminal?.hash || terminal.hash.toLowerCase() !== ACTIVE.toBlockHash || before?.hash?.toLowerCase() !== ACTIVE.toBlockHash) {
      return failed('reorg');
    }
    const lockerHash = await hashBytecode(lockerCode);
    const factoryHash = await hashBytecode(factoryCode);
    if (lockerHash !== EXPECTED.locker || factoryHash !== EXPECTED.factory) {
      return failed('fingerprint_mismatch');
    }

    const evidenceUrlForAddress = target => `https://robinhoodchain.blockscout.com/address/${target}`;
    const reads = calls.map(([name, target, calldata], index) => ({ name, target, calldata, raw: mechanicsResults[index], blockNumber: ACTIVE.toBlock, blockHash: ACTIVE.toBlockHash, evidenceUrl: evidenceUrlForAddress(target) }));
    const by = Object.fromEntries(reads.map(read => [read.name, read]));
    const decoded = Object.fromEntries(reads.map(read => [
      read.name,
      ['locker.protocolFeeShare', 'locker.tokenProtocolFeeShares', 'pool.fee'].includes(read.name)
        ? uint(read.raw)
        : address(read.raw),
    ]));
    if (
      Object.values(decoded).some(value => value === null)
      || decoded['factory.locker'] !== ACTIVE.locker
      || decoded['locker.feeRedirects'] !== ACTIVE.redirect
      || decoded['locker.protocolFeeRecipient'] !== ACTIVE.protocolRecipient
      || decoded['locker.protocolFeeShare'] !== '30'
      || decoded['locker.tokenProtocolFeeShares'] !== '30'
      || decoded['v3Factory.getPool'] !== ACTIVE.pool
      || decoded['positionManager.ownerOf'] !== ACTIVE.locker
      || decoded['pool.token0'] !== ACTIVE.weth
      || decoded['pool.token1'] !== ACTIVE.token
      || decoded['pool.fee'] !== '10000'
    ) {
      return failed('mechanics_mismatch');
    }

    const paddedToken = `0x${'0'.repeat(24)}${ACTIVE.token.slice(2)}`;
    const chunks = [];
    const claims = [];
    for (let start = BigInt(ACTIVE.fromBlock); start <= BigInt(ACTIVE.toBlock); start += 50000n) {
      const end = start + 49999n > BigInt(ACTIVE.toBlock)
        ? BigInt(ACTIVE.toBlock)
        : start + 49999n;
      chunks.push({
        fromBlock: `${start}`,
        toBlock: `${end}`,
        anchorHash: ACTIVE.toBlockHash,
        filter: {
          address: ACTIVE.locker,
          fromBlock: HEX(start),
          toBlock: HEX(end),
          topics: [ACTIVE.claimTopic, paddedToken, null],
        },
      });
    }
    for (let offset = 0; offset < chunks.length; offset += 16) {
      const group = chunks.slice(offset, offset + 16);
      const responses = await rpcMany(rpc, group.map(chunk => ['eth_getLogs', [chunk.filter]]));
      for (const [index, chunk] of group.entries()) {
        const results = responses[index].map(rawLog);
        delete chunk.filter;
        Object.assign(chunk, {
          results,
          responseDigest: await digest(results),
          resultCount: `${results.length}`,
          evidenceUrl: evidenceUrls().locker,
        });
        claims.push(...results);
      }
    }

    const claimsByTransactionHash = new Map(
      claims.map(log => [log.transactionHash.toLowerCase(), log]),
    );
    const final = await rpcMany(rpc, [
      ...[...claimsByTransactionHash.keys()].map(hash => ['eth_getTransactionReceipt', [hash]]),
      ['eth_getBlockByNumber', [tag, false]],
    ]);
    const after = final.pop();
    const receipts = final;
    const receiptsMatchClaims = receipts.every(receipt => {
      const receiptHash = receipt?.transactionHash?.toLowerCase();
      const claim = claimsByTransactionHash.get(receiptHash);
      return receipt?.logs
        && claim
        && receipt.blockHash?.toLowerCase() === claim.blockHash.toLowerCase();
    });
    if (!receiptsMatchClaims) {
      return failed('missing_receipt');
    }
    if (after?.hash?.toLowerCase() !== ACTIVE.toBlockHash) {
      return failed('reorg');
    }

    const allLogs = receipts
      .flatMap(receipt => receipt.logs.map(rawLog))
      .filter(log => log.topics[0]?.toLowerCase() === ACTIVE.transferTopic
        || (log.topics[0]?.toLowerCase() === ACTIVE.claimTopic && log.topics[1]?.toLowerCase() === paddedToken));
    const launch = by['factory.getLaunchedToken'].raw;
    if (!/^0x(?:[0-9a-f]{64}){13}$/i.test(launch)) {
      return failed('mechanics_mismatch');
    }

    const mechanics = {
      factory: ACTIVE.factory,
      factoryLocker: decoded['factory.locker'],
      resolvedLocker: decoded['factory.locker'],
      token: ACTIVE.token,
      weth: ACTIVE.weth,
      redirect: decoded['locker.feeRedirects'],
      protocolRecipient: decoded['locker.protocolFeeRecipient'],
      pool: decoded['v3Factory.getPool'],
      positionManager: ACTIVE.positionManager,
      positionId: ACTIVE.positionId,
      positionOwner: decoded['positionManager.ownerOf'],
      poolFee: decoded['pool.fee'],
      collectFeesSelector: ACTIVE.collectFeesSelector,
      tokenProtocolFeeShares: {
        protocol: decoded['locker.tokenProtocolFeeShares'],
        creator: '70',
      },
      protocolFeeShare: decoded['locker.protocolFeeShare'],
      evidence: {
        blockNumber: ACTIVE.toBlock,
        blockHash: ACTIVE.toBlockHash,
        calls: reads,
        codeFingerprints: {
          locker: {
            expected: EXPECTED.locker,
            computed: lockerHash,
            blockNumber: ACTIVE.toBlock,
            blockHash: ACTIVE.toBlockHash,
            evidenceUrl: evidenceUrlForAddress(ACTIVE.locker),
          },
          factory: {
            expected: EXPECTED.factory,
            computed: factoryHash,
            blockNumber: ACTIVE.toBlock,
            blockHash: ACTIVE.toBlockHash,
            evidenceUrl: evidenceUrlForAddress(ACTIVE.factory),
          },
        },
      },
    };

    return buildFeeLedger({
      mechanics,
      scan: {
        completed: true,
        query: {
          address: ACTIVE.locker,
          topic0: ACTIVE.claimTopic,
          tokenTopic: paddedToken,
        },
        chunks,
        eventCount: `${claims.length}`,
        toBlockHash: ACTIVE.toBlockHash,
        observedAt: now().toISOString(),
        beforeAnchor: {
          block: ACTIVE.toBlock,
          hash: before.hash,
          blockHash: before.hash,
        },
        afterAnchor: {
          block: ACTIVE.toBlock,
          hash: after.hash,
          blockHash: after.hash,
        },
        evidenceUrls: evidenceUrls(),
      },
      logs: allLogs,
    });
  } catch {
    return failed('rpc_or_parse_error');
  }
}
