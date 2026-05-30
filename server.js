const express = require('express');
const cors    = require('cors');
const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');

const app  = express();
app.use(cors());
app.use(express.json());

// In-memory session store  { sessionId -> { browser, page, status } }
const sessions = {};

// ── helper: launch browser ──────────────────────────────────────────
async function launchBrowser() {
  const executablePath = await chromium.executablePath();
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
}

// ── helper: wait for selector safely ───────────────────────────────
async function waitFor(page, selector, timeout = 15000) {
  await page.waitForSelector(selector, { visible: true, timeout });
}

// ════════════════════════════════════════════════════════════════════
//  POST /submit-lead
//  Body: { record_id, full_name, email, pan, dob, mobile }
//  Opens UrbanMoney, fills the form, triggers OTP
// ════════════════════════════════════════════════════════════════════
app.post('/submit-lead', async (req, res) => {
  const { record_id, full_name, email, pan, dob, mobile } = req.body;

  if (!record_id || !full_name || !email || !pan || !dob || !mobile) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Set realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log(`[${record_id}] Navigating to UrbanMoney...`);
    await page.goto('https://www.urbanmoney.com/credit-score', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // ── Fill: Full Name ──
    console.log(`[${record_id}] Filling name...`);
    await waitFor(page, 'input[name="fullName"], input[placeholder*="Name"], input[id*="name"]');
    await page.type(
      'input[name="fullName"], input[placeholder*="Name"], input[id*="name"]',
      full_name,
      { delay: 60 }
    );

    // ── Fill: Mobile ──
    console.log(`[${record_id}] Filling mobile...`);
    await waitFor(page, 'input[name="mobileNo"], input[placeholder*="Mobile"], input[type="tel"]');
    await page.type(
      'input[name="mobileNo"], input[placeholder*="Mobile"], input[type="tel"]',
      mobile,
      { delay: 60 }
    );

    // ── Fill: Email ──
    console.log(`[${record_id}] Filling email...`);
    await waitFor(page, 'input[name="emailId"], input[type="email"], input[placeholder*="Email"]');
    await page.type(
      'input[name="emailId"], input[type="email"], input[placeholder*="Email"]',
      email,
      { delay: 60 }
    );

    // ── Check consent checkbox if present ──
    try {
      const checkbox = await page.$('input[type="checkbox"]');
      if (checkbox) {
        const checked = await page.$eval('input[type="checkbox"]', el => el.checked);
        if (!checked) await checkbox.click();
      }
    } catch (_) { /* optional field */ }

    // ── Click Submit / Get OTP ──
    console.log(`[${record_id}] Clicking submit...`);
    await waitFor(page, 'button[type="submit"], button.submit-btn, button.get-otp-btn, button');
    await page.click('button[type="submit"], button.submit-btn, button.get-otp-btn');

    // ── Wait for OTP screen ──
    console.log(`[${record_id}] Waiting for OTP screen...`);
    await page.waitForFunction(
      () => document.body.innerText.includes('OTP') || document.body.innerText.includes('otp'),
      { timeout: 20000 }
    );

    // Store session
    sessions[record_id] = { browser, page, status: 'AWAITING_OTP' };

    console.log(`[${record_id}] OTP sent successfully.`);
    return res.json({ status: 'success', message: 'OTP has been dispatched to mobile.' });

  } catch (err) {
    console.error(`[${record_id}] submit-lead error:`, err.message);
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: `Automation failed: ${err.message}` });
  }
});

// ════════════════════════════════════════════════════════════════════
//  POST /confirm-otp
//  Body: { record_id, otp }
//  Types OTP into UrbanMoney → scrapes CIBIL score
// ════════════════════════════════════════════════════════════════════
app.post('/confirm-otp', async (req, res) => {
  const { record_id, otp } = req.body;

  if (!record_id || !otp) {
    return res.status(400).json({ error: 'Missing record_id or otp.' });
  }

  const session = sessions[record_id];
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired. Please resubmit.' });
  }

  const { browser, page } = session;

  try {
    console.log(`[${record_id}] Entering OTP: ${otp}`);

    // ── Fill OTP field(s) ──
    // Some sites have a single input, others have 6 separate boxes
    const otpInputs = await page.$$('input[type="tel"], input.otp-input, input[maxlength="1"], input[name*="otp"], input[id*="otp"]');

    if (otpInputs.length > 1) {
      // Multiple single-digit boxes
      const digits = String(otp).split('');
      for (let i = 0; i < otpInputs.length && i < digits.length; i++) {
        await otpInputs[i].click();
        await otpInputs[i].type(digits[i], { delay: 80 });
      }
    } else {
      // Single OTP input
      await waitFor(page, 'input[type="tel"], input[name*="otp"], input[id*="otp"], input[placeholder*="OTP"]');
      await page.type(
        'input[type="tel"], input[name*="otp"], input[id*="otp"], input[placeholder*="OTP"]',
        String(otp),
        { delay: 80 }
      );
    }

    // ── Click Verify / Submit OTP ──
    console.log(`[${record_id}] Clicking verify OTP...`);
    await page.click('button[type="submit"], button.verify-btn, button.submit-otp');

    // ── Wait for score to appear ──
    console.log(`[${record_id}] Waiting for CIBIL score...`);
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        return /\b[3-9]\d{2}\b/.test(text) && (
          text.includes('CIBIL') || text.includes('credit score') || text.includes('Score')
        );
      },
      { timeout: 30000 }
    );

    // ── Scrape the score ──
    const score = await page.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/\b([3-9]\d{2})\b/);
      return match ? parseInt(match[1]) : null;
    });

    console.log(`[${record_id}] Score found: ${score}`);

    // Cleanup session
    await browser.close().catch(() => {});
    delete sessions[record_id];

    if (!score) {
      return res.status(502).json({ error: 'Could not extract score from page.' });
    }

    return res.json({ status: 'success', score });

  } catch (err) {
    console.error(`[${record_id}] confirm-otp error:`, err.message);
    await browser.close().catch(() => {});
    delete sessions[record_id];
    return res.status(500).json({ error: `OTP verification failed: ${err.message}` });
  }
});

// ── Health check ────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', sessions: Object.keys(sessions).length }));

// ── Start ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CIBIL backend running on port ${PORT}`));
