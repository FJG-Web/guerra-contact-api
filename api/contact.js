import nodemailer from "nodemailer";

// Allowed origins — only these domains can POST to this function
const ALLOWED_ORIGINS = [
  "https://guerramanagementgroup.com",
  "https://www.guerramanagementgroup.com",
];

// In-memory rate limit (resets per cold start; good enough for a contact form)
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 5;             // 5 submissions
const RATE_LIMIT_WINDOW_MS = 60_000;  // per minute, per IP

// Disable Vercel's default body parser so we can read raw body for FormData
export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseUrlEncoded(str) {
  const params = new URLSearchParams(str);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

function parseMultipart(buf, boundary) {
  const obj = {};
  const text = buf.toString("utf8");
  const parts = text.split(`--${boundary}`);
  for (const part of parts) {
    const nameMatch = part.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const splitIdx = part.indexOf("\r\n\r\n");
    if (splitIdx === -1) continue;
    let value = part.slice(splitIdx + 4);
    // Trim trailing \r\n and any closing boundary marker
    value = value.replace(/\r\n--\s*$/, "").replace(/\r\n$/, "");
    obj[name] = value;
  }
  return obj;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Basic rate limiting by IP
  const ip = (req.headers["x-forwarded-for"] || "")
    .toString()
    .split(",")[0]
    .trim() || "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, reset: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  rateLimitMap.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many submissions. Please try again in a minute." });
  }

  // Parse body based on content-type
  let data = {};
  try {
    const ct = (req.headers["content-type"] || "").toLowerCase();
    const raw = await readRawBody(req);

    if (ct.includes("application/json")) {
      data = JSON.parse(raw.toString("utf8") || "{}");
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      data = parseUrlEncoded(raw.toString("utf8"));
    } else if (ct.includes("multipart/form-data")) {
      const boundaryMatch = ct.match(/boundary=(.+)$/);
      if (boundaryMatch) data = parseMultipart(raw, boundaryMatch[1].trim());
    } else {
      // Last resort: try JSON
      try { data = JSON.parse(raw.toString("utf8") || "{}"); } catch { data = {}; }
    }
  } catch (e) {
    console.error("Body parse error:", e);
    return res.status(400).json({ error: "Could not parse submission." });
  }

  const name     = String(data.name     || "").trim();
  const email    = String(data.email    || "").trim();
  const company  = String(data.company  || "").trim();
  const venture  = String(data.venture  || "").trim();
  const message  = String(data.message  || "").trim();
  const honeypot = String(data._gotcha  || "").trim();

  // Honeypot — silently succeed for bots
  if (honeypot) {
    return res.status(200).json({ ok: true });
  }

  // Validation
  if (!name || !email || !venture || !message) {
    console.log("Missing fields. Received:", { name: !!name, email: !!email, venture: !!venture, message: !!message });
    return res.status(400).json({ error: "Please fill in all required fields." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  if (name.length > 200 || email.length > 200 || company.length > 200 ||
      venture.length > 100 || message.length > 5000) {
    return res.status(400).json({ error: "Submission too long." });
  }

  // Prevent header injection
  const safeName = name.replace(/[\r\n]/g, " ");
  const safeEmail = email.replace(/[\r\n]/g, "");

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.protonmail.ch",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: process.env.PROTON_SMTP_USER,
        pass: process.env.PROTON_SMTP_PASS,
      },
    });

    const textBody =
`New contact form submission via guerramanagementgroup.com

────────────────────────────────────
Name:     ${name}
Email:    ${email}
Company:  ${company || "—"}
Venture:  ${venture}
────────────────────────────────────

Message:
${message}

────────────────────────────────────
Reply directly to this email to respond to ${safeName}.
`;

    await transporter.sendMail({
      from: `"Guerra Site" <${process.env.PROTON_SMTP_USER}>`,
      to: process.env.PROTON_SMTP_USER,
      replyTo: `"${safeName}" <${safeEmail}>`,
      subject: `New ${venture} inquiry — ${safeName}`,
      text: textBody,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Mail send failed:", err);
    return res.status(500).json({
      error: "Could not send your message. Please email support@guerramanagementgroup.com directly.",
    });
  }
}
