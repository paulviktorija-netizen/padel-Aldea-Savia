const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// On Railway, store data in /data (persistent volume). Fallback to local.
const DATA_DIR = process.env.DATA_DIR || "/tmp";
const DB_FILE = path.join(DATA_DIR, "reservations.json");

// ── Simple JSON file database ────────────────────────────────────────────────
function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf8");
}

// Initialize file if missing
if (!fs.existsSync(DB_FILE)) writeDB([]);

// ── Config ───────────────────────────────────────────────────────────────────
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
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay(); // 0 = Sunday
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diffToMon);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return {
    monStr: mon.toISOString().slice(0, 10),
    sunStr: sun.toISOString().slice(0, 10),
  };
}

function slotStartMs(dateStr, slotLabel) {
  const hhmm = slotLabel.split("–")[0].trim();
  const [hh, mm] = hhmm.split(":").map(Number);
  const d = new Date(`${dateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`);
  return d.getTime();
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Auth ─────────────────────────────────────────────────────────────────────
app.post("/api/auth", (req, res) => {
  if (req.body.code === ACCESS_CODE) return res.json({ ok: true });
  res.status(401).json({ error: "Invalid access code." });
});

// ── GET reservations for a date ──────────────────────────────────────────────
app.get("/api/reservations", (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date param required" });
  const rows = readDB().filter(r => r.date === date);
  res.json(rows);
});

// ── GET my reservations ──────────────────────────────────────────────────────
app.get("/api/my-reservations", (req, res) => {
  const { lastName, unit } = req.query;
  if (!lastName || !unit) return res.status(400).json({ error: "lastName and unit required" });
  const rows = readDB().filter(
    r => r.lastName.toLowerCase() === lastName.toLowerCase() &&
         r.unit.toLowerCase() === unit.toLowerCase()
  ).sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot));
  res.json(rows);
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
    return res.status(400).json({
      error: `Slots can only be booked up to ${MAX_ADVANCE_HOURS} hours in advance.`,
    });
  }

  const db = readDB();

  // Slot already taken?
  if (db.find(r => r.date === date && r.slot === slot)) {
    return res.status(409).json({ error: "This slot was just booked by someone else. Please choose another." });
  }

  // Weekly limit
  const { monStr, sunStr } = getWeekBounds(date);
  const weekCount = db.filter(
    r => r.lastName.toLowerCase() === lastName.toLowerCase() &&
         r.unit.toLowerCase() === unit.toLowerCase() &&
         r.date >= monStr && r.date <= sunStr
  ).length;

  if (weekCount >= MAX_PER_WEEK) {
    return res.status(400).json({
      error: `You already have ${MAX_PER_WEEK} reservations this week. The weekly limit is ${MAX_PER_WEEK}.`,
    });
  }

  const entry = {
    id: genId(),
    date, slot, firstName, lastName, unit, phase, companions,
    createdAt: now,
  };

  db.push(entry);
  writeDB(db);
  res.json({ id: entry.id });
});

// ── DELETE cancel reservation ────────────────────────────────────────────────
app.delete("/api/reservations/:id", (req, res) => {
  const { id } = req.params;
  const { lastName, unit } = req.body;

  if (!lastName || !unit) {
    return res.status(400).json({ error: "Last name and unit required to cancel." });
  }

  const db = readDB();
  const row = db.find(r => r.id === id);

  if (!row) return res.status(404).json({ error: "Reservation not found." });

  if (
    row.lastName.toLowerCase() !== lastName.toLowerCase() ||
    row.unit.toLowerCase() !== unit.toLowerCase()
  ) {
    return res.status(403).json({
      error: "The name or unit number does not match this reservation. Only the person who booked can cancel.",
    });
  }

  writeDB(db.filter(r => r.id !== id));
  res.json({ ok: true });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Padel server running → http://localhost:${PORT}`);
});
