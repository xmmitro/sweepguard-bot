require('dotenv').config();
const config = require('./config');
const CHAINS = require('./chains');
const TOKENS = require('./tokens');
const { Web3 } = require('web3');
const axios = require('axios');
const ethers = require('ethers');
const chalk = require('chalk');
const fs = require('fs');
const moment = require('moment');
const winston = require('winston');
const readline = require('readline');

// Destructure configuration variables
const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, WALLET_SWEEP_KEY, WALLET_SWEEP, WALLET_DEST, ETH_MIN_SWEEP, TOKEN_MIN_SWEEP } = config;

// Validate critical configuration variables at startup
if (!WALLET_SWEEP) {
  console.error(chalk.red.bold("Error: WALLET_SWEEP is not defined in the configuration. Please check your .env file."));
  process.exit(1);
}
if (!WALLET_DEST) {
  console.error(chalk.red.bold("Error: WALLET_DEST is not defined in the configuration. Please check your .env file."));
  process.exit(1);
}
if (!WALLET_SWEEP_KEY) {
  console.error(chalk.red.bold("Error: WALLET_SWEEP_KEY is not defined in the configuration. Please check your .env file."));
  process.exit(1);
}

// Setup Winston logger for file logging (minimized for speed)
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.File({ filename: 'sweeper-bot.log' })
  ]
});

// Utility function to send Telegram messages
async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message });
    logger.info(`Telegram message sent: ${message}`);
  } catch (error) {
    console.error(chalk.red(`Failed to send Telegram message: ${error.message}`));
    logger.error(`Failed to send Telegram message: ${error.message}`);
  }
}

// Utility function to pause execution
const sleep = (seconds) => new Promise(resolve => setTimeout(resolve, seconds * 1000));

// ERC-20 ABI for token sweeping with decimals
const ERC20_ABI = [
  { "constant": true, "inputs": [], "name": "decimals", "outputs": [{ "name": "", "type": "uint8" }], "type": "function" },
  { "constant": true, "inputs": [{ "name": "_owner", "type": "address" }], "name": "balanceOf", "outputs": [{ "name": "balance", "type": "uint256" }], "type": "function" },
  { "constant": false, "inputs": [{ "name": "_to", "type": "address" }, { "name": "_value", "type": "uint256" }], "name": "transfer", "outputs": [{ "name": "success", "type": "bool" }], "type": "function" }
];

// Track failed sweeps, retry schedules, and insufficient balance states
const failedSweeps = new Set();
const retrySchedules = new Map(); // chain-asset: { lastAttempt: timestamp, retryAfter: seconds }
const insufficientBalance = new Set(); // Tracks assets with insufficient balance for gas
const tokenDecimalsCache = new Map(); // Cache token decimals for speed

// Chain-specific gas limits
const CHAIN_GAS_LIMITS = {
  arbitrum: 30000,
  ethereum: 21000,
  polygon: 25000,
  base: 35000
};

// Priority queue for sweeping (higher balance = higher priority)
class PriorityQueue {
  constructor() {
    this.queue = [];
  }
  enqueue(item, priority) {
    this.queue.push({ item, priority });
  }
  sort() { // Lazy sorting for efficiency
    this.queue.sort((a, b) => b.priority - a.priority);
  }
  dequeue() {
    if (this.queue.length > 1) this.sort(); // Sort only when dequeuing
    return this.queue.shift();
  }
  isEmpty() {
    return this.queue.length === 0;
  }
}

const sweepQueue = new PriorityQueue();

// Function to fetch token decimals with caching
async function getTokenDecimals(web3, tokenAddress) {
  if (tokenDecimalsCache.has(tokenAddress)) {
    return tokenDecimalsCache.get(tokenAddress);
  }
  const contract = new web3.eth.Contract(ERC20_ABI, tokenAddress);
  try {
    const decimals = await contract.methods.decimals().call();
    tokenDecimalsCache.set(tokenAddress, decimals);
    return decimals;
  } catch (err) {
    console.warn(chalk.yellow(`Failed to fetch decimals for ${tokenAddress}: ${err.message}, defaulting to 18`));
    tokenDecimalsCache.set(tokenAddress, 18);
    return 18; // Default to 18 if fetch fails
  }
}

