module.exports = {
  solidity: "0.8.30",
  paths: { sources: "./contracts/src", tests: "./contracts/test", cache: "./contracts/cache", artifacts: "./contracts/artifacts" },
  networks: { hardhat: { chainId: 31337, hardfork: "cancun" } },
  mocha: { timeout: 60000 },
};
