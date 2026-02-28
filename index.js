import express from "express";
import dotenv from "dotenv";
import { ethers } from "ethers";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json());

// ================= ENV =================
const API_KEY = process.env.API_KEY || "";
const RPC_HTTP = process.env.RPC_HTTP;
const PRIVATE_KEY = process.env.HOT_WALLET_PRIVATE_KEY;
const USDT_CONTRACT = process.env.USDT_CONTRACT || "0x55d398326f99059fF775485246999027B3197955";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY;

const POLL_MS = Number(process.env.POLL_MS || 12000);
const PORT = Number(process.env.PORT || 3000);

// unique amount tags like 10.001, 10.002 ...
const TAG_STEP = Number(process.env.TAG_STEP || 0.001);
const TAG_MAX = Number(process.env.TAG_MAX || 0.099);

// ================= AUTH =================
function requireApiKey(req, res, next) {
  const key = req.header("x-api-key");
  if (!key || key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function die(msg) {
  console.error("ERROR:", msg);
  process.exit(1);
}

// ================= CHECK ENV =================
if (!API_KEY) die("API_KEY missing");
if (!RPC_HTTP) die("RPC_HTTP missing");
if (!PRIVATE_KEY) die("HOT_WALLET_PRIVATE_KEY missing");
if (!BSCSCAN_API_KEY) die("BSCSCAN_API_KEY missing");

// ================= CHAIN =================
const provider = new ethers.JsonRpcProvider(RPC_HTTP);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)"
];

const usdtRead = new ethers.Contract(USDT_CONTRACT, ERC20_ABI, provider);
const usdtWrite = usdtRead.connect(wallet);

let DECIMALS = 18;

// ================= STORAGE (in-memory) =================
// NOTE: Railway restart clears memory. Works for simple use.
// For production: use Postgres (I can provide).
const invoices = new Map();
// invoice = { id, requestedAmount, payAmount, tag, status, toAddress, createdAt, txHash }
let lastProcessedTime = 0;

function nowIso() {
  return new Date().toISOString();
}

function roundTo3(n) {
  return Math.round(n * 1000) / 1000;
}

function allocateTag() {
  // avoid collisions: pick a tag not used by other pending invoices
  const used = new Set();
  for (const inv of invoices.values()) {
    if (inv.status === "pending") used.add(inv.tag);
  }

  for (let t = TAG_STEP; t <= TAG_MAX + 1e-12; t += TAG_STEP) {
    const tag = roundTo3(t);
    if (!used.has(tag)) return tag;
  }
  return null;
}

// compare using smallest unit to avoid floating problems
function amountsEqual(aStr, bStr) {
  const a = ethers.parseUnits(String(aStr), DECIMALS);
  const b = ethers.parseUnits(String(bStr), DECIMALS);
  return a === b;
}

// ================= BSCSCAN =================
async function fetchIncomingUsdtTransfers() {
  const address = wallet.address;

  const url =
    "https://api.bscscan.com/api" +
    `?module=account&action=tokentx` +
    `&contractaddress=${USDT_CONTRACT}` +
    `&address=${address}` +
    `&page=1&offset=50&sort=desc` +
    `&apikey=${BSCSCAN_API_KEY}`;

  const r = await fetch(url);
  const data = await r.json();

  if (!data || !data.result) return [];
  if (data.status !== "1") return []; // includes "No transactions found"
  return data.result;
}

function formatTokenAmount(rawValue) {
  return ethers.formatUnits(rawValue, DECIMALS);
}

// ================= ROUTES =================
app.get("/", (req, res) => res.send("BSC USDT gateway running"));

app.get("/api/info", requireApiKey, (req, res) => {
  res.json({
    address: wallet.address,
    usdtContract: USDT_CONTRACT,
    decimals: DECIMALS,
    pollMs: POLL_MS,
    tagStep: TAG_STEP,
    tagMax: TAG_MAX
  });
});

app.get("/api/balance", requireApiKey, async (req, res) => {
  const bal = await usdtRead.balanceOf(wallet.address);
  res.json({ address: wallet.address, usdt: ethers.formatUnits(bal, DECIMALS) });
});

// Create invoice with unique amount (10 -> 10.001 etc)
app.post("/api/invoices", requireApiKey, (req, res) => {
  const { amount } = req.body;
  const n = Number(amount);

  if (!amount || !Number.isFinite(n) || n <= 0) {
    return res.status(400).json({ error: "amount must be > 0" });
  }

  const tag = allocateTag();
  if (tag === null) {
    return res.status(503).json({ error: "Too many pending invoices, try again later" });
  }

  const requestedAmount = roundTo3(n);
  const payAmount = roundTo3(requestedAmount + tag);

  const id = crypto.randomUUID();
  const inv = {
    id,
    requestedAmount: requestedAmount.toFixed(3),
    tag: tag.toFixed(3),
    payAmount: payAmount.toFixed(3),
    status: "pending",
    toAddress: wallet.address,
    createdAt: nowIso(),
    txHash: null
  };

  invoices.set(id, inv);
  res.json(inv);
});

app.get("/api/invoices/:id", requireApiKey, (req, res) => {
  const inv = invoices.get(req.params.id);
  if (!inv) return res.status(404).json({ error: "not found" });
  res.json(inv);
});

// Send USDT (payout)
app.post("/api/send", requireApiKey, async (req, res) => {
  const { to, amount } = req.body;

  if (!ethers.isAddress(to)) return res.status(400).json({ error: "invalid to address" });
  const n = Number(amount);
  if (!amount || !Number.isFinite(n) || n <= 0) return res.status(400).json({ error: "amount must be > 0" });

  try {
    const value = ethers.parseUnits(String(amount), DECIMALS);
    const tx = await usdtWrite.transfer(to, value);
    res.json({ ok: true, txHash: tx.hash });
  } catch (e) {
    res.status(500).json({ error: "send failed", details: String(e?.message || e) });
  }
});

// ================= DEPOSIT LOOP =================
async function depositLoop() {
  try {
    const transfers = await fetchIncomingUsdtTransfers();

    for (const t of transfers) {
      const time = Number(t.timeStamp || "0");
      if (!time) continue;
      if (time <= lastProcessedTime) continue;

      if ((t.to || "").toLowerCase() !== wallet.address.toLowerCase()) continue;

      const receivedAmount = formatTokenAmount(t.value);
      const txHash = t.hash;

      console.log("Incoming USDT:", { receivedAmount, txHash, time });

      for (const inv of invoices.values()) {
        if (inv.status !== "pending") continue;
        if (amountsEqual(inv.payAmount, receivedAmount)) {
          inv.status = "confirmed";
          inv.txHash = txHash;
          break;
        }
      }
    }

    if (transfers.length > 0) {
      const newest = Number(transfers[0].timeStamp || "0");
      if (newest > lastProcessedTime) lastProcessedTime = newest;
    }
  } catch (e) {
    console.error("depositLoop error:", e?.message || e);
  } finally {
    setTimeout(depositLoop, POLL_MS);
  }
}

// ================= START =================
async function init() {
  DECIMALS = await usdtRead.decimals();
  console.log("USDT decimals:", DECIMALS);
  console.log("Gateway address:", wallet.address);
}

await init();
depositLoop();

app.listen(PORT, () => console.log("Listening on port", PORT));