// Function to check native balances in parallel
async function checkNativeBalances(previousBalances) {
  const balancePromises = Object.entries(CHAINS).map(async ([name, web3]) => {
    if (failedSweeps.has(`${name}-native`) && !retrySchedules.has(`${name}-native`)) return [name, previousBalances[name] || ethers.BigNumber.from(0)];
    try {
      if (!web3.utils.isAddress(WALLET_SWEEP)) {
        throw new Error(`Invalid address for ${name}: ${WALLET_SWEEP}`);
      }
      const balance = await web3.eth.getBalance(WALLET_SWEEP);
      const newBalance = ethers.BigNumber.from(balance);
      const prevBalance = previousBalances[name] || ethers.BigNumber.from(0);
      if (!newBalance.eq(prevBalance)) {
        console.log(chalk.cyan(`[${name}] Balance: ${ethers.utils.formatEther(newBalance)} ETH`));
      }
      return [name, newBalance];
    } catch (err) {
      console.error(chalk.red(`[${name}] Error fetching balance: ${err.message}`));
      logger.error(`[${name}] Error fetching balance: ${err.message}`);
      return [name, previousBalances[name] || ethers.BigNumber.from(0)];
    }
  });
  const balancesArray = await Promise.all(balancePromises);
  return Object.fromEntries(balancesArray);
}

// Function to check token balances in parallel with decimal normalization
async function checkTokenBalances(chain, web3, previousTokenBalances) {
  const tokens = TOKENS[chain] || [];
  const balancePromises = tokens.map(async (token) => {
    const assetKey = `${chain}-${token.symbol}`;
    if (failedSweeps.has(assetKey) && !retrySchedules.has(assetKey)) return [token.symbol, previousTokenBalances[token.symbol] || { raw: ethers.BigNumber.from(0), decimals: 18 }];
    try {
      const contract = new web3.eth.Contract(ERC20_ABI, token.address);
      const balance = await contract.methods.balanceOf(WALLET_SWEEP).call();
      const decimals = await getTokenDecimals(web3, token.address);
      const newBalance = { raw: ethers.BigNumber.from(balance), decimals };
      const prevBalance = previousTokenBalances[token.symbol] || { raw: ethers.BigNumber.from(0), decimals };
      if (!newBalance.raw.eq(prevBalance.raw)) {
        const formattedBalance = ethers.utils.formatUnits(newBalance.raw, decimals);
        console.log(chalk.cyan(`[${chain}] ${token.symbol} Balance: ${formattedBalance}`));
      }
      return [token.symbol, newBalance];
    } catch (err) {
      console.error(chalk.red(`[${chain}] Error fetching ${token.symbol} balance: ${err.message}`));
      logger.error(`[${chain}] Error fetching ${token.symbol} balance: ${err.message}`);
      return [token.symbol, previousTokenBalances[token.symbol] || { raw: ethers.BigNumber.from(0), decimals: 18 }];
    }
  });
  const balancesArray = await Promise.all(balancePromises);
  return Object.fromEntries(balancesArray);
}

