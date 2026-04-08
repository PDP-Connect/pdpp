/**
 * Instagram scraping script.
 * Adapted from context-gateway/public/automations/instagram-headless.js.
 *
 * Injected globals (provided by runner in index.js):
 *   page           — Playwright page
 *   requestInput   — async (config) => values
 *   broadcastData  — (key, value) => void
 *   broadcast      — (msg) => void
 *   ingestRecord   — async (connectorId, ownerToken, stream, record) => void
 *   log            — (level, message) => void
 *   connectorId    — string
 *   ownerToken     — string
 *   grantIssuedAt  — string (ISO, used for time_range display only — not filtering at ingest)
 *   syncState      — object — cursor map from previous run (null keys = first run)
 *   emitState      — (stream, cursor) => void — persist STATE checkpoint to RS
 *   collectionMode — 'full_refresh' | 'incremental'
 */

const state = {
  webInfo: null,
  followingAccounts: [],
  adsData: { advertisers: [], ad_topics: [], targeting_categories: [] },
  isComplete: false,
};

const pause = async (ms) => new Promise(resolve => setTimeout(resolve, ms));

const withTimeout = async (promise, ms, label) => {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const dismissInstagramPrompts = async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const dismissed = await page.evaluate(`
        (() => {
          const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
          const target = candidates.find(el => /Not now|Not Now|Skip|Cancel|Close/i.test((el.innerText || '').trim()));
          if (target) { target.click(); return true; }
          return false;
        })()
      `);
      if (!dismissed) break;
      await pause(1200);
    } catch { break; }
  }
};

const fetchWebInfo = async () => {
  try {
    const result = await page.evaluate(`
      (async () => {
        try {
          const response = await fetch("https://www.instagram.com/accounts/web_info/", {
            headers: { "X-Requested-With": "XMLHttpRequest" }
          });
          if (!response.ok) return { error: 'response not ok', status: response.status };
          const html = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, "text/html");
          const scripts = doc.querySelectorAll('script[type="application/json"][data-sjs]');
          const findPolarisData = (obj) => {
            if (!obj || typeof obj !== 'object') return null;
            if (Array.isArray(obj) && obj[0] === 'PolarisViewer' && obj.length >= 3) return obj[2];
            for (const key in obj) {
              if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const found = findPolarisData(obj[key]);
                if (found) return found;
              }
            }
            return null;
          };
          let foundData = null;
          for (const script of scripts) {
            try {
              const jsonContent = JSON.parse(script.textContent);
              foundData = findPolarisData(jsonContent);
              if (foundData) break;
            } catch (e) {}
          }
          if (foundData?.data) return { success: true, data: foundData.data };
          return { error: 'no polaris data found' };
        } catch (err) { return { error: err.message }; }
      })()
    `);
    return result?.success ? result.data : null;
  } catch { return null; }
};

const scrapeFollowingAccounts = async (username, userId, expectedCount) => {
  try {
    broadcastData('status', `Fetching following list for @${username}...`);
    if (!userId) return [];

    const apiAccounts = await page.evaluate(`
      (async ({ userId, expectedCount }) => {
        const collected = [];
        const seen = new Set();
        let nextMaxId = null;
        let iterations = 0;
        while (iterations < 20) {
          iterations += 1;
          const params = new URLSearchParams({ count: '50' });
          if (nextMaxId) params.set('max_id', nextMaxId);
          const response = await fetch(\`/api/v1/friendships/\${userId}/following/?\${params.toString()}\`, {
            headers: { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' },
            credentials: 'include',
          });
          if (!response.ok) throw new Error(\`Following API failed with status \${response.status}\`);
          const data = await response.json();
          const users = Array.isArray(data.users) ? data.users : [];
          for (const user of users) {
            if (!user?.username || seen.has(user.username)) continue;
            seen.add(user.username);
            collected.push({
              pk_id: user.pk_id || user.pk || String(user.id || ''),
              username: user.username,
              full_name: user.full_name || '',
              is_verified: !!user.is_verified,
            });
          }
          if ((typeof expectedCount === 'number' && expectedCount > 0 && collected.length >= expectedCount) || !data.next_max_id) break;
          nextMaxId = data.next_max_id;
        }
        return collected;
      })(${JSON.stringify({ userId, expectedCount })})
    `);
    return Array.isArray(apiAccounts) ? apiAccounts : [];
  } catch (error) {
    log('error', `Failed to scrape following accounts: ${error.message}`);
    return [];
  }
};

