const blessed = require('blessed');
const fs = require('fs');
const path = require('path');
const fetch = require("node-fetch");
const { GSwap, PrivateKeySigner } = require('@gala-chain/gswap-sdk');
require('dotenv').config();

const API_BASE = "https://dex-backend-prod1.defi.gala.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const USER = process.env.USER_ADDRESS;

const gSwap = new GSwap({
  signer: new PrivateKeySigner(PRIVATE_KEY),
});

// Create screen
const screen = blessed.screen({
  smartCSR: true,
  title: 'GALA Trading Bot Dashboard                                                       '
});

// Create boxes for different data sections
const priceBox = blessed.box({
  top: 0,
  left: 0,
  width: '33%',
  height: '30%',
  content: 'Loading price data...',
  tags: true,
  border: {
    type: 'line'
  },
  style: {
    fg: 'black',
    border: {
      fg: '#666666'
    }
  },
  label: ' GALA Price '
});

const balanceBox = blessed.box({
  top: 0,
  left: '33%',
  width: '34%',
  height: '30%',
  content: 'Loading balance...',
  tags: true,
  border: {
    type: 'line'
  },
  style: {
    fg: 'black',
    border: {
      fg: '#666666'
    }
  },
  label: ' Portfolio '
});

const swapsBox = blessed.box({
  top: 0,
  right: 0,
  width: '33%',
  height: '30%',
  content: 'Loading swap data...',
  tags: true,
  border: {
    type: 'line'
  },
  style: {
    fg: 'black',
    border: {
      fg: '#666666'
    }
  },
  label: ' Total Swaps '
});

const historyBox = blessed.box({
  top: '30%',
  left: 0,
  width: '100%',
  height: '70%',
  content: 'Loading history...',
  tags: true,
  border: {
    type: 'line'
  },
  style: {
    fg: 'black',
    border: {
      fg: '#666666'
    }
  },
  label: ' Recent Actions ',
  scrollable: true
});

// Append boxes to screen
screen.append(priceBox);
screen.append(balanceBox);
screen.append(swapsBox);
screen.append(historyBox);

// Exit on 'q' or Ctrl+C
screen.key(['escape', 'q', 'C-c'], function() {
  return process.exit(0);
});

// Data fetching functions (from your existing code)
async function getCurrentPrice() {
  const token = "GALA$Unit$none$none";
  const res = await fetch(`${API_BASE}/v1/trade/price?token=${token}`);
  const data = await res.json();
  return data?.data || null;
}

async function updateData() {
  try {
    // Update price
    const price = await getCurrentPrice();
    priceBox.setContent(`{center}{bold}${price ? `$${price} GUSDC` : 'Price unavailable'}{/bold}{/center}\n\n{center}Last updated: ${new Date().toLocaleTimeString()}{/center}`);

    // Update balance
    const assets = await gSwap.assets.getUserAssets(USER, 1, 20);
    let galaBalance = 0;
    let gusdcBalance = 0;
    assets.tokens.forEach(token => {
      if (token.symbol === 'GALA') galaBalance = Number(token.quantity);
      if (token.symbol === 'GUSDC') gusdcBalance = Number(token.quantity);
    });

    const portfolioValue = (galaBalance * (price || 0)) + gusdcBalance;
    balanceBox.setContent(`{center}$${portfolioValue.toFixed(2)}{/center}\n\n{center}${galaBalance.toFixed(2)} GALA • ${gusdcBalance.toFixed(2)} GUSDC{/center}`);

    // Update swap data
    let totalSwaps = 0;
    let tradeVolume = 0;
    
    try {
      const galaScanRes = await fetch(`https://galascan.gala.com/api/all-transactions/${USER}`);
      if (galaScanRes.ok) {
        const transactions = await galaScanRes.json();
        
        if (Array.isArray(transactions)) {
          // Filter for swap transactions
          const swapTxs = transactions.filter(tx => 
            tx.Method && tx.Method.includes('Swap')
          );
          
          totalSwaps = swapTxs.length;
          
          // Calculate trade volume by summing all GALA amounts
          swapTxs.forEach(tx => {
            if (tx.Amount && tx.Amount.includes('GALA')) {
              // Extract amount from format "0.23462743:GALA"
              const amountStr = tx.Amount.split(':')[0];
              const amount = parseFloat(amountStr);
              if (!isNaN(amount)) {
                tradeVolume += amount;
              }
            }
          });
                  }
      } else {
        console.log('GalaScan API response not OK:', galaScanRes.status);
      }
    } catch (apiError) {
      console.log('GalaScan API not available:', apiError.message);
    }

    swapsBox.setContent(`{center}{bold}${totalSwaps}{/bold}{/center}\n\n{center}Volume: ${tradeVolume.toFixed(2)} GALA{/center}`);

    // Update history
    const historyPath = path.join(__dirname, "history.json");
    if (fs.existsSync(historyPath)) {
      const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      const recentActions = history.slice(0, 5).map((h, i) => 
        `${i + 1}. ${h.timestamp}: ${h.action.action} ${h.action.amount} ${h.action.token}\n   Reason: ${h.reasoning}`
      ).join('\n\n');
      historyBox.setContent(recentActions || 'No recent actions');
    }

    screen.render();
  } catch (error) {
    performanceBox.setContent(`Error: ${error.message}`);
    screen.render();
  }
}

// Initial load and auto-refresh
updateData();
setInterval(updateData, 30000); // Update every 30 seconds

// Render the screen
screen.render();