// Function to sweep native funds
async function sweepNativeFunds(chain, web3, balance, retryCount = 0) {
  const MAX_RETRIES = 3;
  const assetKey = `${chain}-native`;
  if (retryCount >= MAX_RETRIES) {
    console.error(chalk.red.bold(`[${chain}] Max retries (${MAX_RETRIES}) reached for native funds. Scheduling retry.`));
    await sendTelegramMessage(`⚠️ Max retries (${MAX_RETRIES}) reached for ${chain} native funds. Scheduling retry.`);
    logger.error(`[${chain}] Max retries reached for native funds. Scheduling retry.`);
    failedSweeps.add(assetKey);
    retrySchedules.set(assetKey, { lastAttempt: Date.now(), retryAfter: 3600 }); // Retry after 1 hour
    return;
  }

  try {
    // Fast RPC health check
    try {
      await web3.eth.getBlockNumber();
    } catch (err) {
      console.warn(chalk.yellow(`[${chain}] RPC unresponsive: ${err.message}, skipping sweep`));
      return;
    }

    const gasPrice = await getOptimalGasPrice(web3); // Feature 4: Dynamic Gas Price
    const gasLimit = CHAIN_GAS_LIMITS[chain] || 30000; // Feature 11: Chain-Specific Gas Limits
    const gasCost = ethers.BigNumber.from(gasPrice).mul(gasLimit);
    const gasBuffer = ethers.utils.parseEther('0.00005');
    const totalGasReserve = gasCost.add(gasBuffer);

    console.log(chalk.gray(`[${chain}] Balance: ${ethers.utils.formatEther(balance)} ETH, Gas Price: ${gasPrice} wei, Gas Cost: ${ethers.utils.formatEther(gasCost)} ETH, Total Reserve: ${ethers.utils.formatEther(totalGasReserve)} ETH`));

    const minTransferAmount = ETH_MIN_SWEEP;
    const totalRequired = totalGasReserve.add(minTransferAmount);
    if (balance.lt(totalGasReserve)) { // Check gas first
      if (!failedSweeps.has(assetKey) && !insufficientBalance.has(assetKey)) {
        console.log(chalk.yellow(`[${chain}] Insufficient balance for gas: ${ethers.utils.formatEther(balance)} ETH (Need ${ethers.utils.formatEther(totalGasReserve)} ETH)`));
        await sendTelegramMessage(`ℹ️ Insufficient balance for gas on ${chain}: ${ethers.utils.formatEther(balance)} ETH`);
        insufficientBalance.add(assetKey);
      }
      return; // Stop attempting until new funds
    }
    if (balance.lt(totalRequired)) {
      if (!failedSweeps.has(assetKey) && !insufficientBalance.has(assetKey)) {
        console.log(chalk.yellow(`[${chain}] Insufficient balance: ${ethers.utils.formatEther(balance)} ETH (Need ${ethers.utils.formatEther(totalRequired)} ETH)`));
        await sendTelegramMessage(`ℹ️ Insufficient balance on ${chain}: ${ethers.utils.formatEther(balance)} ETH`);
      }
      return;
    }

    const amountToSend = balance.sub(totalGasReserve);
    if (amountToSend.lte(0)) {
      console.log(chalk.yellow(`[${chain}] Amount to send is zero or negative: ${ethers.utils.formatEther(amountToSend)} ETH`));
      return;
    }

    const nonce = await web3.eth.getTransactionCount(WALLET_SWEEP, 'pending');
    const tx = {
      to: WALLET_DEST,
      value: amountToSend.toString(),
      gas: gasLimit,
      gasPrice: gasPrice.toString(), // Fixed: Convert BigNumber to string
      nonce: nonce
    };
    const signedTx = await web3.eth.accounts.signTransaction(tx, WALLET_SWEEP_KEY);
    const txReceipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

    // Feature 18: Sweep Confirmation Checker
    await confirmTransaction(web3, txReceipt.transactionHash, chain);

    console.log(chalk.green.bold(`[${chain}] ✅ Swept ${ethers.utils.formatEther(amountToSend)} ETH. Tx Hash: ${txReceipt.transactionHash}`));
    await sendTelegramMessage(`✅ Swept ${ethers.utils.formatEther(amountToSend)} ETH on ${chain}. Tx Hash: ${txReceipt.transactionHash}`);
    failedSweeps.delete(assetKey);
    retrySchedules.delete(assetKey);
    insufficientBalance.delete(assetKey); // Reset if successful
  } catch (error) {
    console.error(chalk.red(`[${chain}] Error sweeping funds: ${error.message}`));
    await sendTelegramMessage(`⚠️ Error sweeping funds on ${chain}: ${error.message}`);
    logger.error(`[${chain}] Error sweeping funds: ${error.message}`);
    await sleep(5);
    await sweepNativeFunds(chain, web3, balance, retryCount + 1);
  }
}

