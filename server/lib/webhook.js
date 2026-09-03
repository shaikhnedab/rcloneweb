const DISCORD_URL_RE = /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//;

/** Test-send a payload to a Discord webhook (URL strictly validated). */
export async function testWebhook({ url, payload }) {
  if (typeof url !== 'string' || !DISCORD_URL_RE.test(url)) {
    return { code: 400, body: { error: 'Invalid Discord webhook URL' } };
  }
  try {
    const res = await fetch(`${url}?wait=true`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(12000),
    });
    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      return { code: res.status, body: { error: `Discord responded ${res.status}`, detail: text.slice(0, 300) } };
    }
    // Drain the body so the socket is released.
    await res.arrayBuffer().catch(() => {});
    return { code: 200, body: { ok: true } };
  } catch (e) {
    return { code: 502, body: { error: String(e?.cause?.message || e?.message || e).slice(0, 300) } };
  }
}
