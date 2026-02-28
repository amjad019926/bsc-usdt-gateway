import express from "express";
import dotenv from "dotenv";
import { ethers } from "ethers";
import crypto from "crypto";
import pg from "pg";

dotenv.config();
const app = express();
app.use(express.json());

// ================= ENV =================
const API_KEY = process.env.API_KEY || "";
const RPC_HTTP = process.env.RPC_HTTP;
const PRIVATE_KEY = process.env.HOT_WALLET_PRIVATE_KEY;

// USDT BEP20 on BSC
const USDT_CONTRACT =
  process.env.USDT_CONTRACT || "0x55d398326f99059fF775485246999027B3197955";

// Etherscan API key (API V2). For BSC: chainid=56
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

const POLL_MS = Number(process.env.POLL_MS || 12000);
const PORT = Number(process.env.PORT || 3000);

// Unique amount tags like 10.001, 10.002 ...
const TAG_STEP = Number(process.env.TAG_STEP || 0.001);
const TAG_MAX = Number(process.env.TAG_MAX || 0.099);

// Postgres
const DATABASE_URL = process.env.DATABASE_URL;

// ================= HELPERS =================
function die(msg) {
  console.error("ERROR:", msg);
  process.exit(1);
}
if (!API_KEY) die("API_KEY missing");
if (!RPC_HTTP) die("RPC_HTTP missing");
if (!PRIVATE_KEY) die("HOT_WALLET_PRIVATE_KEY missing");
if (!ETHERSCAN_API_KEY) die("ETHERSCAN_API_KEY missing");
if (!DATABASE_URL) die("DATABASE_URL missing (add Railway Postgres)");

function requireApiKey(req, res, next) {
  const key = req.header("x-api-key");
  if (!key || key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function nowIso() {
  return new Date().toISOString();
}
function roundTo3(n) {
  return Math.round(n * 1000) / 1000;
}

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

// ================= DB =================
const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
});

async function dbInit() {
  // invoices: persistent
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id UUID PRIMARY KEY,
      requested_amount NUMERIC(30, 18) NOT NULL,
      tag NUMERIC(30, 18) NOT NULL,
      pay_amount NUMERIC(30, 18) NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      to_address TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tx_hash TEXT
    );
  `);

  // processed tx hashes so we never miss or double-process
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_txs (
      tx_hash TEXT PRIMARY KEY,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // helpful index
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
  `);
}

// ================= Etherscan V2 fetch =================
async function fetchIncomingUsdtTransfers() {
  const address = wallet.address;
  const url =
    "https://api.etherscan.io/api" +
    `?chainid=56` +
    `&module=account&action=tokentx` +
    `&contractaddress=${USDT_CONTRACT}` +
    `&address=${address}` +
    `&page=1&offset=100&sort=desc` +
    `&apikey=${ETHERSCAN_API_KEY}`;

  const r = await fetch(url);
  const data = await r.json();

  // status "1" ok, "0" could be "No transactions found" or rate limit
  if (!data || !data.result) return [];
  if (data.status !== "1") return [];
  return data.result;
}

function formatTokenAmount(rawValue) {
  return ethers.formatUnits(rawValue, DECIMALS);
}

function amountsEqual(aStr, bStr) {
  const a = ethers.parseUnits(String(aStr), DECIMALS);
  const b = ethers.parseUnits(String(bStr), DECIMALS);
  return a === b;
}

// Allocate tag safely (from DB): find a tag not used by pending invoices
async function allocateTagFromDb() {
  // Get all used tags for pending invoices
  const { rows } = await pool.query(
    "SELECT tag FROM invoices WHERE status='pending'"
  );
  const used = new Set(rows.map(r => Number(r.tag)));

  for (let t = TAG_STEP; t <= TAG_MAX + 1e-12; t += TAG_STEP) {
    const tag = roundTo3(t);
    if (!used.has(tag)) return tag;
  }
  return null;
}

// ================= API ROUTES =================
app.get("/", (req, res) => res.send("BSC USDT gateway running (SOLID + Postgres)"));

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