// Function to sweep token funds
async function sweepTokenFunds(chain, web3, token, balanceInfo, retryCount = 0) {
  const MAX_RETRIES = 3;
  const assetKey = `${chain}-${token.symbol}`;
  if (retryCount >= MAX_RETRIES) {
    console.error(chalk.red.bold(`[${chain}] Max retries (${MAX_RETRIES}) reached for ${token.symbol}. Scheduling retry.`));
    await sendTelegramMessage(`⚠️ Max retries (${MAX_RETRIES}) reached for ${token.symbol} on ${chain}. Scheduling retry.`);
    logger.error(`[${chain}] Max retries reached for ${token.symbol}. Scheduling retry.`);
    failedSweeps.add(assetKey);
    retrySchedules.set(assetKey, { lastAttempt: Date.now(), retryAfter: 3600 });
    return;
  }

  try {
    // Fast RPC health check
    try {
      await web3.eth.getBlockNumber();
    } catch (err) {
      console.warn(chalk.yellow(`[${chain}] RPC unresponsive: ${err.message}, skipping sweep`));
      return;
    }

    const contract = new web3.eth.Contract(ERC20_ABI, token.address);
    const balance = balanceInfo.raw;
    const decimals = balanceInfo.decimals;

    // Check native balance for gas
    const nativeBalance = await web3.eth.getBalance(WALLET_SWEEP);
    const gasPrice = await getOptimalGasPrice(web3); // Feature 4
    const gasLimit = CHAIN_GAS_LIMITS[chain] || 60000; // Feature 11
    const gasCost = ethers.BigNumber.from(gasPrice).mul(gasLimit);
    const gasBuffer = ethers.utils.parseEther('0.00005');
    const totalGasReserve = gasCost.add(gasBuffer);

    if (ethers.BigNumber.from(nativeBalance).lt(totalGasReserve)) {
      if (!failedSweeps.has(assetKey) && !insufficientBalance.has(assetKey)) {
        console.log(chalk.yellow(`[${chain}] Insufficient native balance for gas to sweep ${token.symbol}: ${ethers.utils.formatEther(nativeBalance)} ETH (Need ${ethers.utils.formatEther(totalGasReserve)} ETH)`));
        await sendTelegramMessage(`ℹ️ Insufficient native balance for gas on ${chain} to sweep ${token.symbol}: ${ethers.utils.formatEther(nativeBalance)} ETH`);
        insufficientBalance.add(assetKey);
      }
      return; // Stop attempting until new funds
    }

    if (balance.lt(TOKEN_MIN_SWEEP)) {
      if (!failedSweeps.has(assetKey)) {
        console.log(chalk.yellow(`[${chain}] ${token.symbol} balance too low: ${ethers.utils.formatUnits(balance, decimals)} (Need ${ethers.utils.formatUnits(TOKEN_MIN_SWEEP, decimals)})`));
      }
      return;
    }

    const nonce = await web3.eth.getTransactionCount(WALLET_SWEEP, 'pending');
    const txData = contract.methods.transfer(WALLET_DEST, balance.toString()).encodeABI();
    const tx = {
      to: token.address,
      data: txData,
      gas: gasLimit,
      gasPrice: gasPrice.toString(), // Fixed: Convert BigNumber to string
      nonce: nonce
    };

    const signedTx = await web3.eth.accounts.signTransaction(tx, WALLET_SWEEP_KEY);
    const txReceipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

    // Feature 18: Sweep Confirmation Checker
    await confirmTransaction(web3, txReceipt.transactionHash, chain);

    const formattedAmount = ethers.utils.formatUnits(balance, decimals);
    console.log(chalk.green.bold(`[${chain}] ✅ Swept ${formattedAmount} ${token.symbol}. Tx Hash: ${txReceipt.transactionHash}`));
    await sendTelegramMessage(`✅ Swept ${formattedAmount} ${token.symbol} on ${chain}. Tx Hash: ${txReceipt.transactionHash}`);
    failedSweeps.delete(assetKey);
    retrySchedules.delete(assetKey);
    insufficientBalance.delete(assetKey); // Reset if successful
  } catch (error) {
    console.error(chalk.red(`[${chain}] Error sweeping ${token.symbol}: ${error.message}`));
    await sendTelegramMessage(`⚠️ Error sweeping ${token.symbol} on ${chain}: ${error.message}`);
    logger.error(`[${chain}] Error sweeping ${token.symbol}: ${error.message}`);
    await sleep(5);
    await sweepTokenFunds(chain, web3, token, balanceInfo, retryCount + 1);
  }
}

