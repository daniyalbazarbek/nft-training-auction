require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { SEPOLIA_RPC_URL, PRIVATE_KEY } = process.env;
const sepoliaPrivateKey = PRIVATE_KEY
  ? PRIVATE_KEY.startsWith("0x")
    ? PRIVATE_KEY
    : `0x${PRIVATE_KEY}`
  : undefined;

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    sepolia: {
      url: SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
      accounts: sepoliaPrivateKey ? [sepoliaPrivateKey] : [],
    },
  },
};
