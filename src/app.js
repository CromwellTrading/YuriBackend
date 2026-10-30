import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import inventoryRoutes from './routes/inventory.js';
import salesRoutes from './routes/sales.js';
import dashboardRoutes from './routes/dashboard.js';
import announcementRoutes from './routes/announcements.js';
import teamRoutes from './routes/team.js';
import deviceRoutes from './routes/devices.js';
import businessRoutes from './routes/businesses.js';
import { pool } from './db.js';
import { notFoundHandler, errorHandler } from './middleware/errors.js';
import { isPushConfigured } from './services/scheduler.js';

const app = express();
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './storage/uploads');
fs.mkdirSync(uploadDir, { recursive: true });
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'false' ? false : 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
app.use((req, res, next) => {
  req.id = req.get('x-request-id')?.slice(0, 100) || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  const origin = req.get('origin');
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ data: null, message: 'Origen no autorizado.', code: 'CORS_NOT_ALLOWED' });
  }
  if (origin && allowedOrigins.length && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Business-Slug, X-App-Version');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(express.json({ limit: '2mb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use('/uploads', express.static(uploadDir, {
  fallthrough: false,
  index: false,
  dotfiles: 'deny',
  maxAge: '7d',
  immutable: true,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  },
}));
app.use('/api/', rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 900000),
  limit: Number(process.env.RATE_LIMIT_MAX || 120),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { data: null, message: 'Se alcanzó el límite temporal de solicitudes. Inténtalo nuevamente más tarde.', code: 'RATE_LIMITED' },
}));

app.get('/health', (_req, res) => res.json({ data: { status: 'ok', pushConfigured: isPushConfigured() }, message: 'Servicio disponible.' }));
app.get('/health/ready', async (_req, res) => {
  const result = await pool.query("SELECT to_regclass('public.businesses') AS businesses, to_regclass('public.products') AS products, to_regclass('public.sales') AS sales");
  const ready = Boolean(result.rows[0].businesses && result.rows[0].products && result.rows[0].sales);
  if (!ready) return res.status(503).json({ data: { status: 'not_ready', migrationsApplied: false }, message: 'El servicio todavía no está configurado.' });
  res.json({ data: { status: 'ready', pushConfigured: isPushConfigured() }, message: 'Servicio listo.' });
});
app.use('/api/v1/businesses', businessRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/sales', salesRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/announcements', announcementRoutes);
app.use('/api/v1/team', teamRoutes);
app.use('/api/v1/devices', deviceRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