// Feature 4: Dynamic Gas Price Adjustment
async function getOptimalGasPrice(web3) {
  const gasPrice = await web3.eth.getGasPrice();
  return ethers.BigNumber.from(gasPrice).mul(110).div(100); // 10% buffer
}

// Advanced Feature: Balance Threshold Alerts
async function checkThresholdAlerts(chain, balance, threshold = ethers.utils.parseEther('0.1')) {
  if (balance.gt(threshold)) {
    console.log(chalk.magenta(`[${chain}] High balance alert: ${ethers.utils.formatEther(balance)} ETH exceeds threshold!`));
    await sendTelegramMessage(`📈 High balance alert on ${chain}: ${ethers.utils.formatEther(balance)} ETH`);
  }
}

// Feature 18: Sweep Confirmation Checker
async function confirmTransaction(web3, txHash, chain, confirmations = 3) {
  for (let i = 0; i < 10; i++) { // Retry up to 10 times
    try {
      const receipt = await web3.eth.getTransactionReceipt(txHash);
      if (receipt && receipt.blockNumber) {
        const currentBlock = await web3.eth.getBlockNumber();
        if (currentBlock - receipt.blockNumber >= confirmations) {
          return true;
        }
      }
      await sleep(2); // Faster confirmation check
    } catch (err) {
      console.warn(chalk.yellow(`[${chain}] Confirmation check failed for ${txHash}: ${err.message}`));
    }
  }
  console.error(chalk.red(`[${chain}] Failed to confirm ${txHash} after retries.`));
  await sendTelegramMessage(`⚠️ Failed to confirm sweep on ${chain}: ${txHash}`);
  throw new Error(`Transaction ${txHash} not confirmed`);
}

// Feature 21: Interactive CLI
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let checkInterval = 10; // Global variable for CLI control
function startCLI() {
  rl.on('line', async (input) => {
    const [command, ...args] = input.trim().split(' ');
    switch (command.toLowerCase()) {
      case 'status':
        console.log(chalk.green.bold(`[STATUS] Running since: ${moment().format('YYYY-MM-DD HH:mm:ss')}`));
        console.log(chalk.green(`Chains: ${Object.keys(CHAINS).join(', ')}`));
        console.log(chalk.green(`Failed Sweeps: ${Array.from(failedSweeps).join(', ') || 'None'}`));
        console.log(chalk.green(`Insufficient Balances: ${Array.from(insufficientBalance).join(', ') || 'None'}`));
        break;
      case 'pause':
        console.log(chalk.yellow.bold("[CLI] Pausing sweeps..."));
        checkInterval = Infinity; // Effectively pauses the loop
        break;
      case 'resume':
        console.log(chalk.green.bold("[CLI] Resuming sweeps..."));
        checkInterval = 10;
        break;
      case 'exit':
        console.log(chalk.red.bold("[CLI] Shutting down..."));
        process.exit(0);
      case 'retry':
        const asset = args[0];
        if (retrySchedules.has(asset)) {
          retrySchedules.set(asset, { lastAttempt: Date.now(), retryAfter: 0 }); // Immediate retry
          console.log(chalk.green(`[CLI] Scheduled immediate retry for ${asset}`));
        } else {
          console.log(chalk.yellow(`[CLI] No retry scheduled for ${asset}`));
        }
        break;
      default:
        console.log(chalk.yellow("[CLI] Commands: status, pause, resume, retry <chain-asset>, exit"));
    }
  });
}

