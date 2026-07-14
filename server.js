require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { MongoClient } = require("mongodb");

const app = express();

app.use(cors());
app.use(express.json());

/* ------------------------------------------------------------------ */
/* TEDx Registration + Admin Panel                                     */
/* ------------------------------------------------------------------ */

const mongoUri = process.env.MONGODB_URI || "";
const mongoDbName = process.env.MONGODB_DB_NAME || "alraheem";
let registrationsCollection;

async function initMongo() {
  if (!mongoUri) {
    console.error("Missing MONGODB_URI environment variable.");
    process.exit(1);
  }

  const client = new MongoClient(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  await client.connect();
  const db = client.db(mongoDbName);
  registrationsCollection = db.collection("alraheem");
  console.log(`Connected to MongoDB database: ${mongoDbName}, collection: alraheem`);
}

initMongo().catch((err) => {
  console.error("MongoDB connection error:", err);
  process.exit(1);
});

// ---- Uploads (payment screenshots) ----
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|pdf/;
    const ok = allowed.test(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error("Only image or PDF files are allowed"), ok);
  },
});

// ---- Admin auth (simple token derived from credentials, stateless) ----
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "tedx-al-raheem-secret";

function makeToken(username, password) {
  return crypto
    .createHmac("sha256", ADMIN_SECRET)
    .update(`${username}:${password}`)
    .digest("hex");
}
const VALID_TOKEN = makeToken(ADMIN_USERNAME, ADMIN_PASSWORD);

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== VALID_TOKEN) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

// ---- Public: submit registration ----
app.post("/api/register", upload.single("paymentScreenshot"), (req, res) => {
  try {
    const {
      fullName,
      cnic,
      email,
      whatsapp,
      phone,
      city,
      organization,
      degreeProgram,
      semesterYear,
      jobTitle,
      category,
      paymentMethod,
      transactionId,
      attendedBefore,
      hearAbout,
      declaration,
    } = req.body;

    // Basic required-field validation
    const required = { fullName, cnic, category, declaration };
    for (const [key, val] of Object.entries(required)) {
      if (!val) {
        return res
          .status(400)
          .json({ success: false, message: `Missing required field: ${key}` });
      }
    }
    if (declaration !== "true" && declaration !== true) {
      return res.status(400).json({
        success: false,
        message: "You must confirm the declaration checkbox.",
      });
    }

    const entry = {
      id: uuidv4(),
      fullName,
      cnic,
      email: email || "",
      whatsapp: whatsapp || "",
      phone: phone || "",
      city: city || "",
      organization: organization || "",
      degreeProgram: degreeProgram || "",
      semesterYear: semesterYear || "",
      jobTitle: jobTitle || "",
      category,
      paymentMethod: paymentMethod || "",
      transactionId: transactionId || "",
      paymentScreenshot: req.file ? `/uploads/${req.file.filename}` : "",
      attendedBefore: attendedBefore || "No",
      hearAbout: hearAbout || "",
      declaration: true,
      status: "pending", // pending | approved | rejected
      checkedIn: false,
      createdAt: new Date().toISOString(),
    };

    await registrationsCollection.insertOne(entry);

    res.json({
      success: true,
      message: "Registration submitted successfully!",
      id: entry.id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Registration failed." });
  }
});

// ---- Admin: login ----
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return res.json({ success: true, token: VALID_TOKEN });
  }
  res.status(401).json({ success: false, message: "Invalid credentials" });
});

// ---- Admin: list / search registrations ----
app.get("/api/admin/registrations", requireAdmin, async (req, res) => {
  try {
    const { search = "", status = "", category = "", checkedIn = "" } = req.query;
    let results = await registrationsCollection.find({}).toArray();

    if (search) {
      const q = search.toLowerCase();
      results = results.filter(
        (r) =>
          (r.fullName || "").toLowerCase().includes(q) ||
          (r.cnic || "").toLowerCase().includes(q) ||
          (r.email || "").toLowerCase().includes(q) ||
          (r.phone || "").toLowerCase().includes(q) ||
          (r.whatsapp || "").toLowerCase().includes(q)
      );
    }
    if (status) results = results.filter((r) => r.status === status);
    if (category) results = results.filter((r) => r.category === category);
    if (checkedIn) results = results.filter((r) => String(r.checkedIn) === checkedIn);

    results = [...results].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    res.json({ success: true, count: results.length, registrations: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to load registrations." });
  }
});

// ---- Admin: update a registration (approve/reject/check-in) ----
app.patch("/api/admin/registrations/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;
    const entry = await registrationsCollection.findOne({ id });

    if (!entry) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    let update = {};
    if (action === "approve") update.status = "approved";
    else if (action === "reject") update.status = "rejected";
    else if (action === "checkin") update.checkedIn = true;
    else if (action === "uncheckin") update.checkedIn = false;
    else return res.status(400).json({ success: false, message: "Invalid action" });

    await registrationsCollection.updateOne({ id }, { $set: update });
    const updated = await registrationsCollection.findOne({ id });
    res.json({ success: true, registration: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to update registration." });
  }
});

// ---- Admin: export checked-in delegates as CSV ----
app.get("/api/admin/export/checked-in", requireAdmin, async (req, res) => {
  try {
    const rows = await registrationsCollection
      .find({ checkedIn: true })
      .toArray();

    const headers = [
      "Full Name",
      "CNIC",
      "Email",
      "WhatsApp",
      "Phone",
      "City",
      "Organization",
      "Degree/Program",
      "Category",
      "Status",
    ];

    const escapeCsv = (val) => `"${String(val ?? "").replace(/"/g, '""')}"`;

    const lines = [headers.join(",")];
    rows.forEach((r) => {
      lines.push(
        [
          r.fullName,
          r.cnic,
          r.email,
          r.whatsapp,
          r.phone,
          r.city,
          r.organization,
          r.degreeProgram,
          r.category,
          r.status,
        ]
          .map(escapeCsv)
          .join(",")
      );
    });

    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="checked-in-delegates.csv"`
    );
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to export checked-in delegates." });
  }
});

// ---- Serve uploaded payment screenshots (admin only) ----
app.get("/uploads/:filename", requireAdmin, (req, res) => {
  const filePath = path.join(uploadsDir, req.params.filename);
  if (!filePath.startsWith(uploadsDir)) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

/* ------------------------------------------------------------------ */

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL,
    pass: process.env.PASSWORD,
  },
});

app.get("/", (req, res) => {
  res.send("Server is running.");
});

app.post("/send-email", async (req, res) => {
  const { name, email, phone, message } = req.body;
  try {
    await transporter.sendMail({
      from: process.env.EMAIL,
      to: process.env.TOEMAIL,
      subject: "New Quote Request",
      text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\nMessage: ${message}`,
    });
    res.json({ success: true, message: "Email sent successfully!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Email sending failed." });
  }
});

// Local/dev server (Vercel uses the exported `app` directly and ignores this)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;