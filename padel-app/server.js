const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// On Railway, store DB in /data (persistent volume). Fallback to local.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "reservations.db");

const db = new Database(DB_PATH);

// ── Schema ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    slot TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    unit TEXT NOT NULL,
    phase TEXT NOT NULL,
    companions TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(date, slot)
  )
`);

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Config (change ACCESS_CODE here or via env var) ──────────────────────────
const ACCESS_CODE = process.env.ACCESS_CODE || "ALDEАСAVIA3";

const SLOTS = [
  "09:00 – 10:30",
  "10:30 – 12:00",
  "12:00 – 13:30",
  "13:30 – 15:00",
  "17:30 – 19:00",
  "19:00 – 20:30",
  "20:30 – 22:00",
];

const MAX_PER_WEEK = 2;
const MAX_ADVANCE_HOURS = 24;

// ── Helpers ──────────────────────────────────────────────────────────────────
function genId() {
  return crypto.randomBytes(8).toString("hex");
}

function getWeekBounds(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setUTCDate(d.getUTCDate() + diffToMon);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  return {
    monStr: mon.toISOString().slice(0, 10),
    sunStr: sun.toISOString().slice(0, 10),
  };
}

function slotStartMs(dateStr, slotLabel) {
  const hhmm = slotLabel.split("–")[0].trim();
  const [hh, mm] = hhmm.split(":").map(Number);
  const d = new Date(`${dateStr}T${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00`);
  return d.getTime();
}

// ── Auth check endpoint ──────────────────────────────────────────────────────
app.post("/api/auth", (req, res) => {
  const { code } = req.body;
  if (code === ACCESS_CODE) return res.json({ ok: true });
  res.status(401).json({ error: "Invalid access code." });
});

// ── GET reservations for a date ──────────────────────────────────────────────
app.get("/api/reservations", (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date param required" });
  const rows = db.prepare(
    "SELECT * FROM reservations WHERE date = ? ORDER BY slot"
  ).all(date);
  res.json(rows.map(r => ({
    id: r.id,
    date: r.date,
    slot: r.slot,
    firstName: r.first_name,
    lastName: r.last_name,
    unit: r.unit,
    phase: r.phase,
    companions: r.companions,
  })));
});

// ── GET reservations by unit + lastName ─────────────────────────────────────
app.get("/api/my-reservations", (req, res) => {
  const { lastName, unit } = req.query;
  if (!lastName || !unit) return res.status(400).json({ error: "lastName and unit required" });
  const rows = db.prepare(
    "SELECT * FROM reservations WHERE lower(last_name) = lower(?) AND lower(unit) = lower(?) ORDER BY date, slot"
  ).all(lastName, unit);
  res.json(rows.map(r => ({
    id: r.id,
    date: r.date,
    slot: r.slot,
    firstName: r.first_name,
    lastName: r.last_name,
    unit: r.unit,
    phase: r.phase,
    companions: r.companions,
  })));
});

// ── POST create reservation ──────────────────────────────────────────────────
app.post("/api/reservations", (req, res) => {
  const { date, slot, firstName, lastName, unit, phase, companions } = req.body;

  if (!date || !slot || !firstName || !lastName || !unit || !phase || !companions) {
    return res.status(400).json({ error: "All fields are required." });
  }

  if (!SLOTS.includes(slot)) {
    return res.status(400).json({ error: "Invalid slot." });
  }

  const now = Date.now();
  const slotMs = slotStartMs(date, slot);

  if (slotMs < now) {
    return res.status(400).json({ error: "This slot is in the past." });
  }
  const hoursAhead = (slotMs - now) / 3_600_000;
  if (hoursAhead > MAX_ADVANCE_HOURS) {
    return res.status(400).json({ error: `Slots can only be booked up to ${MAX_ADVANCE_HOURS} hours in advance.` });
  }

  // Weekly limit
  const { monStr, sunStr } = getWeekBounds(date);
  const weekCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM reservations WHERE lower(last_name) = lower(?) AND lower(unit) = lower(?) AND date >= ? AND date <= ?"
  ).get(lastName, unit, monStr, sunStr).cnt;

  if (weekCount >= MAX_PER_WEEK) {
    return res.status(400).json({ error: `You already have ${MAX_PER_WEEK} reservations this week. The weekly limit is ${MAX_PER_WEEK}.` });
  }

  try {
    const id = genId();
    db.prepare(
      "INSERT INTO reservations (id, date, slot, first_name, last_name, unit, phase, companions, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(id, date, slot, firstName, lastName, unit, phase, companions, now);
    res.json({ id });
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "This slot was just booked by someone else. Please choose another." });
    }
    res.status(500).json({ error: "Server error." });
  }
});

// ── DELETE cancel reservation ────────────────────────────────────────────────
app.delete("/api/reservations/:id", (req, res) => {
  const { id } = req.params;
  const { lastName, unit } = req.body;

  if (!lastName || !unit) {
    return res.status(400).json({ error: "Last name and unit required to cancel." });
  }

  const row = db.prepare("SELECT * FROM reservations WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Reservation not found." });

  if (
    row.last_name.toLowerCase() !== lastName.toLowerCase() ||
    row.unit.toLowerCase() !== unit.toLowerCase()
  ) {
    return res.status(403).json({ error: "The name or unit number does not match this reservation. Only the person who booked can cancel." });
  }

  db.prepare("DELETE FROM reservations WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Padel reservation server running on http://localhost:${PORT}`);
});
