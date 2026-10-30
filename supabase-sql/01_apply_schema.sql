-- Cafeteria backend: initial schema for Supabase SQL Editor
-- Run once in Supabase Dashboard -> SQL Editor -> New query.
-- This file includes migration 001_initial.sql and records it as applied.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  time_zone TEXT NOT NULL DEFAULT 'America/Havana',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 100),
  identifier TEXT NOT NULL CHECK (length(trim(identifier)) BETWEEN 3 AND 180),
  identifier_norm TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('OWNER','WORKER','CUSTOMER')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, identifier_norm)
);
CREATE INDEX IF NOT EXISTS users_business_role_idx ON users(business_id, role, active);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  user_agent TEXT,
  ip_address INET
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS auth_sessions_active_idx ON auth_sessions(token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '',
  category_name TEXT NOT NULL CHECK (length(trim(category_name)) BETWEEN 1 AND 100),
  image_path TEXT,
  unit_name TEXT NOT NULL DEFAULT 'unidad',
  subunit_name TEXT,
  sale_mode TEXT NOT NULL CHECK (sale_mode IN ('UNIT','SUBUNIT','BOTH')),
  subunits_per_unit INTEGER CHECK (subunits_per_unit IS NULL OR subunits_per_unit BETWEEN 1 AND 1000000),
  unit_price_cup BIGINT CHECK (unit_price_cup IS NULL OR unit_price_cup >= 0),
  unit_price_transfer BIGINT CHECK (unit_price_transfer IS NULL OR unit_price_transfer >= 0),
  subunit_price_cup BIGINT CHECK (subunit_price_cup IS NULL OR subunit_price_cup >= 0),
  subunit_price_transfer BIGINT CHECK (subunit_price_transfer IS NULL OR subunit_price_transfer >= 0),
  stock_units BIGINT NOT NULL DEFAULT 0 CHECK (stock_units >= 0),
  stock_subunits BIGINT CHECK (stock_subunits IS NULL OR stock_subunits >= 0),
  minimum_stock BIGINT NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  public_visible BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  price_version UUID NOT NULL DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (subunits_per_unit IS NULL AND stock_subunits IS NULL) OR
    (subunits_per_unit IS NOT NULL AND stock_subunits IS NOT NULL AND stock_subunits < subunits_per_unit)
  )
);
CREATE INDEX IF NOT EXISTS products_business_active_idx ON products(business_id, active, category_name, name);
CREATE INDEX IF NOT EXISTS products_business_updated_idx ON products(business_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  client_sale_id UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  worker_id UUID NOT NULL REFERENCES users(id),
  worker_name_snapshot TEXT NOT NULL,
  sold_at TIMESTAMPTZ NOT NULL,
  sold_at_original TEXT NOT NULL,
  device_time_zone_id TEXT NOT NULL,
  device_offset_minutes INTEGER NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH_CUP','TRANSFER_CUP')),
  currency TEXT NOT NULL DEFAULT 'CUP' CHECK (currency = 'CUP'),
  total_cup BIGINT NOT NULL CHECK (total_cup > 0),
  status TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('ACCEPTED','REVERSED')),
  app_version TEXT NOT NULL DEFAULT '1.0.0',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, client_sale_id)
);
CREATE INDEX IF NOT EXISTS sales_business_sold_idx ON sales(business_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS sales_worker_sold_idx ON sales(business_id, worker_id, sold_at DESC);

CREATE TABLE IF NOT EXISTS sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name_snapshot TEXT NOT NULL,
  unit_name_snapshot TEXT NOT NULL,
  subunit_name_snapshot TEXT,
  unit_quantity BIGINT NOT NULL CHECK (unit_quantity >= 0),
  subunit_quantity BIGINT NOT NULL CHECK (subunit_quantity >= 0),
  subunits_per_unit_snapshot INTEGER,
  price_version_snapshot TEXT NOT NULL,
  unit_price_applied_cup BIGINT NOT NULL CHECK (unit_price_applied_cup >= 0),
  subunit_price_applied_cup BIGINT CHECK (subunit_price_applied_cup IS NULL OR subunit_price_applied_cup >= 0),
  total_cup BIGINT NOT NULL CHECK (total_cup > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (unit_quantity > 0 OR subunit_quantity > 0)
);
CREATE INDEX IF NOT EXISTS sale_items_sale_idx ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS sale_items_product_idx ON sale_items(business_id, product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  product_id UUID NOT NULL REFERENCES products(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('INITIAL','SALE','ADJUSTMENT','REVERSAL')),
  unit_delta BIGINT NOT NULL DEFAULT 0,
  subunit_delta BIGINT,
  previous_units BIGINT NOT NULL,
  previous_subunits BIGINT,
  new_units BIGINT NOT NULL,
  new_subunits BIGINT,
  sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_movements_product_idx ON inventory_movements(business_id, product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 140),
  message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
  publish_at TIMESTAMPTZ NOT NULL,
  publish_at_original TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','PUBLISHED','CANCELLED','EXPIRED')),
  send_push_notification BOOLEAN NOT NULL DEFAULT TRUE,
  image_path TEXT,
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  push_enqueued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > publish_at)
);
CREATE INDEX IF NOT EXISTS announcements_schedule_idx ON announcements(status, publish_at);
CREATE INDEX IF NOT EXISTS announcements_public_idx ON announcements(business_id, status, publish_at DESC);

CREATE TABLE IF NOT EXISTS push_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ANDROID')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, device_id)
);
CREATE INDEX IF NOT EXISTS push_devices_recipients_idx ON push_devices(business_id, active) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS push_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','DEAD')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (announcement_id, device_id)
);
CREATE INDEX IF NOT EXISTS push_outbox_pending_idx ON push_outbox(status, next_attempt_at) WHERE status IN ('PENDING','SENDING');

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_business_idx ON audit_logs(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The migration runner uses this record to avoid trying to re-apply the file.
INSERT INTO public.schema_migrations (filename)
VALUES ('001_initial.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;

-- Quick verification after running:
-- SELECT filename, applied_at FROM public.schema_migrations ORDER BY applied_at;
-- SELECT to_regclass('public.businesses'), to_regclass('public.products'), to_regclass('public.sales');
