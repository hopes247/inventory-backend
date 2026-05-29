// ─────────────────────────────────────────────────────────────────────────────
// server.js  —  Inventory Management API
// Stack: Node.js + Express + MySQL2
//
// Setup:
//   npm install express mysql2 cors dotenv
//   node server.js
//
// MySQL schema is auto-initialized on first run (see initDB).
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express = require("express");
const mysql   = require("mysql2/promise");
const cors    = require("cors");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── DB Connection Pool ────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || "localhost",
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASS     || "",
  database: process.env.DB_NAME     || "inventory_db",
  waitForConnections: true,
  connectionLimit: 10,
});

// ── Initialize Database Schema ────────────────────────────────────────────────
async function initDB() {
  const conn = await pool.getConnection();
  try {
    // Create database if not exists
    await conn.query(`CREATE DATABASE IF NOT EXISTS inventory_db`);
    await conn.query(`USE inventory_db`);

    // item_types table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS item_types (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        type_name VARCHAR(100) NOT NULL UNIQUE
      )
    `);

    // Seed item_types
    await conn.query(`
      INSERT IGNORE INTO item_types (type_name)
      VALUES ('Electronics'),('Furniture'),('Clothing'),('Books'),('Sports'),('Appliances')
    `);

    // purchases table (groups items bought together)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // items table with FK to item_types and purchases
    await conn.query(`
      CREATE TABLE IF NOT EXISTS items (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        purchase_id     INT NOT NULL,
        name            VARCHAR(255) NOT NULL,
        purchase_date   DATE NOT NULL,
        stock_available TINYINT(1) NOT NULL DEFAULT 0,
        item_type_id    INT NOT NULL,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (item_type_id) REFERENCES item_types(id),
        FOREIGN KEY (purchase_id)  REFERENCES purchases(id) ON DELETE CASCADE
      )
    `);

    console.log("✅ Database initialized");
  } finally {
    conn.release();
  }
}

// ── Validation Middleware ─────────────────────────────────────────────────────
function validateItem(item) {
  const errors = {};
  if (!item.name || String(item.name).trim().length < 2)
    errors.name = "Item name must be at least 2 characters.";
  if (!item.item_type_id)
    errors.item_type_id = "Item type is required.";
  if (!item.purchase_date)
    errors.purchase_date = "Purchase date is required.";
  else if (isNaN(Date.parse(item.purchase_date)))
    errors.purchase_date = "Purchase date is invalid.";
  return errors;
}

// ── GET /api/item-types — list all types ─────────────────────────────────────
app.get("/api/item-types", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM item_types ORDER BY type_name");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/items — fetch all items with JOIN ───────────────────────────────
// JOIN query: items JOIN item_types ON items.item_type_id = item_types.id
app.get("/api/items", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        i.id,
        i.purchase_id,
        i.name,
        i.purchase_date,
        i.stock_available,
        i.created_at,
        it.id        AS item_type_id,
        it.type_name
      FROM items i
      JOIN item_types it ON i.item_type_id = it.id
      ORDER BY i.purchase_id DESC, i.id ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/purchases — submit a purchase with multiple items ───────────────
// Body: { items: [ { name, item_type_id, purchase_date, stock_available } ] }
app.post("/api/purchases", async (req, res) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "At least one item is required." });

  // Validate all items
  const allErrors = items.map(validateItem);
  if (allErrors.some(e => Object.keys(e).length > 0))
    return res.status(422).json({ errors: allErrors });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Create purchase record
    const [purchaseResult] = await conn.query(
      "INSERT INTO purchases () VALUES ()"
    );
    const purchaseId = purchaseResult.insertId;

    // 2. Insert each item (batch INSERT)
    const values = items.map(item => [
      purchaseId,
      item.name.trim(),
      item.purchase_date,
      item.stock_available ? 1 : 0,
      parseInt(item.item_type_id),
    ]);

    await conn.query(
      `INSERT INTO items (purchase_id, name, purchase_date, stock_available, item_type_id)
       VALUES ?`,
      [values]
    );

    await conn.commit();
    res.status(201).json({ purchase_id: purchaseId, item_count: items.length });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ── PUT /api/items/:id — update a single item ────────────────────────────────
app.put("/api/items/:id", async (req, res) => {
  const { id } = req.params;
  const { name, item_type_id, purchase_date, stock_available } = req.body;

  const errors = validateItem({ name, item_type_id, purchase_date });
  if (Object.keys(errors).length)
    return res.status(422).json({ errors });

  try {
    const [result] = await pool.query(
      `UPDATE items
       SET name = ?, item_type_id = ?, purchase_date = ?, stock_available = ?
       WHERE id = ?`,
      [name.trim(), parseInt(item_type_id), purchase_date, stock_available ? 1 : 0, id]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ error: "Item not found." });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/items/:id ─────────────────────────────────────────────────────
app.delete("/api/items/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query("DELETE FROM items WHERE id = ?", [id]);
    if (result.affectedRows === 0)
      return res.status(404).json({ error: "Item not found." });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
}).catch(err => {
  console.error("Failed to initialize DB:", err);
  process.exit(1);
});

