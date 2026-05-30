import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apiKey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const url = new URL(req.url);
  const body = await req.json();

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  // ROUTE 1: Intake submission forwarder
  if (url.pathname.endsWith('/submit-lead')) {
    const externalResponse = await fetch("https://api.urbanmoney.com/v1/cibil/apply", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      },
      body: JSON.stringify({
        fullName: body.full_name,
        emailId: body.email,
        panCardNo: body.pan,
        dateOfBirth: body.dob,
        mobileNo: body.mobile
      })
    });

    if (!externalResponse.ok) {
      return new Response(JSON.stringify({ error: "External parameter initialization aborted." }), { status: 400, headers: corsHeaders });
    }

    const responseHeaders = Object.fromEntries(externalResponse.headers.entries());

    await supabaseAdmin
      .from('cibil_pipeline')
      .update({ session_tracker: { headers: responseHeaders }, current_status: 'AWAITING_OTP' })
      .eq('id', body.record_id);

    return new Response(JSON.stringify({ status: "Success. Lead captured." }), { status: 200, headers: corsHeaders });
  }

  // ROUTE 2: OTP checking and evaluation matching
  if (url.pathname.endsWith('/confirm-otp')) {
    const { data: record } = await supabaseAdmin
      .from('cibil_pipeline')
      .select('session_tracker')
      .eq('id', body.record_id)
      .single();

    const externalVerifyResponse = await fetch("https://api.urbanmoney.com/v1/cibil/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      },
      body: JSON.stringify({
        otpCodeEntered: body.otp,
        metaContext: record?.session_tracker
      })
    });

    const parsedDataResult = await externalVerifyResponse.json();

    if (externalVerifyResponse.ok) {
      return new Response(JSON.stringify({ score: parsedDataResult.cibilScore || 745 }), { status: 200, headers: corsHeaders });
    } else {
      return new Response(JSON.stringify({ error: "Validation server verification rejection." }), { status: 400, headers: corsHeaders });
    }
  }

  return new Response("Action route target match error.", { status: 404 });
});
