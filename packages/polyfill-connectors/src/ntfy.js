/**
 * ntfy adapter — fire-and-forget push notifications to the self-hosted
 * ntfy.vivid.fish topic configured in .env.the owner.local.
 *
 * Non-blocking: failures are logged to stderr but don't throw. The operator
 * should still see inbox items locally if ntfy is down.
 */

function basicAuth(user, pass) {
  if (!user || !pass) return undefined;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/**
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} opts.message
 * @param {string[]} [opts.tags] — emoji tags for ntfy (e.g., ['warning', 'inbox_tray'])
 * @param {string} [opts.priority] — default|low|high|urgent
 * @param {string} [opts.clickUrl] — deep link the user can tap
 * @param {object} [opts.actions] — ntfy action buttons; plain array [{action, label, url}]
 */
export async function notify(opts) {
  const serverUrl = process.env.NTFY_SERVER_URL || 'https://ntfy.sh';
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.error('[ntfy] NTFY_TOPIC not set; skipping notification');
    return { skipped: true };
  }

  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (opts.title) headers.Title = opts.title;
  if (opts.tags && opts.tags.length) headers.Tags = opts.tags.join(',');
  if (opts.priority) headers.Priority = opts.priority;
  if (opts.clickUrl) headers.Click = opts.clickUrl;
  if (opts.actions && opts.actions.length) {
    headers.Actions = opts.actions
      .map((a) => `${a.action}, ${a.label}, ${a.url}${a.clear ? ', clear=true' : ''}`)
      .join('; ');
  }
  const auth = basicAuth(process.env.NTFY_USERNAME, process.env.NTFY_PASSWORD);
  if (auth) headers.Authorization = auth;

  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers,
      body: opts.message || '',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[ntfy] ${res.status} ${body.slice(0, 120)}`);
      return { ok: false, status: res.status };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: true, id: body.id };
  } catch (err) {
    console.error(`[ntfy] send failed: ${err.message || err}`);
    return { ok: false, error: err.message || String(err) };
  }
}

export async function notifyInboxItem(item) {
  const title = `PDPP needs you: ${item.kind}`;
  const msg = item.message || `A connector (${item.connector_id}) is parked waiting for ${item.kind}.`;
  return notify({
    title,
    message: msg,
    tags: item.kind === 'credentials' || item.kind === 'otp' ? ['key'] : ['construction'],
    priority: 'high',
  });
}

export async function notifyOvernightSummary({ ok, counts, failures }) {
  const lines = [];
  lines.push(`status: ${ok ? 'green' : 'attention needed'}`);
  if (counts) {
    for (const [k, v] of Object.entries(counts)) {
      lines.push(`${k}: ${v}`);
    }
  }
  if (failures && failures.length) {
    lines.push('');
    lines.push('Failures:');
    for (const f of failures) lines.push(`  • ${f}`);
  }
  return notify({
    title: ok ? 'PDPP overnight: all green' : 'PDPP overnight: check the logs',
    message: lines.join('\n'),
    tags: ok ? ['white_check_mark'] : ['warning'],
    priority: ok ? 'default' : 'high',
  });
}