const scrapeDialogList = async () => page.evaluate(`
  (() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return [];
    return Array.from(dialog.querySelectorAll('[role="list"] [role="listitem"]'))
      .map(el => (el.textContent || '').trim())
      .filter(text => text.length > 0);
  })()
`);

const waitForDialogList = async (timeout = 8000) => {
  try {
    await page.waitForFunction(`
      (() => {
        const dialog = document.querySelector('[role="dialog"]');
        return !!dialog && dialog.querySelectorAll('[role="list"] [role="listitem"]').length > 0;
      })()
    `, { timeout });
    return true;
  } catch { return false; }
};

const fetchAdsSSR = async (url) => page.evaluate(`
  (async () => {
    try {
      const resp = await fetch("${url}", { credentials: "include", headers: { "Accept": "text/html" } });
      if (!resp.ok) return { error: resp.status, advertisers: [], ad_topics: [] };
      const html = await resp.text();
      const result = { advertisers: [], ad_topics: [] };
      if (html.includes('advertiser_name')) {
        const regex = /"advertiser_name":"([^"]+)"/g;
        let m;
        while ((m = regex.exec(html)) !== null) {
          const decoded = m[1].replace(/\\\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
          result.advertisers.push(decoded);
        }
      }
      if (html.includes('data_driven_unified_ad_topics_with_ddt_first_n')) {
        const regex = /"ad_topic_name":"([^"]+)"/g;
        let m;
        while ((m = regex.exec(html)) !== null) result.ad_topics.push(m[1]);
        if (result.ad_topics.length === 0) {
          const regex2 = /"topic_display_name":"([^"]+)"/g;
          while ((m = regex2.exec(html)) !== null) result.ad_topics.push(m[1]);
        }
      }
      result.advertisers = [...new Set(result.advertisers)];
      result.ad_topics = [...new Set(result.ad_topics)];
      return result;
    } catch (e) { return { error: e.message, advertisers: [], ad_topics: [] }; }
  })()
`);

