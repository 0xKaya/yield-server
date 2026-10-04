const sdk = require('@defillama/sdk');
const utils = require('../utils');

const CHAIN = 'robinhood';
const PAPER = '0x008dd62dd934f3ffdc0986ba5316c78ae51cb1c9';
const PLATE = '0x5b00c30098216a00905ee3fb5bda413006418bb6';
const OPLATE = '0x34d537f53ea0a1333a5d7621e7f023ee6cfcb787';
const SPY = '0x117cc2133c37b721f49de2a7a74833232b3b4c0c';
const PAIRS = {
  '0x6178406c433c70b006e2f81a79a5d98bf5b0af85': { other: PAPER, symbol: 'PAPER-SPY' },
  '0x73c4aae208080d94e97a0abe80f140a140846cc8': { other: PLATE, symbol: 'PLATE-SPY' },
};
// Genesis pays PAPER for a fixed window; the reward pool pays oPLATE.
const CHEFS = [
  {
    address: '0x935661973d9379b792bcb110d1eebd05034b838f',
    meta: 'Genesis',
    reward: PAPER,
    poolInfo: 'function poolInfo(uint256) view returns (address token, uint256 depFee, uint256 allocPoint, uint256 lastRewardTime, uint256 acc, bool isStarted, uint256 totalStaked, (bool isGauge, address gauge, address[] rewardTokens) gaugeInfo, uint256 perSecond)',
  },
  {
    address: '0x55d8c2eb48cdcc1835dd38568f22feb6a0893d35',
    meta: 'oPLATE farm',
    reward: OPLATE,
    poolInfo: 'function poolInfo(uint256) view returns (address token, uint256 depFee, uint256 allocPoint, uint256 lastRewardTime, uint256 acc, bool isStarted, uint256 totalStaked, (bool isGauge, address gauge, uint8 gaugeDex) gaugeInfo, uint256 perSecond)',
  },
];
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

const call = (target, abi, params) => sdk.api.abi.call({ target, abi, params, chain: CHAIN }).then((r) => r.output);

// PAPER and PLATE are priced through their SPY pairs; each LP is worth twice its SPY side.
async function pairPrices(spyUsd) {
  const prices = {};
  for (const [lp, { other }] of Object.entries(PAIRS)) {
    const [token0, reserves, supply] = await Promise.all([
      call(lp, 'address:token0'),
      call(lp, 'function getReserves() view returns (uint112, uint112, uint32)'),
      call(lp, 'uint256:totalSupply'),
    ]);
    const spyFirst = token0.toLowerCase() === SPY;
    const spyAmount = Number(spyFirst ? reserves[0] : reserves[1]) / 1e18;
    const otherAmount = Number(spyFirst ? reserves[1] : reserves[0]) / 1e18;
    if (!(spyAmount > 0 && otherAmount > 0 && Number(supply) > 0)) continue;
    prices[other] = (spyAmount * spyUsd) / otherAmount;
    prices[lp] = (spyAmount * spyUsd * 2) / (Number(supply) / 1e18);
  }
  return prices;
}

async function apy() {
  const now = Date.now() / 1000;
  const coins = await utils.getPrices([SPY, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0x5fc5360d0400a0fd4f2af552add042d716f1d168'], CHAIN);
  const prices = { ...coins.pricesByAddress, ...(await pairPrices(coins.pricesByAddress[SPY])) };
  // oPLATE is exercised into PLATE by paying SPY at liquidPayBps of the PLATE TWAP, so it is valued at PLATE less that cost.
  const payBps = Number(await call(OPLATE, 'uint256:liquidPayBps'));
  if (prices[PLATE]) prices[OPLATE] = prices[PLATE] * (1 - payBps / 10000);

  const pools = [];
  for (const chef of CHEFS) {
    const [start, end, length] = await Promise.all(['uint256:poolStartTime', 'uint256:poolEndTime', 'uint256:poolLength'].map((abi) => call(chef.address, abi)));
    if (now < Number(start) || now >= Number(end)) continue;
    const infos = (await sdk.api.abi.multiCall({ target: chef.address, abi: chef.poolInfo, calls: [...Array(Number(length)).keys()].map((i) => ({ params: [i] })), chain: CHAIN })).output.map((r) => r.output);
    for (const [pid, info] of infos.entries()) {
      const token = info.token.toLowerCase();
      const decimals = Number(await call(token, 'uint8:decimals'));
      const tvlUsd = (Number(info.totalStaked) / 10 ** decimals) * prices[token];
      const rewardUsdPerYear = (Number(info.perSecond) / 1e18) * SECONDS_PER_YEAR * prices[chef.reward];
      const pair = PAIRS[token];
      pools.push({
        pool: `${chef.address}-${pid}-${CHAIN}`,
        chain: utils.formatChain(CHAIN),
        project: 'stonkpress',
        symbol: pair ? pair.symbol : utils.formatSymbol(await call(token, 'string:symbol')),
        tvlUsd,
        apyReward: tvlUsd > 0 ? (rewardUsdPerYear / tvlUsd) * 100 : 0,
        rewardTokens: [chef.reward],
        underlyingTokens: pair ? [pair.other, SPY] : [token],
        token,
        poolMeta: chef.meta,
        url: 'https://www.stonk.press',
      });
    }
  }
  return pools.filter(utils.keepFinite);
}

module.exports = {
  // TODO: protocolId from https://api.llama.fi/protocols once DefiLlama-Adapters#21385 lists StonkPress.
  timetravel: false,
  apy,
  url: 'https://www.stonk.press',
};
