// Import the Web3 constructor by destructuring it from the 'web3' module
const { Web3 } = require('web3');

// Export an object with Web3 instances for each chain
module.exports = {
  arbitrum: new Web3('https://arb-mainnet.g.alchemy.com/v2/kwGkrz6Eeg4N3X5IntpuQDngaawdlq0O'),
  ethereum: new Web3('https://eth-mainnet.alchemyapi.io/v2/kwGkrz6Eeg4N3X5IntpuQDngaawdlq0O'),
  polygon: new Web3('https://polygon-mainnet.g.alchemy.com/v2/kwGkrz6Eeg4N3X5IntpuQDngaawdlq0O'),
  base: new Web3('https://base-sepolia.g.alchemy.com/v2/kwGkrz6Eeg4N3X5IntpuQDngaawdlq0O')
};