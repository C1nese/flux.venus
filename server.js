const express = require('express');
const { ethers } = require('ethers');
const path = require('path');

const app = express();
const PORT = 3000;

// BSC RPC endpoint (WebSocket for event listening)
const BSC_WSS = 'wss://bsc.publicnode.com';
const USDC_CONTRACT_ADDRESS = '0xfE60462E93cee34319F48Cfc6AcFbc13c2882Df9';
const FUSDT_CONTRACT_ADDRESS = '0xA5b8FCa32E5252B0B58EAbf1A8c79d958F8EE6A2';

// Contract ABI - ERC-4626 standard events + Transfer for debugging
const CONTRACT_ABI = [
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

// Store SSE clients
const clients = [];

// Event history storage (max 200 events per asset)
const MAX_HISTORY = 200;
const eventHistory = {
  usdc: [],
  fusdt: []
};

// Track last processed block numbers
const lastProcessedBlock = {
  usdc: null,
  fusdt: null
};

// Reconnection state
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000; // 最大重连延迟 60 秒
let currentProvider = null;
let heartbeatInterval = null;

// Statistics
const stats = {
  usdc: {
    totalDeposit: 0,
    totalWithdraw: 0
  },
  fusdt: {
    totalDeposit: 0,
    totalWithdraw: 0
  }
};

// Serve static files
app.use(express.static(__dirname));

// SSE endpoint
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initial stats
  res.write(`data: ${JSON.stringify({ type: 'stats', data: stats })}\n\n`);

  // Send historical events (page refresh recovery)
  const historyData = {
    type: 'history',
    data: {
      usdc: [...eventHistory.usdc],
      fusdt: [...eventHistory.fusdt]
    }
  };
  res.write(`data: ${JSON.stringify(historyData)}\n\n`);

  // Add client to list
  clients.push(res);

  // Remove client on disconnect
  req.on('close', () => {
    const index = clients.indexOf(res);
    if (index !== -1) {
      clients.splice(index, 1);
    }
  });
});

// Broadcast to all clients
function broadcast(data, skipHistory = false) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    client.write(message);
  });
  
  // Add to history if it's an event and not a historical event
  if (data.type === 'event' && !skipHistory) {
    const historyKey = data.data.tokenType.toLowerCase();
    if (eventHistory[historyKey]) {
      eventHistory[historyKey].push(data.data);
      
      // Keep only last MAX_HISTORY events
      if (eventHistory[historyKey].length > MAX_HISTORY) {
        eventHistory[historyKey].shift();
      }
    }
  }
}

// Helper function to process and broadcast events
function processEvent(eventType, tokenType, eventArgs, event) {
  const blockNumber = event.log.blockNumber;
  const receivedAt = new Date().toISOString(); // 本地接收时间
  
  // Update last processed block
  if (tokenType === 'USDC') {
    if (!lastProcessedBlock.usdc || blockNumber > lastProcessedBlock.usdc) {
      lastProcessedBlock.usdc = blockNumber;
    }
  } else if (tokenType === 'FUSDT') {
    if (!lastProcessedBlock.fusdt || blockNumber > lastProcessedBlock.fusdt) {
      lastProcessedBlock.fusdt = blockNumber;
    }
  }
  
  let eventData;
  
  if (eventType === 'Transfer') {
    const [from, to, value] = eventArgs;
    const amount = parseFloat(ethers.formatUnits(value, 18));
    
    eventData = {
      type: 'event',
      data: {
        eventType: 'Transfer',
        tokenType: tokenType,
        from: from,
        to: to,
        address: to,
        amount: amount,
        timestamp: new Date(event.log.timestamp || Date.now()).toISOString(),
        receivedAt: receivedAt,
        txHash: event.log.transactionHash,
        blockNumber: blockNumber
      },
      stats: { ...stats }
    };
    
    console.log(`[${tokenType} Transfer] ${from} -> ${to}: ${amount.toFixed(6)} (Block: ${blockNumber})`);
  } else if (eventType === 'Deposit') {
    const [sender, owner, assets, shares] = eventArgs;
    const amount = parseFloat(ethers.formatUnits(assets, 18));
    
    if (tokenType === 'USDC') {
      stats.usdc.totalDeposit += amount;
    } else {
      stats.fusdt.totalDeposit += amount;
    }
    
    eventData = {
      type: 'event',
      data: {
        eventType: 'Deposit',
        tokenType: tokenType,
        address: owner,
        amount: amount,
        shares: parseFloat(ethers.formatUnits(shares, 18)),
        timestamp: new Date(event.log.timestamp || Date.now()).toISOString(),
        receivedAt: receivedAt,
        txHash: event.log.transactionHash,
        blockNumber: blockNumber
      },
      stats: { ...stats }
    };
    
    console.log(`[${tokenType} Deposit] ${owner} - ${amount.toFixed(6)} (${eventData.data.shares.toFixed(6)} shares)`);
  } else if (eventType === 'Withdraw') {
    const [sender, receiver, owner, assets, shares] = eventArgs;
    const amount = parseFloat(ethers.formatUnits(assets, 18));
    
    if (tokenType === 'USDC') {
      stats.usdc.totalWithdraw += amount;
    } else {
      stats.fusdt.totalWithdraw += amount;
    }
    
    eventData = {
      type: 'event',
      data: {
        eventType: 'Withdraw',
        tokenType: tokenType,
        address: receiver,
        amount: amount,
        shares: parseFloat(ethers.formatUnits(shares, 18)),
        timestamp: new Date(event.log.timestamp || Date.now()).toISOString(),
        receivedAt: receivedAt,
        txHash: event.log.transactionHash,
        blockNumber: blockNumber
      },
      stats: { ...stats }
    };
    
    console.log(`[${tokenType} Withdraw] ${receiver} - ${amount.toFixed(6)} (${eventData.data.shares.toFixed(6)} shares)`);
  }
  
  broadcast(eventData);
}

