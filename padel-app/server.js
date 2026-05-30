const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Base de données PostgreSQL ────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      slot TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      unit TEXT NOT NULL,
      phase TEXT NOT NULL,
      companions TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(date, slot)
    )
  `);
  console.log("Database ready.");
}

// ── Config ───────────────────────────────────────────────────────────────────
const SECRET_BASE = process.env.SECRET_BASE || "SAVIA";
const SECRET_PIN  = process.env.SECRET_PIN  || "47";
const ADMIN_KEY   = process.env.ADMIN_KEY   || "admin123";

function getMonthlyCode() {
  const now  = new Date();
  const mm   = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const hash = crypto.createHash("md5").update(SECRET_PIN + mm + yyyy).digest("hex");
  const twoDigits = String(parseInt(hash.slice(0, 4), 16) % 90 + 10);
  return (SECRET_BASE + twoDigits).toUpperCase();
}

const SLOTS = [
  "09:00 - 10:30","10:30 - 12:00","12:00 - 13:30","16:00 - 17:30",
  "17:30 - 19:00","19:00 - 20:30","20:30 - 22:00",
];

const MAX_PER_WEEK     = 2;
const MAX_ADVANCE_HOURS = 24;
const TULUM_OFFSET_MS  = 5 * 60 * 60 * 1000;

function genId() { return crypto.randomBytes(8).toString("hex"); }

function getWeekBounds(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(d); mon.setDate(d.getDate() + diffToMon);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return { monStr: mon.toISOString().slice(0,10), sunStr: sun.toISOString().slice(0,10) };
}

function slotStartMs(dateStr, slotLabel) {
  const hhmm = slotLabel.split("-")[0].trim();
  const [hh, mm] = hhmm.split(":").map(Number);
  const [yyyy, mo, dd] = dateStr.split("-").map(Number);
  return Date.UTC(yyyy, mo - 1, dd, hh, mm, 0) + TULUM_OFFSET_MS;
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Auth ─────────────────────────────────────────────────────────────────────
app.post("/api/auth", (req, res) => {
  if (req.body.code === getMonthlyCode()) return res.json({ ok: true });
  res.status(401).json({ error: "Invalid access code." });
});

// ── Admin : codes des 6 prochains mois ───────────────────────────────────────
app.get("/api/admin/code", (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden." });
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const now = new Date();
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const d    = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const mm   = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hash = crypto.createHash("md5").update(SECRET_PIN + mm + yyyy).digest("hex");
    const code = (SECRET_BASE + String(parseInt(hash.slice(0,4), 16) % 90 + 10)).toUpperCase();
    codes.push({ month: months[d.getMonth()] + " " + yyyy, code });
  }
  res.json(codes);
});

// ── GET réservations d'une date ──────────────────────────────────────────────
app.get("/api/reservations", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date param required" });
  const { rows } = await pool.query("SELECT * FROM reservations WHERE date=$1", [date]);
  res.json(rows.map(r => ({
    id: r.id, date: r.date, slot: r.slot,
    firstName: r.first_name, lastName: r.last_name,
    unit: r.unit, phase: r.phase, companions: r.companions,
  })));
});

// ── GET mes réservations ─────────────────────────────────────────────────────
app.get("/api/my-reservations", async (req, res) => {
  const { lastName, unit } = req.query;
  if (!lastName || !unit) return res.status(400).json({ error: "lastName and unit required" });
  const { rows } = await pool.query(
    "SELECT * FROM reservations WHERE lower(last_name)=lower($1) AND lower(unit)=lower($2) ORDER BY date, slot",
    [lastName, unit]
  );
  res.json(rows.map(r => ({
    id: r.id, date: r.date, slot: r.slot,
    firstName: r.first_name, lastName: r.last_name,
    unit: r.unit, phase: r.phase, companions: r.companions,
  })));
});

// ── POST créer une réservation ───────────────────────────────────────────────
app.post("/api/reservations", async (req, res) => {
  const { date, slot, firstName, lastName, unit, phase, companions } = req.body;
  if (!date || !slot || !firstName || !lastName || !unit || !phase || !companions)
    return res.status(400).json({ error: "All fields are required." });
  if (!SLOTS.includes(slot))
    return res.status(400).json({ error: "Invalid slot." });

  const now    = Date.now();
  const slotMs = slotStartMs(date, slot);
  if (slotMs < now)
    return res.status(400).json({ error: "This slot is in the past." });
  if ((slotMs - now) / 3_600_000 > MAX_ADVANCE_HOURS)
    return res.status(400).json({ error: `Slots can only be booked up to ${MAX_ADVANCE_HOURS} hours in advance.` });

  const { monStr, sunStr } = getWeekBounds(date);
  const { rows: weekRows } = await pool.query(
    "SELECT COUNT(*) FROM reservations WHERE lower(unit)=lower($1) AND date>=$2 AND date<=$3",
    [unit, monStr, sunStr]
  );
  if (parseInt(weekRows[0].count) >= MAX_PER_WEEK)
    return res.status(400).json({ error: `Weekly limit of ${MAX_PER_WEEK} reservations per unit reached.` });

  try {
    const id = genId();
    await pool.query(
      "INSERT INTO reservations(id,date,slot,first_name,last_name,unit,phase,companions,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, date, slot, firstName, lastName, unit, phase, companions, now]
    );
    res.json({ id });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "This slot was just booked by someone else." });
    throw e;
  }
});

// ── PATCH modifier une réservation ───────────────────────────────────────────
app.patch("/api/reservations/:id", async (req, res) => {
  const { id } = req.params;
  const { lastName, unit, firstName, phase, companions } = req.body;
  if (!lastName || !unit) return res.status(400).json({ error: "Last name and unit required." });
  const { rows } = await pool.query("SELECT * FROM reservations WHERE id=$1", [id]);
  if (!rows.length) return res.status(404).json({ error: "Reservation not found." });
  const row = rows[0];
  if (row.last_name.toLowerCase() !== lastName.toLowerCase() || row.unit.toLowerCase() !== unit.toLowerCase())
    return res.status(403).json({ error: "Only the person who booked can edit this reservation." });
  await pool.query(
    "UPDATE reservations SET first_name=$1, phase=$2, companions=$3 WHERE id=$4",
    [firstName || row.first_name, phase || row.phase, companions || row.companions, id]
  );
  res.json({ ok: true });
});

// ── DELETE annuler une réservation ───────────────────────────────────────────
app.delete("/api/reservations/:id", async (req, res) => {
  const { id } = req.params;
  const { lastName, unit } = req.body;
  if (!lastName || !unit) return res.status(400).json({ error: "Last name and unit required." });
  const { rows } = await pool.query("SELECT * FROM reservations WHERE id=$1", [id]);
  if (!rows.length) return res.status(404).json({ error: "Reservation not found." });
  const row = rows[0];
  if (row.last_name.toLowerCase() !== lastName.toLowerCase() || row.unit.toLowerCase() !== unit.toLowerCase())
    return res.status(403).json({ error: "Only the person who booked can cancel." });
  await pool.query("DELETE FROM reservations WHERE id=$1", [id]);
  res.json({ ok: true });
});

// ── Démarrage ────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`Padel server running on port ${PORT}`));
}).catch(err => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
