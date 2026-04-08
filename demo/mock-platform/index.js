/**
 * MusicVault — mock music streaming platform
 *
 * A convincing but entirely local fake of a Spotify-like platform.
 * Used by the scraper to demonstrate real browser-based data collection.
 */
import express from 'express';

const app = express();
const PORT = 4000;

const USER = {
  username: 'demouser',
  password: 'demo1234',
  displayName: 'Alex Demo',
  avatar: 'AD',
  plan: 'Premium',
  memberSince: 'January 2019',
};

const TOP_ARTISTS = [
  { id: 'art_001', name: 'Radiohead', genres: ['Alternative', 'Art Rock'], popularity: 82, followers: '7.8M', image: '#7B68EE' },
  { id: 'art_002', name: 'Kendrick Lamar', genres: ['Hip Hop', 'Conscious Rap'], popularity: 93, followers: '22M', image: '#C0392B' },
  { id: 'art_003', name: 'The Weeknd', genres: ['R&B', 'Pop'], popularity: 95, followers: '38M', image: '#8E44AD' },
  { id: 'art_004', name: 'Taylor Swift', genres: ['Pop', 'Country Pop'], popularity: 100, followers: '98M', image: '#E91E8C' },
  { id: 'art_005', name: 'Aphex Twin', genres: ['Electronic', 'IDM', 'Ambient'], popularity: 71, followers: '2.1M', image: '#1ABC9C' },
  { id: 'art_006', name: 'Drake', genres: ['Hip Hop', 'Canadian Pop'], popularity: 96, followers: '73M', image: '#F39C12' },
  { id: 'art_007', name: 'Adele', genres: ['British Soul', 'Pop'], popularity: 88, followers: '42M', image: '#3498DB' },
  { id: 'art_008', name: 'Foo Fighters', genres: ['Alternative Metal', 'Rock'], popularity: 79, followers: '12M', image: '#E74C3C' },
];

