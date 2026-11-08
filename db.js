const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbDir = path.join(__dirname, 'data');
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(dbDir, 'inventify.db');
const usersSeedPath = path.join(dbDir, 'users.json');

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

let dbPromise = null;

function readSeedUsers() {
  if (!fs.existsSync(usersSeedPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(usersSeedPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function writeSeedUsers(users) {
  const tempPath = `${usersSeedPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(users, null, 2));
  fs.renameSync(tempPath, usersSeedPath);
}

function persistDatabase(db) {
  const data = db.export();
  const tempPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, Buffer.from(data));
    fs.renameSync(tempPath, dbPath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw error;
  }
}

function statementExists(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const exists = stmt.step();
  stmt.reset();
  return exists;
}

function createDefaultSeedData(db) {
  const categoryRows = [
    ['Electronics'],
    ['Consumables'],
    ['Hardware']
  ];

  categoryRows.forEach(([name]) => {
    if (!statementExists(db, 'SELECT 1 FROM categories WHERE name = ?', [name])) {
      db.run('INSERT INTO categories (name) VALUES (?)', [name]);
    }
  });

  const supplierRows = [
    ['Apex Tech Global', 'hello@apextech.com', '0800-123-456', 'Singapore'],
    ['PackPro Supply', 'support@packpro.com', '0800-654-321', 'Manila'],
    ['Northwind Industrial', 'sales@northwind.com', '0800-987-654', 'Jakarta']
  ];

  supplierRows.forEach(([name, email, phone, location]) => {
    if (!statementExists(db, 'SELECT 1 FROM suppliers WHERE name = ?', [name])) {
      db.run('INSERT INTO suppliers (name, email, phone, location) VALUES (?, ?, ?, ?)', [name, email, phone, location]);
    }
  });

  const seedUsers = readSeedUsers();
  seedUsers.forEach((user) => {
    if (!user || !user.email) {
      return;
    }

    const normalizedEmail = String(user.email).trim().toLowerCase();
    const payload = [
      user.id || `user-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      String(user.businessName || '').trim(),
      String(user.fullName || '').trim(),
      normalizedEmail,
      String(user.passwordHash || '')
    ];

    if (!statementExists(db, 'SELECT 1 FROM users WHERE LOWER(email) = LOWER(?)', [normalizedEmail])) {
      db.run(
        'INSERT INTO users (id, businessName, fullName, email, passwordHash) VALUES (?, ?, ?, ?, ?)',
        payload
      );
    }
  });
}

async function initializeDatabase() {
  if (!dbPromise) {
    dbPromise = initSqlJs().then(SQL => {
      let db;
      if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
        const integrityCheck = db.exec('PRAGMA integrity_check');
        if (integrityCheck[0]?.values[0]?.[0] !== 'ok') {
          throw new Error('Database disk image is malformed');
        }
      } else {
        db = new SQL.Database();
      }

      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          businessName TEXT NOT NULL,
          fullName TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          passwordHash TEXT NOT NULL,
          createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS workspaces (
          user_id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS suppliers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          email TEXT,
          phone TEXT,
          location TEXT,
          createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sku TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          stock_quantity INTEGER NOT NULL DEFAULT 0,
          min_stock INTEGER NOT NULL DEFAULT 0,
          price REAL NOT NULL DEFAULT 0,
          cost REAL NOT NULL DEFAULT 0,
          icon TEXT,
          location TEXT,
          unit TEXT NOT NULL DEFAULT 'pcs',
          createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS purchase_orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          po_number TEXT NOT NULL UNIQUE,
          item_name TEXT NOT NULL,
          supplier_name TEXT NOT NULL,
          quantity INTEGER NOT NULL,
          unit TEXT NOT NULL,
          cost REAL NOT NULL DEFAULT 0,
          lead_days INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'urgent',
          createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS inventory_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_sku TEXT NOT NULL,
          movement_type TEXT NOT NULL,
          quantity INTEGER NOT NULL,
          reason TEXT,
          createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(product_sku) REFERENCES products(sku)
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS sales (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sale_number TEXT NOT NULL UNIQUE,
          customer_name TEXT,
          total_amount REAL NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS sale_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sale_id INTEGER NOT NULL,
          product_sku TEXT NOT NULL,
          quantity INTEGER NOT NULL,
          unit_price REAL NOT NULL,
          createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(sale_id) REFERENCES sales(id),
          FOREIGN KEY(product_sku) REFERENCES products(sku)
        );
      `);

      const countStmt = db.prepare('SELECT COUNT(*) as total FROM products');
      countStmt.step();
      const rowCount = countStmt.getAsObject().total;
      countStmt.reset();

      if (rowCount === 0) {
        createDefaultSeedData(db);
      }

      persistDatabase(db);
      return db;
    }).catch(error => {
      const isCorrupt = /database disk image is malformed|file is not a database/i.test(error.message);
      if (!isCorrupt || !fs.existsSync(dbPath)) {
        throw error;
      }

      const backupPath = path.join(dbDir, `inventify.db.corrupt-${Date.now()}`);
      fs.renameSync(dbPath, backupPath);
      console.warn(`Malformed database preserved at ${backupPath}; rebuilding from saved account records.`);
      dbPromise = null;
      return initializeDatabase();
    });
  }

  return dbPromise;
}

async function createUser({ id, businessName, fullName, email, passwordHash }) {
  const db = await initializeDatabase();
  const normalizedEmail = String(email).trim().toLowerCase();
  const existingUsers = readSeedUsers();
  const hasSeededUser = existingUsers.some((user) => String(user.email || '').trim().toLowerCase() === normalizedEmail);

  db.run(
    'INSERT INTO users (id, businessName, fullName, email, passwordHash) VALUES (?, ?, ?, ?, ?)',
    [id, businessName, fullName, normalizedEmail, passwordHash]
  );

  if (!hasSeededUser) {
    const nextUsers = [
      ...existingUsers,
      {
        id,
        businessName,
        fullName,
        email: normalizedEmail,
        passwordHash
      }
    ];
    writeSeedUsers(nextUsers);
  }

  persistDatabase(db);
}

async function getUserByEmail(email) {
  const db = await initializeDatabase();
  const stmt = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)');
  stmt.bind([email]);

  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.reset();
    return row;
  }

  stmt.reset();
  return null;
}

async function getUserById(id) {
  const db = await initializeDatabase();
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  stmt.bind([id]);

  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.reset();
    return row;
  }

  stmt.reset();
  return null;
}

async function listUsers() {
  const db = await initializeDatabase();
  const stmt = db.prepare('SELECT id, businessName, fullName, email, createdAt FROM users ORDER BY createdAt DESC');
  const rows = [];

  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }

  stmt.reset();
  return rows;
}

async function getWorkspace(userId) {
  const db = await initializeDatabase();
  const stmt = db.prepare('SELECT data FROM workspaces WHERE user_id = ?');
  stmt.bind([userId]);

  if (!stmt.step()) {
    stmt.reset();
    return null;
  }

  const row = stmt.getAsObject();
  stmt.reset();
  return JSON.parse(row.data);
}

async function saveWorkspace(userId, workspace) {
  const db = await initializeDatabase();
  const data = JSON.stringify(workspace);
  db.run(
    `INSERT INTO workspaces (user_id, data, updatedAt)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updatedAt = CURRENT_TIMESTAMP`,
    [userId, data]
  );
  persistDatabase(db);
}

async function listProducts() {
  const db = await initializeDatabase();
  const stmt = db.prepare('SELECT * FROM products ORDER BY createdAt DESC');
  const rows = [];

  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }

  stmt.reset();
  return rows;
}

async function createProduct(product) {
  const db = await initializeDatabase();
  const { sku, name, category, stock_quantity, min_stock, price, cost, icon, location, unit } = product;
  db.run(
    'INSERT INTO products (sku, name, category, stock_quantity, min_stock, price, cost, icon, location, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [sku, name, category, stock_quantity || 0, min_stock || 0, price || 0, cost || 0, icon || '📦', location || 'Receiving', unit || 'pcs']
  );
  persistDatabase(db);
}

async function listSuppliers() {
  const db = await initializeDatabase();
  const stmt = db.prepare('SELECT * FROM suppliers ORDER BY createdAt DESC');
  const rows = [];

  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }

  stmt.reset();
  return rows;
}

async function listPurchaseOrders() {
  const db = await initializeDatabase();
  const stmt = db.prepare('SELECT * FROM purchase_orders ORDER BY createdAt DESC');
  const rows = [];

  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }

  stmt.reset();
  return rows;
}

module.exports = {
  initializeDatabase,
  createUser,
  getUserByEmail,
  getUserById,
  listUsers,
  getWorkspace,
  saveWorkspace,
  listProducts,
  createProduct,
  listSuppliers,
  listPurchaseOrders
};
