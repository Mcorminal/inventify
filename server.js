const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  createUser,
  getUserByEmail,
  getUserById,
  listUsers,
  getWorkspace,
  saveWorkspace,
  initializeDatabase
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const JWT_SECRET = process.env.JWT_SECRET || 'inventify-dev-secret-key';

function hashPassword(password) {
  return crypto
    .pbkdf2Sync(password, 'inventify-salt', 100000, 64, 'sha512')
    .toString('hex');
}

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      businessName: user.businessName,
      fullName: user.fullName
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Session expired or invalid token.' });
  }
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(ROOT_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'test.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'inventify-api' });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await getUserById(req.user.id);

  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  return res.json({
    user: {
      id: user.id,
      businessName: user.businessName,
      fullName: user.fullName,
      email: user.email
    }
  });
});

app.get('/api/workspace', authMiddleware, async (req, res) => {
  try {
    const workspace = await getWorkspace(req.user.id);
    return res.json({ workspace });
  } catch (error) {
    console.error('Unable to load workspace:', error);
    return res.status(500).json({ message: 'Unable to load workspace.' });
  }
});

app.put('/api/workspace', authMiddleware, async (req, res) => {
  const workspace = req.body;
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    return res.status(400).json({ message: 'Workspace data must be a JSON object.' });
  }

  try {
    await saveWorkspace(req.user.id, workspace);
    return res.json({ success: true });
  } catch (error) {
    console.error('Unable to save workspace:', error);
    return res.status(500).json({ message: 'Unable to save workspace.' });
  }
});

app.get('/api/users', authMiddleware, async (req, res) => {
  const users = await listUsers();
  res.json({ users });
});

app.post('/api/signup', async (req, res) => {
  const { businessName, fullName, email, password } = req.body || {};

  if (!businessName || !fullName || !email || !password) {
    return res.status(400).json({ message: 'Please complete all signup fields.' });
  }

  if (!/^\S+@\S+\.\S+$/.test(String(email))) {
    return res.status(400).json({ message: 'Use a valid email address.' });
  }

  if (String(password).length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const existingUser = await getUserByEmail(normalizedEmail);

  if (existingUser) {
    return res.status(409).json({ message: 'An account with that email already exists.' });
  }

  const newUser = {
    id: `user-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    businessName: String(businessName).trim(),
    fullName: String(fullName).trim(),
    email: normalizedEmail,
    passwordHash: hashPassword(String(password))
  };

  await createUser(newUser);
  const token = createToken(newUser);

  return res.status(201).json({
    success: true,
    token,
    user: {
      id: newUser.id,
      businessName: newUser.businessName,
      fullName: newUser.fullName,
      email: newUser.email
    }
  });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ message: 'Enter your email and password to sign in.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = await getUserByEmail(normalizedEmail);

  if (!user || user.passwordHash !== hashPassword(String(password))) {
    return res.status(401).json({
      message: 'No matching account found. Create a new account or check your password.'
    });
  }

  const token = createToken(user);

  return res.json({
    success: true,
    token,
    user: {
      id: user.id,
      businessName: user.businessName,
      fullName: user.fullName,
      email: user.email
    }
  });
});

async function startServer() {
  await initializeDatabase();

  app.listen(PORT, () => {
    console.log(`Inventify backend running at http://localhost:${PORT}`);
  });
}

startServer();