const scrapeAdInterestsFallback = async () => {
  const safeGoto = async (url) => {
    try {
      await withTimeout(page.goto(url, { timeout: 15000 }), 20000, `goto ${url}`);
      return true;
    } catch (error) {
      log('warn', `Failed to navigate to ${url}: ${error.message}`);
      return false;
    }
  };

  broadcastData('status', 'Fetching ad interests...');
  if (!(await safeGoto('https://accountscenter.instagram.com/ads/'))) return;

  try {
    await withTimeout(page.waitForSelector('[role="button"]', { timeout: 10000 }), 15000, 'ads landing buttons');
  } catch { return; }

  try {
    broadcastData('status', 'Fetching ad interests: reading advertisers...');
    const advertisers = await withTimeout(page.evaluate(`
      (() => {
        const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const unique = new Set();
        const results = [];
        const pushName = (value) => {
          const name = normalize(value);
          if (!name || unique.has(name)) return;
          unique.add(name);
          results.push({ name });
        };
        const heading = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
          .find(el => /Advertisers you saw ads from/i.test(normalize(el.textContent)));
        if (!heading) return results;
        let current = heading;
        for (let depth = 0; current && depth < 8; depth += 1) {
          const sibling = current.nextElementSibling;
          if (sibling?.querySelectorAll) {
            const items = sibling.querySelectorAll('[role="listitem"]');
            if (items.length > 0) {
              for (const item of Array.from(items)) {
                const text = normalize(item.textContent);
                if (!text || /See all/i.test(text)) continue;
                pushName(text);
              }
              break;
            }
          }
          current = current.parentElement;
        }
        return results;
      })()
    `), 12000, 'scrape advertisers');
    state.adsData.advertisers = Array.isArray(advertisers) ? advertisers : [];
  } catch (error) {
    log('warn', `Failed to read advertisers: ${error.message}`);
  }

  if (await safeGoto('https://accountscenter.instagram.com/ads/ad_topics/')) {
    try {
      broadcastData('status', 'Fetching ad interests: reading topics...');
      await withTimeout(page.waitForSelector('[role="dialog"]', { timeout: 8000 }), 12000, 'ad topics dialog');
      const topics = await withTimeout(page.evaluate(`
        (() => {
          const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
          const unique = new Set();
          const results = [];
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return results;
          const sectionHeading = Array.from(dialog.querySelectorAll('h1, h2, h3, [role="heading"]'))
            .find(el => /Your activity-based topics/i.test(normalize(el.textContent)));
          if (!sectionHeading) return results;
          const section = sectionHeading.closest('div');
          const scope = section?.parentElement || dialog;
          const emptyState = Array.from(scope.querySelectorAll('*'))
            .some(el => /You don't currently have any activity-based topics/i.test(normalize(el.textContent)));
          if (emptyState) return results;
          for (const item of Array.from(scope.querySelectorAll('[role="listitem"]'))) {
            const text = normalize(item.textContent);
            if (!text) continue;
            const candidate = text.split(/\\n+/).map(s => s.trim()).filter(Boolean)[0];
            if (!candidate || /special topics|see less|review topic choices/i.test(candidate)) continue;
            if (unique.has(candidate)) continue;
            unique.add(candidate);
            results.push({ name: candidate });
          }
          return results;
        })()
      `), 12000, 'scrape ad topics');
      state.adsData.ad_topics = Array.isArray(topics) ? topics : [];
    } catch (error) {
      log('warn', `Failed to read ad topics: ${error.message}`);
    }
  }

  if (await safeGoto('https://accountscenter.instagram.com/ads/')) {
    try {
      broadcastData('status', 'Fetching ad interests: checking targeting categories...');
      await withTimeout(page.waitForSelector('[role="tab"]', { timeout: 8000 }), 12000, 'ads tabs');
      const clickedCategories = await withTimeout(page.evaluate(`
        (() => {
          const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
          const manageInfo = tabs.find(tab => /manage info/i.test((tab.textContent || '').trim()));
          if (manageInfo) manageInfo.click();
          const links = Array.from(document.querySelectorAll('[role="tabpanel"] a, [role="tabpanel"] [role="link"]'));
          const categories = links.find(link => /categories used to reach you/i.test((link.textContent || '').trim()));
          if (categories) { categories.click(); return true; }
          return false;
        })()
      `), 12000, 'open targeting categories');

      if (clickedCategories && await withTimeout(waitForDialogList(6000), 10000, 'targeting categories dialog')) {
        const categoryNames = await withTimeout(scrapeDialogList(), 10000, 'scrape targeting categories');
        state.adsData.targeting_categories = categoryNames.map(name => ({ name }));
      }
    } catch (error) {
      log('warn', `Failed to read targeting categories: ${error.message}`);
    }
  }
};

const scrapeAdInterests = async () => {
  try {
    broadcastData('status', 'Fetching ad interests...');
    const ssrData = await withTimeout(fetchAdsSSR('https://accountscenter.instagram.com/ads/'), 20000, 'SSR ads extraction');
    if (ssrData && !ssrData.error && ssrData.advertisers.length > 0) {
      log('info', `SSR ads: ${ssrData.advertisers.length} advertisers, ${ssrData.ad_topics.length} topics`);
      state.adsData.advertisers = ssrData.advertisers.map(name => ({ name }));
      state.adsData.ad_topics = ssrData.ad_topics.map(name => ({ name }));
      return;
    }
    log('info', 'SSR ads found nothing, falling back to DOM scraping');
    await scrapeAdInterestsFallback();
  } catch (error) {
    log('error', `Failed to scrape ad interests: ${error.message}`);
  }
};

