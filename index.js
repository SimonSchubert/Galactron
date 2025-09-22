const fetch = require("node-fetch");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai")
const { GSwap, PrivateKeySigner } = require( '@gala-chain/gswap-sdk');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const API_BASE = "https://dex-backend-prod1.defi.gala.com";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const USER = process.env.USER_ADDRESS;

const RUN_INTERVAL_MS = 60 * 60 * 1000;

const gSwap = new GSwap({
  signer: new PrivateKeySigner(PRIVATE_KEY),
});

console.log("Using user:", USER);

/**
 * Fetch current price of GALA
 */
async function getCurrentPrice() {
  const token = "GALA$Unit$none$none";
  const res = await fetch(`${API_BASE}/v1/trade/price?token=${token}`);
  const data = await res.json();

  if (data && data.data) {
    const nowISO = new Date().toISOString();
    const csvPath = path.join(__dirname, "price_history.csv");
    const newLine = `${data.data},${nowISO}\n`;
    let csvContent = "";
    if (fs.existsSync(csvPath)) {
      csvContent = fs.readFileSync(csvPath, "utf8");
    }
    // Filter out entries older than 3 days
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const filteredLines = csvContent
      .split("\n")
      .filter(line => {
        const parts = line.split(",");
        if (parts.length < 2) return false;
        const ts = Date.parse(parts[1]);
        return !isNaN(ts) && ts >= threeDaysAgo;
      });
    // Add the new line at the top
    const updatedContent = [newLine.trim(), ...filteredLines].join("\n") + "\n";
    fs.writeFileSync(csvPath, updatedContent);
    return data.data;
  } else {
    console.error("❌ Unexpected response:", data);
    return null;
  }
}

// Path for storing history
const historyPath = path.join(__dirname, "history.json");

// Load previous history
let history = [];
if (fs.existsSync(historyPath)) {
  try {
    history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
  } catch (e) {
    console.error("Failed to parse history.json:", e);
    history = [];
  }
}

