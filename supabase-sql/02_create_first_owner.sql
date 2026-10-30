-- Create the cafeteria and its first OWNER account directly in Supabase SQL Editor.
-- Edit the values in the DECLARE section before running.
-- Do NOT commit a completed copy of this file to a public repository.
-- Run 01_apply_schema.sql first.

DO $bootstrap$
DECLARE
  v_business_name TEXT := 'CHANGE_ME_CAFETERIA_NAME';
  v_business_slug TEXT := 'change-me-cafeteria';
  v_owner_name TEXT := 'CHANGE_ME_OWNER_NAME';
  v_owner_identifier TEXT := 'CHANGE_ME_OWNER_NICK';
  v_owner_password TEXT := 'CHANGE_ME_STRONG_PASSWORD_12_CHARS_MIN';
  v_time_zone TEXT := 'America/Havana';

  v_business_id UUID;
  v_owner_count INTEGER;
  v_crypto_schema TEXT;
  v_password_hash TEXT;
BEGIN
  IF v_business_name LIKE 'CHANGE_ME%' OR length(btrim(v_business_name)) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'Edit v_business_name (2-120 characters) before running.';
  END IF;
  IF v_business_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR v_business_slug LIKE 'change-me%' THEN
    RAISE EXCEPTION 'Edit v_business_slug. Use lowercase letters, numbers and hyphens.';
  END IF;
  IF v_owner_name LIKE 'CHANGE_ME%' OR length(btrim(v_owner_name)) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Edit v_owner_name before running.';
  END IF;
  IF v_owner_identifier LIKE 'CHANGE_ME%' OR length(btrim(v_owner_identifier)) NOT BETWEEN 3 AND 180 THEN
    RAISE EXCEPTION 'Edit v_owner_identifier (the owner Nick) before running.';
  END IF;
  IF v_owner_password LIKE 'CHANGE_ME%' OR length(v_owner_password) < 12 OR octet_length(v_owner_password) > 72 THEN
    RAISE EXCEPTION 'Set a strong password of at least 12 characters and at most 72 UTF-8 bytes.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = v_time_zone) THEN
    RAISE EXCEPTION 'Invalid business time zone: %', v_time_zone;
  END IF;

  -- Find the schema where Supabase installed pgcrypto (usually extensions).
  SELECT n.nspname
    INTO v_crypto_schema
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pgcrypto';

  IF v_crypto_schema IS NULL THEN
    RAISE EXCEPTION 'pgcrypto extension is not installed. Run 01_apply_schema.sql first.';
  END IF;

  EXECUTE format(
    'SELECT %I.crypt($1, %I.gen_salt(''bf'', 12))',
    v_crypto_schema,
    v_crypto_schema
  )
  INTO v_password_hash
  USING v_owner_password;

  SELECT id
    INTO v_business_id
    FROM public.businesses
   WHERE slug = v_business_slug
   FOR UPDATE;

  IF v_business_id IS NULL THEN
    INSERT INTO public.businesses (name, slug, time_zone)
    VALUES (btrim(v_business_name), v_business_slug, v_time_zone)
    RETURNING id INTO v_business_id;
  ELSE
    SELECT count(*)::INTEGER
      INTO v_owner_count
      FROM public.users
     WHERE business_id = v_business_id
       AND role = 'OWNER';

    IF v_owner_count > 0 THEN
      RAISE EXCEPTION 'This cafeteria already has an OWNER account. No account or password was changed.';
    END IF;
  END IF;

  INSERT INTO public.users (
    business_id,
    display_name,
    identifier,
    identifier_norm,
    password_hash,
    role
  )
  VALUES (
    v_business_id,
    btrim(v_owner_name),
    btrim(v_owner_identifier),
    lower(btrim(v_owner_identifier)),
    v_password_hash,
    'OWNER'
  );

  RAISE NOTICE 'First owner created. Business slug: %, owner Nick: %', v_business_slug, btrim(v_owner_identifier);
END
$bootstrap$;

-- Verify without exposing the password/hash:
-- SELECT b.name, b.slug, u.display_name, u.identifier, u.role, u.active
-- FROM public.businesses b JOIN public.users u ON u.business_id=b.id
-- WHERE b.slug='YOUR_BUSINESS_SLUG';