const detectOtp = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const text = document.body.innerText;
        const hasCodeInput = !!document.querySelector('input[name="verificationCode"], input[name="email"][id^="_r_"], input[aria-label*="Code"]');
        return hasCodeInput && (
          text.includes("Enter the code") ||
          text.includes("Check your email") ||
          text.includes("Two-factor authentication") ||
          text.includes("Security code") ||
          text.includes("Security Code") ||
          text.includes("authentication app")
        );
      })()
    `);
  } catch { return false; }
};

// ─── Main login loop ─────────────────────────────────────────────────────────

broadcastData('status', 'Launching Instagram...');
await page.goto('https://www.instagram.com/');

let isLoggedIn = false;
let lastError = null;
let attempts = 0;
const maxAttempts = 3;
let credentials = null;

while (!isLoggedIn && attempts < maxAttempts) {
  attempts++;

  try {
    const userSelector = 'input[name="username"], input[name="email"], input[aria-label*="Username"]';
    await page.waitForSelector(userSelector, { timeout: 10000, state: 'visible' });
  } catch {
    lastError = 'Failed to load Instagram login page. Retrying...';
    continue;
  }

  if (!credentials || lastError) {
    credentials = await requestInput({
      title: 'Log in to Instagram',
      description: lastError || 'Enter your Instagram credentials to continue',
      schema: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', title: 'Username, Email or Phone' },
          password: { type: 'string', title: 'Password' },
        },
      },
      uiSchema: {
        username: { 'ui:placeholder': 'Username, email, or phone', 'ui:autofocus': true },
        password: { 'ui:widget': 'password', 'ui:placeholder': 'Password' },
      },
      submitLabel: 'Log In',
      error: lastError,
    });
  }

  broadcastData('status', 'Signing in...');

  try {
    const userSelector = 'input[name="username"], input[name="email"], input[aria-label*="Username"]';
    const passSelector = 'input[name="password"], input[name="pass"], input[aria-label*="Password"]';
    await page.fill(userSelector, credentials.username);
    await pause(500);
    await page.fill(passSelector, credentials.password);
    await pause(500);
    await page.press(passSelector, 'Enter');
  } catch {
    lastError = 'Login form disappeared or became unresponsive. Retrying...';
    continue;
  }

  broadcastData('status', 'Authenticating...');
  await pause(12000);

  // Check for login error
  let errorMsg = null;
  try {
    errorMsg = await page.evaluate(`
      (() => {
        const el = document.querySelector('[role="alert"], #loginForm p[role="alert"]');
        return el ? el.textContent : null;
      })()
    `);
  } catch {}

  if (errorMsg) {
    lastError = `Login failed: ${errorMsg}`;
    continue;
  }

  if (await detectOtp()) {
    broadcastData('status', 'Two-factor authentication required');
    const otpResult = await requestInput({
      title: 'Two-Factor Authentication',
      description: 'Enter the security code sent to your email or phone',
      schema: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string', title: 'Security Code', minLength: 6, maxLength: 8 },
        },
      },
      uiSchema: { code: { 'ui:placeholder': '000000', 'ui:autofocus': true } },
      submitLabel: 'Verify',
    });

    try {
      const otpSelector = 'input[name="verificationCode"], input[name="email"][id^="_r_"], input[aria-label*="Code"], input[aria-label*="code"]';
      await page.fill(otpSelector, otpResult.code);
      await pause(1000);
      try {
        await page.waitForFunction(`
          (() => {
            const btn = Array.from(document.querySelectorAll('[role="button"]'))
              .find(el => /Continue|Confirm|Verify|Next/i.test(el.innerText || ''));
            return btn && btn.getAttribute('aria-disabled') !== 'true';
          })()
        `, { timeout: 10000 });
      } catch {}
      const continueBtn = '[role="button"]:has-text("Continue"), [role="button"]:has-text("Confirm"), button:has-text("Confirm"), button:has-text("Continue")';
      await page.click(continueBtn, { timeout: 5000 });
      await pause(8000);
    } catch {}
  }

  broadcastData('status', 'Checking login status...');

  // Detect captcha / security challenge — emit manual_action INTERACTION
  // so the UI can show a "complete this in the browser" overlay
  try {
    const url = await page.url();
    const hasCaptcha = url.includes('challenge') || url.includes('checkpoint') ||
      await page.evaluate(`
        (() => {
          return !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"], [data-testid="captcha"]');
        })()
      `).catch(() => false);
    if (hasCaptcha) {
      broadcastData('status', 'Security check detected — waiting for user');
      await requestInput({
        kind: 'manual_action',
        title: 'Complete Security Check',
        message: 'Instagram requires a security check. Complete it in the browser above, then click Continue.',
        submitLabel: 'Continue',
      });
    }
  } catch { /* best-effort */ }

  await dismissInstagramPrompts();

  let webInfo = null;
  for (let r = 0; r < 3; r++) {
    webInfo = await fetchWebInfo();
    if (webInfo?.username) break;
    await pause(3000);
  }

  if (webInfo?.username) {
    isLoggedIn = true;
    state.webInfo = webInfo;
    broadcastData('status', `Logged in as @${webInfo.username}`);
  } else {
    const url = await page.url();
    if (url.includes('challenge') || url.includes('checkpoint') || url.includes('auth_platform')) {
      broadcastData('status', 'Final security check — please complete in browser...');
      await pause(8000);
      const finalInfo = await fetchWebInfo();
      if (finalInfo?.username) {
        isLoggedIn = true;
        state.webInfo = finalInfo;
      }
    } else {
      await page.goto('https://www.instagram.com/');
      await pause(5000);
      await dismissInstagramPrompts();
      await pause(2000);
      const retryInfo = await fetchWebInfo();
      if (retryInfo?.username) {
        isLoggedIn = true;
        state.webInfo = retryInfo;
      }
    }
    if (!isLoggedIn) {
      lastError = 'Login failed. Please check credentials or security status.';
    }
  }
}

if (!isLoggedIn) {
  throw new Error('Instagram login failed after all attempts');
}

// ─── Data scraping ───────────────────────────────────────────────────────────

const username = state.webInfo?.username;
broadcastData('status', `Fetching profile: @${username}`);

// Navigate to profile to capture graphql response with user ID + following count
await page.goto(`https://www.instagram.com/${username}/`);
await pause(5000);

