require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const mongoose = require("mongoose");

const app = express();

app.use(cors());
app.use(express.json());

// ---------------- MongoDB Connection ----------------
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    isConnected = true;
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
    throw err;
  }
}

// Ensure DB connects before handling any request (works with serverless cold starts too)
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: "Database connection failed." });
  }
});

// ---------------- Booking Schema ----------------
const bookingSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  date: { type: String, required: true }, // e.g. "Wed Jul 16 2026"
  slot: { type: String, required: true }, // e.g. "12:00 PM - 1:00 PM"
  createdAt: { type: Date, default: Date.now },
});

// Prevent the same slot on the same date from being booked twice
bookingSchema.index({ date: 1, slot: 1 }, { unique: true });

const Booking = mongoose.models.Booking || mongoose.model("Booking", bookingSchema);

// ---------------- Quote Schema ----------------
const quoteSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const Quote = mongoose.models.Quote || mongoose.model("Quote", quoteSchema);

// ---------------- Mailer (optional — only used if EMAIL/PASSWORD are set) ----------------
const emailEnabled = !!(process.env.EMAIL && process.env.PASSWORD);

const transporter = emailEnabled
  ? nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL,
        pass: process.env.PASSWORD,
      },
    })
  : null;

async function sendMailSafe(options) {
  if (!emailEnabled) return; // Email not configured — skip silently, DB save is what matters
  try {
    await transporter.sendMail(options);
  } catch (error) {
    console.error("Email sending failed:", error.message);
  }
}

app.get("/", (req, res) => {
  res.send("Server is running.");
});

app.post("/send-email", async (req, res) => {
  const { name, email, phone, message } = req.body;

  if (!name || !email || !phone || !message) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }

  try {
    // Save the quote request to the database — this is the source of truth
    await Quote.create({ name, email, phone, message });
  } catch (error) {
    console.error("Failed to save quote to database:", error.message);
    return res.status(500).json({ success: false, message: "Failed to save your request. Please try again." });
  }

  // Notification email is optional — fires only if EMAIL/PASSWORD are configured
  await sendMailSafe({
    from: process.env.EMAIL,
    to: process.env.TOEMAIL,
    subject: "New Quote Request",
    text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\nMessage: ${message}`,
  });

  res.json({ success: true, message: "Request saved successfully!" });
});

// ---------------- Get booked slots for a date ----------------
app.get("/booked-slots", async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({ success: false, message: "Date is required." });
  }

  try {
    const bookings = await Booking.find({ date }).select("slot -_id");
    const bookedSlots = bookings.map((b) => b.slot);
    res.json({ success: true, bookedSlots });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to fetch booked slots." });
  }
});

// ---------------- Book a consultation ----------------
app.post("/book-consultation", async (req, res) => {
  const { name, email, phone, date, slot } = req.body;

  if (!name || !email || !phone || !date || !slot) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }

  try {
    // Save to DB first — this is what actually prevents double-booking
    await Booking.create({ name, email, phone, date, slot });
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate key -> slot already booked by someone else
      return res.status(409).json({
        success: false,
        message: "This slot has just been booked by someone else. Please choose another slot.",
      });
    }
    console.error(error);
    return res.status(500).json({ success: false, message: "Booking failed. Please try again." });
  }

  // Confirmation emails are optional — fire only if EMAIL/PASSWORD are configured
  await sendMailSafe({
    from: process.env.EMAIL,
    to: process.env.TOEMAIL,
    subject: "New Consultation Booking",
    text: `A new consultation has been booked.\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\nDate: ${date}\nTime Slot: ${slot}`,
  });

  await sendMailSafe({
    from: process.env.EMAIL,
    to: email,
    subject: "Consultation Booking Confirmed - Al Raheem Technologies",
    text: `Hi ${name},\n\nYour free consultation with Al Raheem Technologies Pvt Ltd has been booked.\n\nDate: ${date}\nTime Slot: ${slot}\n\nWe will reach out to you shortly. Thank you!\n\nAl Raheem Technologies Pvt Ltd`,
  });

  res.json({ success: true, message: "Consultation booked successfully!" });
});

// ---------------- (Optional) list all bookings — useful for an admin view later ----------------
app.get("/bookings", async (req, res) => {
  try {
    const bookings = await Booking.find().sort({ createdAt: -1 });
    res.json({ success: true, bookings });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to fetch bookings." });
  }
});

// ---------------- (Optional) list all quote requests — useful for an admin view later ----------------
app.get("/quotes", async (req, res) => {
  try {
    const quotes = await Quote.find().sort({ createdAt: -1 });
    res.json({ success: true, quotes });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to fetch quotes." });
  }
});

module.exports = app;
