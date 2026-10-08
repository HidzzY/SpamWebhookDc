import fetch from 'node-fetch';
import FormData from 'form-data';

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const API_KEY = process.env.API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  // auth: header X-Api-Key harus match
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // body: { action: 'send'|'edit'|'delete'|'spam'|'file', payload: {...} }
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (Buffer.isBuffer(body)) body = JSON.parse(body.toString());
  } catch {
    return res.status(400).json({ error: 'invalid json' });
  }

  const { action, payload = {} } = body || {};
  if (!action) return res.status(400).json({ error: 'missing action' });

  const base = WEBHOOK_URL;

  try {
    if (action === 'info') {
      const r = await fetch(base);
      const d = await r.json();
      return res.status(r.status).json(sanitize(d));
    }

    if (action === 'send') {
      const r = await fetch(`${base}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clean(payload))
      });
      const d = await safeJson(r);
      return res.status(r.status).json(d);
    }

    if (action === 'edit') {
      const r = await fetch(base, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clean(payload))
      });
      const d = await safeJson(r);
      return res.status(r.status).json(d);
    }

    if (action === 'delete') {
      const r = await fetch(base, { method: 'DELETE' });
      return res.status(r.status).end();
    }

    if (action === 'deleteMessage') {
      if (!payload.messageId) return res.status(400).json({ error: 'missing messageId' });
      const r = await fetch(`${base}/messages/${payload.messageId}`, { method: 'DELETE' });
      return res.status(r.status).end();
    }

    if (action === 'spam') {
      const count = Math.min(Math.max(parseInt(payload.count) || 1, 1), 50);
      const delay = Math.min(Math.max(parseInt(payload.delay) || 500, 100), 10000);
      const results = [];
      for (let i = 0; i < count; i++) {
        const r = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(clean(payload.message || {}))
        });
        results.push(r.status);
        if (i < count - 1) await new Promise(x => setTimeout(x, delay));
      }
      return res.status(200).json({ sent: results.length, statuses: results });
    }

    if (action === 'file') {
      if (!payload.fileBase64 || !payload.filename) {
        return res.status(400).json({ error: 'missing fileBase64/filename' });
      }
      const buf = Buffer.from(payload.fileBase64, 'base64');
      const fd = new FormData();
      fd.append('file', buf, { filename: payload.filename });
      fd.append('payload_json', JSON.stringify(clean(payload.message || {})));
      const r = await fetch(`${base}?wait=true`, { method: 'POST', body: fd, headers: fd.getHeaders() });
      const d = await safeJson(r);
      return res.status(r.status).json(d);
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: 'proxy error', detail: e.message });
  }
}

function clean(o) {
  const out = {};
  const allow = ['content','username','avatar_url','tts','embeds','flags','thread_name','allowed_mentions'];
  for (const k of allow) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function sanitize(d) {
  if (d && typeof d === 'object') {
    const { token, url, ...rest } = d;
    return rest;
  }
  return d;
}

async function safeJson(r) {
  const t = await r.text();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return { raw: t }; }
}