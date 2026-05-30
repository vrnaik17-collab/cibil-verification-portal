import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// ═══════════════════════════════════════════════════
//  CreditPulse — urbanmoney-proxy Edge Function
//  Handles: lead submission → OTP trigger → score fetch
// ═══════════════════════════════════════════════════

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ── Helper: structured JSON response ──
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Helper: log event to Supabase ──
async function logEvent(
  admin: ReturnType<typeof createClient>,
  recordId: string,
  event: string,
  meta: Record<string, unknown> = {}
) {
  await admin.from('cibil_audit_log').insert({
    record_id: recordId,
    event,
    meta,
    created_at: new Date().toISOString(),
  }).throwOnError().catch(() => {/* audit failures are non-fatal */})
}

// ── Validate required fields ──
function requireFields(body: Record<string, unknown>, fields: string[]): string | null {
  for (const f of fields) {
    if (!body[f] || String(body[f]).trim() === '') return `Missing required field: ${f}`
  }
  return null
}

// ════════════════════════════════════════════════════
serve(async (req) => {

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405)
  }

  const url = new URL(req.url)

  // Parse body safely
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400)
  }

  // Initialise Supabase admin client
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } }
  )

  // ─────────────────────────────────────────────────
  //  ROUTE 1 › /submit-lead
  //  Receives user details → forwards to UrbanMoney
  //  → stores session headers for OTP handshake
  // ─────────────────────────────────────────────────
  if (url.pathname.endsWith('/submit-lead')) {

    const missingField = requireFields(body, ['record_id','full_name','email','pan','dob','mobile'])
    if (missingField) return jsonResponse({ error: missingField }, 400)

    const { record_id, full_name, email, pan, dob, mobile } = body

    // PAN format guard (server-side)
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(String(pan))) {
      return jsonResponse({ error: 'Invalid PAN format.' }, 400)
    }

    let externalResponse: Response
    try {
      externalResponse = await fetch("https://api.urbanmoney.com/v1/cibil/apply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "CreditPulse/1.0",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          fullName:    full_name,
          emailId:     email,
          panCardNo:   pan,
          dateOfBirth: dob,
          mobileNo:    mobile,
        }),
        signal: AbortSignal.timeout(15_000),  // 15s timeout
      })
    } catch (err) {
      await logEvent(supabaseAdmin, String(record_id), 'PARTNER_TIMEOUT', { error: String(err) })
      return jsonResponse({ error: 'Partner API timed out. Please retry.' }, 503)
    }

    if (!externalResponse.ok) {
      const errText = await externalResponse.text().catch(() => '')
      await logEvent(supabaseAdmin, String(record_id), 'PARTNER_REJECTED', {
        status: externalResponse.status,
        body: errText.slice(0, 500),
      })
      return jsonResponse({ error: 'Partner portal rejected the request.' }, 400)
    }

    // Capture session cookies/headers for OTP step
    const sessionHeaders: Record<string, string> = {}
    for (const [k, v] of externalResponse.headers.entries()) {
      if (['set-cookie','x-session-id','x-trace-id'].includes(k.toLowerCase())) {
        sessionHeaders[k] = v
      }
    }

    const { error: dbErr } = await supabaseAdmin
      .from('cibil_pipeline')
      .update({
        session_tracker: { headers: sessionHeaders },
        current_status:  'AWAITING_OTP',
        updated_at:      new Date().toISOString(),
      })
      .eq('id', record_id)

    if (dbErr) {
      console.error('DB update error (submit-lead):', dbErr)
      return jsonResponse({ error: 'Database update failed.' }, 500)
    }

    await logEvent(supabaseAdmin, String(record_id), 'LEAD_SUBMITTED')
    return jsonResponse({ status: 'success', message: 'OTP has been dispatched.' })
  }

  // ─────────────────────────────────────────────────
  //  ROUTE 2 › /confirm-otp
  //  Sends OTP + session context to UrbanMoney verify
  //  → returns the CIBIL score on success
  // ─────────────────────────────────────────────────
  if (url.pathname.endsWith('/confirm-otp')) {

    const missingField = requireFields(body, ['record_id', 'otp'])
    if (missingField) return jsonResponse({ error: missingField }, 400)

    const { record_id, otp } = body

    // OTP format guard
    if (!/^[0-9]{4,6}$/.test(String(otp))) {
      return jsonResponse({ error: 'OTP must be 4–6 digits.' }, 400)
    }

    // Fetch session context from DB
    const { data: record, error: fetchErr } = await supabaseAdmin
      .from('cibil_pipeline')
      .select('session_tracker, current_status')
      .eq('id', record_id)
      .single()

    if (fetchErr || !record) {
      return jsonResponse({ error: 'Session record not found.' }, 404)
    }

    if (record.current_status === 'COMPLETED') {
      return jsonResponse({ error: 'Score already fetched for this session.' }, 409)
    }

    let verifyResponse: Response
    try {
      verifyResponse = await fetch("https://api.urbanmoney.com/v1/cibil/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "CreditPulse/1.0",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          otpCodeEntered: otp,
          metaContext:    record.session_tracker,
        }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      await logEvent(supabaseAdmin, String(record_id), 'VERIFY_TIMEOUT', { error: String(err) })
      return jsonResponse({ error: 'Verification service timed out. Please retry.' }, 503)
    }

    const parsedResult = await verifyResponse.json().catch(() => ({}))

    if (!verifyResponse.ok) {
      await logEvent(supabaseAdmin, String(record_id), 'OTP_REJECTED', {
        status: verifyResponse.status,
        body:   parsedResult,
      })
      return jsonResponse({ error: 'Invalid OTP. Please check and retry.' }, 400)
    }

    const score = parsedResult.cibilScore ?? parsedResult.score ?? null

    if (!score) {
      return jsonResponse({ error: 'Score not available in partner response.' }, 502)
    }

    // Persist score
    await supabaseAdmin
      .from('cibil_pipeline')
      .update({
        cibil_score:    score,
        current_status: 'COMPLETED',
        completed_at:   new Date().toISOString(),
      })
      .eq('id', record_id)

    await logEvent(supabaseAdmin, String(record_id), 'SCORE_FETCHED', { score })
    return jsonResponse({ status: 'success', score })
  }

  // ─────────────────────────────────────────────────
  //  No matching route
  // ─────────────────────────────────────────────────
  return jsonResponse({ error: 'Unknown route.' }, 404)
})