const SAVED_TRACKS = [
  { id: 'trk_001', title: 'Creep', artist: 'Radiohead', album: 'Pablo Honey', duration: '3:58', savedDate: '3 months ago', color: '#7B68EE' },
  { id: 'trk_002', title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', duration: '3:20', savedDate: '2 months ago', color: '#8E44AD' },
  { id: 'trk_003', title: 'HUMBLE.', artist: 'Kendrick Lamar', album: 'DAMN.', duration: '2:57', savedDate: '3 weeks ago', color: '#C0392B' },
  { id: 'trk_004', title: 'Shake It Off', artist: 'Taylor Swift', album: '1989', duration: '3:39', savedDate: '10 days ago', color: '#E91E8C' },
  { id: 'trk_005', title: 'God\'s Plan', artist: 'Drake', album: 'Scorpion', duration: '3:18', savedDate: '1 month ago', color: '#F39C12' },
  { id: 'trk_006', title: 'Someone Like You', artist: 'Adele', album: '21', duration: '4:45', savedDate: '5 days ago', color: '#3498DB' },
  { id: 'trk_007', title: 'Karma Police', artist: 'Radiohead', album: 'OK Computer', duration: '4:24', savedDate: '85 days ago', color: '#7B68EE' },
  { id: 'trk_008', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', duration: '5:54', savedDate: '45 days ago', color: '#9B59B6' },
];

const RECENTLY_PLAYED = [
  { id: 'play_001', title: 'Creep', artist: 'Radiohead', playedAt: '1 hour ago', color: '#7B68EE' },
  { id: 'play_002', title: 'Blinding Lights', artist: 'The Weeknd', playedAt: '2 hours ago', color: '#8E44AD' },
  { id: 'play_003', title: 'God\'s Plan', artist: 'Drake', playedAt: '4 hours ago', color: '#F39C12' },
  { id: 'play_004', title: 'HUMBLE.', artist: 'Kendrick Lamar', playedAt: 'Yesterday', color: '#C0392B' },
  { id: 'play_005', title: 'Shake It Off', artist: 'Taylor Swift', playedAt: 'Yesterday', color: '#E91E8C' },
];

// In-memory session store (demo only)
const sessions = new Set();

function renderArtistCard(a) {
  return `
    <div class="artist-card" data-id="${a.id}" data-name="${a.name}" data-genres="${a.genres.join(',')}" data-popularity="${a.popularity}">
      <div class="artist-avatar" style="background:${a.image}">${a.name.split(' ').map(w => w[0]).join('').slice(0,2)}</div>
      <div class="artist-info">
        <div class="artist-name">${a.name}</div>
        <div class="artist-genres">${a.genres.join(' · ')}</div>
        <div class="artist-meta">${a.followers} followers · Popularity ${a.popularity}/100</div>
      </div>
    </div>`;
}

function renderTrackRow(t, i) {
  return `
    <div class="track-row" data-id="${t.id}" data-title="${t.title}" data-artist="${t.artist}">
      <div class="track-num">${i + 1}</div>
      <div class="track-color" style="background:${t.color}"></div>
      <div class="track-info">
        <div class="track-title">${t.title}</div>
        <div class="track-artist">${t.artist}</div>
      </div>
      <div class="track-album">${t.album}</div>
      <div class="track-saved">${t.savedDate}</div>
      <div class="track-duration">${t.duration}</div>
    </div>`;
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #121212; color: #fff; min-height: 100vh; }

  /* Login */
  .login-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); }
  .login-card { background: #282828; border-radius: 16px; padding: 48px 40px; width: 400px; box-shadow: 0 32px 64px rgba(0,0,0,0.5); }
  .login-logo { font-size: 28px; font-weight: 800; color: #1db954; margin-bottom: 8px; letter-spacing: -1px; }
  .login-tagline { color: #999; font-size: 14px; margin-bottom: 32px; }
  .login-card h2 { font-size: 22px; font-weight: 700; margin-bottom: 24px; }
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; font-size: 13px; font-weight: 600; color: #ccc; margin-bottom: 6px; }
  .form-group input { width: 100%; padding: 12px 16px; background: #3e3e3e; border: 1px solid #555; border-radius: 8px; color: #fff; font-size: 15px; outline: none; transition: border-color 0.2s; }
  .form-group input:focus { border-color: #1db954; }
  .login-btn { width: 100%; padding: 14px; background: #1db954; border: none; border-radius: 50px; color: #000; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 8px; transition: transform 0.1s, background 0.2s; }
  .login-btn:hover { background: #1ed760; transform: scale(1.01); }
  .login-hint { margin-top: 20px; text-align: center; color: #666; font-size: 13px; }
  .login-hint span { color: #1db954; }

  /* App shell */
  .app { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
  .sidebar { background: #000; padding: 24px 16px; display: flex; flex-direction: column; gap: 4px; }
  .sidebar-logo { font-size: 22px; font-weight: 800; color: #1db954; margin-bottom: 24px; padding: 0 8px; letter-spacing: -0.5px; }
  .nav-item { padding: 10px 12px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 12px; font-size: 14px; font-weight: 600; color: #999; transition: all 0.15s; text-decoration: none; }
  .nav-item:hover { color: #fff; background: #282828; }
  .nav-item.active { color: #fff; }
  .nav-icon { width: 20px; text-align: center; font-size: 16px; }
  .sidebar-section { margin-top: 20px; padding: 0 12px; font-size: 11px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: 1px; }
  .user-area { margin-top: auto; padding: 12px; background: #282828; border-radius: 12px; display: flex; align-items: center; gap: 10px; }
  .user-avatar { width: 36px; height: 36px; border-radius: 50%; background: #1db954; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800; color: #000; flex-shrink: 0; }
  .user-name { font-size: 13px; font-weight: 600; }
  .user-plan { font-size: 11px; color: #1db954; }

  /* Main content */
  .main { background: linear-gradient(180deg, #1a1a2e 0%, #121212 300px); padding: 32px; overflow-y: auto; }
  .page-title { font-size: 28px; font-weight: 800; margin-bottom: 6px; }
  .page-subtitle { color: #999; font-size: 14px; margin-bottom: 32px; }
  .section-label { font-size: 13px; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; }

  /* Artist cards */
  .artists-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 40px; }
  .artist-card { background: #282828; border-radius: 12px; padding: 16px; display: flex; align-items: center; gap: 14px; transition: background 0.15s; cursor: pointer; }
  .artist-card:hover { background: #333; }
  .artist-avatar { width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 800; color: #fff; flex-shrink: 0; }
  .artist-name { font-size: 15px; font-weight: 700; margin-bottom: 3px; }
  .artist-genres { font-size: 12px; color: #aaa; margin-bottom: 3px; }
  .artist-meta { font-size: 11px; color: #666; }

  /* Track list */
  .tracks-list { background: #282828; border-radius: 12px; overflow: hidden; margin-bottom: 40px; }
  .tracks-header { display: grid; grid-template-columns: 32px 8px 1fr 160px 100px 60px; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #333; font-size: 11px; color: #666; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .track-row { display: grid; grid-template-columns: 32px 8px 1fr 160px 100px 60px; gap: 12px; padding: 10px 16px; align-items: center; transition: background 0.1s; cursor: pointer; }
  .track-row:hover { background: #333; }
  .track-num { font-size: 14px; color: #999; text-align: center; }
  .track-color { width: 8px; height: 32px; border-radius: 2px; }
  .track-title { font-size: 14px; font-weight: 600; margin-bottom: 2px; }
  .track-artist { font-size: 12px; color: #aaa; }
  .track-album { font-size: 13px; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track-saved { font-size: 12px; color: #aaa; }
  .track-duration { font-size: 13px; color: #aaa; text-align: right; }

  /* Recently played */
  .recent-list { display: flex; flex-direction: column; gap: 8px; }
  .recent-item { background: #282828; border-radius: 10px; padding: 12px 16px; display: flex; align-items: center; gap: 12px; }
  .recent-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .recent-title { font-size: 14px; font-weight: 600; }
  .recent-artist { font-size: 12px; color: #aaa; }
  .recent-time { margin-left: auto; font-size: 12px; color: #666; }
`;

// Routes
app.get('/', (req, res) => {
  if (sessions.has(req.headers.cookie?.match(/sid=([^;]+)/)?.[1])) {
    res.redirect('/library');
    return;
  }
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>MusicVault</title>
  <meta charset="utf-8">
  <style>${CSS}</style>
</head>
<body>
<div class="login-page">
  <div class="login-card">
    <div class="login-logo">MusicVault</div>
    <div class="login-tagline">Your music, your data.</div>
    <h2>Sign in to your account</h2>
    <form method="POST" action="/login" id="login-form">
      <div class="form-group">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" placeholder="Enter your username" autocomplete="username" value="demouser">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" placeholder="Enter your password" autocomplete="current-password" value="demo1234">
      </div>
      <button class="login-btn" type="submit">Sign In</button>
    </form>
    <div class="login-hint">Demo credentials: <span>demouser</span> / <span>demo1234</span></div>
  </div>
</div>
</body>
</html>`);
});

app.use(express.urlencoded({ extended: false }));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === USER.username && password === USER.password) {
    const sid = Math.random().toString(36).slice(2);
    sessions.add(sid);
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly`);
    res.redirect('/library');
  } else {
    res.redirect('/?error=invalid');
  }
});

function requireAuth(req, res, next) {
  const sid = req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
  if (!sessions.has(sid)) { res.redirect('/'); return; }
  next();
}

app.get('/library', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>MusicVault — Library</title>
  <meta charset="utf-8">
  <style>${CSS}</style>
</head>
<body>
<div class="app">
  <nav class="sidebar">
    <div class="sidebar-logo">MusicVault</div>
    <a class="nav-item" href="/library"><span class="nav-icon">◎</span> Home</a>
    <a class="nav-item active" href="/library"><span class="nav-icon">♪</span> Your Library</a>
    <a class="nav-item" href="/top-artists"><span class="nav-icon">★</span> Top Artists</a>
    <a class="nav-item" href="/saved-tracks"><span class="nav-icon">♥</span> Saved Tracks</a>
    <a class="nav-item" href="/recent"><span class="nav-icon">↺</span> Recently Played</a>
    <div class="sidebar-section">Account</div>
    <a class="nav-item" href="/settings"><span class="nav-icon">⚙</span> Settings</a>
    <div class="user-area">
      <div class="user-avatar">${USER.avatar}</div>
      <div>
        <div class="user-name">${USER.displayName}</div>
        <div class="user-plan">${USER.plan}</div>
      </div>
    </div>
  </nav>
  <main class="main">
    <div class="page-title">Good evening, ${USER.displayName}</div>
    <div class="page-subtitle">Member since ${USER.memberSince}</div>

    <div class="section-label">Your Top Artists</div>
    <div class="artists-grid" id="top-artists">
      ${TOP_ARTISTS.slice(0, 4).map(renderArtistCard).join('')}
    </div>

    <div class="section-label">Recently Played</div>
    <div class="recent-list" id="recently-played">
      ${RECENTLY_PLAYED.slice(0, 3).map(p => `
        <div class="recent-item" data-id="${p.id}" data-title="${p.title}" data-artist="${p.artist}">
          <div class="recent-dot" style="background:${p.color}"></div>
          <div>
            <div class="recent-title">${p.title}</div>
            <div class="recent-artist">${p.artist}</div>
          </div>
          <div class="recent-time">${p.playedAt}</div>
        </div>`).join('')}
    </div>
  </main>
</div>
</body>
</html>`);
});

app.get('/top-artists', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>MusicVault — Top Artists</title>
  <meta charset="utf-8">
  <style>${CSS}</style>
</head>
<body>
<div class="app">
  <nav class="sidebar">
    <div class="sidebar-logo">MusicVault</div>
    <a class="nav-item" href="/library"><span class="nav-icon">◎</span> Home</a>
    <a class="nav-item" href="/library"><span class="nav-icon">♪</span> Your Library</a>
    <a class="nav-item active" href="/top-artists"><span class="nav-icon">★</span> Top Artists</a>
    <a class="nav-item" href="/saved-tracks"><span class="nav-icon">♥</span> Saved Tracks</a>
    <a class="nav-item" href="/recent"><span class="nav-icon">↺</span> Recently Played</a>
    <div class="user-area">
      <div class="user-avatar">${USER.avatar}</div>
      <div><div class="user-name">${USER.displayName}</div><div class="user-plan">${USER.plan}</div></div>
    </div>
  </nav>
  <main class="main">
    <div class="page-title">Your Top Artists</div>
    <div class="page-subtitle">Based on all-time listening history</div>
    <div class="section-label">All Time Favorites</div>
    <div class="artists-grid" id="top-artists">
      ${TOP_ARTISTS.map(renderArtistCard).join('')}
    </div>
  </main>
</div>
</body>
</html>`);
});

app.get('/saved-tracks', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>MusicVault — Saved Tracks</title>
  <meta charset="utf-8">
  <style>${CSS}</style>
</head>
<body>
<div class="app">
  <nav class="sidebar">
    <div class="sidebar-logo">MusicVault</div>
    <a class="nav-item" href="/library"><span class="nav-icon">◎</span> Home</a>
    <a class="nav-item" href="/library"><span class="nav-icon">♪</span> Your Library</a>
    <a class="nav-item" href="/top-artists"><span class="nav-icon">★</span> Top Artists</a>
    <a class="nav-item active" href="/saved-tracks"><span class="nav-icon">♥</span> Saved Tracks</a>
    <a class="nav-item" href="/recent"><span class="nav-icon">↺</span> Recently Played</a>
    <div class="user-area">
      <div class="user-avatar">${USER.avatar}</div>
      <div><div class="user-name">${USER.displayName}</div><div class="user-plan">${USER.plan}</div></div>
    </div>
  </nav>
  <main class="main">
    <div class="page-title">Saved Tracks</div>
    <div class="page-subtitle">${SAVED_TRACKS.length} songs saved to your library</div>
    <div class="tracks-list" id="saved-tracks">
      <div class="tracks-header">
        <div>#</div><div></div><div>Title</div><div>Album</div><div>Added</div><div>⏱</div>
      </div>
      ${SAVED_TRACKS.map(renderTrackRow).join('')}
    </div>
  </main>
</div>
</body>
</html>`);
});

app.get('/recent', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>MusicVault — Recently Played</title>
  <meta charset="utf-8">
  <style>${CSS}</style>
</head>
<body>
<div class="app">
  <nav class="sidebar">
    <div class="sidebar-logo">MusicVault</div>
    <a class="nav-item" href="/library"><span class="nav-icon">◎</span> Home</a>
    <a class="nav-item" href="/library"><span class="nav-icon">♪</span> Your Library</a>
    <a class="nav-item" href="/top-artists"><span class="nav-icon">★</span> Top Artists</a>
    <a class="nav-item" href="/saved-tracks"><span class="nav-icon">♥</span> Saved Tracks</a>
    <a class="nav-item active" href="/recent"><span class="nav-icon">↺</span> Recently Played</a>
    <div class="user-area">
      <div class="user-avatar">${USER.avatar}</div>
      <div><div class="user-name">${USER.displayName}</div><div class="user-plan">${USER.plan}</div></div>
    </div>
  </nav>
  <main class="main">
    <div class="page-title">Recently Played</div>
    <div class="page-subtitle">Your listening history</div>
    <div class="recent-list" id="recently-played">
      ${RECENTLY_PLAYED.map(p => `
        <div class="recent-item" data-id="${p.id}" data-title="${p.title}" data-artist="${p.artist}">
          <div class="recent-dot" style="background:${p.color}"></div>
          <div>
            <div class="recent-title">${p.title}</div>
            <div class="recent-artist">${p.artist}</div>
          </div>
          <div class="recent-time">${p.playedAt}</div>
        </div>`).join('')}
    </div>
  </main>
</div>
</body>
</html>`);
});

// JSON API endpoints (for scraper to also read directly)
app.get('/api/top-artists', requireAuth, (req, res) => res.json(TOP_ARTISTS));
app.get('/api/saved-tracks', requireAuth, (req, res) => res.json(SAVED_TRACKS));
app.get('/api/recently-played', requireAuth, (req, res) => res.json(RECENTLY_PLAYED));

app.listen(PORT, () => console.log(`MusicVault mock platform on http://localhost:${PORT}`));
