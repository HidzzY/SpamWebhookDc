import fetch from 'node-fetch';
import FormData from 'form-data';

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
  maxDuration: 30
};

const ALLOWED_HOST = 'discord.com';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function validateWebhookUrl(raw) {
  if (typeof raw !== 'string') return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.hostname !== ALLOWED_HOST) return null;
  const m = u.pathname.match(/^\/api\/v\d+\/webhooks\/(\d+)\/([\w-]+)$/);
  if (!m) return null;
  return `https://${ALLOWED_HOST}/api/v10/webhooks/${m[1]}/${m[2]}`;
}

function sanitizeResponse(data) {
  if (!data || typeof data !== 'object') return data;
  const { token, url, ...rest } = data;
  return rest;
}

function sanitizePayload(p) {
  const allow = ['content','username','avatar_url','tts','embeds','flags','thread_name','allowed_mentions','attachments'];
  const out = {};
  for (const k of allow) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid json' }); }
  }
  if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString()); } catch { return res.status(400).json({ error: 'invalid json' }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'missing body' });

  const { webhookUrl, method = 'POST', body: payload, isForm = false, fileBase64, filename } = body;

  const base = validateWebhookUrl(webhookUrl);
  if (!base) return res.status(400).json({ error: 'invalid webhook url' });

  const allowedMethods = ['GET', 'POST', 'PATCH', 'DELETE'];
  const m = String(method).toUpperCase();
  if (!allowedMethods.includes(m)) return res.status(400).json({ error: 'method not allowed' });

  const target = m === 'GET' ? base : `${base}${m === 'POST' ? '?wait=true' : ''}`;

  try {
    let r;
    if (isForm && fileBase64 && filename) {
      const buf = Buffer.from(fileBase64, 'base64');
      if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'file too large' });
      const fd = new FormData();
      fd.append('file', buf, { filename: String(filename).replace(/[^\w.\-]/g, '_') });
      fd.append('payload_json', JSON.stringify(sanitizePayload(payload || {})));
      r = await fetch(target, { method: m, body: fd, headers: fd.getHeaders(), redirect: 'manual' });
    } else if (m === 'GET' || m === 'DELETE') {
      r = await fetch(target, { method: m, redirect: 'manual' });
    } else {
      r = await fetch(target, {
        method: m,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sanitizePayload(payload || {})),
        redirect: 'manual'
      });
    }

    const status = r.status;
    const text = await r.text();
    res.setHeader('X-Upstream-Status', String(status));
    const rlRemaining = r.headers.get('x-ratelimit-remaining');
    const rlReset = r.headers.get('x-ratelimit-reset-after');
    if (rlRemaining) res.setHeader('X-RateLimit-Remaining', rlRemaining);
    if (rlReset) res.setHeader('X-RateLimit-Reset-After', rlReset);

    if (!text) return res.status(status).end();
    try {
      const json = JSON.parse(text);
      return res.status(status).json(sanitizeResponse(json));
    } catch {
      return res.status(status).send(text);
    }
  } catch (e) {
    return res.status(502).json({ error: 'relay error', detail: e.message });
  }
}