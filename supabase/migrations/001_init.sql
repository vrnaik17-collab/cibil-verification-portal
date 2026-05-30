-- ═══════════════════════════════════════════════════════════════════
--  CreditPulse — Supabase Database Migration
--  Run this in: Supabase Dashboard → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Main pipeline table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cibil_pipeline (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- User details (submitted by the form)
  full_name        text NOT NULL,
  email            text NOT NULL,
  dob              date NOT NULL,
  pan              text NOT NULL,
  mobile           text NOT NULL,

  -- State machine
  current_status   text NOT NULL DEFAULT 'PENDING'
                   CHECK (current_status IN (
                     'PENDING',
                     'AWAITING_OTP',
                     'OTP_SUBMITTED',
                     'COMPLETED',
                     'FAILED'
                   )),

  -- OTP and session data (stored server-side only)
  user_entered_otp text,
  session_tracker  jsonb,

  -- Final result
  cibil_score      integer CHECK (cibil_score BETWEEN 300 AND 900),

  -- Timestamps
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cibil_pipeline_updated_at ON cibil_pipeline;
CREATE TRIGGER cibil_pipeline_updated_at
  BEFORE UPDATE ON cibil_pipeline
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 2. Audit log table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cibil_audit_log (
  id          bigserial PRIMARY KEY,
  record_id   uuid REFERENCES cibil_pipeline(id) ON DELETE CASCADE,
  event       text NOT NULL,
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_cibil_pipeline_status  ON cibil_pipeline(current_status);
CREATE INDEX IF NOT EXISTS idx_cibil_pipeline_pan     ON cibil_pipeline(pan);
CREATE INDEX IF NOT EXISTS idx_cibil_audit_record_id  ON cibil_audit_log(record_id);

-- ── 3. Row Level Security ───────────────────────────────────────────
ALTER TABLE cibil_pipeline  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cibil_audit_log ENABLE ROW LEVEL SECURITY;

-- Allow anon role to INSERT new leads (form submission)
CREATE POLICY "anon_insert_leads"
  ON cibil_pipeline
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Block anon from reading any rows (service_role has full access)
CREATE POLICY "no_anon_select"
  ON cibil_pipeline
  FOR SELECT
  TO anon
  USING (false);

-- Block anon from updating rows (only the Edge Function can)
CREATE POLICY "no_anon_update"
  ON cibil_pipeline
  FOR UPDATE
  TO anon
  USING (false);

-- Block all anon access on audit log
CREATE POLICY "no_anon_audit"
  ON cibil_audit_log
  FOR ALL
  TO anon
  USING (false);

-- ── 4. Mask sensitive columns for audit queries ─────────────────────
CREATE OR REPLACE VIEW cibil_pipeline_safe AS
  SELECT
    id,
    CONCAT(LEFT(full_name, 2), REPEAT('*', GREATEST(LENGTH(full_name) - 4, 0)), RIGHT(full_name, 2)) AS full_name,
    CONCAT(LEFT(email, 2), '***@***', RIGHT(email, 3)) AS email,
    CONCAT(LEFT(pan, 2), '*****', RIGHT(pan, 2))       AS pan,
    CONCAT(LEFT(mobile, 2), '******', RIGHT(mobile, 2)) AS mobile,
    current_status,
    cibil_score,
    created_at,
    completed_at
  FROM cibil_pipeline;