(async () => {
  await GSwap.events.connectEventSocket();

  try {
    let price = await getCurrentPrice();
    console.log("⏱ Live Price:", price, "at", new Date().toISOString());

    // Check last run timestamp
    const lastRunPath = path.join(__dirname, 'last_run.txt');
    let now = Date.now();
    let shouldContinue = true;
    if (fs.existsSync(lastRunPath)) {
      const lastRunStr = fs.readFileSync(lastRunPath, 'utf8');
      const lastRun = parseInt(lastRunStr, 10);
      if (!isNaN(lastRun) && now - lastRun < RUN_INTERVAL_MS) {
        const mins = Math.ceil((RUN_INTERVAL_MS - (now - lastRun)) / 60000);
        console.log(`⏳ Not enough time has passed since last run. Try again in ${mins} minutes.`);
        shouldContinue = false;
      }
    }
    if (!shouldContinue) return;

    // Save new timestamp
    fs.writeFileSync(lastRunPath, now.toString());

    // Get user assets
    const assets = await gSwap.assets.getUserAssets(USER, 1, 20);
    console.log(`User has ${assets.count} different tokens`);

    let tokens = [];
    let galaBalance = 0;
    let gusdcBalance = 0;
    assets.tokens.forEach(token => {
      tokens.push({ symbol: token.symbol, quantity: token.quantity });
      if (token.symbol === 'GALA') galaBalance = Number(token.quantity);
      if (token.symbol === 'GUSDC') gusdcBalance = Number(token.quantity);
    });

    console.log(tokens);

    // Read price history from CSV
    const csvPath = path.join(__dirname, "price_history.csv");
    let priceHistory = "";
    if (fs.existsSync(csvPath)) {
      priceHistory = fs.readFileSync(csvPath, "utf8");
    }

    // Prepare prompt for Gemini with assets, price history, and action history
    const prompt = `
You are a trading assistant for GALA tokens. Every 60 minutes, you receive the following data:

1. **GALA price history** (format: price,ISO8601 timestamp, newest first):
${priceHistory}

2. **User token balances**: ${JSON.stringify(tokens)}

3. **Previous actions and reasoning**:
${history.map((h, i) => `Step ${i + 1}:\nReasoning: ${h.reasoning}\nAction: ${JSON.stringify(h.action)}\nResult: ${h.result}\n`).join('\n')}

**Instructions:**
- Analyze the price trend and the user's balances.
- Consider previous actions and their results.
- Provide a short reasoning inside the json response for your decision.
- Only reply with a JSON object in this format:
  {
    "reasoning": "<your reasoning>",
    "action": {"action": "buy"|"sell", "token": "GALA", "amount": <number>}
  }
- Always keep at least 5% any token in the wallet and never sell the full amount. Always keep at least 10 GALA in the wallet for transaction fees.
- To encourage proactive trading, aim to either buy or sell between 10% and 25% of your GALA or GUSDC holdings in a single transaction.

Example response:
{
  "reasoning": "The price has dropped for 3 hours, so I recommend buying GALA.",
  "action": {"action": "buy", "token": "GALA", "amount": 1.23}
}
`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    let instruction;
    try {
      instruction = JSON.parse(
        response.text.replace("```json", "").replace("```", "")
      );
    } catch (e) {
      console.log("Invalid gemini response:", response.text);
      return;
    }
    console.log("💡 Reasoning:", instruction.reasoning);
    console.log("💡 Instruction:", instruction.action);

    const GALA = 'GALA|Unit|none|none';
    const GUSDC = 'GUSDC|Unit|none|none';

    // Always keep at least 5 GALA for fees
    if (instruction.token === 'GALA' && instruction.action === 'sell') {
      if (instruction.amount > galaBalance - 5) {
        instruction.amount = Math.max(galaBalance - 5, 0);
      }
      if (instruction.amount <= 0) {
        console.log('Not enough GALA to sell after reserving for fees.');
        return;
      }
    }

    let amountIn = Number(instruction.action.amount);
    let tokenIn = '';
    let tokenOut = '';
    if (instruction.action.action === 'buy' && instruction.action.token === 'GALA') {
      // Buy GALA with GUSDC: amount is GUSDC to spend
      tokenIn = GUSDC;
      tokenOut = GALA;
      // sdk requires USDC not GALA 
      const latestPrice = Number(price); 
      amountIn = amountIn * latestPrice;
    } else if (instruction.action.action === 'sell' && instruction.action.token === 'GALA') {
      // Sell GALA for GUSDC: amount is GALA to sell
      tokenIn = GALA;
      tokenOut = GUSDC;
    } else {
      console.log('Invalid instruction:', instruction);
      return;
    }

    const quote = await gSwap.quoting.quoteExactInput(
      tokenIn,
      tokenOut, 
      amountIn,
    );

    const transaction = await gSwap.swaps.swap(
      tokenIn,
      tokenOut,
      quote.feeTier,
      {
        exactIn: amountIn,
        amountOutMinimum: quote.outTokenAmount.multipliedBy(0.95),
      },
      USER
    );

    console.log('Swap transaction submitted:', transaction.transactionId);

    console.log('Transaction pending', tokenOut, tokenIn, quote.feeTier, amountIn, USER);

    // Wait for transaction to complete
    try {
      const result = await transaction.wait();
      console.log('Swap completed successfully!', result);
    } catch (error) {
      console.error('Error waiting for transaction:', error);
    }

    // After performing the trade, store the reasoning and action in history
    history.unshift({
      timestamp: new Date().toISOString(),
      reasoning: instruction.reasoning,
      action: instruction.action,
      result: transaction?.message || "No transaction",
    });

    // Keep only the last 20 entries
    history = history.slice(0, 20);

    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  } finally {
    GSwap.events.disconnectEventSocket();
  }
})();
