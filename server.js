
import express from "express";
import crypto from "node:crypto";
import pg from "pg";

const app = express();
const { Pool } = pg;

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const PRICE_STARS = Number(process.env.PRICE_STARS || 100);
const PERIOD = 2592000;

if (!BOT_TOKEN || !WEBHOOK_SECRET || !DATABASE_URL) {
  throw new Error("Missing required environment variables");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false"
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json());

async function telegram(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    throw new Error(`Telegram API error: ${result.description}`);
  }

  return result.result;
}

function validateInitData(raw) {
  if (!raw || typeof raw !== "string") return null;

  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!hash || !authDate) return null;
  if (Math.abs(Date.now() / 1000 - authDate) > 3600) return null;

  const entries = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b));

  const checkString = entries
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const expected = crypto
    .createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hash, "hex");

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const user = JSON.parse(params.get("user") || "null");
    return user && Number.isSafeInteger(user.id) ? user : null;
  } catch {
    return null;
  }
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id BIGINT PRIMARY KEY,
      active_until BIGINT NOT NULL DEFAULT 0,
      charge_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_payments (
      charge_id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      payload TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

app.get("/", (_req, res) => {
  res.json({ service: "VOLYA", status: "running" });
});

app.post("/api/invoice", async (req, res) => {
  try {
    const user = validateInitData(req.body?.initData);
    if (!user) return res.status(401).json({ error: "Invalid Telegram session" });

    const invoice = await telegram("createInvoiceLink", {
      title: "ВОЛЯ — подписка на 30 дней",
      description: "Доступ к приложению ВОЛЯ на 30 дней",
      payload: `volya_monthly_${user.id}_${crypto.randomUUID()}`,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: "Подписка ВОЛЯ на 30 дней", amount: PRICE_STARS }],
      subscription_period: PERIOD
    });

    res.json({ invoice });
  } catch (error) {
    console.error("Invoice creation failed:", error.message);
    res.status(500).json({ error: "Could not create invoice" });
  }
});

app.post("/api/status", async (req, res) => {
  const user = validateInitData(req.body?.initData);
  if (!user) return res.status(401).json({ error: "Invalid Telegram session" });

  try {
    const result = await pool.query(
      "SELECT active_until FROM subscriptions WHERE user_id = $1",
      [String(user.id)]
    );

    const activeUntil = Number(result.rows[0]?.active_until || 0);

    res.json({
      active: activeUntil > Math.floor(Date.now() / 1000),
      activeUntil
    });
  } catch (error) {
    console.error("Status lookup failed:", error.message);
    res.status(500).json({ error: "Could not check subscription" });
  }
});

app.post("/telegram/webhook", async (req, res) => {
  if (req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  try {
    const update = req.body;

    if (update.pre_checkout_query) {
      const query = update.pre_checkout_query;
      await telegram("answerPreCheckoutQuery", {
        pre_checkout_query_id: query.id,
        ok: true
      });
    }

    const payment = update.message?.successful_payment;
    if (!payment) return;

    const userId = update.message.from?.id;
    const payload = payment.invoice_payload;
    const chargeId = payment.telegram_payment_charge_id;

    if (!userId || !chargeId || !payload?.startsWith(`volya_monthly_${userId}_`)) {
      console.error("Payment payload/user mismatch");
      return;
    }

    const expiration = Number(payment.subscription_expiration_date || 0);
    if (!expiration) {
      console.error("Missing subscription expiration date");
      return;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const inserted = await client.query(
        `INSERT INTO processed_payments (charge_id, user_id, payload)
         VALUES ($1, $2, $3)
         ON CONFLICT (charge_id) DO NOTHING
         RETURNING charge_id`,
        [chargeId, String(userId), payload]
      );

      if (inserted.rowCount) {
        await client.query(
          `INSERT INTO subscriptions (user_id, active_until, charge_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO UPDATE SET
             active_until = GREATEST(subscriptions.active_until, EXCLUDED.active_until),
             charge_id = EXCLUDED.charge_id,
             updated_at = NOW()`,
          [String(userId), expiration, chargeId]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Payment processing failed:", error.message);
  }
});

initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`VOLYA server listening on ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error.message);
    process.exit(1);
  });