// Extract user info from page
const profileInfo = await fetchWebInfo();
const userId = profileInfo?.id || state.webInfo?.id;
const followingCount = profileInfo?.following_count || 0;

// ─── following_accounts ──────────────────────────────────────────────────────
log('info', `Scraping following accounts for @${username}...`);
broadcast({ type: 'progress', stream: 'following_accounts', message: `Fetching following list for @${username}…` });
const followingAccounts = await scrapeFollowingAccounts(username, userId, followingCount);
log('info', `Scraped ${followingAccounts.length} following accounts`);
broadcast({ type: 'progress', stream: 'following_accounts', message: `Ingesting ${followingAccounts.length} accounts…`, count: followingAccounts.length });

for (const account of followingAccounts) {
  const id = account.pk_id || account.id || account.username;
  await ingestRecord(connectorId, ownerToken, 'following_accounts', {
    key: id,
    data: {
      id,
      username: account.username,
      full_name: account.full_name,
      is_verified: account.is_verified,
    },
    emitted_at: new Date().toISOString(),
  });
  await page.waitForTimeout(150);
}
// Emit STATE checkpoint for following_accounts
emitState('following_accounts', { synced_at: new Date().toISOString(), count: followingAccounts.length });
broadcast({ type: 'stream-complete', stream: 'following_accounts', count: followingAccounts.length });

