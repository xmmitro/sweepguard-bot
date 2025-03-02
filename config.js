require('dotenv').config();
const ethers = require('ethers');

if (!ethers || !ethers.utils || !ethers.utils.parseEther) {
  throw new Error('Failed to import ethers library. Please ensure it is installed with "npm install ethers".');
}

module.exports = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  WALLET_SWEEP_KEY: process.env.WALLET_SWEEP_KEY,
  WALLET_SWEEP: process.env.WALLET_SWEEP,
  WALLET_DEST: process.env.WALLET_DEST,
  ETH_MIN_SWEEP: ethers.utils.parseEther('0.000001'), // Reduced to 0.000001 ETH
  TOKEN_MIN_SWEEP: ethers.BigNumber.from('1000000') // Minimum 1 USDT (assuming 6 decimals)
};