// Query missed events during disconnection
async function queryMissedEvents(contract, tokenType, fromBlock, toBlock) {
  try {
    console.log(`查询 ${tokenType} 遗漏事件: Block ${fromBlock} -> ${toBlock}`);
    
    // Query Transfer events
    const transferFilter = contract.filters.Transfer();
    const transferEvents = await contract.queryFilter(transferFilter, fromBlock, toBlock);
    
    // Query Deposit events
    const depositFilter = contract.filters.Deposit();
    const depositEvents = await contract.queryFilter(depositFilter, fromBlock, toBlock);
    
    // Query Withdraw events
    const withdrawFilter = contract.filters.Withdraw();
    const withdrawEvents = await contract.queryFilter(withdrawFilter, fromBlock, toBlock);
    
    // Combine and sort by block number
    const allEvents = [...transferEvents, ...depositEvents, ...withdrawEvents].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      return a.transactionIndex - b.transactionIndex;
    });
    
    console.log(`找到 ${allEvents.length} 个 ${tokenType} 遗漏事件`);
    
    // Process each event
    for (const event of allEvents) {
      const eventName = event.fragment.name;
      processEvent(eventName, tokenType, event.args, event);
    }
    
  } catch (error) {
    console.error(`查询 ${tokenType} 遗漏事件失败:`, error.message);
  }
}