// Main monitoring function with advanced features
async function monitorFunds() {
  let previousNativeBalances = await checkNativeBalances({});
  let previousTokenBalances = {};
  for (const chain of Object.keys(CHAINS)) {
    previousTokenBalances[chain] = await checkTokenBalances(chain, CHAINS[chain], {});
  }
  let lastSweepTime = Date.now();
  let totalSweptNative = {};
  let totalSweptTokens = {};

  startCLI(); // Feature 21: Start Interactive CLI

  while (true) {
    const nativeBalances = await checkNativeBalances(previousNativeBalances);
    let newFundsDetected = false;

    // Feature 9: Sweep Priority Queue
    sweepQueue.queue = []; // Reset queue
    for (const [chain, balance] of Object.entries(nativeBalances)) {
      if (balance.gt(ETH_MIN_SWEEP) && !failedSweeps.has(`${chain}-native`) && !insufficientBalance.has(`${chain}-native`)) {
        sweepQueue.enqueue({ type: 'native', chain, balance }, ethers.utils.formatEther(balance));
      }
      const tokenBalances = await checkTokenBalances(chain, CHAINS[chain], previousTokenBalances[chain] || {});
      for (const [symbol, balanceInfo] of Object.entries(tokenBalances)) {
        if (balanceInfo.raw.gt(TOKEN_MIN_SWEEP) && !failedSweeps.has(`${chain}-${symbol}`) && !insufficientBalance.has(`${chain}-${symbol}`)) {
          sweepQueue.enqueue({ type: 'token', chain, symbol, balanceInfo }, ethers.utils.formatUnits(balanceInfo.raw, balanceInfo.decimals));
        }
      }
    }

    // Batch process priority queue
    const sweepPromises = [];
    while (!sweepQueue.isEmpty()) {
      const { item } = sweepQueue.dequeue();
      if (item.type === 'native') {
        sweepPromises.push(sweepNativeFunds(item.chain, CHAINS[item.chain], item.balance));
        totalSweptNative[item.chain] = (totalSweptNative[item.chain] || ethers.BigNumber.from(0)).add(item.balance.sub(previousNativeBalances[item.chain] || 0));
      } else if (item.type === 'token') {
        const token = TOKENS[item.chain].find(t => t.symbol === item.symbol);
        sweepPromises.push(sweepTokenFunds(item.chain, CHAINS[item.chain], token, item.balanceInfo));
        totalSweptTokens[`${item.chain}-${item.symbol}`] = (totalSweptTokens[`${item.chain}-${item.symbol}`] || ethers.BigNumber.from(0)).add(item.balanceInfo.raw.sub(previousTokenBalances[item.chain][item.symbol]?.raw || 0));
      }
    }
    await Promise.all(sweepPromises); // Batch execute sweeps

    for (const [chain, balance] of Object.entries(nativeBalances)) {
      const prevBalance = previousNativeBalances[chain] || ethers.BigNumber.from(0);
      if (balance.gt(prevBalance)) {
        const newFunds = balance.sub(prevBalance);
        console.log(chalk.blue.bold(`[${chain}] 💰 New funds received: ${ethers.utils.formatEther(newFunds)} ETH`));
        await sendTelegramMessage(`💰 New funds received on ${chain}: ${ethers.utils.formatEther(newFunds)} ETH`);
        logger.info(`[${chain}] New funds received: ${ethers.utils.formatEther(newFunds)} ETH`);
        newFundsDetected = true;
        // Retry insufficient balances across all chains
        for (const assetKey of insufficientBalance) {
          insufficientBalance.delete(assetKey);
          console.log(chalk.green(`[${chain}] New funds detected, retrying sweep for ${assetKey}`));
          if (assetKey.endsWith('-native')) {
            const retryChain = assetKey.split('-')[0];
            if (nativeBalances[retryChain]) {
              sweepQueue.enqueue({ type: 'native', chain: retryChain, balance: nativeBalances[retryChain] }, ethers.utils.formatEther(nativeBalances[retryChain]));
            }
          } else {
            const [retryChain, symbol] = assetKey.split('-');
            const token = TOKENS[retryChain]?.find(t => t.symbol === symbol);
            if (token && previousTokenBalances[retryChain][symbol]) {
              sweepQueue.enqueue({ type: 'token', chain: retryChain, symbol, balanceInfo: previousTokenBalances[retryChain][symbol] }, ethers.utils.formatUnits(previousTokenBalances[retryChain][symbol].raw, previousTokenBalances[retryChain][symbol].decimals));
            }
          }
        }
      }

      await checkThresholdAlerts(chain, balance);

      const tokenBalances = previousTokenBalances[chain] = await checkTokenBalances(chain, CHAINS[chain], previousTokenBalances[chain] || {});
      for (const [symbol, balanceInfo] of Object.entries(tokenBalances)) {
        const prevTokenBalance = previousTokenBalances[chain][symbol]?.raw || ethers.BigNumber.from(0);
        if (balanceInfo.raw.gt(prevTokenBalance)) {
          const newFunds = balanceInfo.raw.sub(prevTokenBalance);
          console.log(chalk.blue.bold(`[${chain}] 💰 New ${symbol} received: ${ethers.utils.formatUnits(newFunds, balanceInfo.decimals)}`));
          await sendTelegramMessage(`💰 New ${symbol} received on ${chain}: ${ethers.utils.formatUnits(newFunds, balanceInfo.decimals)}`);
          logger.info(`[${chain}] New ${symbol} received: ${ethers.utils.formatUnits(newFunds, balanceInfo.decimals)}`);
          newFundsDetected = true;
          // Retry insufficient balances across all chains
          for (const assetKey of insufficientBalance) {
            insufficientBalance.delete(assetKey);
            console.log(chalk.green(`[${chain}] New funds detected, retrying sweep for ${assetKey}`));
            if (assetKey.endsWith('-native')) {
              const retryChain = assetKey.split('-')[0];
              if (nativeBalances[retryChain]) {
                sweepQueue.enqueue({ type: 'native', chain: retryChain, balance: nativeBalances[retryChain] }, ethers.utils.formatEther(nativeBalances[retryChain]));
              }
            } else {
              const [retryChain, symbolRetry] = assetKey.split('-');
              const token = TOKENS[retryChain]?.find(t => t.symbol === symbolRetry);
              if (token && previousTokenBalances[retryChain][symbolRetry]) {
                sweepQueue.enqueue({ type: 'token', chain: retryChain, symbol: symbolRetry, balanceInfo: previousTokenBalances[retryChain][symbolRetry] }, ethers.utils.formatUnits(previousTokenBalances[retryChain][symbolRetry].raw, previousTokenBalances[retryChain][symbolRetry].decimals));
              }
            }
          }
        }
      }
    }

    if (Date.now() - lastSweepTime > 3600000) { // Every hour
      const nativeSummary = Object.fromEntries(Object.entries(totalSweptNative).map(([k, v]) => [k, ethers.utils.formatEther(v)]));
      console.log(chalk.magenta.bold(`[SUMMARY] Total Swept Native: ${JSON.stringify(nativeSummary)}`));
      console.log(chalk.magenta.bold(`[SUMMARY] Total Swept Tokens: ${JSON.stringify(totalSweptTokens)}`));
      lastSweepTime = Date.now();
    }

    checkInterval = newFundsDetected ? 0.5 : Math.min(checkInterval + 1, 30); // Faster polling when active

    for (const [chain, web3] of Object.entries(CHAINS)) {
      try {
        await web3.eth.getBlockNumber();
      } catch (err) {
        console.warn(chalk.yellow(`[${chain}] Chain RPC warning: ${err.message}`));
        logger.warn(`[${chain}] Chain RPC warning: ${err.message}`);
      }
    }

    previousNativeBalances = nativeBalances;
    await sleep(Math.max(checkInterval, 0.5)); // Minimum 0.5-second delay for performance
  }
}

// Advanced Features Implementation
console.log(chalk.green.bold(`
  🚀 Multi-Chain Anti-Sweeper Bot v2.1
  Started at: ${moment().format('YYYY-MM-DD HH:mm:ss')}
  Monitoring: ${Object.keys(CHAINS).join(', ')}
  Wallet: ${WALLET_SWEEP}
  CLI Commands: status, pause, resume, retry <chain-asset>, exit
`));
logger.info(`Bot started at ${moment().format('YYYY-MM-DD HH:mm:ss')}`);

monitorFunds().catch(err => {
  console.error(chalk.red.bold(`Critical error in bot: ${err.message}`));
  logger.error(`Critical error in bot: ${err.message}`);
  process.exit(1);
});