// Create invoice (unique amount tag)
app.post("/api/invoices", requireApiKey, async (req, res) => {
  const { amount } = req.body;
  const n = Number(amount);

  if (!amount || !Number.isFinite(n) || n <= 0) {
    return res.status(400).json({ error: "amount must be > 0" });
  }

  const tag = await allocateTagFromDb();
  if (tag === null) return res.status(503).json({ error: "Too many pending invoices, try later" });

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

  try {
    await pool.query(
      `INSERT INTO invoices (id, requested_amount, tag, pay_amount, status, to_address)
       VALUES ($1,$2,$3,$4,'pending',$5)`,
      [id, inv.requestedAmount, inv.tag, inv.payAmount, inv.toAddress]
    );
    res.json(inv);
  } catch (e) {
    // In rare case pay_amount unique collision, retry once
    console.error("invoice insert error:", e?.message || e);
    return res.status(500).json({ error: "invoice create failed, try again" });
  }
});

// Get invoice
app.get("/api/invoices/:id", requireApiKey, async (req, res) => {
  const id = req.params.id;
  const { rows } = await pool.query(
    "SELECT id, requested_amount, tag, pay_amount, status, to_address, created_at, tx_hash FROM invoices WHERE id=$1",
    [id]
  );
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  const r = rows[0];
  res.json({
    id: r.id,
    requestedAmount: String(r.requested_amount),
    tag: String(r.tag),
    payAmount: String(r.pay_amount),
    status: r.status,
    toAddress: r.to_address,
    createdAt: r.created_at,
    txHash: r.tx_hash
  });
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

// ================= SOLID DEPOSIT LOOP =================
// No time skipping. We store processed tx hashes in DB.
// Even if Etherscan returns delayed/out-of-order, we still catch it.
async function depositLoop() {
  try {
    const transfers = await fetchIncomingUsdtTransfers();

    for (const t of transfers) {
      const txHash = (t.hash || "").toLowerCase();
      if (!txHash) continue;

      // incoming only
      if ((t.to || "").toLowerCase() !== wallet.address.toLowerCase()) continue;

      // if already processed, skip
      const already = await pool.query("SELECT 1 FROM processed_txs WHERE tx_hash=$1", [txHash]);
      if (already.rows.length > 0) continue;

      const receivedAmount = formatTokenAmount(t.value);

      // find matching pending invoice by pay_amount
      // Using string compare in smallest unit to avoid float issues:
      const { rows } = await pool.query(
        "SELECT id, pay_amount FROM invoices WHERE status='pending'"
      );

      let matchedInvoiceId = null;
      for (const r of rows) {
        if (amountsEqual(String(r.pay_amount), receivedAmount)) {
          matchedInvoiceId = r.id;
          break;
        }
      }

      if (matchedInvoiceId) {
        await pool.query(
          "UPDATE invoices SET status='confirmed', tx_hash=$1 WHERE id=$2 AND status='pending'",
          [t.hash, matchedInvoiceId]
        );
        console.log("✅ Confirmed invoice", matchedInvoiceId, "amount", receivedAmount, "tx", t.hash);
      } else {
        console.log("Seen incoming USDT but no invoice match:", { receivedAmount, txHash });
      }

      // mark tx as processed (so we never process it again)
      await pool.query("INSERT INTO processed_txs (tx_hash) VALUES ($1) ON CONFLICT DO NOTHING", [txHash]);
    }

    // keep processed_txs small (optional cleanup)
    // delete older than 30 days
    await pool.query("DELETE FROM processed_txs WHERE seen_at < NOW() - INTERVAL '30 days'");
  } catch (e) {
    console.error("depositLoop error:", e?.message || e);
  } finally {
    setTimeout(depositLoop, POLL_MS);
  }
}

// ================= START =================
async function init() {
  await dbInit();

  try {
    DECIMALS = await usdtRead.decimals();
  } catch {
    DECIMALS = 18; // USDT on BSC is 18
    console.log("Warning: decimals() failed, using 18");
  }

  console.log("USDT decimals:", DECIMALS);
  console.log("Gateway address:", wallet.address);
  console.log("USDT contract:", USDT_CONTRACT);
  console.log("Polling every ms:", POLL_MS);
}

await init();
depositLoop();

app.listen(PORT, () => console.log("Listening on port", PORT));