// Initialize provider and contract
async function initMonitor() {
  try {
    // Clear old heartbeat if exists
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    
    // Destroy old provider if exists
    if (currentProvider) {
      try {
        currentProvider.destroy();
      } catch (e) {
        // Ignore errors during cleanup
      }
    }
    
    const provider = new ethers.WebSocketProvider(BSC_WSS);
    currentProvider = provider;
    
    const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, CONTRACT_ABI, provider);
    const fusdtContract = new ethers.Contract(FUSDT_CONTRACT_ADDRESS, CONTRACT_ABI, provider);

    console.log(`\n[${new Date().toISOString()}] 监控 USDC 合约: ${USDC_CONTRACT_ADDRESS}`);
    console.log(`[${new Date().toISOString()}] 监控 FUSDT 合约: ${FUSDT_CONTRACT_ADDRESS}`);
    console.log(`[${new Date().toISOString()}] BSC WebSocket: ${BSC_WSS}`);
    
    // Get current block
    const currentBlock = await provider.getBlockNumber();
    console.log(`[${new Date().toISOString()}] 当前区块: ${currentBlock}`);
    
    // Query missed events if reconnecting
    if (lastProcessedBlock.usdc) {
      const fromBlock = lastProcessedBlock.usdc + 1;
      if (fromBlock < currentBlock) {
        console.log(`[${new Date().toISOString()}] 补全 USDC 遗漏事件...`);
        await queryMissedEvents(usdcContract, 'USDC', fromBlock, currentBlock);
      }
    } else {
      lastProcessedBlock.usdc = currentBlock;
    }
    
    if (lastProcessedBlock.fusdt) {
      const fromBlock = lastProcessedBlock.fusdt + 1;
      if (fromBlock < currentBlock) {
        console.log(`[${new Date().toISOString()}] 补全 FUSDT 遗漏事件...`);
        await queryMissedEvents(fusdtContract, 'FUSDT', fromBlock, currentBlock);
      }
    } else {
      lastProcessedBlock.fusdt = currentBlock;
    }
    
    // Setup heartbeat - ping every 30 seconds
    heartbeatInterval = setInterval(async () => {
      try {
        await provider.getBlockNumber();
        console.log(`[${new Date().toISOString()}] ❤️ 心跳检测正常`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ 心跳检测失败:`, error.message);
        // Heartbeat failed, trigger reconnection
        if (currentProvider === provider) {
          try {
            provider.websocket.close();
          } catch (e) {
            // Ignore close errors
          }
        }
      }
    }, 30000); // 30 seconds

    // Handle WebSocket errors and reconnection
    provider.websocket.on('error', (error) => {
      console.error(`[${new Date().toISOString()}] WebSocket 错误:`, error.message);
      console.error(`[${new Date().toISOString()}] 错误代码:`, error.code);
    });

    provider.websocket.on('close', (code, reason) => {
      console.log(`[${new Date().toISOString()}] WebSocket 连接断开 (code: ${code}, reason: ${reason})`);
      
      // Clear heartbeat
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      
      // Only reconnect if this is still the current provider
      if (currentProvider === provider) {
        // Exponential backoff: 5s, 10s, 20s, 40s, 60s (max)
        reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
        
        console.log(`[${new Date().toISOString()}] 第 ${reconnectAttempts} 次重连，${delay/1000} 秒后尝试...`);
        
        setTimeout(() => {
          initMonitor();
        }, delay);
      }
    });
    
    provider.websocket.on('open', () => {
      console.log(`[${new Date().toISOString()}] ✅ WebSocket 连接成功`);
      reconnectAttempts = 0; // Reset reconnect attempts on successful connection
    });

    // USDC event listeners
    usdcContract.on('Transfer', (from, to, value, event) => {
      processEvent('Transfer', 'USDC', [from, to, value], event);
    });

    usdcContract.on('Deposit', (sender, owner, assets, shares, event) => {
      processEvent('Deposit', 'USDC', [sender, owner, assets, shares], event);
    });

    usdcContract.on('Withdraw', (sender, receiver, owner, assets, shares, event) => {
      processEvent('Withdraw', 'USDC', [sender, receiver, owner, assets, shares], event);
    });

    // FUSDT event listeners
    fusdtContract.on('Transfer', (from, to, value, event) => {
      processEvent('Transfer', 'FUSDT', [from, to, value], event);
    });

    fusdtContract.on('Deposit', (sender, owner, assets, shares, event) => {
      processEvent('Deposit', 'FUSDT', [sender, owner, assets, shares], event);
    });

    fusdtContract.on('Withdraw', (sender, receiver, owner, assets, shares, event) => {
      processEvent('Withdraw', 'FUSDT', [sender, receiver, owner, assets, shares], event);
    });

    console.log('事件监听已启动...');
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 初始化监控失败:`, error.message);
    console.error(`[${new Date().toISOString()}] 错误代码:`, error.code);
    console.error(`[${new Date().toISOString()}] 10 秒后自动重试...`);
    
    // Don't exit, just retry after delay
    setTimeout(() => {
      initMonitor();
    }, 10000);
  }
}

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  console.error(`[${new Date().toISOString()}] 未捕获的异常:`, error.message);
  console.error(`[${new Date().toISOString()}] 错误代码:`, error.code);
  console.error(`[${new Date().toISOString()}] 10 秒后自动重试...`);
  
  // Don't exit, retry initialization
  setTimeout(() => {
    initMonitor();
  }, 10000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] 未处理的 Promise 拒绝:`, reason);
  console.error(`[${new Date().toISOString()}] 10 秒后自动重试...`);
  
  // Don't exit, retry initialization
  setTimeout(() => {
    initMonitor();
  }, 10000);
});

// Start server
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] 服务器运行在 http://localhost:${PORT}`);
  initMonitor();
});