// ─── posts (timeline) ────────────────────────────────────────────────────────
log('info', 'Scraping posts timeline...');
broadcastData('status', 'Fetching posts...');

// Incremental: only fetch posts newer than the cursor (if we have one)
const postsCursor = syncState?.posts?.last_taken_at || null;
if (collectionMode === 'incremental' && postsCursor) {
  log('info', `Incremental posts sync — cursor: ${postsCursor}`);
  broadcast({ type: 'progress', stream: 'posts', message: `Incremental sync — fetching posts since ${new Date(postsCursor).toLocaleDateString()}…` });
} else {
  broadcast({ type: 'progress', stream: 'posts', message: 'Full refresh — fetching all posts…' });
}

// Use Instagram's timeline API
const allTimelinePosts = await page.evaluate(`
  (async () => {
    try {
      const resp = await fetch('/api/v1/feed/user/${userId}/?count=50', {
        headers: { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      const items = Array.isArray(data.items) ? data.items : [];
      return items.map(item => ({
        id: String(item.id || item.pk || ''),
        shortcode: item.code || item.shortcode || '',
        caption: (Array.isArray(item.caption) ? item.caption[0]?.text : item.caption?.text) || '',
        like_count: item.like_count || 0,
        comment_count: item.comment_count || 0,
        taken_at: item.taken_at ? new Date(item.taken_at * 1000).toISOString() : new Date().toISOString(),
        media_type: item.media_type === 1 ? 'IMAGE' : item.media_type === 2 ? 'VIDEO' : 'CAROUSEL_ALBUM',
      }));
    } catch (e) { return []; }
  })()
`);

// Apply incremental filter — only ingest posts newer than cursor
const timelinePosts = (collectionMode === 'incremental' && postsCursor)
  ? allTimelinePosts.filter(p => p.taken_at > postsCursor)
  : allTimelinePosts;

log('info', `Scraped ${allTimelinePosts.length} posts total, ingesting ${timelinePosts.length} (${collectionMode === 'incremental' ? 'incremental' : 'full'})`);
broadcast({ type: 'progress', stream: 'posts', message: `Ingesting ${timelinePosts.length} posts…`, count: timelinePosts.length, total: allTimelinePosts.length });

for (const post of timelinePosts) {
  await ingestRecord(connectorId, ownerToken, 'posts', {
    key: post.id,
    data: post,
    emitted_at: new Date().toISOString(),
  });
  await page.waitForTimeout(150);
}

// Emit STATE checkpoint with the most recent taken_at as the cursor (only if posts were found)
if (allTimelinePosts.length > 0) {
  const maxTakenAt = allTimelinePosts.reduce((max, p) => p.taken_at > max ? p.taken_at : max, allTimelinePosts[0].taken_at);
  emitState('posts', { last_taken_at: maxTakenAt, total_seen: allTimelinePosts.length });
}

broadcast({ type: 'stream-complete', stream: 'posts', count: timelinePosts.length });

// ─── ad_targeting ─────────────────────────────────────────────────────────────
log('info', 'Scraping ad targeting data...');
await scrapeAdInterests();

const adTopics = state.adsData.ad_topics.map(t => typeof t === 'string' ? t : t.name).filter(Boolean);
const advertisers = state.adsData.advertisers.map(a => typeof a === 'string' ? a : a.name).filter(Boolean);
const categories = state.adsData.targeting_categories.map(c => typeof c === 'string' ? c : c.name).filter(Boolean);

await ingestRecord(connectorId, ownerToken, 'ad_targeting', {
  key: 'targeting',
  data: {
    topics: adTopics,
    advertisers,
    categories,
  },
  emitted_at: new Date().toISOString(),
});
broadcast({ type: 'stream-complete', stream: 'ad_targeting', count: 1 });
log('info', `Ad targeting: ${adTopics.length} topics, ${advertisers.length} advertisers, ${categories.length} categories`);

broadcastData('status', 'Data collection complete');
log('info', 'Instagram scraping complete');
