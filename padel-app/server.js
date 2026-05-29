const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || "/tmp";
const DB_FILE = path.join(DATA_DIR, "reservations.json");

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return []; }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf8");
}
if (!fs.existsSync(DB_FILE)) writeDB([]);

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
  "09:00 - 10:30",
  "10:30 - 12:00",
  "12:00 - 13:30",
  "16:00 - 17:30",
  "17:30 - 19:00",
  "19:00 - 20:30",
  "20:30 - 22:00",
];

const MAX_PER_WEEK = 2;
const MAX_ADVANCE_HOURS = 24;

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
  return new Date(`${dateStr}T${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00`).getTime();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/auth", (req, res) => {
  if (req.body.code === getMonthlyCode()) return res.json({ ok: true });
  res.status(401).json({ error: "Invalid access code." });
});

app.get("/api/admin/code", (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden." });
  const now = new Date();
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  res.json({ code: getMonthlyCode(), month: months[now.getMonth()] + " " + now.getFullYear() });
});

app.get("/api/reservations", (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date param required" });
  res.json(readDB().filter(r => r.date === date));
});

app.get("/api/my-reservations", (req, res) => {
  const { lastName, unit } = req.query;
  if (!lastName || !unit) return res.status(400).json({ error: "lastName and unit required" });
  const rows = readDB().filter(
    r => r.lastName.toLowerCase() === lastName.toLowerCase() &&
         r.unit.toLowerCase() === unit.toLowerCase()
  ).sort((a,b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot));
  res.json(rows);
});

app.post("/api/reservations", (req, res) => {
  const { date, slot, firstName, lastName, unit, phase, companions } = req.body;
  if (!date || !slot || !firstName || !lastName || !unit || !phase || !companions)
    return res.status(400).json({ error: "All fields are required." });
  if (!SLOTS.includes(slot))
    return res.status(400).json({ error: "Invalid slot." });
  const now = Date.now();
  const slotMs = slotStartMs(date, slot);
  if (slotMs < now)
    return res.status(400).json({ error: "This slot is in the past." });
  if ((slotMs - now) / 3600000 > MAX_ADVANCE_HOURS)
    return res.status(400).json({ error: `Slots can only be booked up to ${MAX_ADVANCE_HOURS} hours in advance.` });
  const db = readDB();
  if (db.find(r => r.date === date && r.slot === slot))
    return res.status(409).json({ error: "This slot was just booked by someone else." });
  const { monStr, sunStr } = getWeekBounds(date);
  const weekCount = db.filter(r =>
    r.lastName.toLowerCase() === lastName.toLowerCase() &&
    r.unit.toLowerCase() === unit.toLowerCase() &&
    r.date >= monStr && r.date <= sunStr
  ).length;
  if (weekCount >= MAX_PER_WEEK)
    return res.status(400).json({ error: `Weekly limit of ${MAX_PER_WEEK} reservations reached.` });
  const entry = { id: genId(), date, slot, firstName, lastName, unit, phase, companions, createdAt: now };
  db.push(entry);
  writeDB(db);
  res.json({ id: entry.id });
});

app.delete("/api/reservations/:id", (req, res) => {
  const { id } = req.params;
  const { lastName, unit } = req.body;
  if (!lastName || !unit) return res.status(400).json({ error: "Last name and unit required." });
  const db = readDB();
  const row = db.find(r => r.id === id);
  if (!row) return res.status(404).json({ error: "Reservation not found." });
  if (row.lastName.toLowerCase() !== lastName.toLowerCase() || row.unit.toLowerCase() !== unit.toLowerCase())
    return res.status(403).json({ error: "Only the person who booked can cancel." });
  writeDB(db.filter(r => r.id !== id));
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Padel server running → http://localhost:${PORT}`));
