const TOKEN_LAUNCHED_TOPIC = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';

function generationProfile({
  generation,
  address,
  deploymentBlock,
  locker,
  lockerDeploymentBlock,
  factoryCodeSha256,
  lockerCodeSha256,
  supportedFeatures,
  source
}) {
  return Object.freeze({
    generation,
    address,
    deploymentBlock,
    locker,
    lockerDeploymentBlock,
    selectors: Object.freeze({
      getLaunchedToken: '0x3cf28b5a',
      locker: '0xd7b96d4e',
      graduationStatus: '0x98d652f1',
      ownerOf: '0x6352211e',
      feeRedirects: '0xdce780c2',
      tokenProtocolFeeShares: '0xf1c8f3c0'
    }),
    launchEvent: Object.freeze({
      name: 'TokenLaunched',
      topic0: TOKEN_LAUNCHED_TOPIC,
      tokenTopicIndex: 1
    }),
    expectedCodeIdentities: Object.freeze({
      factory: Object.freeze({
        algorithm: 'sha256-lowercase-rpc-bytecode',
        digest: factoryCodeSha256
      }),
      locker: Object.freeze({
        algorithm: 'sha256-lowercase-rpc-bytecode',
        digest: lockerCodeSha256
      })
    }),
    supportedFeatures: Object.freeze([...supportedFeatures]),
    source
  });
}

export const ROBINHOOD_CHAIN = Object.freeze({
  chainId: '4663',
  weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  v3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  quoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  poolFee: '10000',
  tokenDecimals: 18,
  factories: Object.freeze([
    generationProfile({
      generation: 'active',
      address: '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb',
      deploymentBlock: '8991118',
      locker: '0x736d76699c26d0d966744cae304c000d471f7f35',
      lockerDeploymentBlock: '8991102',
      factoryCodeSha256: '22d0b4a1c81871e657494c418f002cba04134b7a67c05a45f53d87c7a9398fb9',
      lockerCodeSha256: '0435c0624330dd5488860aa53c9228af0d49289cfb10cf1f17cc7a7f79b497f8',
      supportedFeatures: [
        'exit_ladder',
        'lp_custody',
        'fee_split_redirect',
        'graduation_status',
        'restriction_horizon',
        'factory_launch_lookup'
      ],
      source: 'pons active factory getLaunchedToken'
    }),
    generationProfile({
      generation: 'legacy',
      address: '0x0c37a24f5d23a486fa692d1500881d698b1f77a4',
      deploymentBlock: '8600612',
      locker: '0x31ca5e101941a93a7dd6d0497928700625cf54b5',
      lockerDeploymentBlock: '8600590',
      factoryCodeSha256: '64628fa24e0954fb0676e56c30ab3175410cfd4b332ad90fafd1bac2dfa90b08',
      lockerCodeSha256: 'a50e60c3884a5a99bb4a129cca7899b9084263e762a0dedf02bcb93b1e8e4e46',
      supportedFeatures: [
        'exit_ladder',
        'restriction_horizon',
        'factory_launch_lookup'
      ],
      source: 'pons legacy factory getLaunchedToken'
    })
  ])
});
