import { config } from './config.js';
import { getAdminSession, loginWithSharedPassword, logoutAdmin } from './api/admin.js';
import { dbDelete, dbGet, dbPatch, dbPost, dbUpsert } from './api/supabase.js';
import { extractResultsFromImage } from './api/result-extraction.js';
import { classifyDriverByEfficiency } from './domain/classification.js';
import { calculateDropRound, calculateSessionPoints } from './domain/scoring.js';

// ============================================================
// STATE
// ============================================================
let state = {
  series: [config.series],
  currentSeriesId: config.series.id,
  currentSeriesName: config.series.name,
  isAdmin: false,
  activeThresholds: {p:72, g:55, s:35},
  allTimeData: [],
  allTimeSortKey: 'wins',
  allTimeSortDir: 1,
  allTimeClassFilter: 'all',
  allTimeSearch: '',
  standingsClassFilter: 'all',
  currentDrivers: [],
  csvData: [],
  theme: 'dark',
};

function applyTheme(theme) {
  state.theme = theme || 'dark';
  document.body.classList.toggle('theme-usa', state.theme === 'usa-light');
  // update toggle button label if it exists
  const btn = document.getElementById('theme-toggle-btn');
  if(btn) btn.textContent = state.theme === 'usa-light' ? '🌙 Switch to Dark' : '🇺🇸 USA Light';
}

async function toggleTheme() {
  const newTheme = state.theme === 'usa-light' ? 'dark' : 'usa-light';
  applyTheme(newTheme);
  try {
    // upsert into admin_config
    const existing = await dbGet('admin_config', 'key=eq.theme');
    if(existing.length) {
      await dbPatch('admin_config', 'key=eq.theme', {value: newTheme});
    } else {
      await dbPost('admin_config', [{key: 'theme', value: newTheme}]);
    }
    toast(newTheme === 'usa-light' ? '🇺🇸 USA Light theme applied' : '🌙 Dark theme applied');
  } catch(e) {
    toast('Error saving theme: ' + e.message, 'error');
  }
}

// ============================================================
// UI HELPERS
// ============================================================
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(`page-${id}`);
  if(el) el.classList.add('active');
}

function showAdminPage(id) {
  if(!state.isAdmin) { toggleAdminMenu(); return; }
  // deactivate public nav
  document.querySelectorAll('.nvb').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(`page-${id}`);
  if(el) el.classList.add('active');
  // highlight active admin menu item
  document.querySelectorAll('.admin-dropdown-item').forEach(i => i.classList.remove('active'));
  const menuItem = document.getElementById(`amenu-${id}`);
  if(menuItem) menuItem.classList.add('active');
  // trigger page init
  if(id==='enter-results') initEnterResults();
  else if(id==='season-setup') initSeasonSetup();
  else if(id==='tracks') initTracksPage();
  else if(id==='scoring') initScoring();
  else if(id==='drivers-admin') initDriversAdmin();
  else if(id==='share') initShare();
}

function toggleAdminMenu() {
  const dd = document.getElementById('admin-dropdown');
  dd.classList.toggle('open');
  // close when clicking outside
  if(dd.classList.contains('open')) {
    setTimeout(() => {
      document.addEventListener('click', closeOnOutsideClick);
    }, 10);
  }
}

function closeOnOutsideClick(e) {
  const dd = document.getElementById('admin-dropdown');
  const btn = document.getElementById('admin-menu-btn');
  if(!dd.contains(e.target) && !btn.contains(e.target)) {
    closeAdminMenu();
  }
}

function closeAdminMenu() {
  document.getElementById('admin-dropdown').classList.remove('open');
  document.removeEventListener('click', closeOnOutsideClick);
}

async function adminLogout() {
  try { await logoutAdmin(); } catch(e) { console.warn('Could not clear admin session', e); }
  state.isAdmin = false;
  document.getElementById('admin-menu-btn').className = 'admin-btn';
  document.getElementById('admin-menu-btn').textContent = '🔒 Admin';
  document.getElementById('admin-logged-in').style.display = 'none';
  document.getElementById('admin-logged-out').style.display = 'block';
  navTo(document.querySelector('.nvb'), 'dashboard');
  toast('Signed out');
}

function initTracksPage() {
  loadCircuitRegistry();
}

function initDriversAdmin() {
  loadDriverRoster();
}
function navTo(el, id) {
  document.querySelectorAll('.nvb').forEach(b => b.classList.remove('active'));
  if(el) el.classList.add('active');
  showPage(id);
  if(id==='dashboard') loadDashboard();
  else if(id==='standings') loadStandings();
  else if(id==='events') loadEventsPage();
  else if(id==='drivers') loadDrivers();
  else if(id==='records') loadRecords();
  else if(id==='enter-results') initEnterResults();
  else if(id==='scoring') initScoring();
  else if(id==='season-setup') initSeasonSetup();
}
function requireAdmin(fn) {
  if(state.isAdmin) fn();
  else { toggleAdminMenu(); }
}
function toast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => t.classList.remove('show'), 3000);
}
function loading(el) { document.getElementById(el).innerHTML = '<div class="loading"><span class="spinner"></span>Loading...</div>'; }

function badgeHTML(cls) {
  const map = {P:'<span class="bp">P</span>',G:'<span class="bg">G</span>',S:'<span class="bs">S</span>',B:'<span class="bb">B</span>',U:'<span class="bu">—</span>'};
  return map[cls] || map.U;
}
function badgeFull(cls) {
  const map = {P:'<span class="bp">PLATINUM</span>',G:'<span class="bg">GOLD</span>',S:'<span class="bs">SILVER</span>',B:'<span class="bb">BRONZE</span>',U:'<span class="bu">UNRATED</span>'};
  return map[cls] || map.U;
}
function effColor(cls) {
  return {P:'var(--simr-platinum)',G:'var(--simr-amber)',S:'var(--simr-silver)',B:'var(--simr-bronze)'}[cls] || 'var(--simr-muted)';
}
function initials(name) {
  return name.split(' ').filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();
}
// Returns display name if set, otherwise gamertag
function driverLabel(driver) {
  if(!driver) return 'Unknown';
  return driver.display_name || driver.name;
}

// ============================================================
// LAP RECORDS HELPER
// ============================================================
async function getLapRecords(seriesId) {
  // Get all race sessions with lap times for this series
  const { events, sessions, results } = await getSeriesData();
  const raceSessions = sessions.filter(s=>s.session_type==='race');
  
  // Group by event track
  const trackRecords = {}; // key: track name, value: {driver_id, lap_time, event_name, session_id, car}
  
  const toSecs = t => {
    if(!t) return Infinity;
    const clean = t.replace(',','.').trim();
    const parts = clean.split(':');
    return parts.length===2 ? parseFloat(parts[0])*60+parseFloat(parts[1]) : parseFloat(parts[0]);
  };

  // Load cars table for names
  const carsArr = await dbGet('cars', `series_id=eq.${seriesId}&order=name.asc`);
  const carsMap = {};
  carsArr.forEach(c => carsMap[c.id] = c.name);

  // Fetch events directly to ensure car_id is included
  const eventsWithCar = await dbGet('events', `series_id=eq.${seriesId}`);
  const evCarMap = {};
  eventsWithCar.forEach(e => evCarMap[e.id] = e.car_id);

  // Load season_drivers for per-driver car overrides
  const seasonDriversArr = await dbGet('season_drivers');
  const sdBySeasonDriver = {}; // driver_id+season_id -> car_model
  const sdByEventDriver = {};  // driver_id+event_id -> car_model
  seasonDriversArr.forEach(sd => {
    if(sd.season_id) sdBySeasonDriver[`${sd.driver_id}_${sd.season_id}`] = sd.car_model;
    if(sd.event_id) sdByEventDriver[`${sd.driver_id}_${sd.event_id}`] = sd.car_model;
  });

  // Load circuit layouts for session-level layout lookup
  const layoutsForLR = await dbGet('circuit_layouts');
  const circuitsForLR = await dbGet('circuits');
  const layoutMapLR = {};
  layoutsForLR.forEach(l => layoutMapLR[l.id] = l);
  const circuitMapLR = {};
  circuitsForLR.forEach(c => circuitMapLR[c.id] = c.name);

  raceSessions.forEach(sess => {
    const ev = events.find(e=>e.id===sess.event_id);
    if(!ev) return;
    // Use session-level layout if set, else fall back to event track
    let trackKey;
    if(sess.circuit_layout_id && layoutMapLR[sess.circuit_layout_id]) {
      const layout = layoutMapLR[sess.circuit_layout_id];
      const circuitName = circuitMapLR[layout.circuit_id] || (ev.track||ev.name||'Unknown').replace(/\s*\([^)]+\)/g,'').trim();
      const layoutSuffix = layout.name && layout.name.toLowerCase()!=='circuit' ? ' — '+layout.name : '';
      trackKey = circuitName + layoutSuffix;
    } else {
      const rawTrack = ev.track || ev.name || 'Unknown';
      trackKey = rawTrack.replace(/\s*\([^)]+\)/g, '').trim();
    }
    const sessResults = results.filter(r=>r.session_id===sess.id&&r.lap_time&&!r.dnf);
    sessResults.forEach(r => {
      const secs = toSecs(r.lap_time);
      if(isNaN(secs)||secs===Infinity) return;
      if(!trackRecords[trackKey] || secs < toSecs(trackRecords[trackKey].lap_time)) {
        // Car priority: per-driver override > event car_id > legacy text
        const driverCarId = ev.season_id
          ? null  // season driver car overrides handled via car_id on season_drivers (future)
          : null;
        const eventCarId = evCarMap[ev.id];
        const carName = carsMap[eventCarId] || null;
        const legacyCar = ev.season_id
          ? (sdBySeasonDriver[`${r.driver_id}_${ev.season_id}`] || null)
          : (sdByEventDriver[`${r.driver_id}_${ev.id}`] || null);
        trackRecords[trackKey] = {
          driver_id: r.driver_id,
          lap_time: r.lap_time,
          secs,
          event_name: ev.name||ev.track,
          event_id: ev.id,
          track: trackKey,
          carName,
          car: legacyCar
        };
      }
    });
  });

  return trackRecords;
}

// Get lap records held by a specific driver
function getDriverLapRecords(driverId, trackRecords) {
  return Object.values(trackRecords).filter(r=>r.driver_id===driverId);
}

// ============================================================
// SERIES-SCOPED DATA HELPERS
// ============================================================
// Get all sessions and results scoped to current series
async function getSeriesData() {
  const seriesId = state.currentSeriesId;
  const [seasons, events, sessions, results] = await Promise.all([
    dbGet('seasons', `series_id=eq.${seriesId}&order=season_number.asc`),
    dbGet('events', `series_id=eq.${seriesId}&order=event_date.asc`),
    dbGet('sessions', 'limit=5000', { headers: { Range: '0-4999', 'Range-Unit': 'items' } }),
    dbGet('results', 'limit=10000', { headers: { Range: '0-9999', 'Range-Unit': 'items' } })
  ]);
  // Filter sessions and results to this series only
  const evIds = new Set(events.map(e=>e.id));
  const seriesSessions = sessions.filter(s=>evIds.has(s.event_id));
  const sessIds = new Set(seriesSessions.map(s=>s.id));
  const seriesResults = results.filter(r=>sessIds.has(r.session_id));
  return { seasons, events, sessions: seriesSessions, results: seriesResults };
}

// ============================================================
// SCORING / CLASSIFICATION LOGIC
// ============================================================
function classifyDriver(careerEff, starts, thresholds) {
  return classifyDriverByEfficiency(
    careerEff,
    starts,
    thresholds || state.activeThresholds
  );
}

// Calculate ALL career stats live from results for a driver
// Pass careerStatsMap to use as fallback for poles from historic seasons
function calcLiveCareerStats(driverId, allResults, allSessions, allEvents, allSeasons, scoringConfigMap, careerStatsMap, eventScoringConfigMap) {
  let starts = 0, wins = 0, podiums = 0, top5s = 0, top10s = 0, poles = 0;
  let totalEarned = 0, totalPossible = 0, totalFinishSum = 0;
  const eventBreakdown = [];

  // race results
  let careerPosGained = 0;
  let startPosTotal = 0;
  let startPosRaces = 0;
  allSessions.filter(s => s.session_type === 'race').forEach(sess => {
    const ev = allEvents.find(e => e.id === sess.event_id);
    if(!ev) return;
    const season = allSeasons.find(s => s.id === ev.season_id);
    // One-off events: use event-level scoring first, then season fallback
    const sc = ev.is_one_off
      ? (eventScoringConfigMap?.[ev.id] || scoringConfigMap[allSeasons[0]?.id] || [])
      : (scoringConfigMap[season?.id] || []);
    const r = allResults.find(res => res.session_id === sess.id && res.driver_id === driverId);
    if(!r) return;
    starts++;
    const sessPossible = sess.points_max || 20;
    totalPossible += sessPossible;
    // Starting position: use grid_position on result OR fallback to matching grid session
    const gridSessForPG = allSessions.find(gs=>gs.event_id===sess.event_id&&gs.session_type==='grid'&&gs.race_number===sess.race_number);
    let startPos = r.grid_position;
    if(!startPos && gridSessForPG) {
      const gr = allResults.find(res=>res.session_id===gridSessForPG.id&&res.driver_id===driverId);
      startPos = gr?.position;
    }
    if(startPos) {
      startPosTotal += startPos;
      startPosRaces++;
      if(!r.dnf && r.position && startPos > r.position) {
        careerPosGained += startPos - r.position;
      }
    }
    if(!r.dnf) {
      totalFinishSum += r.position || 99;
      if(r.position === 1) wins++;
      if(r.position <= 3) podiums++;
      if(r.position <= 5) top5s++;
      if(r.position <= 10) top10s++;
    }
    // Points — DNF earns last classified position's points, via shared session map
    const baseP1Live = sc.length ? sc[0].points : 20;
    const sessResultsForPts = allResults.filter(res => res.session_id === sess.id);
    const sessPtsMapLive = calcSessionPointsMap(sess, sessResultsForPts, sc, baseP1Live);
    const sessEarned = sessPtsMapLive[driverId] || 0;
    totalEarned += sessEarned;
    eventBreakdown.push({
      eventId: ev.id,
      eventName: ev.name || ev.track || 'Unknown',
      seasonName: season?.name || null,
      isOneOff: ev.is_one_off || false,
      eventType: ev.event_type || null,
      position: r.dnf ? 'DNF' : (r.position || '?'),
      earned: sessEarned,
      possible: sessPossible,
      raceNum: sess.race_number,
      date: ev.event_date || ''
    });
  });

  // poles from qualifying grid sessions (is_qualifying=true, P1)
  allSessions.filter(s => s.session_type === 'grid' && s.is_qualifying).forEach(sess => {
    const r = allResults.find(res => res.session_id === sess.id && res.driver_id === driverId && res.position === 1);
    if(r) poles++;
  });
  // also check old 'quali' type for backwards compatibility
  allSessions.filter(s => s.session_type === 'quali').forEach(sess => {
    const r = allResults.find(res => res.session_id === sess.id && res.driver_id === driverId && res.position === 1);
    if(r) poles++;
  });

  // fastest laps
  let fastestLaps = 0;
  allSessions.filter(s => s.session_type === 'race').forEach(sess => {
    const r = allResults.find(res => res.session_id === sess.id && res.driver_id === driverId && res.fastest_lap);
    if(r) fastestLaps++;
  });

  // positions gained — compare race finish to matching grid/quali session starting position
  let totalPosGained = 0; let posGainedRaces = 0;
  allSessions.filter(s => s.session_type === 'race').forEach(sess => {
    const ev = allEvents.find(e => e.id === sess.event_id);
    if(!ev) return;
    const r = allResults.find(res => res.session_id === sess.id && res.driver_id === driverId);
    if(!r || r.dnf || !r.position) return;
    // use explicit grid_position if set, otherwise look up matching grid session
    let startPos = r.grid_position || null;
    if(!startPos) {
      const gridSess = allSessions.find(s =>
        s.event_id === sess.event_id &&
        s.session_type === 'grid' &&
        s.race_number === sess.race_number
      );
      if(gridSess) {
        const gridResult = allResults.find(res => res.session_id === gridSess.id && res.driver_id === driverId);
        startPos = gridResult?.position || null;
      }
    }
    if(startPos) {
      totalPosGained += (startPos - r.position);
      posGainedRaces++;
    }
  });

  const eff = totalPossible > 0 ? (totalEarned / totalPossible) * 100 : null;
  const avg = starts > 0 ? totalFinishSum / starts : null;
  const avgPosGained = posGainedRaces > 0 ? totalPosGained / posGainedRaces : null;

  // merge with career_stats poles for historic seasons that had no grid sessions entered
  const storedPoles = careerStatsMap?.[driverId]?.poles || 0;
  const totalPoles = Math.max(poles, storedPoles);

  return { starts, wins, podiums, top5s, top10s, poles: totalPoles, fastestLaps, eff, avg, avgPosGained, totalPosGained, totalEarned, totalPossible, eventBreakdown, careerPosGained, avgStartPos: startPosRaces>0 ? startPosTotal/startPosRaces : null };
}

// Shared points calculator for a single race session's results.
// DNF results earn points equal to the LAST CLASSIFIED (non-DNF) position in that session.
function calcSessionPointsMap(sess, sessResults, sc, baseMax) {
  return calculateSessionPoints(sess, sessResults, sc);
}

function calcStandings(seasonId, allResults, allSessions, allEvents, scoringConfig, classConfig, careerStatsMap, seasonDriversArr) {
  const events = allEvents.filter(e => e.season_id === seasonId && !e.is_one_off);
  const driverMap = {};

  // Multi-car: key standings by driver+car combo instead of just driver
  const isMultiCar = events.some(e => e.is_multi_car);
  const carMap = {}; // driver_id -> car_model
  if(isMultiCar && seasonDriversArr) {
    seasonDriversArr.forEach(sd => { if(!carMap[sd.driver_id]) carMap[sd.driver_id] = sd.car_model; });
  }
  const eKey = (driverId) => isMultiCar ? `${driverId}|${carMap[driverId]||''}` : driverId;

  let completedEventIds = []; // rounds with at least one result — used for drop round eligibility

  events.forEach(ev => {
    const sessions = allSessions.filter(s => s.event_id === ev.id);
    const raceSessions = sessions.filter(s => s.session_type === 'race');
    const qualiSession = sessions.find(s => s.session_type === 'quali');

    let eventPts = {};
    let eventMaxPts = 0;

    raceSessions.forEach(sess => {
      const sessResults = allResults.filter(r => r.session_id === sess.id);
      const sc = scoringConfig.filter(s => s.season_id === seasonId).sort((a,b)=>a.position-b.position);
      const sessionPointsMax = sess.points_max || 20;
      const baseMax = sc.length ? sc[0].points : 20;
      eventMaxPts += sessionPointsMax;
      const sessPtsMap = calcSessionPointsMap(sess, sessResults, sc, baseMax);

      sessResults.forEach(r => {
        const k = eKey(r.driver_id);
        if(!driverMap[k]) {
          driverMap[k] = {
            driver_id: r.driver_id,
            car_model: isMultiCar ? (carMap[r.driver_id]||null) : null,
            pts: 0, wins: 0, podiums: 0, poles: 0,
            starts: 0, racesEntered: 0, eventPts: {},
            maxPossible: 0, roundHistory: []
          };
        }
        const d = driverMap[k];
        d.racesEntered++;
        const earned = sessPtsMap[r.driver_id] || 0;
        d.pts += earned;
        if(!eventPts[k]) eventPts[k] = {pts:0, maxPts:0};
        eventPts[k].pts += earned;
        if(!r.dnf) {
          if(r.position === 1) d.wins++;
          if(r.position <= 3) d.podiums++;
        }
        d.maxPossible += sessionPointsMax;
      });

    });

    // poles from qualifying grid sessions — outside race loop so counted once per event
    const gridSessions = sessions.filter(s => s.session_type === 'grid' && s.is_qualifying);
    gridSessions.forEach(gs => {
      const poleResult = allResults.find(r => r.session_id === gs.id && r.position === 1);
      if(poleResult) { const k = eKey(poleResult.driver_id); if(driverMap[k]) driverMap[k].poles++; }
    });
    // also check old quali type
    if(qualiSession) {
      const qualiResults = allResults.filter(r => r.session_id === qualiSession.id);
      const pole = qualiResults.find(r => r.position === 1);
      if(pole) { const k = eKey(pole.driver_id); if(driverMap[k]) driverMap[k].poles++; }
    }

    // store event pts for drop round calc — only count this round as "completed" if anyone scored in it
    if(Object.keys(eventPts).length > 0) completedEventIds.push(ev.id);
    Object.keys(eventPts).forEach(k => {
      if(!driverMap[k]) return;
      if(!driverMap[k].eventPts[ev.id]) driverMap[k].eventPts[ev.id] = 0;
      driverMap[k].eventPts[ev.id] += eventPts[k].pts;
    });
  });

  // drop round — always drop the single lowest-scoring completed round (missed rounds count as 0).
  // Requires at least 2 completed rounds — dropping your only round would zero your score.
  const dropEnabled = classConfig?.drop_round_enabled !== false;

  const standings = Object.values(driverMap).map(d => {
    const drop = calculateDropRound(d.eventPts, completedEventIds, dropEnabled);
    const adjustedPts = d.pts - drop.droppedPoints;
    const eff = d.maxPossible > 0 ? (d.pts / d.maxPossible) * 100 : null;

    // career eff + career starts from liveEffMap if available, else careerStatsMap
    const liveCareer = state._liveEffMap?.[d.driver_id];
    const cs = careerStatsMap[d.driver_id];
    const careerEff = liveCareer?.eff ?? cs?.career_eff ?? null;
    const careerStarts = liveCareer?.starts ?? cs?.starts ?? d.racesEntered;
    const displayCls = classifyDriver(careerEff, careerStarts);

    // poles fallback from career_stats for historic seasons with no grid sessions
    const storedPoles = careerStatsMap?.[d.driver_id]?.poles || 0;
    const totalPoles = Math.max(d.poles || 0, storedPoles);

    return {
      ...d,
      adjustedPts,
      dropAmt: drop.droppedEventId ? drop.droppedPoints : null,
      droppedEventId: drop.droppedEventId,
      eff,
      careerEff,
      cls: displayCls,
      starts: d.racesEntered,
      poles: totalPoles
    };
  });

  return standings.sort((a,b) => b.adjustedPts - a.adjustedPts || b.wins - a.wins);
}

// ============================================================
// INIT
// ============================================================
async function init() {
  try {
    state.isAdmin = await getAdminSession();
    const cfg = await dbGet('admin_config', 'key=eq.theme&select=key,value');
    cfg.forEach(row => {
      if(row.key === 'theme') applyTheme(row.value);
    });

    if(state.isAdmin) {
      const btn = document.getElementById('admin-menu-btn');
      btn.className = 'admin-btn logged-in';
      btn.innerHTML = '⚙ Admin ▾';
      document.getElementById('admin-logged-in').style.display = 'block';
      document.getElementById('admin-logged-out').style.display = 'none';
    }

    // load drivers
    state.currentDrivers = await dbGet('drivers', 'order=name');

    // load thresholds for the active/latest season upfront
    await loadActiveThresholds();

    // pre-calculate live career stats for all drivers so badges work everywhere
    await refreshLiveCareerStats();

    await loadDashboard();
  } catch(e) {
    console.error('Init error', e);
    toast('Failed to connect to database. Check your Supabase config.', 'error');
  }
}

// ============================================================
// SEASON SELECT HELPERS
// ============================================================
async function loadSeasonSelects(selectIds, seriesId) {
  const seasons = await dbGet('seasons', `series_id=eq.${seriesId}&order=season_number.desc`);
  selectIds.forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    const cur = el.value;
    el.innerHTML = seasons.length
      ? seasons.map(s => `<option value="${s.id}">${s.name}</option>`).join('')
      : '<option value="">No seasons</option>';
    if(cur && seasons.find(s=>s.id===cur)) el.value = cur;
  });
  return seasons;
}

// ============================================================
// DASHBOARD
// ============================================================
async function loadDashboard() {
  // Load everything needed for this series
  const { seasons, events, sessions, results } = await getSeriesData();
  const [scoringConfig, classConfig, careerStats, drivers] = await Promise.all([
    dbGet('scoring_config'),
    dbGet('classification_config'),
    dbGet('career_stats', `series_id=eq.${state.currentSeriesId}`),
    dbGet('drivers', 'order=name')
  ]);
  // sort seasons desc for active detection
  seasons.sort((a,b)=>b.season_number-a.season_number);

  state.currentDrivers = drivers;

  // Find active season
  const activeSeason = seasons.find(s => s.is_active) || seasons[0];

  // Build scoring config map
  const scoringConfigMap = {};
  scoringConfig.forEach(sc => {
    if(!scoringConfigMap[sc.season_id]) scoringConfigMap[sc.season_id] = [];
    scoringConfigMap[sc.season_id].push(sc);
  });

  const careerMap = {};
  careerStats.forEach(cs => { careerMap[cs.driver_id] = cs; });

  // All events with results
  const eventsWithResults = events.filter(ev => {
    const evSessions = sessions.filter(s => s.event_id === ev.id);
    return evSessions.some(s => results.some(r => r.session_id === s.id));
  });

  // Last event = most recent with results
  const lastEvent = eventsWithResults[eventsWithResults.length - 1];

  // Next event = next upcoming without results
  const nextEvent = events.find(ev => {
    const evSessions = sessions.filter(s => s.event_id === ev.id);
    return !evSessions.some(s => results.some(r => r.session_id === s.id));
  });

  // Season events only for championship
  const seasonEvents = activeSeason
    ? events.filter(e => e.season_id === activeSeason.id && !e.is_one_off)
    : [];
  const completedSeasonEvents = seasonEvents.filter(ev => {
    const evSessions = sessions.filter(s => s.event_id === ev.id);
    return evSessions.some(s => results.some(r => r.session_id === s.id));
  });

  // ── SEASON HEADER ──
  const classBreakdown = {};
  if(activeSeason) {
    const sc = scoringConfigMap[activeSeason.id] || [];
    const cc = classConfig.find(c => c.season_id === activeSeason.id) || null;
    const standings = calcStandings(activeSeason.id, results, sessions, events, sc, cc, careerMap);
    standings.forEach(d => { classBreakdown[d.cls] = (classBreakdown[d.cls]||0)+1; });

    // Just set the season name label for the championship section
    const seasonNameEl = document.getElementById('dash-season-name');
    if(seasonNameEl) seasonNameEl.textContent = activeSeason.name;
  } else {
    const seasonNameEl = document.getElementById('dash-season-name');
    if(seasonNameEl) seasonNameEl.textContent = 'No active season';
  }

  // ── LAST EVENT ──
  if(lastEvent) {
    const isSpecial = lastEvent.is_one_off;
    const evSessions = sessions.filter(s => s.event_id === lastEvent.id);
    const raceSessions = evSessions.filter(s => s.session_type === 'race').sort((a,b)=>a.race_number-b.race_number);
    const dateStr = lastEvent.event_date ? new Date(lastEvent.event_date+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) : '';

    const raceWinners = raceSessions.map(sess => {
      const winner = results.filter(r=>r.session_id===sess.id&&!r.dnf).sort((a,b)=>a.position-b.position)[0];
      const winnerDrv = winner ? drivers.find(d=>d.id===winner.driver_id) : null;
      const tagCls = sess.race_number===1?'tr1':sess.race_number===2?'tr2':'tr3';
      return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--simr-border)">
        <span class="tag ${tagCls}" style="flex-shrink:0">R${sess.race_number}</span>
        <span style="font-weight:600;font-size:13px">${winnerDrv?driverLabel(winnerDrv):'—'}</span>
        <span style="color:var(--simr-amber);font-size:11px;margin-left:auto">P1</span>
      </div>`;
    }).join('');

    // Build top 3 for last event
    const lastEvRaceSessions = sessions.filter(s=>s.event_id===lastEvent.id&&s.session_type==='race');
    const lastEvResults = results.filter(r=>lastEvRaceSessions.map(s=>s.id).includes(r.session_id));
    const lastEvTotals = {};
    lastEvRaceSessions.forEach(sess => {
      const evSc = scoringConfigMap[lastEvent.season_id]||Object.values(scoringConfigMap)[0]||[];
      const baseP1Dash = evSc.length ? evSc[0].points : 20;
      const sessResultsAllDash = lastEvResults.filter(r=>r.session_id===sess.id);
      const sessMapDash = calcSessionPointsMap(sess, sessResultsAllDash, evSc, baseP1Dash);
      Object.entries(sessMapDash).forEach(([dId,pt])=>{ lastEvTotals[dId] = (lastEvTotals[dId]||0) + pt; });
    });
    const lastEvTop3 = Object.entries(lastEvTotals).sort((a,b)=>b[1]-a[1]).slice(0,3);
    const podiumColors = ['color:#d4a820','color:#8a9aaa','color:#c07030'];
    const top3Html = lastEvTop3.map(([dId,pts],i) => {
      const drv = drivers.find(d=>d.id===dId);
      return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--simr-border)">
        <span style="${podiumColors[i]};font-weight:700;font-size:13px;width:20px">P${i+1}</span>
        <span style="font-weight:600;font-size:13px">${driverLabel(drv)}</span>
        <span style="color:var(--simr-muted);font-size:11px;margin-left:auto">${pts} pts</span>
      </div>`;
    }).join('');

    // Season/round/circuit context
    const lastEvSeason = seasons.find(s=>s.id===lastEvent.season_id);
    const lastEvSeasonLine = lastEvSeason ? `<div style="font-size:11px;color:var(--simr-muted)">${lastEvSeason.name}</div>` : '';
    const lastEvTypeBadge = lastEvent.is_one_off?(lastEvent.event_type==='exhibition'?'<span class="tag tgrid" style="font-size:10px">🎪</span>':'<span class="tag tspecial" style="font-size:10px">⭐</span>'):'';
    const lastEvTrack = lastEvent.track && lastEvent.name && lastEvent.track!==lastEvent.name ? lastEvent.track.replace(/ —.*$/,'') : '';
    const lastEvCar = lastEvSeason?.car_class || '';

    document.getElementById('dash-last-event').innerHTML = `
      ${lastEvSeasonLine}
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
        ${lastEvTypeBadge}
        <span style="font-weight:600;font-size:14px">${lastEvent.name||lastEvent.track}</span>
      </div>
      ${lastEvTrack ? `<div style="font-size:12px;color:var(--simr-muted);margin-bottom:2px">${lastEvTrack}${lastEvCar?' · '+lastEvCar:''}</div>` : (lastEvCar?`<div style="font-size:12px;color:var(--simr-muted);margin-bottom:2px">${lastEvCar}</div>`:'')}
      <div style="font-size:11px;color:var(--simr-hint);margin-bottom:10px">${dateStr}</div>
      ${top3Html||'<div style="color:var(--simr-muted);font-size:13px">No race results</div>'}`;
  } else {
    document.getElementById('dash-last-event').innerHTML = '<div style="color:var(--simr-muted);font-size:13px">No events completed yet</div>';
  }

  // ── NEXT EVENT ──
  if(nextEvent) {
    const evSessions = sessions.filter(s => s.event_id === nextEvent.id);
    const dateStr = nextEvent.event_date ? new Date(nextEvent.event_date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}) : 'Date TBD';
    const sessionTags = evSessions.map(sess => {
      const isGrid = sess.session_type==='grid';
      const tagCls = isGrid?(sess.is_qualifying?'tquali':'tgrid'):'tr1';
      const label = isGrid?(sess.is_qualifying?'Q':'G'):'R'+(sess.race_number||'');
      return `<span class="tag ${tagCls}">${label}</span>`;
    }).join('');

    const nextEvSeason = seasons.find(s=>s.id===nextEvent.season_id);
    const nextEvSeasonLine = nextEvSeason ? `<div style="font-size:11px;color:var(--simr-muted)">${nextEvSeason.name}</div>` : '';
    const nextEvTypeBadge = nextEvent.is_one_off?(nextEvent.event_type==='exhibition'?'<span class="tag tgrid" style="font-size:10px">🎪</span>':'<span class="tag tspecial" style="font-size:10px">⭐</span>'):'';
    const nextEvTrack = nextEvent.track && nextEvent.name && nextEvent.track!==nextEvent.name ? nextEvent.track.replace(/ —.*$/,'') : '';
    const nextEvCar = nextEvSeason?.car_class || '';

    document.getElementById('dash-next-event').innerHTML = `
      ${nextEvSeasonLine}
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
        ${nextEvTypeBadge}
        <span style="font-weight:600;font-size:14px">${nextEvent.name||nextEvent.track}</span>
      </div>
      ${nextEvTrack ? `<div style="font-size:12px;color:var(--simr-muted);margin-bottom:2px">${nextEvTrack}${nextEvCar?' · '+nextEvCar:''}</div>` : (nextEvCar?`<div style="font-size:12px;color:var(--simr-muted);margin-bottom:2px">${nextEvCar}</div>`:'')}
      <div style="font-size:11px;color:var(--simr-hint);margin-bottom:10px">${dateStr}</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap">${sessionTags||'<span style="color:var(--simr-hint);font-size:12px">No sessions built yet</span>'}</div>`;
  } else {
    document.getElementById('dash-next-event').innerHTML = '<div style="color:var(--simr-muted);font-size:13px">No upcoming events scheduled</div>';
  }

  // ── RECENT EVENT FULL RESULTS ──
  if(lastEvent) {
    const evSessions = sessions.filter(s => s.event_id === lastEvent.id);
    const raceSessions = evSessions.filter(s => s.session_type==='race').sort((a,b)=>a.race_number-b.race_number);
    const qualiSessions = evSessions.filter(s => s.session_type==='grid');
    // For special events use active season scoring; for season events use their season
    let seasonScoring = [];
    if(lastEvent.season_id && scoringConfigMap[lastEvent.season_id]) {
      seasonScoring = scoringConfigMap[lastEvent.season_id];
    } else if(activeSeason) {
      seasonScoring = scoringConfigMap[activeSeason.id] || [];
    }

    // Get all drivers in this event
    const evResults = results.filter(r => evSessions.map(s=>s.id).includes(r.session_id));
    const driverIds = [...new Set(evResults.map(r=>r.driver_id))];

    // Car assignments for multi-car events
    const dashCarMap = {};
    if(lastEvent.is_multi_car) {
      const sdDashArr = await dbGet('season_drivers', `event_id=eq.${lastEvent.id}`);
      sdDashArr.forEach(sd => { dashCarMap[sd.driver_id] = sd.car_model; });
      if(lastEvent.season_id) {
        const sdSeasonArr = await dbGet('season_drivers', `season_id=eq.${lastEvent.season_id}`);
        sdSeasonArr.forEach(sd => { if(!dashCarMap[sd.driver_id]) dashCarMap[sd.driver_id] = sd.car_model; });
      }
    }

    // Build per-driver event totals
    const driverRows = driverIds.map(dId => {
      const drv = drivers.find(d=>d.id===dId);
      let total = 0;
      const gridPos = qualiSessions.length > 0
        ? evResults.find(r=>r.session_id===qualiSessions[0].id&&r.driver_id===dId)?.position
        : null;
      const raceCells = raceSessions.map(sess => {
        const r = evResults.find(res=>res.session_id===sess.id&&res.driver_id===dId);
        if(!r) return {pos:null, pts:0, fl:false, dnf:false};
        const baseP1Dash2 = seasonScoring.length ? seasonScoring[0].points : 20;
        const sessResultsDash = evResults.filter(res=>res.session_id===sess.id);
        const sessPtsMapDash = calcSessionPointsMap(sess, sessResultsDash, seasonScoring, baseP1Dash2);
        const pts = sessPtsMapDash[dId] || 0;
        total += pts;
        return {pos:r.dnf?'DNF':r.position, pts, fl:r.fastest_lap, dnf:r.dnf};
      });
      const car = dashCarMap[dId] || null;
      return {dId, drv, gridPos, raceCells, total, car};
    }).sort((a,b)=>b.total-a.total);

    const headers = raceSessions.map(s=>`<th style="width:70px;border-left:2px solid var(--simr-border2);padding:8px 10px">R${s.race_number}</th><th style="width:55px;padding:8px 10px">Pts</th>`).join('');
    const rows = driverRows.map((d,i) => {
      const posCls = i===0?'pg':i===1?'ps':i===2?'pb':'';
      const raceCols = d.raceCells.map(rc => `
        <td style="border-left:2px solid var(--simr-border2);padding:10px 10px;${rc.pos===1?'color:#d4a820;font-weight:600':rc.dnf?'color:var(--simr-red)':''}">${rc.pos!==null?'P'+rc.pos:'—'}</td>
        <td style="font-weight:600;padding:10px 10px">${rc.pts||'—'}</td>
      `).join('');
      return `<tr>
        <td class="${posCls}" style="padding:10px 10px">${i+1}</td>
        <td style="font-weight:600;padding:10px 10px">${driverLabel(d.drv)}${lastEvent.is_multi_car&&d.car?'<span style="font-size:11px;color:var(--simr-muted);font-weight:400"> — '+d.car+'</span>':''}${d.raceCells.some(r=>r.fl)?'<span class="fl-badge" style="margin-left:4px">FL</span>':''}</td>
        <td style="color:var(--simr-muted);padding:10px 10px">${d.gridPos?'P'+d.gridPos:'—'}</td>
        ${raceCols}
        <td style="font-weight:700;color:var(--simr-amber);padding:10px 10px;border-left:2px solid var(--simr-border2)">${d.total}</td>
      </tr>`;
    }).join('');

    const evDateStr = lastEvent.event_date
      ? new Date(lastEvent.event_date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})
      : '';
    const evTrack = lastEvent.track && lastEvent.name && lastEvent.track !== lastEvent.name
      ? lastEvent.track.replace(/ —.*$/,'') : '';
    // Build fastest lap notes for dashboard
    const dashFlNotes = raceSessions.map(sess => {
      const flRes = evResults.find(r=>r.session_id===sess.id&&r.fastest_lap);
      if(!flRes) return '';
      const flDrv = drivers.find(d=>d.id===flRes.driver_id);
      const lapTime = flRes.lap_time ? ` — ${flRes.lap_time}` : '';
      return `<span style="margin-right:16px"><span style="color:var(--simr-text);font-weight:600">R${sess.race_number} FL:</span> <span style="font-weight:600;color:var(--simr-purple)">${driverLabel(flDrv)}${lapTime}</span></span>`;
    }).filter(Boolean);
    const dashFlHtml = dashFlNotes.length ? `<div style="margin-top:10px;padding:8px 12px;background:var(--simr-surface2);border-radius:6px;font-size:13px"><span style="color:var(--simr-amber);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:4px">⚡ Fastest laps</span>${dashFlNotes.join('')}</div>` : '';

    document.getElementById('dash-recent-results').innerHTML = `
      <div style="border-bottom:1px solid var(--simr-border);padding-bottom:14px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-size:11px;color:var(--simr-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">
              ${lastEvent.is_one_off ? (lastEvent.event_type==='exhibition' ? '🎪 Exhibition' : '⭐ Special event') : 'Most recent round'}
            </div>
            <div style="font-size:22px;font-weight:700;margin-bottom:4px">${lastEvent.name||lastEvent.track}</div>
            ${evTrack ? `<div style="font-size:13px;color:var(--simr-muted);margin-bottom:4px">${evTrack}</div>` : ''}
            <div style="font-size:12px;color:var(--simr-muted)">${evDateStr}</div>
          </div>
          <button class="btn btn-sm" onclick="navTo(document.querySelectorAll('.nvb')[2],'events');setTimeout(()=>selectResultEvent('${lastEvent.id}'),800)" style="font-size:11px;padding:5px 12px">View full results →</button>
        </div>
      </div>
      <div style="overflow-x:auto"><table style="table-layout:auto;min-width:500px">
        <thead><tr>
          <th style="width:32px">Pos</th>
          <th style="min-width:120px">Driver</th>
          <th style="width:50px">Grid</th>
          ${headers}
          <th style="width:60px">Total</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${dashFlHtml}
    `;
  } else {
    document.getElementById('dash-recent-results').innerHTML = '<div class="card-title">Recent event</div><div style="color:var(--simr-muted);font-size:13px;padding:8px 0">No results yet</div>';
  }

  // ── CHAMPIONSHIP TOP 5 ──
  if(activeSeason) {
    const sc = scoringConfigMap[activeSeason.id] || [];
    const cc = classConfig.find(c => c.season_id === activeSeason.id) || null;
    const standings = calcStandings(activeSeason.id, results, sessions, events, sc, cc, careerMap);
    const top5 = standings.slice(0, 5);
    const leaderPts = top5[0]?.adjustedPts || 0;

    document.getElementById('dash-standings').innerHTML = top5.length ? `
      <table style="table-layout:fixed;min-width:500px">
        <thead><tr>
          <th style="width:32px">Pos</th>
          <th style="min-width:120px">Driver</th>
          <th style="width:65px">Class</th>
          <th style="width:60px">Pts</th>
          <th style="width:70px">Gap</th>
          <th style="width:35px">W</th>
          <th style="width:38px">Pod</th>
          <th style="width:75px">Season Eff%</th>
        </tr></thead>
        <tbody>${top5.map((d,i) => {
          const drv = drivers.find(dr=>dr.id===d.driver_id);
          const posCls = i===0?'pg':i===1?'ps':i===2?'pb':'';
          const gap = i===0 ? '—' : '-'+(leaderPts-d.adjustedPts);
          const eff = d.eff !== null ? d.eff.toFixed(1)+'%' : '—';
          return `<tr>
            <td class="${posCls}">${i+1}</td>
            <td style="font-weight:600">${driverLabel(drv)}</td>
            <td>${badgeHTML(d.cls)}</td>
            <td class="pts-cell">${d.adjustedPts}</td>
            <td style="font-family:monospace;font-size:12px;color:${i===0?'var(--simr-hint)':'var(--simr-red)'}">${gap}</td>
            <td>${d.wins}</td>
            <td>${d.podiums}</td>
            <td class="eff-cell" style="color:var(--simr-muted)">${eff}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : '<div style="color:var(--simr-muted);font-size:13px;padding:8px 0">No results yet</div>';
  } else {
    document.getElementById('dash-standings').innerHTML = '<div style="color:var(--simr-muted);font-size:13px;padding:8px 0">No active season</div>';
  }
}


// ============================================================
// DRIVERS
// ============================================================
async function loadDrivers() {
  document.getElementById('drivers-title').textContent = `${state.currentSeriesName} — Drivers`;
  const [drivers, careerStats, seasons, results, sessions, events, allScoringConfigs] = await Promise.all([
    dbGet('drivers', 'order=name'),
    dbGet('career_stats', `series_id=eq.${state.currentSeriesId}`),
    dbGet('seasons', `series_id=eq.${state.currentSeriesId}&order=season_number.asc`),
    dbGet('results'),
    dbGet('sessions'),
    dbGet('events', `series_id=eq.${state.currentSeriesId}`),
    dbGet('scoring_config')
  ]);
  state.currentDrivers = drivers;

  const careerMap = {};
  careerStats.forEach(cs => { careerMap[cs.driver_id] = cs; });

  const scoringConfigMap = {};
  allScoringConfigs.forEach(sc => {
    if(!scoringConfigMap[sc.season_id]) scoringConfigMap[sc.season_id] = [];
    scoringConfigMap[sc.season_id].push(sc);
  });

  if(!drivers.length) {
    document.getElementById('driver-cards').innerHTML = '<div class="loading">No drivers yet.</div>';
    return;
  }

  // pre-calc live stats for all drivers
  // Filter to series only
  const drvEventIds = new Set(events.map(e=>e.id));
  const drvSessions = sessions.filter(s=>drvEventIds.has(s.event_id));
  const drvSessionIds = new Set(drvSessions.map(s=>s.id));
  const drvResults = results.filter(r=>drvSessionIds.has(r.session_id));

  state._liveEffMap = {};
  drivers.forEach(drv => {
    state._liveEffMap[drv.id] = calcLiveCareerStats(drv.id, drvResults, drvSessions, events, seasons, scoringConfigMap, careerMap);
  });
  state._scoringConfigMap = scoringConfigMap;
  state._allResults = results;
  state._allSessions = sessions;
  state._allEvents = events;
  state._allSeasons = seasons;

  document.getElementById('driver-cards').innerHTML = drivers.map((drv,i) => {
    const live = state._liveEffMap[drv.id];
    const careerEff = live.eff;
    const cls = classifyDriver(careerEff, live.starts);
    const champs = drv.championships || 0;

    return `<div class="driver-card" onclick="selectDriver(this,'${drv.id}')">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-size:17px;font-weight:700;line-height:1.2">${driverLabel(drv)}</div>
        ${badgeFull(cls)}
      </div>
      <div style="display:flex;justify-content:space-between;padding-top:10px;border-top:1px solid var(--simr-border)">
        <div style="text-align:center"><div style="font-size:16px;font-weight:600">${live.wins}</div><div style="font-size:10px;color:var(--simr-muted)">Wins</div></div>
        <div style="text-align:center"><div style="font-size:16px;font-weight:600">${live.podiums}</div><div style="font-size:10px;color:var(--simr-muted)">Podiums</div></div>
        <div style="text-align:center"><div style="font-size:16px;font-weight:600">${live.starts}</div><div style="font-size:10px;color:var(--simr-muted)">Starts</div></div>
        <div style="text-align:center"><div style="font-size:16px;font-weight:600">${champs}</div><div style="font-size:10px;color:var(--simr-muted)">Champs</div></div>
      </div>
    </div>`;
  }).join('');

  // No auto-load — detail appears only when a driver card is clicked
  document.getElementById('driver-detail').style.display = 'none';
}

async function selectDriver(el, driverId) {
  document.querySelectorAll('.driver-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  const [careerStats, seasons] = await Promise.all([
    dbGet('career_stats', `series_id=eq.${state.currentSeriesId}`),
    dbGet('seasons', `series_id=eq.${state.currentSeriesId}&order=season_number.asc`)
  ]);
  const careerMap = {};
  careerStats.forEach(cs=>{ careerMap[cs.driver_id]=cs; });
  const dd = document.getElementById('driver-detail');
  dd.style.display = 'block';
  dd.style.opacity = '0.5';
  await showDriverDetail(driverId, state.currentDrivers, careerMap, seasons);
  dd.style.opacity = '1';
}

async function showDriverDetail(driverId, drivers, careerMap, seasons) {
  const drv = drivers.find(d=>d.id===driverId);
  if(!drv) return;
  const cs = careerMap[driverId];
  const liveStats = state._liveEffMap?.[driverId] || null;
  const careerEff = liveStats?.eff ?? null;
  const cls = classifyDriver(careerEff, liveStats?.starts);
  const champs = drv.championships || 0;

  // Load season history data — fetch directly to ensure it's always available
  const allSeasons = await dbGet('seasons', `series_id=eq.${state.currentSeriesId}&order=season_number.desc`);
  const { events: allEvents, sessions: allSessions, results: allResults } = await getSeriesData();
  const scoringConfigs = await dbGet('scoring_config');
  const seasonDriversArr = await dbGet('season_drivers', `driver_id=eq.${driverId}`);
  const sdBySeason = {};
  seasonDriversArr.forEach(sd => sdBySeason[sd.season_id] = sd);

  const seasonHistory = allSeasons.map(s => {
    const sEvents = allEvents.filter(e=>e.season_id===s.id&&!e.is_one_off);
    const sSessions = allSessions.filter(sess=>sEvents.map(e=>e.id).includes(sess.event_id)&&sess.session_type==='race');
    const sResults = allResults.filter(r=>sSessions.map(sess=>sess.id).includes(r.session_id)&&r.driver_id===driverId);
    if(!sResults.length) return null;
    const sc = scoringConfigs.filter(c=>c.season_id===s.id);
    let pts = 0;
    sResults.forEach(r => {
      if(!r.dnf) { const p = sc.find(c=>c.position===r.position); pts += p?.points||0; }
    });
    const wins = sResults.filter(r=>r.position===1&&!r.dnf).length;
    const pods = sResults.filter(r=>r.position<=3&&!r.dnf).length;
    const starts = sResults.length;
    const sd = sdBySeason[s.id];
    return { s, pts, wins, pods, starts, car: sd?.car_model||'', carClass: sd?.car_class||'' };
  }).filter(Boolean);

  const seasonHistoryHtml = ''; // replaced by participationHtml below

  // Load lap records and special event wins
  const trackRecords = await getLapRecords(state.currentSeriesId);
  const driverRecords = getDriverLapRecords(driverId, trackRecords);

  // Special event wins (only 'special' type, not exhibition)
  const specialEventWins = allEvents.filter(e=>e.is_one_off&&(e.event_type==='special'||!e.event_type)&&e.round_winner_id===driverId);
  // Event group wins
  const eventGroupWins = await dbGet('event_groups', `series_id=eq.${state.currentSeriesId}&round_winner_id=eq.${driverId}`);

  // Championships pill + special event wins
  const champPills = champs > 0
    ? Array(champs).fill(0).map(()=>`<span class="champ-pill">🏆 Champion</span>`).join('')
    : '';
  const specialWinPills = specialEventWins.map(e=>`<span class="champ-pill" style="background:rgba(100,60,180,0.12);border-color:rgba(100,60,180,0.35);color:var(--simr-purple)">⭐ ${e.name||e.track}</span>`).join('');
  const groupWinPills = eventGroupWins.map(g=>`<span class="champ-pill" style="background:rgba(212,168,32,0.15);border-color:rgba(212,168,32,0.5);color:var(--simr-amber)">🏅 ${g.name}</span>`).join('');
  const grandSlamEvents = state._grandSlamMap?.[driverId] || [];
  const grandSlamPills = grandSlamEvents.map(evName=>`<span class="champ-pill" style="background:rgba(191,10,48,0.1);border-color:rgba(191,10,48,0.35);color:var(--simr-red)">⭐ Grand Slam — ${evName}</span>`).join('');
  const allPills = champPills + grandSlamPills + specialWinPills + groupWinPills || '<span style="font-size:12px;color:var(--simr-hint)">No championships yet</span>';

  // Build full participation history
  const seasonParticipation = allSeasons.map(s => {
    const sEvents = allEvents.filter(e=>e.season_id===s.id&&!e.is_one_off);
    const sSessions = allSessions.filter(sess=>sEvents.map(e=>e.id).includes(sess.event_id)&&sess.session_type==='race');
    const sResults = allResults.filter(r=>sSessions.map(sess=>sess.id).includes(r.session_id)&&r.driver_id===driverId);
    if(!sResults.length) return null;
    const sc = scoringConfigs.filter(c=>c.season_id===s.id);
    const baseMaxS = sc.length ? sc[0].points : 20;
    // Points — DNF-aware, per session via shared helper
    let pts = 0;
    sSessions.forEach(sess => {
      const sessResultsAll = allResults.filter(r=>r.session_id===sess.id);
      const sessMap = calcSessionPointsMap(sess, sessResultsAll, sc, baseMaxS);
      if(sessMap[driverId]!=null) pts += sessMap[driverId];
    });
    const sd = sdBySeason[s.id];
    // Calculate final standing position in this season
    const allDriversInSeason = [...new Set(allResults.filter(r=>sSessions.map(sess=>sess.id).includes(r.session_id)).map(r=>r.driver_id))];
    const ptsByDriver = {};
    allDriversInSeason.forEach(dId => { ptsByDriver[dId] = 0; });
    sSessions.forEach(sess => {
      const sessResultsAll = allResults.filter(r=>r.session_id===sess.id);
      const sessMap = calcSessionPointsMap(sess, sessResultsAll, sc, baseMaxS);
      Object.entries(sessMap).forEach(([dId,pt])=>{ ptsByDriver[dId] = (ptsByDriver[dId]||0) + pt; });
    });
    const sortedDrivers = Object.entries(ptsByDriver).sort((a,b)=>b[1]-a[1]);
    const finalPos = sortedDrivers.findIndex(([dId])=>dId===driverId) + 1;
    // Latest event date in this season, for chronological sorting of event history
    const latestDate = sEvents.reduce((max,ev)=>(ev.event_date&&ev.event_date>max)?ev.event_date:max, '');
    return { type:'season', name: s.name, car: sd?.car_model||'', pts, starts: sResults.length, wins: sResults.filter(r=>r.position===1&&!r.dnf).length, finalPos, date: latestDate };
  }).filter(Boolean);

  const oneOffParticipation = allEvents.filter(e=>e.is_one_off).map(e => {
    const eSessions = allSessions.filter(s=>s.event_id===e.id&&s.session_type==='race');
    const eResults = allResults.filter(r=>eSessions.map(s=>s.id).includes(r.session_id)&&r.driver_id===driverId);
    if(!eResults.length) return null;
    // Use event-level scoring config if available, else fall back to most recent season
    const evSc = scoringConfigs.filter(c=>c.event_id===e.id);
    const sc = evSc.length ? evSc : scoringConfigs.filter(c=>c.season_id===allSeasons[0]?.id);
    const baseMax = sc.length ? sc[0].points : 20;
    const isSpecial = e.event_type==='special' || !e.event_type;
    // Final position — DNF-aware, apply session multipliers via shared helper
    const evAllDriverIds = [...new Set(allResults.filter(r=>eSessions.map(s=>s.id).includes(r.session_id)).map(r=>r.driver_id))];
    const evPts = {};
    evAllDriverIds.forEach(dId => { evPts[dId] = 0; });
    eSessions.forEach(sess => {
      const sessResultsAll = allResults.filter(r=>r.session_id===sess.id);
      const sessMap = calcSessionPointsMap(sess, sessResultsAll, sc, baseMax);
      Object.entries(sessMap).forEach(([dId,pt])=>{ evPts[dId] = (evPts[dId]||0) + pt; });
    });
    const evSorted = Object.entries(evPts).sort((a,b)=>b[1]-a[1]);
    const evFinalPos = evSorted.findIndex(([dId])=>dId===driverId) + 1;
    const myPts = evPts[driverId] || 0;
    return { type: isSpecial?'special':'exhibition', name: e.name||e.track, pts: myPts, starts: eResults.length, wins: eResults.filter(r=>r.position===1&&!r.dnf).length, isWinner: e.round_winner_id===driverId, finalPos: evFinalPos, date: e.event_date||'' };
  }).filter(Boolean);

  const allParticipation = [...seasonParticipation, ...oneOffParticipation]
    .sort((a,b)=>(b.date||'').localeCompare(a.date||''));

  // Cumulative career efficiency over time — aggregated by ROUND (event), not individual session/race
  const eventAgg = {};
  (liveStats?.eventBreakdown || []).forEach(e => {
    if(!eventAgg[e.eventId]) eventAgg[e.eventId] = {earned:0, possible:0, date: e.date, eventName: e.eventName};
    eventAgg[e.eventId].earned += e.earned||0;
    eventAgg[e.eventId].possible += e.possible||0;
  });
  const effChronological = Object.values(eventAgg).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  let runEarned = 0, runPossible = 0;
  const effTrend = effChronological.map(e => {
    runEarned += e.earned||0;
    runPossible += e.possible||0;
    return runPossible > 0 ? (runEarned/runPossible*100) : null;
  }).filter(v=>v!==null);
  const effTrendLabels = effChronological.map(e => (e.eventName||'').slice(0,10));

  const participationHtml = allParticipation.length ? `
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--simr-border)">
      <div style="display:grid;grid-template-columns:7fr 3fr;gap:12px;align-items:start">
        <div>
          <div style="font-size:11px;color:var(--simr-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Career efficiency by round</div>
          <div style="background:var(--simr-surface2);border-radius:8px;padding:12px">
            ${effTrend.length>=2 ? `<div style="position:relative;width:100%;height:180px">
              <canvas id="driver-eff-chart-${driverId}" role="img" aria-label="Line chart of cumulative career efficiency by round for ${driverLabel(drv)}"></canvas>
            </div>` : '<div style="font-size:12px;color:var(--simr-hint);padding:20px 0;text-align:center">Not enough round history for a trend yet</div>'}
          </div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--simr-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Event history</div>
          <div style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;padding-right:4px">
            ${allParticipation.map(p=>`
              <div style="display:flex;align-items:center;gap:6px;font-size:11px">
                <span style="font-size:10px;color:var(--simr-hint);flex-shrink:0">${p.type==='season'?'🏆':p.type==='special'?'⭐':'🎪'}</span>
                <span style="font-weight:600;color:var(--simr-amber);flex-shrink:0">${p.finalPos?'P'+p.finalPos:'—'}</span>
                <span style="color:var(--simr-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.name}</span>
                ${p.isWinner?'<span style="color:#a07ff0;font-size:9px;flex-shrink:0">★</span>':''}
              </div>`).join('')}
          </div>
        </div>
      </div>
    </div>` : '';

  // Lap records section
  const lapRecordsHtml = driverRecords.length ? `
    <div class="card" style="margin-top:12px;margin-bottom:0">
      <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleSection('driver-lap-records')">
        <div class="card-title" style="margin-bottom:0">🏁 Lap records held (${driverRecords.length})</div>
        <span id="driver-lap-records-arrow" style="color:var(--simr-muted)">▶</span>
      </div>
      <div id="driver-lap-records" style="display:none;margin-top:12px">
        <table style="table-layout:auto">
          <thead><tr><th>Track</th><th>Time</th><th>Car</th><th>Event</th></tr></thead>
          <tbody>${driverRecords.map(r=>`<tr>
            <td style="font-weight:600;font-size:12px">${r.track.replace(/\s*\([^)]+\)/g,'').trim()}</td>
            <td style="font-family:monospace;font-size:12px;color:var(--simr-purple)">${r.lap_time}</td>
            <td style="font-size:11px;color:var(--simr-muted)">${r.car||'—'}</td>
            <td style="font-size:11px;color:var(--simr-muted)">${r.event_name}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>` : '';

  document.getElementById('driver-detail').innerHTML = `
    <div class="card" style="margin-bottom:0">
      <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:16px">
        <div class="avatar" style="width:52px;height:52px;font-size:20px;flex-shrink:0">${initials(driverLabel(drv))}</div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px">
            <div style="font-size:20px;font-weight:700">${driverLabel(drv)}</div>
            ${badgeFull(cls)}
          </div>
          <div style="font-size:12px;color:var(--simr-muted)">${drv.car_number?'Car #'+drv.car_number+' · ':''}${drv.name!==driverLabel(drv)?'Gamertag: '+drv.name:''}</div>
          <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">${allPills}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:28px;font-weight:700;color:${effColor(cls)}">${careerEff!==null?careerEff.toFixed(1)+'%':'—'}</div>
          <div style="font-size:11px;color:var(--simr-muted)">Career efficiency</div>
        </div>
      </div>
      <div class="stat-grid" style="grid-template-columns:repeat(5,1fr)">
        <div class="stat-box"><div class="stat-val">${liveStats?.starts||0}</div><div class="stat-lbl">Starts</div></div>
        <div class="stat-box"><div class="stat-val">${liveStats?.wins||0}</div><div class="stat-lbl">Wins</div></div>
        <div class="stat-box"><div class="stat-val">${liveStats?.podiums||0}</div><div class="stat-lbl">Podiums</div></div>
        <div class="stat-box"><div class="stat-val">${liveStats?.top5s||0}</div><div class="stat-lbl">Top 5s</div></div>
        <div class="stat-box"><div class="stat-val">${liveStats?.top10s||0}</div><div class="stat-lbl">Top 10s</div></div>
        <div class="stat-box"><div class="stat-val">${liveStats?.poles||cs?.poles||0}</div><div class="stat-lbl">Poles</div></div>
        <div class="stat-box"><div class="stat-val">${liveStats?.fastestLaps||0}</div><div class="stat-lbl">Fastest laps</div></div>
        <div class="stat-box"><div class="stat-val">${cs?.round_wins||0}</div><div class="stat-lbl">Round Wins</div></div>
        <div class="stat-box"><div class="stat-val">${drv.championships||0}</div><div class="stat-lbl">Championships</div></div>
        <div class="stat-box"><div class="stat-val" style="color:${effColor(cls)}">${careerEff!==null?careerEff.toFixed(1)+'%':'—'}</div><div class="stat-lbl">Career Efficiency</div></div>
        <div class="stat-box"><div class="stat-val">${liveStats?.avg?'P'+liveStats.avg.toFixed(1):'—'}</div><div class="stat-lbl">Avg Finish</div></div>
        <div class="stat-box"><div class="stat-val" style="color:${liveStats?.avgPosGained>0?'var(--simr-green)':liveStats?.avgPosGained<0?'var(--simr-red)':'var(--simr-muted)'}">${liveStats?.avgPosGained!=null?(liveStats.avgPosGained>0?'+':'')+liveStats.avgPosGained.toFixed(1):'—'}</div><div class="stat-lbl">Avg +/-</div></div>
        ${(()=>{
          const s = liveStats?.starts||0;
          const winPct = s&&liveStats?.wins ? (liveStats.wins/s*100).toFixed(1)+'%' : '—';
          const podPct = s&&liveStats?.podiums ? (liveStats.podiums/s*100).toFixed(1)+'%' : '—';
          const avgStart = liveStats?.avgStartPos ? 'P'+liveStats.avgStartPos.toFixed(1) : '—';
          const posGained = liveStats?.careerPosGained > 0 ? '+'+liveStats.careerPosGained : liveStats?.careerPosGained||'—';
          return `<div class="stat-box"><div class="stat-val">${winPct}</div><div class="stat-lbl">Win %</div></div>
        <div class="stat-box"><div class="stat-val">${podPct}</div><div class="stat-lbl">Podium %</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--simr-amber)">${liveStats?.totalEarned||0}</div><div class="stat-lbl">Pts Earned</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--simr-muted)">${liveStats?.totalPossible||0}</div><div class="stat-lbl">Pts Available</div></div>
        <div class="stat-box"><div class="stat-val">${avgStart}</div><div class="stat-lbl">Avg Start</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--simr-green)">${posGained}</div><div class="stat-lbl">Pos. Gained</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--simr-amber)">${state._personalBestStreakMap?.[driverId]||0}</div><div class="stat-lbl">Best Streak</div></div>`;
        })()}
      </div>
      ${liveStats?.eventBreakdown?.length ? `
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--simr-border)">
        <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleSection('driver-pts-breakdown')">
          <div style="font-size:11px;color:var(--simr-muted);text-transform:uppercase;letter-spacing:.08em">Points Breakdown</div>
          <span id="driver-pts-breakdown-arrow" style="color:var(--simr-muted);font-size:11px">▶</span>
        </div>
        <div id="driver-pts-breakdown" style="display:none;margin-top:10px;overflow-x:auto">
          <table style="table-layout:auto;font-size:12px">
            <thead><tr>
              <th style="text-align:left">Event</th>
              <th style="text-align:center">Race</th>
              <th style="text-align:center">Pos</th>
              <th style="text-align:center">Earned</th>
              <th style="text-align:center">Available</th>
              <th style="text-align:center">Eff</th>
            </tr></thead>
            <tbody>${liveStats.eventBreakdown.slice().sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0).map(e=>{
              const posColor = e.position===1?'#d4a820':e.position===2?'#8a9aaa':e.position===3?'#c07030':'var(--simr-text)';
              const posLabel = typeof e.position==='number'?'P'+e.position:e.position;
              const effVal = e.earned!==null&&e.possible ? Math.round(e.earned/e.possible*100) : null;
              const effColor2 = effVal!==null ? (effVal>=80?'var(--simr-green)':effVal>=50?'var(--simr-amber)':'var(--simr-red)') : 'var(--simr-hint)';
              return `<tr>
                <td style="font-weight:500">${e.eventName}${e.seasonName?'<span style="font-size:10px;color:var(--simr-muted)"> · '+e.seasonName+'</span>':''}${e.isOneOff?'<span style="font-size:10px;color:var(--simr-amber);margin-left:4px">'+(e.eventType==='exhibition'?'🎪':'⭐')+'</span>':''}</td>
                <td style="text-align:center;color:var(--simr-muted)">R${e.raceNum}</td>
                <td style="text-align:center;font-weight:600;color:${posColor}">${posLabel}</td>
                <td style="text-align:center;font-weight:600">${e.earned!==null?e.earned:'<span style="color:var(--simr-hint)">—</span>'}</td>
                <td style="text-align:center;color:var(--simr-muted)">${e.possible!==null?e.possible:'<span style="color:var(--simr-hint)">—</span>'}</td>
                <td style="text-align:center;font-weight:600;color:${effColor2}">${effVal!==null?effVal+'%':'—'}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>
      </div>` : ''}
      ${participationHtml}
    </div>
    ${lapRecordsHtml}`;

  // Render cumulative efficiency chart if data available
  if(effTrend.length >= 2 && window.Chart) {
    const canvasEl = document.getElementById(`driver-eff-chart-${driverId}`);
    if(canvasEl) {
      new Chart(canvasEl, {
        type: 'line',
        data: {
          labels: effTrendLabels.slice(-effTrend.length),
          datasets: [{
            data: effTrend,
            borderColor: '#9060d0',
            backgroundColor: 'rgba(144,96,208,0.1)',
            fill: true,
            tension: 0.3,
            borderWidth: 2,
            pointRadius: 2,
            pointBackgroundColor: '#9060d0'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: { min: 0, max: 100, ticks: { callback: v=>v+'%', color: '#888890', font:{size:9} }, grid: { color: 'rgba(128,128,128,0.15)' } },
            x: { ticks: { color: '#888890', font: { size: 8 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 8 }, grid: { display: false } }
          }
        }
      });
    }
  }
}

// ============================================================
// STANDINGS
// ============================================================
function renderStandingsTable(standings, containerId, showCareer) {
  const container = document.getElementById(containerId);
  if(!standings.length) {
    container.innerHTML = '<table><tbody><tr><td colspan="13" style="text-align:center;color:var(--simr-muted);padding:20px">No results yet</td></tr></tbody></table>';
    return;
  }
  const leaderPts = standings[0]?.adjustedPts || 0;
  const rows = standings.map((d, i) => {
    const drv = state.currentDrivers.find(dr=>dr.id===d.driver_id);
    const drvName = driverLabel(drv);
    const pos = i + 1;
    const posCls = pos===1?'pg':pos===2?'ps':pos===3?'pb':'';
    const eff = d.eff !== null ? d.eff.toFixed(1)+'%' : '—';
    const ceff = d.careerEff !== null ? d.careerEff.toFixed(1)+'%' : '—';
    const gapToLeader = i === 0 ? '—' : '-'+(leaderPts - d.adjustedPts);
    const gapToAhead = i === 0 ? '—' : '-'+(standings[i-1].adjustedPts - d.adjustedPts);
    return `<tr>
      <td class="${posCls}">${pos}</td>
      <td style="font-weight:600">${drvName}${d.car_model?'<span style="font-size:11px;color:var(--simr-muted);font-weight:400"> — '+d.car_model+'</span>':''}</td>
      <td>${badgeHTML(d.cls)}</td>
      <td class="pts-cell">${d.adjustedPts}</td>
      <td style="font-family:monospace;font-size:12px;color:${i===0?'var(--simr-hint)':'var(--simr-red)'}">${gapToLeader}</td>
      <td style="font-family:monospace;font-size:12px;color:${i===0?'var(--simr-hint)':'var(--simr-muted)'}">${gapToAhead}</td>
      <td>${d.wins}</td>
      <td>${d.podiums}</td>
      <td>${d.poles}</td>
      <td class="eff-cell" style="color:var(--simr-muted)">${eff}</td>
      ${showCareer ? '<td class="eff-cell" style="color:var(--simr-muted)">'+ceff+'</td>' : ''}
      <td>${d.dropAmt !== null ? '<span class="drop-cell">'+d.dropAmt+'</span>' : '<span style="color:var(--simr-hint)">—</span>'}</td>
    </tr>`;
  }).join('');

  container.innerHTML = '<table style="table-layout:fixed;min-width:900px">'
    + '<thead><tr>'
    + '<th style="width:40px">Pos</th>'
    + '<th style="min-width:140px">Driver</th>'
    + '<th style="width:70px">Class</th>'
    + '<th style="width:65px">Pts</th>'
    + '<th style="width:75px">Gap Lead</th>'
    + '<th style="width:75px">Gap Ahead</th>'
    + '<th style="width:50px">Wins</th>'
    + '<th style="width:58px">Podiums</th>'
    + '<th style="width:55px">Poles</th>'
    + '<th style="width:90px">Season Eff%</th>'
    + (showCareer ? '<th style="width:90px">Career Eff%</th>' : '')
    + '<th style="width:60px">Drop</th>'
    + '</tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '</table>';
}

async function loadStandings() {
  const seasons = await loadSeasonSelects(['standings-season-sel'], state.currentSeriesId);
  const seasonId = document.getElementById('standings-season-sel').value;
  if(!seasonId) return;

  const { sessions: allSeriesSessions, results: allSeriesResults } = await getSeriesData();
  const [season, events, scoringConfig, classConfig, careerStats, drivers, seasonDriversArr] = await Promise.all([
    dbGet('seasons', `id=eq.${seasonId}`).then(r=>r[0]),
    dbGet('events', `season_id=eq.${seasonId}&order=event_date.asc`),
    dbGet('scoring_config', `season_id=eq.${seasonId}`),
    dbGet('classification_config', `season_id=eq.${seasonId}`).then(r=>r[0]||null),
    dbGet('career_stats', `series_id=eq.${state.currentSeriesId}`),
    dbGet('drivers', 'order=name'),
    dbGet('season_drivers', `season_id=eq.${seasonId}`)
  ]);
  const sessions = allSeriesSessions;
  const results = allSeriesResults;

  state.currentDrivers = drivers;
  const careerMap = {};
  careerStats.forEach(cs => { careerMap[cs.driver_id] = cs; });

  if(classConfig) {
    state.activeThresholds = {
      p: classConfig.platinum_threshold || 72,
      g: classConfig.gold_threshold || 55,
      s: classConfig.silver_threshold || 35
    };
  }

  // Count completed rounds
  const completedEvents = events.filter(ev => {
    const evSessions = sessions.filter(s=>s.event_id===ev.id);
    return evSessions.some(s=>results.some(r=>r.session_id===s.id));
  });

  // ── SEASON HEADER ──
  if(season) {
    document.getElementById('standings-sub').textContent = `${state.currentSeriesName} · ${season.car_class||''}`;
    // Header is rendered after calcStandings so spotlight stats are available
  }

  // ── STANDINGS TABLE ──
  const isMultiCarSeason = events.some(e => e.is_multi_car);
  const standings = calcStandings(seasonId, results, sessions, events, scoringConfig, classConfig, careerMap, seasonDriversArr);
  renderStandingsTable(standings, 'standings-body', true);

  // ── STANDINGS HEADER + SEASON SPOTLIGHT ──
  if(season) {
    const drvName2 = id => driverLabel(drivers.find(d=>d.id===id));
    const leader = standings[0];
    const second = standings[1];
    const gap = leader && second ? leader.adjustedPts - second.adjustedPts : 0;
    const leaderName = leader ? drvName2(leader.driver_id) : '—';
    const secondName = second ? drvName2(second.driver_id) : null;
    const mostWins = standings.reduce((b,d)=>d.wins>b.wins?d:b,{wins:-1,driver_id:null});
    const mostPods = standings.reduce((b,d)=>d.podiums>b.podiums?d:b,{podiums:-1,driver_id:null});
    const mostPoles = standings.reduce((b,d)=>(d.poles||0)>(b.poles||0)?d:b,{poles:0,driver_id:null});
    const mostStarts = standings.reduce((b,d)=>d.starts>b.starts?d:b,{starts:-1,driver_id:null});
    const highestEff = standings.filter(d=>d.eff!==null).reduce((b,d)=>d.eff>b.eff?d:b,{eff:-1,driver_id:null});
    const lowestEff = standings.filter(d=>d.eff!==null).reduce((b,d)=>d.eff<b.eff?d:b,{eff:999,driver_id:null});
    document.getElementById('standings-season-header').innerHTML = `
      <div style="background:var(--simr-surface);border:1px solid var(--simr-border2);border-radius:8px;overflow:hidden">
        <div style="padding:20px 24px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px">
            <div>
              <div style="font-size:24px;font-weight:700;letter-spacing:.04em;margin-bottom:6px">${season.name}</div>
              <div style="font-size:13px;color:var(--simr-muted)">${state.currentSeriesName} · ${season.car_class||''}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:28px;font-weight:700;color:var(--simr-amber)">Round ${completedEvents.length} <span style="font-size:16px;color:var(--simr-muted);font-weight:400">of ${events.length}</span></div>
              <div style="font-size:12px;color:var(--simr-muted);margin-top:2px">As of Round ${completedEvents.length}</div>
            </div>
          </div>
          ${leader ? `
          <div class="champ-banner" style="margin-top:14px">
            <span style="font-size:18px">🏆</span>
            <div>
              <div style="font-size:14px;font-weight:600">${leaderName}</div>
              <div style="font-size:11px;color:var(--simr-muted)">${season.is_locked?'Champion':'Leading'} · ${leader.adjustedPts} pts${secondName?' · '+gap+' pts ahead of '+secondName:''}</div>
            </div>
          </div>` : ''}
        </div>
        <div class="szn-rec-grid" style="border-top:1px solid var(--simr-border)">
          <div class="szn-rec-cell"><div class="src-label">Most wins</div><div class="src-name">${drvName2(mostWins.driver_id)}</div><div class="src-val">${mostWins.wins>-1?mostWins.wins+' wins':'—'}</div></div>
          <div class="szn-rec-cell"><div class="src-label">Most podiums</div><div class="src-name">${drvName2(mostPods.driver_id)}</div><div class="src-val">${mostPods.podiums>-1?mostPods.podiums+' podiums':'—'}</div></div>
          <div class="szn-rec-cell"><div class="src-label">Most poles</div><div class="src-name">${drvName2(mostPoles.driver_id)}</div><div class="src-val">${mostPoles.poles>0?mostPoles.poles+' poles':'—'}</div></div>
          <div class="szn-rec-cell"><div class="src-label">Most starts</div><div class="src-name">${drvName2(mostStarts.driver_id)}</div><div class="src-val">${mostStarts.starts>-1?mostStarts.starts+' starts':'—'}</div></div>
          <div class="szn-rec-cell"><div class="src-label">Highest eff.</div><div class="src-name">${drvName2(highestEff.driver_id)}</div><div class="src-val">${highestEff.eff>-1?highestEff.eff.toFixed(1)+'%':'—'}</div></div>
          <div class="szn-rec-cell"><div class="src-label">Lowest eff.</div><div class="src-name">${drvName2(lowestEff.driver_id)}</div><div class="src-val">${lowestEff.eff<999?lowestEff.eff.toFixed(1)+'%':'—'}</div></div>
          <div class="szn-rec-cell"><div class="src-label">Championship gap</div><div class="src-name">P1 vs P2</div><div class="src-val">${second?gap+' pts':'—'}</div></div>
          <div class="szn-rec-cell"><div class="src-label">Field size</div><div class="src-name">Drivers this season</div><div class="src-val">${standings.length} drivers</div></div>
        </div>
      </div>`;
  }

  // ── CHAMPIONSHIP POINTS TABLE ──
  const roundsEl = document.getElementById('standings-rounds');
  if(!events.length) {
    roundsEl.innerHTML = '<div style="color:var(--simr-muted);font-size:13px">No rounds yet</div>';
  } else {
    // Build per-entrant per-event totals (multi-car uses driver+car key)
    const mcMap = {}; // driver_id -> car_model for this season
    if(isMultiCarSeason) seasonDriversArr.forEach(sd => { if(!mcMap[sd.driver_id]) mcMap[sd.driver_id] = sd.car_model; });
    const ptKey = (dId) => isMultiCarSeason ? `${dId}|${mcMap[dId]||''}` : dId;
    const evTotals = {};
    standings.forEach(d => { evTotals[ptKey(d.driver_id)] = {}; });

    events.forEach(ev => {
      const evSessions = sessions.filter(s=>s.event_id===ev.id&&s.session_type==='race');
      evSessions.forEach(sess => {
        const baseP1 = scoringConfig.length ? scoringConfig[0].points : 20;
        const sessResultsAll = results.filter(r=>r.session_id===sess.id);
        const sessMap = calcSessionPointsMap(sess, sessResultsAll, scoringConfig, baseP1);
        Object.entries(sessMap).forEach(([dId,pts])=>{
          const k = ptKey(dId);
          if(!evTotals[k]) evTotals[k] = {};
          evTotals[k][ev.id] = (evTotals[k][ev.id]||0) + pts;
        });
      });
    });

    // Column headers — round names
    const headerCols = events.map(ev => {
      const short = (ev.name||ev.track||'R').replace(/^(S\d+\s+)?Round\s*/i,'R').replace(/[^A-Za-z0-9]/g,'').slice(0,6);
      return `<th style="width:52px;text-align:center;font-size:11px;padding:6px 4px" title="${ev.name||ev.track}">${short}</th>`;
    }).join('');

    // Rows — one per entrant in championship order
    const tableRows = standings.map((d,i) => {
      const drv = state.currentDrivers.find(dr=>dr.id===d.driver_id);
      const posCls = i===0?'pg':i===1?'ps':i===2?'pb':'';
      const k = ptKey(d.driver_id);
      const nameDisplay = d.car_model ? `${driverLabel(drv)} <span style="font-size:11px;color:var(--simr-muted)">— ${d.car_model}</span>` : driverLabel(drv);
      const cols = events.map(ev => {
        const pts = evTotals[k]?.[ev.id];
        const hasResults = sessions.filter(s=>s.event_id===ev.id).some(s=>results.some(r=>r.session_id===s.id&&r.driver_id===d.driver_id));
        if(!hasResults) return `<td style="text-align:center;color:var(--simr-hint);font-size:12px">—</td>`;
        const isDropped = d.droppedEventId === ev.id;
        return `<td style="text-align:center;font-weight:600;font-size:12px${isDropped?';color:var(--simr-hint);text-decoration:line-through;font-weight:400':''}" ${isDropped?'title="Dropped round"':''}>${pts||0}</td>`;
      }).join('');
      return `<tr>
        <td class="${posCls}" style="width:32px">${i+1}</td>
        <td style="font-weight:600;font-size:12px">${nameDisplay}</td>
        <td style="font-weight:700;font-size:13px;color:var(--simr-amber);text-align:right;padding-right:12px">${d.adjustedPts}</td>
        ${cols}
      </tr>`;
    }).join('');

    roundsEl.innerHTML = `
      <div style="margin-top:4px">
        <div style="font-size:11px;color:var(--simr-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Championship points by round</div>
        <div style="overflow-x:auto">
          <table style="table-layout:auto;min-width:400px">
            <thead><tr>
              <th style="width:32px">Pos</th>
              <th style="min-width:120px">Driver</th>
              <th style="width:60px;text-align:right;padding-right:12px">Total</th>
              ${headerCols}
            </tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </div>`; 
  }
}


// ============================================================
// RECORDS
// ============================================================
async function loadRecords() {
  if(!state.currentSeriesId) return;
  document.getElementById('records-title').textContent = `${state.currentSeriesName} — Records`;
  const { seasons, events, sessions, results } = await getSeriesData();
  const [careerStats, drivers, allScoringConfigs] = await Promise.all([
    dbGet('career_stats', `series_id=eq.${state.currentSeriesId}`),
    dbGet('drivers', 'order=name'),
    dbGet('scoring_config')
  ]);
  seasons.sort((a,b)=>b.season_number-a.season_number);
  state.currentDrivers = drivers;

  const careerMap = {};
  careerStats.forEach(cs => { careerMap[cs.driver_id] = cs; });

  const scoringConfigMap = {};
  const eventScoringConfigMap = {};
  allScoringConfigs.forEach(sc => {
    if(sc.event_id) {
      if(!eventScoringConfigMap[sc.event_id]) eventScoringConfigMap[sc.event_id] = [];
      eventScoringConfigMap[sc.event_id].push(sc);
    } else if(sc.season_id) {
      if(!scoringConfigMap[sc.season_id]) scoringConfigMap[sc.season_id] = [];
      scoringConfigMap[sc.season_id].push(sc);
    }
  });

  // Calculate ALL career stats live from results for every driver
  const liveStats = {};
  drivers.forEach(drv => {
    liveStats[drv.id] = calcLiveCareerStats(drv.id, results, sessions, events, seasons, scoringConfigMap, careerMap, eventScoringConfigMap);
  });

  const drvName = id => driverLabel(drivers.find(d=>d.id===id));

  // Compute grand slams: P1 in every quali + race session, FL in every race
  const grandSlamMap = {};
  events.forEach(ev => {
    const evQualSess = sessions.filter(s=>s.event_id===ev.id&&s.session_type==='grid');
    const evRaceSess = sessions.filter(s=>s.event_id===ev.id&&s.session_type==='race');
    const evAllSess = [...evQualSess, ...evRaceSess];
    if(!evAllSess.length || !evRaceSess.length) return;
    const driverP1s = {};
    evAllSess.forEach(sess => {
      const p1 = results.find(r=>r.session_id===sess.id&&r.position===1&&!r.dnf);
      if(p1) driverP1s[p1.driver_id] = (driverP1s[p1.driver_id]||0)+1;
    });
    Object.entries(driverP1s).forEach(([dId, wins]) => {
      if(wins !== evAllSess.length) return;
      const flRaces = evRaceSess.filter(sess=>
        results.some(r=>r.session_id===sess.id&&r.driver_id===dId&&r.fastest_lap)
      ).length;
      if(flRaces === evRaceSess.length) {
        if(!grandSlamMap[dId]) grandSlamMap[dId] = [];
        grandSlamMap[dId].push(ev.name||ev.track||'Event');
      }
    });
  });
  state._grandSlamMap = grandSlamMap;

  // Longest win streaks — chronological across all events, race sessions only
  const allRaceSessChron = sessions
    .filter(s=>s.session_type==='race')
    .map(s=>({...s, _date: events.find(e=>e.id===s.event_id)?.event_date||''}))
    .sort((a,b)=>a._date>b._date?1:a._date<b._date?-1:a.race_number-b.race_number);
  const winStreaksList = [];
  const curStreaks = {};
  allRaceSessChron.forEach(sess => {
    results.filter(r=>r.session_id===sess.id).forEach(r => {
      if(r.position===1&&!r.dnf) {
        curStreaks[r.driver_id] = (curStreaks[r.driver_id]||0)+1;
      } else {
        if((curStreaks[r.driver_id]||0)>=1) winStreaksList.push({driver_id:r.driver_id, length:curStreaks[r.driver_id]});
        curStreaks[r.driver_id] = 0;
      }
    });
  });
  Object.entries(curStreaks).forEach(([dId,len])=>{ if(len>=1) winStreaksList.push({driver_id:dId, length:len}); });
  winStreaksList.sort((a,b)=>b.length-a.length);
  const top3Streaks = winStreaksList.slice(0,3);
  const personalBestStreakMap = {};
  winStreaksList.forEach(s=>{ personalBestStreakMap[s.driver_id] = Math.max(personalBestStreakMap[s.driver_id]||0, s.length); });
  state._personalBestStreakMap = personalBestStreakMap;

  // Build alltime data — everything from live results except championships (human confirmed)
  // careerPosGained and avgStartPos come from calcLiveCareerStats (already computed above in liveStats)
  state.allTimeData = drivers.map(drv => {
    const cs = careerMap[drv.id] || {};
    const live = liveStats[drv.id];
    const eff = live.eff;
    const cls = classifyDriver(eff, live.starts);
    return {
      driver_id: drv.id,
      name: driverLabel(drv),
      cls,
      career_eff: eff,
      avg_finish: live.avg,
      starts: live.starts,
      wins: live.wins,
      podiums: live.podiums,
      top5s: live.top5s,
      top10s: live.top10s,
      poles: live.poles,
      fastestLaps: live.fastestLaps || 0,
      round_wins: cs.round_wins || 0,
      championships: drv.championships || 0,
      totalPosGained: live.totalPosGained || 0,
      careerPosGained: live.careerPosGained || 0,
      avgStartPos: live.avgStartPos || null,
      winPct: live.starts > 0 ? (live.wins / live.starts * 100) : 0,
      podiumPct: live.starts > 0 ? (live.podiums / live.starts * 100) : 0,
      grandSlams: (grandSlamMap[drv.id]||[]).length,
      bestStreak: personalBestStreakMap[drv.id] || 0
    };
  });

  // All-time record heroes
  const sorted = [...state.allTimeData].filter(d=>d.starts>=1);
  const topBy = (key) => sorted.reduce((b,d)=>(d[key]||0)>(b[key]||0)?d:b, sorted[0]);
  const topEff = sorted.filter(d=>d.starts>=10).reduce((b,d)=>(d.career_eff||0)>(b.career_eff||0)?d:b, {career_eff:null,name:'—'});
  const topAvg = sorted.filter(d=>d.starts>=10).reduce((b,d)=>{
    if(!d.avg_finish) return b;
    if(!b.avg_finish) return d;
    return d.avg_finish < b.avg_finish ? d : b;
  }, {avg_finish:null,name:'—'});

  // Load lap records for hero cards
  const trackRecords = await getLapRecords(state.currentSeriesId);
  const lapRecordsList = Object.values(trackRecords);

  // Most lap records held
  const recCounts = {};
  lapRecordsList.forEach(r => recCounts[r.driver_id] = (recCounts[r.driver_id]||0)+1);
  const topRecHolder = Object.entries(recCounts).sort((a,b)=>b[1]-a[1])[0];
  const topRecDriver = topRecHolder ? sorted.find(d=>d.driver_id===topRecHolder[0]) : null;

  // Most positions gained in a season
  // Reuse seasons/events/sessions/results already fetched above
  const allSeasonsForRec = seasons;
  const allEventsForRec = events;
  const allSessionsForRec = sessions;
  const allResultsForRec = results;
  let topSeasonPosGained = { driver: null, total: 0, season: null };
  for(const s of allSeasonsForRec) {
    const sEvents = allEventsForRec.filter(e=>e.season_id===s.id);
    const sEvIds = new Set(sEvents.map(e=>e.id));
    const sSessions = allSessionsForRec.filter(sess=>sEvIds.has(sess.event_id));
    const raceSess = sSessions.filter(sess=>sess.session_type==='race');
    const driverGains = {};
    raceSess.forEach(sess => {
      const gridSess = sSessions.find(gs=>gs.event_id===sess.event_id&&gs.session_type==='grid'&&gs.race_number===sess.race_number);
      allResultsForRec.filter(r=>r.session_id===sess.id&&!r.dnf).forEach(r => {
        let startPos = r.grid_position;
        if(!startPos && gridSess) {
          const gr = allResultsForRec.find(res=>res.session_id===gridSess.id&&res.driver_id===r.driver_id);
          startPos = gr?.position;
        }
        if(startPos && r.position) {
          driverGains[r.driver_id] = (driverGains[r.driver_id]||0) + (startPos - r.position);
        }
      });
    });
    Object.entries(driverGains).forEach(([dId, total]) => {
      if(total > topSeasonPosGained.total) topSeasonPosGained = { driver: sorted.find(d=>d.driver_id===dId), total, season: s };
    });
  }

  // Most positions gained in a single race
  let topRacePosGained = { driver: null, gained: 0, event: null, race: null };
  allSessionsForRec.filter(s=>s.session_type==='race').forEach(sess => {
    const ev = allEventsForRec.find(e=>e.id===sess.event_id);
    const gridSess = allSessionsForRec.find(gs=>gs.event_id===sess.event_id&&gs.session_type==='grid'&&gs.race_number===sess.race_number);
    allResultsForRec.filter(r=>r.session_id===sess.id&&!r.dnf).forEach(r => {
      let startPos = r.grid_position;
      if(!startPos && gridSess) {
        const gr = allResultsForRec.find(res=>res.session_id===gridSess.id&&res.driver_id===r.driver_id);
        startPos = gr?.position;
      }
      if(startPos && r.position) {
        const gained = startPos - r.position;
        if(gained > topRacePosGained.gained) {
          topRacePosGained = { driver: sorted.find(d=>d.driver_id===r.driver_id), gained, event: ev?.name||'', race: sess.race_number };
        }
      }
    });
  });

  const topStreak = top3Streaks[0] ? {name: driverLabel(drivers.find(d=>d.id===top3Streaks[0].driver_id)), length: top3Streaks[0].length} : null;
  document.getElementById('rec-heroes').innerHTML = `
    <div class="rec-hero"><div class="rec-icon">🏆</div><div class="rec-cat">Most championships</div><div class="rec-name">${topBy('championships')?.name||'—'}</div><div class="rec-val">${topBy('championships')?.championships||'—'}</div><div class="rec-sub">all time</div></div>
    <div class="rec-hero"><div class="rec-icon">🥇</div><div class="rec-cat">Most wins</div><div class="rec-name">${topBy('wins')?.name||'—'}</div><div class="rec-val">${topBy('wins')?.wins||'—'}</div><div class="rec-sub">all time</div></div>
    <div class="rec-hero"><div class="rec-icon">🏅</div><div class="rec-cat">Most podiums</div><div class="rec-name">${topBy('podiums')?.name||'—'}</div><div class="rec-val">${topBy('podiums')?.podiums||'—'}</div><div class="rec-sub">all time</div></div>
    <div class="rec-hero"><div class="rec-icon">⚡</div><div class="rec-cat">Most poles</div><div class="rec-name">${topBy('poles')?.name||'—'}</div><div class="rec-val">${topBy('poles')?.poles||'—'}</div><div class="rec-sub">all time</div></div>
    <div class="rec-hero"><div class="rec-icon">🔄</div><div class="rec-cat">Most round wins</div><div class="rec-name">${topBy('round_wins')?.name||'—'}</div><div class="rec-val">${topBy('round_wins')?.round_wins||'—'}</div><div class="rec-sub">all time</div></div>
    <div class="rec-hero"><div class="rec-icon">⭐</div><div class="rec-cat">Grand slams</div><div class="rec-name">${topBy('grandSlams')?.grandSlams>0?topBy('grandSlams').name:'—'}</div><div class="rec-val">${topBy('grandSlams')?.grandSlams||'—'}</div><div class="rec-sub">pole · all wins · all FLs</div></div>
    <div class="rec-hero"><div class="rec-icon">🚗</div><div class="rec-cat">Most fastest laps</div><div class="rec-name">${topBy('fastestLaps')?.name||'—'}</div><div class="rec-val">${topBy('fastestLaps')?.fastestLaps||'—'}</div><div class="rec-sub">all time</div></div>
    <div class="rec-hero"><div class="rec-icon">🏁</div><div class="rec-cat">Most lap records</div><div class="rec-name">${topRecDriver?.name||'—'}</div><div class="rec-val">${topRecHolder?topRecHolder[1]:'—'}</div><div class="rec-sub">tracks held</div></div>
    <div class="rec-hero"><div class="rec-icon">📋</div><div class="rec-cat">Most starts</div><div class="rec-name">${topBy('starts')?.name||'—'}</div><div class="rec-val">${topBy('starts')?.starts||'—'}</div><div class="rec-sub">all time</div></div>
    <div class="rec-hero"><div class="rec-icon">🔥</div><div class="rec-cat">Longest win streak</div><div class="rec-name">${topStreak?.name||'—'}</div><div class="rec-val">${topStreak?topStreak.length:'—'}</div><div class="rec-sub">consecutive race wins</div></div>
    <div class="rec-hero"><div class="rec-icon">📈</div><div class="rec-cat">Career pos. gained</div><div class="rec-name">${topBy('careerPosGained')?.name||'—'}</div><div class="rec-val">${topBy('careerPosGained')?.careerPosGained>0?'+'+topBy('careerPosGained').careerPosGained:'—'}</div><div class="rec-sub">passes made all time</div></div>
    <div class="rec-hero"><div class="rec-icon">🚀</div><div class="rec-cat">Most positions gained (race)</div><div class="rec-name">${topRacePosGained.driver?.name||'—'}</div><div class="rec-val">${topRacePosGained.gained>0?'+'+topRacePosGained.gained:'—'}</div><div class="rec-sub">${topRacePosGained.event} R${topRacePosGained.race||''}</div></div>
  `;

  // ── TOP 3 ALL TIME ──
  const top3By = (arr, key, asc=false) =>
    [...arr].filter(d=>(d[key]||0)>0).sort((a,b)=>asc?(a[key]||0)-(b[key]||0):(b[key]||0)-(a[key]||0)).slice(0,3);

  // Lap records count per driver — use recCounts already computed above
  const sortedWithLaps = sorted.map(d=>({...d, lapRecords: recCounts[d.driver_id]||0}));

  const posColors3 = ['#d4a820','#8a9aaa','#c07030'];
  const renderTop3 = (entries, fmt) => entries.length
    ? entries.map((d,i)=>`
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;${i<entries.length-1?'border-bottom:1px solid var(--simr-border)':''}">
          <span style="width:18px;text-align:center;font-size:11px;font-weight:700;color:${posColors3[i]}">${i+1}</span>
          <span style="flex:1;font-size:13px;font-weight:500">${d.name}</span>
          <span style="font-size:13px;font-weight:700;color:var(--simr-amber)">${fmt(d)}</span>
        </div>`).join('')
    : '<div style="font-size:12px;color:var(--simr-hint)">No data</div>';

  const top3Cats = [
    {icon:'🥇',label:'Wins',           entries:top3By(sorted,'wins'),                           fmt:d=>d.wins},
    {icon:'🏅',label:'Podiums',        entries:top3By(sorted,'podiums'),                        fmt:d=>d.podiums},
    {icon:'⚡',label:'Poles',          entries:top3By(sorted,'poles'),                          fmt:d=>d.poles},
    {icon:'🚗',label:'Fastest Laps',   entries:top3By(sorted,'fastestLaps'),                    fmt:d=>d.fastestLaps},
    {icon:'📋',label:'Starts',         entries:top3By(sorted,'starts'),                         fmt:d=>d.starts},
    {icon:'🏆',label:'Championships',  entries:top3By(sorted,'championships'),                   fmt:d=>d.championships},
    {icon:'🔄',label:'Round Wins',     entries:top3By(sorted,'round_wins'),                     fmt:d=>d.round_wins},
    {icon:'⭐',label:'Grand Slams',    entries:top3By(sorted,'grandSlams'),                     fmt:d=>d.grandSlams},
    {icon:'🎯',label:'Career Eff.',    entries:top3By(sorted.filter(d=>d.starts>=10),'career_eff'), fmt:d=>d.career_eff.toFixed(1)+'%'},
    {icon:'📍',label:'Avg Finish',     entries:[...sorted.filter(d=>d.starts>=10&&d.avg_finish)].sort((a,b)=>a.avg_finish-b.avg_finish).slice(0,3), fmt:d=>'P'+d.avg_finish.toFixed(1)},
    {icon:'📊',label:'Win %',          entries:top3By(sorted.filter(d=>d.starts>=10),'winPct'),  fmt:d=>d.winPct.toFixed(1)+'%'},
    {icon:'🏆',label:'Podium %',       entries:top3By(sorted.filter(d=>d.starts>=10),'podiumPct'), fmt:d=>d.podiumPct.toFixed(1)+'%'},
    {icon:'📈',label:'Pos. Gained',    entries:top3By(sorted.filter(d=>d.starts>=10),'careerPosGained'), fmt:d=>'+'+d.careerPosGained},
    {icon:'🏁',label:'Lap Records',    entries:top3By(sortedWithLaps,'lapRecords'),              fmt:d=>d.lapRecords+' tracks'},
    {icon:'🔥',label:'Win Streak',     entries:top3Streaks.map(s=>({name:driverLabel(drivers.find(d=>d.id===s.driver_id))||'—',length:s.length})), fmt:d=>d.length+' wins'},
  ];

  document.getElementById('rec-top3').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
      ${top3Cats.map(cat=>`
        <div style="background:var(--simr-surface);border:1px solid var(--simr-border);border-radius:8px;padding:14px 16px">
          <div style="font-size:10px;color:var(--simr-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">${cat.icon} ${cat.label}</div>
          ${renderTop3(cat.entries, cat.fmt)}
        </div>`).join('')}
    </div>`;

  // season select
  await loadSeasonSelects(['rec-season-sel'], state.currentSeriesId);

  // Lap records
  await renderLapRecords();

  renderAllTimeTable();
}

let _allLapRecords = {};
let _lapRecordsDrivers = [];

async function renderLapRecords(filter='') {
  const el = document.getElementById('lap-records-table');
  const mostEl = document.getElementById('most-lap-records');
  if(!el) return;

  if(!Object.keys(_allLapRecords).length) {
    _allLapRecords = await getLapRecords(state.currentSeriesId);
    _lapRecordsDrivers = await dbGet('drivers','order=name');
  }

  const records = Object.values(_allLapRecords);
  const filtered = filter
    ? records.filter(r=>r.track.toLowerCase().includes(filter.toLowerCase()))
    : records;

  filtered.sort((a,b)=>a.track.localeCompare(b.track));

  if(!filtered.length) {
    el.innerHTML = '<div style="color:var(--simr-muted);font-size:13px;padding:8px 0">No lap records yet — enter race results with lap times to start tracking</div>';
  } else {
    el.innerHTML = `<table style="table-layout:auto">
      <thead><tr>
        <th>Track</th><th>Driver</th><th>Lap Time</th><th>Car</th><th>Event</th>
      </tr></thead>
      <tbody>${filtered.map(r=>{
        const drv = _lapRecordsDrivers.find(d=>d.id===r.driver_id);
        return `<tr>
          <td style="font-weight:600">${r.track.replace(/\s*\([^)]+\)/g,'').trim()}</td>
          <td>${driverLabel(drv)}</td>
          <td style="font-family:monospace;color:var(--simr-purple);font-weight:600">${r.lap_time}</td>
          <td style="color:var(--simr-muted);font-size:12px">${r.carName||r.car||'—'}</td>
          <td style="color:var(--simr-muted);font-size:12px">${r.event_name}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }

  // Most lap records held
  const recordCounts = {};
  records.forEach(r=>{
    recordCounts[r.driver_id] = (recordCounts[r.driver_id]||0)+1;
  });
  const sorted = Object.entries(recordCounts).sort((a,b)=>b[1]-a[1]).slice(0,10);
  if(mostEl) {
    mostEl.innerHTML = sorted.length ? `<table style="table-layout:auto">
      <thead><tr><th style="width:40px">Pos</th><th>Driver</th><th style="width:80px">Records</th></tr></thead>
      <tbody>${sorted.map(([dId,count],i)=>{
        const drv = _lapRecordsDrivers.find(d=>d.id===dId);
        const posCls = i===0?'pg':i===1?'ps':i===2?'pb':'';
        return `<tr><td class="${posCls}">${i+1}</td><td style="font-weight:600">${driverLabel(drv)}</td><td style="font-weight:600;color:var(--simr-purple)">${count}</td></tr>`;
      }).join('')}</tbody>
    </table>` : '<div style="color:var(--simr-muted);font-size:13px;padding:8px 0">No records yet</div>';
  }
}

function filterLapRecords(q) {
  renderLapRecords(q);
}

async function loadSeasonSpotlight() {
  const seasonId = document.getElementById('rec-season-sel')?.value;
  if(!seasonId) return;
  const [seasons, events, sessions, results, scoringConfig, careerStats, drivers, classConfigArr] = await Promise.all([
    dbGet('seasons', `id=eq.${seasonId}`),
    dbGet('events', `season_id=eq.${seasonId}&order=event_date.asc`),
    dbGet('sessions'),
    dbGet('results'),
    dbGet('scoring_config', `season_id=eq.${seasonId}`),
    dbGet('career_stats', `series_id=eq.${state.currentSeriesId}`),
    dbGet('drivers', 'order=name'),
    dbGet('classification_config', `season_id=eq.${seasonId}`)
  ]);
  const season = seasons[0];
  const classConfig = classConfigArr[0] || null;
  const careerMap = {};
  careerStats.forEach(cs=>{careerMap[cs.driver_id]=cs;});
  const standings = calcStandings(seasonId, results, sessions, events, scoringConfig, classConfig, careerMap);
  const leader = standings[0];
  const leaderName = leader ? drivers.find(d=>d.id===leader.driver_id)?.name||'—' : '—';
  const second = standings[1];
  const secondName = second ? drivers.find(d=>d.id===second.driver_id)?.name||'—' : '—';
  const gap = leader && second ? leader.adjustedPts - second.adjustedPts : 0;

  const mostWins = standings.reduce((b,d)=>d.wins>b.wins?d:b,{wins:-1,driver_id:null});
  const mostPods = standings.reduce((b,d)=>d.podiums>b.podiums?d:b,{podiums:-1,driver_id:null});
  const highestEff = standings.filter(d=>d.eff!==null).reduce((b,d)=>d.eff>b.eff?d:b,{eff:-1,driver_id:null});
  const lowestEff = standings.filter(d=>d.eff!==null).reduce((b,d)=>d.eff<b.eff?d:b,{eff:999,driver_id:null});
  const mostStarts = standings.reduce((b,d)=>d.starts>b.starts?d:b,{starts:-1,driver_id:null});
  const drvName2 = id => driverLabel(drivers.find(d=>d.id===id));

  // Poles — live from standings (counts qualifying session P1 results)
  const mostPoles = standings.reduce((b,d)=>(d.poles||0)>(b.poles||0)?d:b, {poles:0,driver_id:null});

  // Most improved — biggest pts gap between first and last event they attended
  const mostImproved = standings.reduce((b,d)=>{
    const evPtsArr = Object.values(d.eventPts||{});
    if(evPtsArr.length < 2) return b;
    const improvement = evPtsArr[evPtsArr.length-1] - evPtsArr[0];
    return improvement > (b.improvement||0) ? {...d, improvement} : b;
  }, {improvement:-999, driver_id:null});

  document.getElementById('rec-season-meta').textContent = `${season?.car_class||''} · ${standings.length} drivers · ${events.filter(e=>!e.is_one_off).length} events`;
  document.getElementById('rec-season-content').innerHTML = `
    <div class="champ-banner">
      <span style="font-size:18px">🏆</span>
      <div><div style="font-size:14px;font-weight:600">${leaderName}</div>
      <div style="font-size:11px;color:var(--simr-muted)">${season?.is_active?'Leading':'Champion'} · ${leader?.adjustedPts||0} pts${second?' · '+gap+' pts ahead of '+secondName:''}</div></div>
    </div>
    <div class="szn-rec-grid" style="border:1px solid var(--simr-border);border-top:none;border-radius:0 0 4px 4px">
      <div class="szn-rec-cell"><div class="src-label">Most wins</div><div class="src-name">${drvName2(mostWins.driver_id)}</div><div class="src-val">${mostWins.wins>-1?mostWins.wins+' wins':'—'}</div></div>
      <div class="szn-rec-cell"><div class="src-label">Most podiums</div><div class="src-name">${drvName2(mostPods.driver_id)}</div><div class="src-val">${mostPods.podiums>-1?mostPods.podiums+' podiums':'—'}</div></div>
      <div class="szn-rec-cell"><div class="src-label">Most poles</div><div class="src-name">${drvName2(mostPoles.driver_id)}</div><div class="src-val">${mostPoles.poles>0?mostPoles.poles+' poles':'—'}</div></div>
      <div class="szn-rec-cell"><div class="src-label">Most starts</div><div class="src-name">${drvName2(mostStarts.driver_id)}</div><div class="src-val">${mostStarts.starts>-1?mostStarts.starts+' starts':'—'}</div></div>
      <div class="szn-rec-cell"><div class="src-label">Highest eff.</div><div class="src-name">${drvName2(highestEff.driver_id)}</div><div class="src-val">${highestEff.eff>-1?highestEff.eff.toFixed(1)+'%':'—'}</div></div>
      <div class="szn-rec-cell"><div class="src-label">Lowest eff.</div><div class="src-name">${drvName2(lowestEff.driver_id)}</div><div class="src-val">${lowestEff.eff<999?lowestEff.eff.toFixed(1)+'%':'—'}</div></div>
      <div class="szn-rec-cell"><div class="src-label">Championship gap</div><div class="src-name">P1 vs P2</div><div class="src-val">${second?gap+' pts':'—'}</div></div>
      <div class="szn-rec-cell"><div class="src-label">Field size</div><div class="src-name">Drivers this season</div><div class="src-val">${standings.length} drivers</div></div>
    </div>
  `;
}

function renderAllTimeTable() {
  let data = [...state.allTimeData];
  if(state.allTimeClassFilter !== 'all') data = data.filter(d=>d.cls===state.allTimeClassFilter);
  if(state.allTimeSearch) data = data.filter(d=>d.name.toLowerCase().includes(state.allTimeSearch));
  const key = state.allTimeSortKey;
  const dir = state.allTimeSortDir;
  data.sort((a,b)=>{
    if(key==='name') return dir * a.name.localeCompare(b.name);
    if(key==='cls'){const o={P:4,G:3,S:2,B:1,U:0};return dir*(o[b.cls]-o[a.cls]);}
    if(key==='avg') return dir*((a.avg_finish||99)-(b.avg_finish||99));
    if(key==='eff') return dir*((b.career_eff??-1)-(a.career_eff??-1));
    return dir * ((b[key]||0) - (a[key]||0));
  });
  const tbody = document.getElementById('alltime-body');
  tbody.innerHTML = data.map((d,i)=>{
    const pc = i===0?'pg':i===1?'ps':i===2?'pb':'';
    return `<tr>
      <td class="${pc}">${i+1}</td>
      <td style="font-weight:600">${d.name}</td>
      <td>${badgeHTML(d.cls)}</td>
      <td style="font-weight:600;color:${d.championships>0?'var(--simr-amber)':'var(--simr-hint)'}">${d.championships||'—'}</td>
      <td>${d.wins||0}</td><td>${d.podiums||0}</td><td>${d.top5s||0}</td><td>${d.top10s||0}</td>
      <td>${d.poles||0}</td><td>${d.fastestLaps||0}</td><td>${d.round_wins||0}</td><td>${(d.starts||0).toLocaleString()}</td>
      <td class="eff-cell" style="color:${effColor(d.cls)}">${d.career_eff!=null?d.career_eff.toFixed(1)+'%':'—'}</td>
      <td style="font-family:monospace;font-size:12px">${d.avg_finish?'P'+d.avg_finish.toFixed(1):'—'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="14" style="text-align:center;color:var(--simr-muted);padding:20px">No data</td></tr>`;
}

function sortAllTime(key) {
  if(state.allTimeSortKey===key) state.allTimeSortDir*=-1;
  else { state.allTimeSortKey=key; state.allTimeSortDir=1; }
  renderAllTimeTable();
}
function filterAllTime(val) { state.allTimeSearch=val.toLowerCase(); renderAllTimeTable(); }
function filterAllTimeClass(btn,cls) {
  document.querySelectorAll('#page-records .filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  state.allTimeClassFilter=cls;
  renderAllTimeTable();
}

// ============================================================
// ENTER RESULTS
// ============================================================
async function initEnterResults() {
  await loadEREvents();
  addResultRow();
}

async function loadEREvents() {
  const seriesId = config.series.id;
  // load all events for this series (season + special event), sorted by date desc
  const events = await dbGet('events', `series_id=eq.${seriesId}&order=event_date.desc`);
  const sel = document.getElementById('er-event-select');
  if(!sel) return;
  
  // group by season for display
  const seasons = await dbGet('seasons', `series_id=eq.${seriesId}&order=season_number.desc`);
  const seasonMap = {};
  seasons.forEach(s => seasonMap[s.id] = s.name);
  
  sel.innerHTML = '<option value="">— select event —</option>';
  
  // Season events grouped
  const seasonEvents = events.filter(e => !e.is_one_off);
  const oneOffEvents = events.filter(e => e.is_one_off);
  
  if(seasonEvents.length) {
    const og = document.createElement('optgroup');
    og.label = 'Season Events';
    seasonEvents.forEach(e => {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = `${seasonMap[e.season_id]||'?'} — ${e.name||e.track}${e.event_date?' ('+new Date(e.event_date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})+')':''}`;
      og.appendChild(opt);
    });
    sel.appendChild(og);
  }
  
  if(oneOffEvents.length) {
    const og = document.createElement('optgroup');
    og.label = 'Special Events';
    oneOffEvents.forEach(e => {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = `${e.name||e.track}${e.event_date?' ('+new Date(e.event_date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})+')':''}`;
      og.appendChild(opt);
    });
    sel.appendChild(og);
  }
  
  // reset session
  document.getElementById('er-session-type').innerHTML = '<option value="">— select event first —</option>';
  document.getElementById('er-event-info').style.display = 'none';
}

async function onEREventSelect() {
  const eventId = document.getElementById('er-event-select').value;
  const infoEl = document.getElementById('er-event-info');
  if(!eventId) {
    document.getElementById('er-session-type').innerHTML = '<option value="">— select event first —</option>';
    infoEl.style.display = 'none';
    return;
  }
  await loadSessionsForEvent(eventId);
  // show event info
  const events = await dbGet('events', `id=eq.${eventId}`);
  const ev = events[0];
  if(ev) {
    infoEl.style.display = 'block';
    infoEl.innerHTML = `${ev.track||ev.name}${ev.is_one_off?' · <span class="tag tspecial" style="font-size:10px">SPECIAL</span>':''}${ev.event_date?' · '+new Date(ev.event_date+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}):''}`;
  }
}

// loadERSeasons and old loadEREvents removed — replaced by loadEREvents above

async function loadSessionsForEvent(eventId) {
  if(!eventId) {
    document.getElementById('er-session-type').innerHTML = '<option value="">— select event first —</option>';
    return;
  }
  const sessions = await dbGet('sessions', `event_id=eq.${eventId}&order=race_number.asc`);
  if(!sessions.length) {
    document.getElementById('er-session-type').innerHTML = '<option value="">No sessions — add them in Season Setup</option>';
    return;
  }
  document.getElementById('er-session-type').innerHTML = sessions.map(s => {
    const isGrid = s.session_type === 'grid';
    const label = isGrid
      ? (s.is_qualifying ? `Q${s.race_number} — Qualifying` : `G${s.race_number} — Grid`)
      : `R${s.race_number} — Race`;
    return `<option value="${s.id}" data-session-type="${s.session_type}" data-is-qualifying="${s.is_qualifying}">${label.trim()}</option>`;
  }).join('');
  updateResultsSessionLabel();
}

function getSelectedSessionMeta() {
  const sel = document.getElementById('er-session-type');
  const opt = sel?.options[sel.selectedIndex];
  if(!opt || !opt.value) return { sessionType: null, isQualifying: false };
  return {
    sessionType: opt.dataset.sessionType || 'race',
    isQualifying: opt.dataset.isQualifying === 'true'
  };
}

function updateResultsSessionLabel() {
  const sel = document.getElementById('er-session-type');
  const opt = sel?.options[sel.selectedIndex];
  const label = document.getElementById('results-session-label');
  if(label && opt) label.textContent = (opt.text || 'Results') + ' — review before saving';

  const { sessionType, isQualifying } = getSelectedSessionMeta();

  // Update table header columns based on session type
  const thTime = document.getElementById('col-time-label');
  const thPos = document.getElementById('col-pos-label');
  const gridBuilder = document.getElementById('grid-builder-section');

  const { sessionType: sType, isQualifying: sIsQ } = getSelectedSessionMeta();
  const isGridNow = sType === 'grid' && !sIsQ;

  if(isGridNow) {
    if(thTime) thTime.style.display = 'none';
    if(thPos) thPos.textContent = 'Grid Pos';
    if(gridBuilder) gridBuilder.style.display = 'block';
    const evId = document.getElementById('er-event-select')?.value;
    if(evId) populateGridSourceSessions(evId);
  } else {
    if(thTime) { thTime.style.display = ''; thTime.textContent = 'Lap Time'; }
    if(thPos) thPos.textContent = 'Pos';
    if(gridBuilder) gridBuilder.style.display = 'none';
  }

  // Clear rows when session type changes
  document.getElementById('results-rows').innerHTML = '';
}

// setEventType removed — Special Events now created in Season Setup

function addResultRow(data) {
  const tbody = document.getElementById('results-rows');
  const pos = tbody.children.length + 1;
  const tr = document.createElement('tr');
  const driverOpts = state.currentDrivers.map(d=>`<option value="${d.id}">${d.name}</option>`).join('');

  const { sessionType, isQualifying } = getSelectedSessionMeta();
  const isRace = sessionType === 'race';
  const isGrid = sessionType === 'grid' && !isQualifying;

  tr.innerHTML = `
    <td style="padding:8px 12px"><input type="number" min="1" value="${data?.position||pos}" style="width:55px;padding:6px 8px;font-size:13px" class="rpos"></td>
    <td style="padding:8px 12px">
      <select class="rdrv" style="width:200px;padding:6px 8px;font-size:13px" onchange="checkUnmatchedDrivers();checkMultiCarAssignment()">
        <option value="">— select driver —</option>
        ${driverOpts}
      </select>
    </td>
    ${!isGrid ? `<td style="padding:8px 12px"><input type="text" placeholder="1:23.456" value="${data?.lap_time||''}" class="rtime" style="width:120px;font-family:monospace;font-size:13px;padding:6px 8px"></td>` : '<td style="display:none"><input type="text" class="rtime"></td>'}
    ${isRace ? `<td style="padding:8px 12px;text-align:center"><input type="checkbox" class="rdnf" ${data?.dnf?'checked':''}></td>` : '<td style="display:none"><input type="checkbox" class="rdnf"></td>'}
    <td style="padding:8px 12px"><span class="rstatus"></span></td>
    <td style="padding:8px 12px"><button class="btn btn-sm" onclick="this.closest('tr').remove()" style="padding:4px 10px;color:var(--simr-muted)">✕</button></td>
  `;
  // if pre-matched ID passed directly, use it
  if(data?.matched_id) {
    tr.querySelector('.rdrv').value = data.matched_id;
    const drv = state.currentDrivers.find(d=>d.id===data.matched_id);
    tr.querySelector('.rstatus').innerHTML = `<span class="status-ok">✓ ${drv?driverLabel(drv):''}</span>`;
  } else if(data?.driver_name) {
    const dl = data.driver_name.toLowerCase();
    const matched = state.currentDrivers.find(d=>{
      if(d.name.toLowerCase()===dl) return true;
      if(d.name.toLowerCase().includes(dl) || dl.includes(d.name.toLowerCase())) return true;
      if(d.aliases) return d.aliases.split(',').map(a=>a.trim().toLowerCase()).some(a=>a===dl||dl.includes(a)||a.includes(dl));
      return false;
    });
    if(matched) {
      tr.querySelector('.rdrv').value = matched.id;
      tr.querySelector('.rstatus').innerHTML = '<span class="status-ok">✓ '+driverLabel(matched)+'</span>';
    } else {
      tr.querySelector('.rstatus').innerHTML = `<span class="status-err" title="Unmatched: ${data.driver_name}">⚠ ${data.driver_name}</span>`;
      tr.dataset.unmatched = data.driver_name;
    }
  } else {
    tr.querySelector('.rstatus').innerHTML = '<span style="color:var(--simr-hint)">—</span>';
  }
  tbody.appendChild(tr);
}

function checkUnmatchedDrivers() {
  const unmatched = document.querySelectorAll('#results-rows tr[data-unmatched]');
  const banner = document.getElementById('unmatched-banner');
  if(unmatched.length > 0 && banner) {
    banner.style.display = 'block';
    banner.textContent = `⚠ ${unmatched.length} unmatched driver${unmatched.length!==1?'s':''} — select from roster before saving`;
  } else if(banner) {
    banner.style.display = 'none';
  }
}

function clearResults() {
  document.getElementById('results-rows').innerHTML = '';
  document.getElementById('ai-status').textContent = '';
  document.getElementById('ai-result').style.display = 'none';
  document.getElementById('btn-apply-ai').style.display = 'none';
  document.getElementById('img-preview').style.display = 'none';
  addResultRow();
}

async function loadGridFromSession() {
  const sourceId = document.getElementById('grid-source-session').value;
  if(!sourceId) { toast('Select a source session first', 'error'); return; }
  const [results, drivers] = await Promise.all([
    dbGet('results', `session_id=eq.${sourceId}`),
    dbGet('drivers', 'order=name')
  ]);
  state.currentDrivers = drivers;
  document.getElementById('results-rows').innerHTML = '';
  results.sort((a,b)=>a.position-b.position).forEach((r,i) => {
    addResultRow({ position: i+1, matched_id: r.driver_id });
  });
  toast('Grid loaded — reorder if needed before saving');
}

// Populate grid source session dropdown when event is selected
async function populateGridSourceSessions(eventId) {
  const sel = document.getElementById('grid-source-session');
  if(!sel) return;
  // Load all sessions across this series events
  const { sessions, events } = await getSeriesData();
  const currentEvent = events.find(e=>e.id===eventId);
  const opts = sessions
    .filter(s=>s.session_type==='race' || (s.session_type==='grid' && s.is_qualifying))
    .map(s=>{
      const ev = events.find(e=>e.id===s.event_id);
      const evName = ev?.name || 'Event';
      const sessLabel = s.session_type==='grid' ? `Q${s.race_number}` : `R${s.race_number}`;
      return `<option value="${s.id}">${evName} — ${sessLabel}</option>`;
    });
  sel.innerHTML = '<option value="">— select source session —</option>' + opts.join('');
}

async function saveResults() {
  const sessionId = document.getElementById('er-session-type').value;
  const eventId = document.getElementById('er-event-select').value;
  // check if selected event is special event
  const erEventId = document.getElementById('er-event-select').value;
  let isOneOff = false;
  if(erEventId) {
    const evCheck = await dbGet('events', `id=eq.${erEventId}`);
    isOneOff = evCheck[0]?.is_one_off || false;
  }

  if(!sessionId && !isOneOff) {
    toast('Select an event and session first', 'error'); return;
  }

  const { sessionType, isQualifying } = getSelectedSessionMeta();
  const isRace = sessionType === 'race';
  const isGridSess = sessionType === 'grid' && !isQualifying;

  const rows = document.querySelectorAll('#results-rows tr');
  const resultData = [];
  rows.forEach(row => {
    const driverId = row.querySelector('.rdrv').value;
    if(!driverId) return;
    const lapTime = row.querySelector('.rtime')?.value.trim() || null;
    resultData.push({
      driver_id: driverId,
      position: parseInt(row.querySelector('.rpos').value) || 99,
      lap_time: lapTime,
      
      grid_position: null,
      dnf: isRace ? (row.querySelector('.rdnf')?.checked || false) : false,
      fastest_lap: false
    });
  });

  // Auto-determine fastest lap from lap times for race sessions
  if(isRace) {
    const withTimes = resultData.filter(r=>r.lap_time&&!r.dnf);
    if(withTimes.length) {
      const toSecs = t => {
        if(!t) return Infinity;
        const parts = t.replace(',','.').split(':');
        return parts.length===2 ? parseFloat(parts[0])*60+parseFloat(parts[1]) : parseFloat(parts[0]);
      };
      let fastestIdx = -1, fastestSecs = Infinity;
      withTimes.forEach(r => {
        const s = toSecs(r.lap_time);
        if(!isNaN(s) && s < fastestSecs) { fastestSecs = s; fastestIdx = resultData.indexOf(r); }
      });
      if(fastestIdx >= 0) resultData[fastestIdx].fastest_lap = true;
    }
  }

  if(!resultData.length) { toast('Add at least one driver result', 'error'); return; }

  try {
    document.getElementById('save-status').textContent = 'Saving...';
    let session;

    if(sessionId) {
      // use existing pre-built session (works for both regular and special events)
      const sessArr = await dbGet('sessions', `id=eq.${sessionId}`);
      session = sessArr[0];
      if(!session) { toast('Session not found', 'error'); return; }
    } else {
      // Special Event — create event and session on the fly
      const seriesId = config.series.id;
      const eventName = document.getElementById('er-name').value.trim();
      const eventDate = document.getElementById('er-date').value;
      const circuitId = document.getElementById('er-circuit')?.value || '';
      const layoutId = document.getElementById('er-layout')?.value || '';
      const circuit = state._circuits?.find(c=>c.id===circuitId);
      const layout = state._layouts?.find(l=>l.id===layoutId);
      const track = circuit ? (circuit.name + (layout?' — '+layout.name:'')) : eventName;
      if(!track && !eventName) { toast('Enter an event name', 'error'); return; }
      const evArr = await dbPost('events', [{
        series_id: seriesId,
        season_id: null,
        name: eventName || track,
        track: track || eventName,
        circuit_layout_id: layoutId || null,
        event_date: eventDate || null,
        is_one_off: true,
        session_count: 1
      }]);
      const event = evArr[0];
      const sessArr = await dbPost('sessions', [{
        event_id: event.id,
        session_type: 'race',
        race_number: 1,
        is_qualifying: false,
        points_max: 0
      }]);
      session = sessArr[0];
    }

    // delete existing results for this session and re-save
    await dbDelete('results', `session_id=eq.${session.id}`);
    await dbPost('results', resultData.map(r => ({...r, session_id: session.id})));

    // Save multi-car assignments if applicable
    const mcWrap = document.getElementById('er-car-assign-wrap');
    if(mcWrap && mcWrap.style.display !== 'none') {
      const mcEventId = session.event_id;
      const mcEvArr = await dbGet('events', `id=eq.${mcEventId}`);
      const mcEv = mcEvArr[0];
      const useSeasonId = !mcEv?.is_one_off && mcEv?.season_id;
      const carSelects = document.querySelectorAll('[id^="mc-car-"]');
      for(const sel of carSelects) {
        const driverId = sel.id.replace('mc-car-', '');
        const carModel = sel.value || null;
        if(!driverId) continue;
        if(useSeasonId) {
          // Season multi-car event: write per season so it persists across rounds
          const ex = await dbGet('season_drivers', `season_id=eq.${mcEv.season_id}&driver_id=eq.${driverId}`);
          if(ex.length) await dbPatch('season_drivers', `season_id=eq.${mcEv.season_id}&driver_id=eq.${driverId}`, {car_model: carModel});
          else await dbPost('season_drivers', [{season_id: mcEv.season_id, driver_id: driverId, event_id: null, car_model: carModel}]);
        } else {
          // One-off event: write per event
          const ex = await dbGet('season_drivers', `event_id=eq.${mcEventId}&driver_id=eq.${driverId}`);
          if(ex.length) await dbPatch('season_drivers', `event_id=eq.${mcEventId}&driver_id=eq.${driverId}`, {car_model: carModel});
          else await dbPost('season_drivers', [{event_id: mcEventId, driver_id: driverId, season_id: null, car_model: carModel}]);
        }
      }
    }

    await refreshLiveCareerStats();
    toast(`✓ Results saved — ${resultData.length} drivers recorded`);
    document.getElementById('save-status').textContent = '';
    const mcWrapClear = document.getElementById('er-car-assign-wrap');
    if(mcWrapClear) mcWrapClear.style.display = 'none';
    clearResults();
  } catch(e) {
    console.error(e);
    toast('Error saving: ' + e.message, 'error');
    document.getElementById('save-status').textContent = '';
  }
}


// ============================================================
// SCREENSHOT DROP ZONE
// ============================================================
let aiResults = [];

function dzOver(e) { e.preventDefault(); document.getElementById('drop-zone').classList.add('over'); }
function dzLeave(e) { document.getElementById('drop-zone').classList.remove('over'); }
function dzDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('over');
  const file = e.dataTransfer.files[0];
  if(file && file.type.startsWith('image/')) processImageFile(file);
}
function handleImg(e) {
  const file = e.target.files[0];
  if(file) processImageFile(file);
}
function processImageFile(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    const b64 = ev.target.result.split(',')[1];
    const mediaType = file.type;
    const preview = document.getElementById('img-preview');
    preview.src = ev.target.result;
    preview.style.display = 'block';
    extractWithAI(b64, mediaType);
  };
  reader.readAsDataURL(file);
}

async function extractWithAI(b64, mediaType) {
  const status = document.getElementById('ai-status');
  status.innerHTML = '<span class="spinner"></span> Extracting results with AI...';
  document.getElementById('ai-result').style.display = 'none';
  document.getElementById('btn-apply-ai').style.display = 'none';

  const roster = state.currentDrivers.map(d=>d.aliases ? `${d.name} (also: ${d.aliases})` : d.name);
  const { sessionType, isQualifying } = getSelectedSessionMeta();
  const isRace = sessionType === 'race';
  const isGrid = sessionType === 'grid' && !isQualifying;
  const isQuali = sessionType === 'grid' && isQualifying;

  try {
    aiResults = await extractResultsFromImage({
      imageBase64: b64,
      mediaType: mediaType || 'image/png',
      roster,
      sessionKind: isQuali ? 'qualifying' : isGrid ? 'grid' : 'race'
    });
    document.getElementById('ai-result').textContent = JSON.stringify(aiResults, null, 2);
    document.getElementById('ai-result').style.display = 'block';
    document.getElementById('btn-apply-ai').style.display = 'inline-block';
    status.innerHTML = `<span class="status-ok">✓ Extracted ${aiResults.length} drivers</span>`;
  } catch(e) {
    status.innerHTML = `<span class="status-err">Extraction failed: ${e.message}</span>`;
  }
}

async function applyAI() {
  if(!aiResults || !aiResults.length) { toast('No extracted results to apply', 'error'); return; }
  document.getElementById('results-rows').innerHTML = '';
  aiResults.forEach(r => {
    const dl = (r.driver_name||'').toLowerCase();
    const matched = state.currentDrivers.find(d => {
      if(d.name.toLowerCase() === dl) return true;
      if(d.name.toLowerCase().includes(dl) || dl.includes(d.name.toLowerCase())) return true;
      if(d.aliases) return d.aliases.split(',').map(a=>a.trim().toLowerCase()).some(a=>a===dl||dl.includes(a)||a.includes(dl));
      return false;
    });
    addResultRow({
      position: r.position,
      driver_name: r.driver_name,
      lap_time: r.lap_time,
      dnf: r.dnf || false,
      matched_id: matched?.id || null
    });
  });
  checkUnmatchedDrivers();
  await checkMultiCarAssignment();
}

async function checkMultiCarAssignment() {
  const wrap = document.getElementById('er-car-assign-wrap');
  if(!wrap) return;
  wrap.style.display = 'none';

  const eventId = document.getElementById('er-event-select')?.value;
  if(!eventId) return;

  const evArr = await dbGet('events', `id=eq.${eventId}`);
  const ev = evArr[0];
  if(!ev?.is_multi_car) return;

  // Cars for this event — use multi_car_ids if set, else all series cars
  const carIds = JSON.parse(ev.multi_car_ids || '[]');
  const cars = carIds.length
    ? await dbGet('cars', `id=in.(${carIds.join(',')})&order=name.asc`)
    : await dbGet('cars', `series_id=eq.${state.currentSeriesId}&order=name.asc`);
  if(!cars.length) { wrap.style.display = 'none'; return; }

  // Prior assignments for auto-populate (event-level overrides season-level)
  const priorCar = {};
  if(ev.season_id) {
    const sdSeason = await dbGet('season_drivers', `season_id=eq.${ev.season_id}`);
    sdSeason.forEach(sd => { priorCar[sd.driver_id] = sd.car_model; });
  }
  const sdEv = await dbGet('season_drivers', `event_id=eq.${eventId}`);
  sdEv.forEach(sd => { priorCar[sd.driver_id] = sd.car_model; });

  // Drivers currently in the results table
  const driverEls = [...document.querySelectorAll('#results-rows tr .rdrv')]
    .map(sel => ({id: sel.value, name: sel.options[sel.selectedIndex]?.text || sel.value}))
    .filter(d => d.id);

  if(!driverEls.length) return;

  const carOpts = '<option value="">— select car —</option>'
    + cars.map(c=>`<option value="${c.name}">${c.name}</option>`).join('');

  document.getElementById('er-car-assign-list').innerHTML = driverEls.map(d =>
    `<div style="display:flex;align-items:center;gap:10px">
      <span style="font-size:13px;font-weight:600;min-width:130px">${d.name}</span>
      <select id="mc-car-${d.id}" style="background:var(--simr-surface);border:1px solid var(--simr-border);border-radius:4px;padding:5px 8px;color:var(--simr-text);font-size:12px;min-width:190px">
        ${carOpts}
      </select>
    </div>`).join('');

  // Pre-populate from prior assignments
  driverEls.forEach(d => {
    const sel = document.getElementById(`mc-car-${d.id}`);
    if(sel && priorCar[d.id]) sel.value = priorCar[d.id];
  });

  wrap.style.display = 'block';
}

// ============================================================
// SCORING CONFIG
// ============================================================
const PRESETS = {
  f1: [25,18,15,12,10,8,6,4,2,1],
  iracing: [50,40,35,32,30,28,26,24,22,20,18,16,14,12,10,8,6,4,2,1],
  simple: [10,6,4,3,2,1],
  custom100: [100,80,60,40,20,10,5,3,2,1]
};
let scoringRows = [100,80,60,40,20,10,5,3,2,1];

async function initScoring() {
  await loadSeasonSelects(['scoring-season-sel'], state.currentSeriesId);
  await loadScoringConfig();
  await loadScoringPresets();
}

async function loadScoringConfig() {
  const seasonId = document.getElementById('scoring-season-sel').value;
  if(!seasonId) return;
  const [sc, cc] = await Promise.all([
    dbGet('scoring_config', `season_id=eq.${seasonId}&order=position.asc`),
    dbGet('classification_config', `season_id=eq.${seasonId}`).then(r=>r[0]||null)
  ]);
  if(sc.length) scoringRows = sc.map(r=>r.points);
  if(cc) {
    document.getElementById('thresh-p').value = cc.platinum_threshold||72;
    document.getElementById('thresh-g').value = cc.gold_threshold||55;
    document.getElementById('thresh-s').value = cc.silver_threshold||35;
    document.getElementById('drop-enabled').checked = cc.drop_round_enabled!==false;
    state.activeThresholds = {
      p: cc.platinum_threshold || 72,
      g: cc.gold_threshold || 55,
      s: cc.silver_threshold || 35
    };
  }
  renderScoringRows();
}

function renderScoringRows() {
  document.getElementById('points-rows').innerHTML = scoringRows.map((pts,i)=>`
    <div style="display:grid;grid-template-columns:60px 1fr 80px 32px;gap:8px;align-items:center;margin-bottom:6px">
      <span style="font-size:12px;color:var(--simr-muted);font-weight:600">${i===0?'🥇 P1':i===1?'🥈 P2':i===2?'🥉 P3':'P'+(i+1)}</span>
      <div style="height:1px;background:var(--simr-border)"></div>
      <input type="number" value="${pts}" min="0" style="width:80px;font-family:monospace" onchange="scoringRows[${i}]=parseInt(this.value)||0">
      <button class="btn btn-sm" onclick="scoringRows.splice(${i},1);renderScoringRows()" style="padding:2px 6px;color:var(--simr-muted)">✕</button>
    </div>
  `).join('');
}

function addPointsRow() { scoringRows.push(0); renderScoringRows(); }
function applyPreset(key) { scoringRows = [...PRESETS[key]]; renderScoringRows(); }

async function saveScoringConfig() {
  const seasonId = document.getElementById('scoring-season-sel').value;
  if(!seasonId) { toast('Select a season first', 'error'); return; }
  try {
    await dbDelete('scoring_config', `season_id=eq.${seasonId}`);
    await dbPost('scoring_config', scoringRows.map((pts,i)=>({season_id:seasonId,position:i+1,points:pts})));
    const ccData = {
      season_id: seasonId,
      platinum_threshold: parseFloat(document.getElementById('thresh-p').value)||72,
      gold_threshold: parseFloat(document.getElementById('thresh-g').value)||55,
      silver_threshold: parseFloat(document.getElementById('thresh-s').value)||35,
      drop_round_enabled: document.getElementById('drop-enabled').checked
    };
    await dbDelete('classification_config', `season_id=eq.${seasonId}`);
    await dbPost('classification_config', [ccData]);
    document.getElementById('scoring-saved').style.display = 'inline';
    setTimeout(()=>document.getElementById('scoring-saved').style.display='none', 2000);
    toast('Scoring config saved');
  } catch(e) {
    toast('Error: '+e.message, 'error');
  }
}

// ============================================================
// SEASON SETUP
// ============================================================
async function initSeasonSetup() {
  resetEventEditor();
  toggleEvType();
  await loadSeasonSelects(['setup-ev-season'], state.currentSeriesId);
  await loadDriverRoster();
  await loadSeasonsList();
  await loadCircuitRegistry();
  await loadCircuitsIntoSelects();
  // Load entrants season selector
  await loadSeasonSelects(['entrants-season-sel'], state.currentSeriesId);
  await loadEntrantsForSeason();
  await loadCarsIntoSelects();

  // Load all one-off events (exhibitions + special) for car assignment
  const exhEvents = await dbGet('events', `series_id=eq.${state.currentSeriesId}&is_one_off=eq.true&order=event_date.desc`);
  const exhSel = document.getElementById('exhibition-event-sel');
  if(exhSel) {
    exhSel.innerHTML = '<option value="">— select event —</option>'
      + exhEvents.map(e=>{
          const typeTag = e.event_type==='exhibition' ? '🎪' : '⭐';
          return `<option value="${e.id}">${typeTag} ${e.name||e.track}</option>`;
        }).join('');
  }
}

async function loadExhibitionEntrants() {
  const eventId = document.getElementById('exhibition-event-sel')?.value;
  if(!eventId) return;
  await renderExhibitionEntrants(eventId, 'exhibition-entrants-list');
}

async function loadEntrantsForSeason() {
  const seasonId = document.getElementById('entrants-season-sel')?.value;
  if(!seasonId) return;
  await renderSeasonEntrants(seasonId, 'season-entrants-list');
}

async function loadCircuitRegistry() {
  await loadCarRegistry();
  const [circuits, layouts] = await Promise.all([
    dbGet('circuits', 'order=name'),
    dbGet('circuit_layouts', 'order=name')
  ]);
  state._circuits = circuits;
  state._layouts = layouts;

  // populate datalist for suggestions
  const dl = document.getElementById('circuit-suggestions');
  if(dl) dl.innerHTML = circuits.map(c=>`<option value="${c.name}">`).join('');

  // render registry list
  const el = document.getElementById('circuit-registry-list');
  if(!el) return;
  if(!circuits.length) { el.innerHTML = '<div style="color:var(--simr-muted);font-size:13px;padding:8px 0">No circuits yet</div>'; return; }

  // group layouts by circuit
  const layoutMap = {};
  layouts.forEach(l => {
    if(!layoutMap[l.circuit_id]) layoutMap[l.circuit_id] = [];
    layoutMap[l.circuit_id].push(l);
  });

  el.innerHTML = circuits.map(c => `
    <div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--simr-border)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span style="font-weight:600;font-size:13px">${c.name}</span>
        <span style="font-size:11px;color:var(--simr-muted)">${c.country||''}</span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${(layoutMap[c.id]||[]).map(l=>`
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;font-size:11px">
            ${l.name}
            <button onclick="deleteLayout('${l.id}')" style="background:none;border:none;color:var(--simr-hint);cursor:pointer;font-size:11px;padding:0;line-height:1">✕</button>
          </span>
        `).join('')}
      </div>
    </div>
  `).join('');
}

async function addCircuitLayout() {
  const circuitName = document.getElementById('new-circuit-name').value.trim();
  const country = document.getElementById('new-circuit-country').value.trim();
  const layoutName = document.getElementById('new-layout-name').value.trim() || 'Circuit';
  if(!circuitName) { toast('Enter a circuit name', 'error'); return; }
  try {
    // upsert circuit
    let circuit = state._circuits?.find(c=>c.name.toLowerCase()===circuitName.toLowerCase());
    if(!circuit) {
      const arr = await dbPost('circuits', [{name: circuitName, country: country||null}]);
      circuit = arr[0];
    }
    // add layout
    await dbPost('circuit_layouts', [{circuit_id: circuit.id, name: layoutName}]);
    document.getElementById('new-circuit-name').value = '';
    document.getElementById('new-circuit-country').value = '';
    document.getElementById('new-layout-name').value = '';
    await loadCircuitRegistry();
    await loadCircuitsIntoSelects();
    toast(`${circuitName} — ${layoutName} added`);
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

async function deleteLayout(id) {
  if(!confirm('Remove this layout?')) return;
  await dbDelete('circuit_layouts', `id=eq.${id}`);
  await loadCircuitRegistry();
  await loadCircuitsIntoSelects();
  toast('Layout removed');
}

async function loadCircuitsIntoSelects() {
  const circuits = state._circuits || await dbGet('circuits', 'order=name');
  // populate all circuit selects
  ['er-circuit', 'setup-ev-circuit'].forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    el.innerHTML = '<option value="">— select circuit —</option>'
      + circuits.map(c=>`<option value="${c.id}">${c.name}${c.country?' ('+c.country+')':''}</option>`).join('');
  });
}

async function loadLayoutsForCircuit(circuitSelectId, layoutSelectId) {
  const circuitId = document.getElementById(circuitSelectId)?.value;
  const layoutEl = document.getElementById(layoutSelectId);
  if(!layoutEl) return;
  if(!circuitId) { layoutEl.innerHTML = '<option value="">— select layout —</option>'; return; }
  const layouts = await dbGet('circuit_layouts', `circuit_id=eq.${circuitId}&order=name`);
  layoutEl.innerHTML = '<option value="">— select layout —</option>'
    + layouts.map(l=>`<option value="${l.id}">${l.name}</option>`).join('');
}

async function loadSeasonsList() {
  const [seasons, seriesList, events, sessions, eventGroups] = await Promise.all([
    dbGet('seasons', 'order=season_number.asc'),
    dbGet('series'),
    dbGet('events', 'order=event_date.asc'),
    dbGet('sessions'),
    dbGet('event_groups', `series_id=eq.${state.currentSeriesId}&order=created_at.asc`)
  ]);
  const seriesMap = {};
  seriesList.forEach(s => seriesMap[s.id] = s.name);

  const el = document.getElementById('seasons-list-body');
  if(!el) return;

  if(!seasons.length && !events.filter(e=>e.is_one_off).length) {
    el.innerHTML = '<div style="color:var(--simr-muted);font-size:13px;padding:8px 0">No seasons yet. Create one above.</div>';
    return;
  }

  let html = '';

  // ── Special Events section (grouped + ungrouped) ──
  const oneOffs = events.filter(e => e.is_one_off).sort((a,b) => new Date(a.event_date||0) - new Date(b.event_date||0));
  if(oneOffs.length || eventGroups.length) {
    // Build group map
    const groupMap = {};
    eventGroups.forEach(g => { groupMap[g.id] = {group: g, events: []}; });
    const ungrouped = [];
    oneOffs.forEach(ev => {
      if(ev.event_group_id && groupMap[ev.event_group_id]) groupMap[ev.event_group_id].events.push(ev);
      else ungrouped.push(ev);
    });

    const sectionId = 'oof-section';
    const totalOneOffs = oneOffs.length;
    html += `<div style="margin-bottom:12px">
      <div onclick="toggleSection('${sectionId}')" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:6px;cursor:pointer;user-select:none">
        <span id="${sectionId}-arrow" style="font-size:12px;color:var(--simr-muted)">▼</span>
        <span style="font-weight:600;font-size:13px">Special Events</span>
        <span class="tag tspecial" style="font-size:9px">SPECIAL</span>
        <span style="font-size:11px;color:var(--simr-muted);margin-left:auto">${totalOneOffs} event${totalOneOffs!==1?'s':''}</span>
      </div>
      <div id="${sectionId}" style="border:1px solid var(--simr-border);border-top:none;border-radius:0 0 6px 6px;overflow:hidden">`;

    // Render event groups first
    Object.values(groupMap).forEach(({group, events: gevs}) => {
      if(!gevs.length && !oneOffs.some(e=>e.event_group_id===group.id)) return;
      const allPublished = gevs.length > 0 && gevs.every(ev=>ev.is_published);
      const winnerName = group.round_winner_id
        ? (events.find(e=>e.id===group.round_winner_id)?.name || 'Unknown') : null;
      html += `<div style="background:var(--simr-surface2);border-bottom:1px solid var(--simr-border)">
        <div style="display:flex;align-items:center;gap:8px;padding:8px 16px">
          <span style="font-size:14px">🏅</span>
          <span style="font-weight:700;font-size:13px">${group.name}</span>
          <span style="font-size:11px;color:var(--simr-muted)">${gevs.length} event${gevs.length!==1?'s':''}</span>
          ${winnerName ? `<span style="font-size:11px;color:var(--simr-amber);margin-left:auto">🏆 ${winnerName}</span>` : ''}
          ${!allPublished && gevs.length>0 ? `<button class="btn btn-sm" onclick="endGroupModal('${group.id}')" style="font-size:10px;padding:2px 7px;color:var(--simr-amber);border-color:var(--simr-amber);margin-left:auto">🏁 End Group</button>` : ''}
        </div>
        ${gevs.map(ev => renderEventRow(ev, sessions)).join('')}
      </div>`;
    });

    // Render ungrouped events
    html += ungrouped.map(ev => renderEventRow(ev, sessions)).join('');
    html += `</div></div>`;
  }

  // ── Season sections ──
  // Sort: active/future first, then locked (completed) oldest first
  const activeSeason = seasons.filter(s => s.is_active || !s.is_locked);
  const lockedSeasons = seasons.filter(s => s.is_locked);
  const orderedSeasons = [...activeSeason, ...lockedSeasons];

  orderedSeasons.forEach(s => {
    const seasonEvents = events.filter(e => e.season_id === s.id).sort((a,b) => new Date(a.event_date||0) - new Date(b.event_date||0));
    const isCollapsed = s.is_locked; // completed seasons start collapsed
    const sectionId = `season-${s.id}`;
    const statusTag = s.is_locked
      ? '<span style="color:var(--simr-amber);font-size:11px">🏆 Complete</span>'
      : s.is_active
        ? '<span style="color:var(--simr-green);font-size:11px">● Active</span>'
        : '<span style="color:var(--simr-hint);font-size:11px">Scheduled</span>';

    html += `
      <div style="margin-bottom:12px">
        <div onclick="toggleSection('${sectionId}')" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:${isCollapsed?'6px':'6px 6px 0 0'};cursor:pointer;user-select:none">
          <span id="${sectionId}-arrow" style="font-size:12px;color:var(--simr-muted)">${isCollapsed?'▶':'▼'}</span>
          <div style="flex:1">
            <div style="font-weight:600;font-size:13px">${s.name}</div>
            <div style="font-size:11px;color:var(--simr-muted);margin-top:1px">${seriesMap[s.series_id]||''} · ${s.car_class||''}</div>
          </div>
          ${statusTag}
          <div style="display:flex;gap:4px" onclick="event.stopPropagation()">
            ${!s.is_locked ? `<button class="btn btn-sm" onclick="endSeasonModal('${s.id}')" style="font-size:10px;padding:2px 7px;color:var(--simr-amber);border-color:var(--simr-amber)">🏁 End</button>` : ''}
            <button class="btn btn-sm" onclick="editSeasonModal('${s.id}')" style="font-size:10px;padding:2px 7px">Edit</button>
            <button class="btn btn-sm" onclick="deleteSeason('${s.id}','${s.name}')" style="font-size:10px;padding:2px 7px;color:var(--simr-red)">Delete</button>
          </div>
        </div>
        <div id="${sectionId}" style="border:1px solid var(--simr-border);border-top:none;border-radius:0 0 6px 6px;overflow:hidden;display:${isCollapsed?'none':'block'}">
          ${seasonEvents.length
            ? seasonEvents.map(ev => renderEventRow(ev, sessions)).join('')
            : '<div style="padding:12px 16px;font-size:12px;color:var(--simr-hint)">No events yet — add one above</div>'
          }
        </div>
      </div>`;
  });

  el.innerHTML = html;
}

function renderEventRow(ev, sessions) {
  const evSessions = sessions.filter(s => s.event_id === ev.id);
  const sessionTags = evSessions.length
    ? evSessions.map(sess => {
        const isGrid = sess.session_type === 'grid';
        const tagCls = isGrid ? (sess.is_qualifying ? 'tquali' : 'tgrid') : 'tr1';
        const label = isGrid ? (sess.is_qualifying ? 'Q' : 'G') : 'R'+(sess.race_number||'');
        return `<span class="tag ${tagCls}" style="font-size:9px;padding:1px 5px">${label}</span>`;
      }).join(' ')
    : '<span style="color:var(--simr-hint);font-size:11px">No sessions</span>';

  const dateStr = ev.event_date
    ? new Date(ev.event_date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})
    : '';

  const isPublished = ev.is_published;
  const publishedTag = isPublished
    ? '<span style="font-size:10px;color:var(--simr-green);margin-left:4px">● Published</span>'
    : '<span style="font-size:10px;color:var(--simr-hint);margin-left:4px">○ Draft</span>';

  const endEventBtn = !isPublished && evSessions.filter(s=>s.session_type==='race').length > 0
    ? `<button class="btn btn-sm" onclick="endEventModal('${ev.id}')" style="font-size:10px;padding:2px 7px;color:var(--simr-amber);border-color:var(--simr-amber)">🏁 End</button>`
    : isPublished ? `<button class="btn btn-sm" onclick="unpublishEvent('${ev.id}')" style="font-size:10px;padding:2px 7px;color:var(--simr-hint)">Unpublish</button>` : '';

  return `<div style="display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--simr-border);background:var(--simr-surface)">
    <span style="font-size:11px;color:var(--simr-muted);width:50px;flex-shrink:0">${dateStr}</span>
    <span style="font-size:13px;font-weight:500;flex:1">📍 ${ev.name||ev.track||'Event'}${publishedTag}</span>
    <div style="display:flex;gap:3px;flex-shrink:0">${sessionTags}</div>
    <div style="display:flex;gap:4px;flex-shrink:0">
      ${endEventBtn}
      <button class="btn btn-sm" onclick="loadEventIntoEditor('${ev.id}')" style="font-size:10px;padding:2px 7px">✏ Edit</button>
      <button class="btn btn-sm" onclick="editEventSessions('${ev.id}','${(ev.name||ev.track||'Event').replace(/'/g,"\'")}',${JSON.stringify(evSessions).replace(/"/g,'&quot;')})" style="font-size:10px;padding:2px 7px">Sessions</button>
      <button class="btn btn-sm" onclick="deleteEventFromSetup('${ev.id}')" style="font-size:10px;padding:2px 7px;color:var(--simr-red)">✕</button>
    </div>
  </div>`;
}
function toggleSection(id) {
  const el = document.getElementById(id);
  const arrow = document.getElementById(id+'-arrow');
  if(!el) return;
  const isHidden = el.style.display === 'none';
  el.style.display = isHidden ? 'block' : 'none';
  if(arrow) arrow.textContent = isHidden ? '▼' : '▶';
  // fix border radius on header
  const header = el.previousElementSibling;
  if(header) header.style.borderRadius = isHidden ? '6px 6px 0 0' : '6px';
}


async function editEventSessions(eventId, eventName, existingSessions) {
  _builderEventId = eventId;
  _sequencerSlots = existingSessions.map(s => {
    const type = s.session_type === 'grid' ? (s.is_qualifying ? 'Q' : 'G') : 'R';
    const mult = s.points_max > 20 ? s.points_max / 20 : 1;
    return { type, mult };
  });
  document.getElementById('session-builder-event-name').textContent = eventName;
  document.getElementById('session-builder-card').style.display = 'block';
  document.getElementById('session-count-input').value = _sequencerSlots.length || 4;
  renderSequencer();
  document.getElementById('session-builder-card').scrollIntoView({behavior:'smooth'});
}

async function deleteEventFromSetup(eventId) {
  if(!confirm('Delete this event and all its sessions and results?')) return;
  try {
    const sessions = await dbGet('sessions', `event_id=eq.${eventId}`);
    for(const s of sessions) await dbDelete('results', `session_id=eq.${s.id}`);
    await dbDelete('sessions', `event_id=eq.${eventId}`);
    await dbDelete('events', `id=eq.${eventId}`);
    toast('Event deleted');
    await loadSeasonsList();
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

async function endSeasonModal(seasonId) {
  // Load season data and calculate final standings
  const [seasons, events, sessions, results, scoringConfig, classConfigArr, drivers] = await Promise.all([
    dbGet('seasons', `id=eq.${seasonId}`),
    dbGet('events', `season_id=eq.${seasonId}&order=event_date.asc`),
    dbGet('sessions'),
    dbGet('results'),
    dbGet('scoring_config', `season_id=eq.${seasonId}`),
    dbGet('classification_config', `season_id=eq.${seasonId}`),
    dbGet('drivers', 'order=name')
  ]);

  const season = seasons[0];
  const classConfig = classConfigArr[0] || null;
  const careerMap = {};
  const standings = calcStandings(seasonId, results, sessions, events, scoringConfig, classConfig, careerMap);
  const leader = standings[0];
  const champion = leader ? drivers.find(d=>d.id===leader.driver_id) : null;

  const modal = document.createElement('div');
  modal.id = 'end-season-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:var(--simr-surface);border:1px solid var(--simr-border);border-radius:8px;padding:24px;width:100%;max-width:480px">
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:32px;margin-bottom:8px">🏆</div>
        <div style="font-size:18px;font-weight:600;margin-bottom:4px">End season — ${season?.name}</div>
        <div style="font-size:13px;color:var(--simr-muted)">This will crown the champion and lock the season</div>
      </div>

      <div style="background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:6px;padding:16px;margin-bottom:16px">
        <div style="font-size:11px;color:var(--simr-muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">Final standings</div>
        ${standings.slice(0,5).map((d,i)=>{
          const drv = drivers.find(dr=>dr.id===d.driver_id);
          return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--simr-border);font-size:13px">
            <span style="${i===0?'color:#d4a820;font-weight:600':i===1?'color:#8a9aaa':i===2?'color:#c07030':'color:var(--simr-muted)'};width:20px">${i+1}</span>
            <span style="flex:1;font-weight:${i===0?'600':'400'}">${driverLabel(drv)}</span>
            <span style="font-weight:600">${d.adjustedPts} pts</span>
            ${i===0?'<span style="color:var(--simr-amber);font-size:11px">← Champion</span>':''}
          </div>`;
        }).join('')}
      </div>

      <div style="background:#1e1800;border:1px solid #6a4800;border-radius:6px;padding:14px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:600;color:var(--simr-amber);margin-bottom:4px">🏆 Champion: ${champion?driverLabel(champion):'Unknown'}</div>
        <div style="font-size:12px;color:var(--simr-muted)">${leader?.adjustedPts||0} points · ${leader?.wins||0} wins · ${leader?.eff!==null?leader.eff.toFixed(1)+'% efficiency':'—'}</div>
      </div>

      <div style="margin-bottom:16px">
        <label class="form-label">Override champion (if different from standings)</label>
        <select id="end-champion-select" style="width:100%">
          ${drivers.map(d=>`<option value="${d.id}" ${d.id===champion?.id?'selected':''}>${driverLabel(d)}</option>`).join('')}
        </select>
      </div>

      <div style="display:flex;gap:8px">
        <button class="btn btn-red" style="flex:1" onclick="confirmEndSeason('${seasonId}')">🏁 Crown champion & end season</button>
        <button class="btn" onclick="document.getElementById('end-season-modal').remove()">Cancel</button>
      </div>
      <div id="end-season-status" style="font-size:12px;color:var(--simr-muted);margin-top:8px;text-align:center"></div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function confirmEndSeason(seasonId) {
  const championId = document.getElementById('end-champion-select').value;
  const status = document.getElementById('end-season-status');
  status.textContent = 'Ending season...';

  try {
    // Lock the season and record champion
    await dbPatch('seasons', `id=eq.${seasonId}`, {
      is_locked: true,
      is_active: false,
      champion_driver_id: championId
    });

    // Increment championship count on the driver
    const drivers = await dbGet('drivers', `id=eq.${championId}`);
    const driver = drivers[0];
    if(driver) {
      await dbPatch('drivers', `id=eq.${championId}`, {
        championships: (driver.championships || 0) + 1
      });
    }

    document.getElementById('end-season-modal').remove();
    toast(`Season ended — ${driverLabel(driver)} crowned champion! 🏆`);
    await loadSeasonsList();
    state.currentDrivers = await dbGet('drivers', 'order=name');
  } catch(e) {
    status.textContent = 'Error: ' + e.message;
    toast('Error: ' + e.message, 'error');
  }
}

async function editSeasonModal(seasonId) {
  const seasons = await dbGet('seasons', `id=eq.${seasonId}`);
  const season = seasons[0];
  if(!season) return;

  const modal = document.createElement('div');
  modal.id = 'season-edit-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:var(--simr-surface);border:1px solid var(--simr-border);border-radius:8px;padding:20px;width:100%;max-width:480px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div style="font-size:15px;font-weight:600">Edit season</div>
        <button class="btn btn-sm" onclick="document.getElementById('season-edit-modal').remove()">Close</button>
      </div>
      <div style="margin-bottom:10px"><label class="form-label">Season name</label><input type="text" id="sedit-name" value="${season.name}" style="width:100%"></div>
      <div style="margin-bottom:10px"><label class="form-label">Season number</label><input type="number" id="sedit-num" value="${season.season_number||''}" style="width:120px"></div>
      <div style="margin-bottom:14px"><label class="form-label">Car / class</label><input type="text" id="sedit-car" value="${season.car_class||''}" style="width:100%"></div>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin-bottom:16px">
        <input type="checkbox" id="sedit-active" ${season.is_active?'checked':''}> Set as active season
      </label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-red btn-sm" onclick="saveSeasonEdit('${seasonId}')">Save changes</button>
        <button class="btn btn-sm" onclick="document.getElementById('season-edit-modal').remove()">Cancel</button>
      </div>
      <div id="sedit-status" style="font-size:12px;color:var(--simr-muted);margin-top:8px"></div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function saveSeasonEdit(seasonId) {
  const name = document.getElementById('sedit-name').value.trim();
  const num = parseInt(document.getElementById('sedit-num').value)||1;
  const car = document.getElementById('sedit-car').value.trim();
  const isActive = document.getElementById('sedit-active').checked;
  if(!name) { document.getElementById('sedit-status').textContent = 'Name required'; return; }
  try {
    // if setting active, deactivate others in same series first
    if(isActive) {
      const seasons = await dbGet('seasons', `id=eq.${seasonId}`);
      if(seasons[0]) await dbPatch('seasons', `series_id=eq.${seasons[0].series_id}`, {is_active: false});
    }
    await dbPatch('seasons', `id=eq.${seasonId}`, {name, season_number: num, car_class: car, is_active: isActive});
    document.getElementById('season-edit-modal').remove();
    toast('Season updated');
    await loadSeasonsList();
    await loadSeasonSelects(['setup-ev-season','dash-season-sel','standings-season-sel','events-season-sel','scoring-season-sel','rec-season-sel'], state.currentSeriesId);
  } catch(e) {
    document.getElementById('sedit-status').textContent = 'Error: '+e.message;
  }
}

async function deleteSeason(id, name) {
  if(!confirm(`Delete "${name}" and ALL its events, sessions, and results? This cannot be undone.`)) return;
  try {
    // cascade delete — events → sessions → results all cascade from season
    const events = await dbGet('events', `season_id=eq.${id}`);
    for(const ev of events) {
      const sessions = await dbGet('sessions', `event_id=eq.${ev.id}`);
      for(const sess of sessions) {
        await dbDelete('results', `session_id=eq.${sess.id}`);
      }
      await dbDelete('sessions', `event_id=eq.${ev.id}`);
    }
    await dbDelete('events', `season_id=eq.${id}`);
    await dbDelete('scoring_config', `season_id=eq.${id}`);
    await dbDelete('classification_config', `season_id=eq.${id}`);
    await dbDelete('seasons', `id=eq.${id}`);
    toast(`Season "${name}" deleted`);
    await loadSeasonsList();
    await loadSeasonSelects(['setup-ev-season','dash-season-sel','standings-season-sel','events-season-sel','scoring-season-sel','rec-season-sel'], state.currentSeriesId);
  } catch(e) {
    toast('Error deleting season: '+e.message, 'error');
  }
}

async function loadDriverRoster() {
  const drivers = await dbGet('drivers', 'order=name');
  state.currentDrivers = drivers;
  document.getElementById('driver-roster-body').innerHTML = drivers.length
    ? drivers.map(d=>`<tr>
        <td style="font-size:12px;color:var(--simr-muted)">${d.name}</td>
        <td style="font-weight:600">${d.display_name||'<span style="color:var(--simr-hint)">—</span>'}</td>
        <td>${d.car_number||'—'}</td>
        <td style="font-size:11px;color:var(--simr-muted);max-width:180px">${d.aliases||'<span style="color:var(--simr-hint)">none</span>'}</td>
        <td style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn-sm" onclick="editDriverModal('${d.id}')" style="font-size:11px;padding:3px 8px">Edit</button>
          <button class="btn btn-sm" onclick="openStatsModal('${d.id}','${(d.display_name||d.name).replace(/'/g,String.fromCharCode(39))}')" style="font-size:11px;padding:3px 8px;color:var(--simr-amber)">Stats</button>
          <button class="btn btn-sm" onclick="deleteDriver('${d.id}')" style="color:var(--simr-red);font-size:11px;padding:3px 8px">Remove</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="5" style="text-align:center;color:var(--simr-muted);padding:16px">No drivers yet</td></tr>';
}

async function addDriver() {
  const name = document.getElementById('new-driver-name').value.trim();
  if(!name) { toast('Enter a gamertag', 'error'); return; }
  const display_name = document.getElementById('new-driver-display').value.trim()||null;
  try {
    await dbPost('drivers', [{name, display_name, car_number: document.getElementById('new-driver-num').value.trim()||null}]);
    document.getElementById('new-driver-name').value = '';
    document.getElementById('new-driver-display').value = '';
    document.getElementById('new-driver-num').value = '';
    await loadDriverRoster();
    state.currentDrivers = await dbGet('drivers','order=name');
    toast(`${display_name||name} added`);
  } catch(e) { toast('Error: '+e.message+' (name may already exist)', 'error'); }
}

async function editDriverModal(driverId) {
  const driver = state.currentDrivers.find(d=>d.id===driverId);
  if(!driver) return;
  const modal = document.createElement('div');
  modal.id = 'driver-edit-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:var(--simr-surface);border:1px solid var(--simr-border);border-radius:8px;padding:20px;width:100%;max-width:480px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div style="font-size:15px;font-weight:600">Edit driver</div>
        <button class="btn btn-sm" onclick="document.getElementById('driver-edit-modal').remove()">Close</button>
      </div>
      <div style="margin-bottom:12px">
        <label class="form-label">Gamertag (match key — used for screenshot extraction)</label>
        <input type="text" id="dedit-name" value="${driver.name}" style="width:100%">
      </div>
      <div style="margin-bottom:12px">
        <label class="form-label">Display name (shown in UI — leave blank to use gamertag)</label>
        <input type="text" id="dedit-display" value="${driver.display_name||''}" placeholder="Leave blank to use gamertag" style="width:100%">
      </div>
      <div style="margin-bottom:12px">
        <label class="form-label">Car number</label>
        <input type="text" id="dedit-num" value="${driver.car_number||''}" style="width:100px">
      </div>
      <div style="margin-bottom:16px">
        <label class="form-label">Aliases (comma separated — alternate names AI might read)</label>
        <input type="text" id="dedit-aliases" value="${driver.aliases||''}" placeholder="AltTag1, OldGamertag" style="width:100%">
        <div style="font-size:11px;color:var(--simr-muted);margin-top:4px">Add any alternate spellings or old gamertags the AI might extract from screenshots</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-red btn-sm" onclick="saveDriverEdit('${driverId}')">Save changes</button>
        <button class="btn btn-sm" onclick="document.getElementById('driver-edit-modal').remove()">Cancel</button>
      </div>
      <div id="dedit-status" style="font-size:12px;color:var(--simr-muted);margin-top:8px"></div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function saveDriverEdit(driverId) {
  const name = document.getElementById('dedit-name').value.trim();
  const display_name = document.getElementById('dedit-display').value.trim()||null;
  const car_number = document.getElementById('dedit-num').value.trim()||null;
  const aliases = document.getElementById('dedit-aliases').value.trim()||null;
  if(!name) { document.getElementById('dedit-status').textContent = 'Gamertag required'; return; }
  try {
    await dbPatch('drivers', `id=eq.${driverId}`, {name, display_name, car_number, aliases});
    state.currentDrivers = await dbGet('drivers','order=name');
    document.getElementById('driver-edit-modal').remove();
    await loadDriverRoster();
    toast('Driver updated');
  } catch(e) {
    document.getElementById('dedit-status').textContent = 'Error: '+e.message;
  }
}

async function deleteDriver(id) {
  if(!confirm('Remove this driver?')) return;
  await dbDelete('drivers', `id=eq.${id}`);
  await loadDriverRoster();
  toast('Driver removed');
}

async function createSeason() {
  const name = document.getElementById('setup-name').value.trim();
  const num = parseInt(document.getElementById('setup-num').value);
  const car = document.getElementById('setup-car').value.trim();
  const seriesId = config.series.id;
  const isActive = document.getElementById('setup-active').checked;
  if(!name) { toast('Enter a season name', 'error'); return; }
  try {
    if(isActive) await dbPatch('seasons', `series_id=eq.${seriesId}`, {is_active:false});
    await dbPost('seasons', [{series_id:seriesId, name, season_number:num||1, car_class:car, is_active:isActive}]);
    await loadSeasonSelects(['setup-ev-season','dash-season-sel','standings-season-sel','events-season-sel','scoring-season-sel','rec-season-sel'], seriesId);
    document.getElementById('setup-name').value = '';
    document.getElementById('setup-num').value = '';
    document.getElementById('setup-car').value = '';
    toast(`Season "${name}" created`);
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

// Track current event being built
let _builderEventId = null;
let _builderSessions = []; // [{type, is_qualifying, race_number}]
// Sequencer state: array of slot types, null=empty, 'Q'=qualifying, 'G'=grid, 'R'=race
let _sequencerSlots = [];

function toggleSetupSpecial() { toggleEvType(); } // legacy compat

async function createSeasonEvent() {
  const isOneOff = document.getElementById('setup-ev-special').checked;
  const seasonId = isOneOff ? null : document.getElementById('setup-ev-season').value;
  if(!isOneOff && !seasonId) { toast('Select a season first', 'error'); return; }

  const eventType = isOneOff
    ? (document.querySelector('input[name="setup-ev-type"]:checked')?.value || 'special')
    : 'season';

  const circuitId = document.getElementById('setup-ev-circuit')?.value || '';
  const layoutId = document.getElementById('setup-ev-layout')?.value || '';
  const name = document.getElementById('setup-ev-name').value.trim();
  const date = document.getElementById('setup-ev-date').value;

  if(!circuitId && !name) { 
    toast('Select a circuit or enter an event name', 'error'); 
    return; 
  }

  try {
    let season = null;
    if(seasonId) {
      const seasons = await dbGet('seasons', `id=eq.${seasonId}`);
      season = seasons[0];
      if(!season) { toast('Season not found', 'error'); return; }
    }

    const circuit = state._circuits?.find(c=>c.id===circuitId);
    const layout = state._layouts?.find(l=>l.id===layoutId);
    const trackDisplay = circuit 
      ? (circuit.name + (layout && layout.name !== 'Circuit' ? ' — '+layout.name : '')) 
      : name;

    const carId = document.getElementById('setup-ev-car')?.value || null;
    const evArr = await dbPost('events', [{
      season_id: seasonId,
      series_id: season ? season.series_id : state.currentSeriesId,
      name: name || trackDisplay,
      track: trackDisplay,
      circuit_layout_id: layoutId || null,
      car_id: carId || null,
      event_date: date || null,
      is_one_off: isOneOff,
      event_type: eventType,
      session_count: 0
    }]);

    _builderEventId = evArr[0].id;
    _builderSessions = [];
    _sequencerSlots = [];

    // show session sequencer
    document.getElementById('session-builder-event-name').textContent = name || trackDisplay;
    document.getElementById('session-builder-card').style.display = 'block';
    document.getElementById('session-builder-status').textContent = '';
    renderSequencer();

    // clear form
    if(document.getElementById('setup-ev-circuit')) document.getElementById('setup-ev-circuit').value = '';
    if(document.getElementById('setup-ev-layout')) document.getElementById('setup-ev-layout').value = '';
    document.getElementById('setup-ev-name').value = '';
    document.getElementById('setup-ev-date').value = '';
    document.getElementById('setup-ev-special').checked = false;
    toggleSetupSpecial();

    toast(`Event "${name||trackDisplay}" created — now build its sessions below`);
    await loadSeasonsList();
  } catch(e) { 
    console.error('createEvent error:', e);
    toast('Error creating event: ' + e.message, 'error'); 
  }
}

// Sequencer - called when event is created
function renderSequencer() {
  const count = parseInt(document.getElementById('session-count-input')?.value) || 4;
  while(_sequencerSlots.length < count) _sequencerSlots.push({type:null, mult:1});
  _sequencerSlots = _sequencerSlots.slice(0, count);
  // Ensure all slots are objects
  _sequencerSlots = _sequencerSlots.map(s => typeof s === 'string' ? {type:s, mult:1} : (s||{type:null,mult:1}));

  const el = document.getElementById('sequencer-slots');
  if(!el) return;

  el.innerHTML = _sequencerSlots.map((slot, i) => {
    const type = slot.type;
    const mult = slot.mult || 1;
    const tagCls = type==='Q'?'tquali':type==='G'?'tgrid':type==='R'?'tr1':'';
    const label = type || '?';
    const style = type ? '' : 'background:var(--simr-surface2);border:1px dashed var(--simr-border2);color:var(--simr-hint);';
    const isMultiLayout = document.getElementById('multi-layout-toggle')?.checked;
    const selectedCircuitId = document.getElementById('setup-ev-circuit')?.value;
    const layouts = selectedCircuitId
      ? (state._layouts || []).filter(l => l.circuit_id === selectedCircuitId)
      : (state._layouts || []);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px">
      <button onclick="cycleSlot(${i})" style="width:52px;height:52px;border-radius:6px;font-size:14px;font-weight:700;cursor:pointer;transition:all .15s;letter-spacing:.06em;${type?'':style}" class="${type?'tag '+tagCls:''}" title="Click to cycle type">${label}</button>
      ${type==='R'?`<select onchange="_sequencerSlots[${i}].mult=parseFloat(this.value);updateSequencerPreview()" style="width:52px;font-size:11px;padding:2px 4px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;color:var(--simr-text)">
        <option value="1" ${mult===1?'selected':''}>1x</option>
        <option value="1.5" ${mult===1.5?'selected':''}>1.5x</option>
        <option value="2" ${mult===2?'selected':''}>2x</option>
        <option value="3" ${mult===3?'selected':''}>3x</option>
      </select>`:'<div style="height:22px"></div>'}
      ${isMultiLayout&&type?`<select onchange="_sequencerSlots[${i}].layoutId=this.value" style="width:80px;font-size:10px;padding:2px 3px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;color:var(--simr-text);margin-top:2px">
        <option value="">— layout —</option>
        ${layouts.map(l=>`<option value="${l.id}" ${slot.layoutId===l.id?'selected':''}>${l.name}</option>`).join('')}
      </select>`:''}
    </div>`;
  }).join('');

  updateSequencerPreview();
}

function cycleSlot(idx) {
  const cycle = [null, 'Q', 'G', 'R'];
  const cur = _sequencerSlots[idx]?.type || null;
  const nextIdx = (cycle.indexOf(cur) + 1) % cycle.length;
  _sequencerSlots[idx] = {type: cycle[nextIdx], mult: _sequencerSlots[idx]?.mult || 1};
  renderSequencer();
}

function updateSequencerPreview() {
  const el = document.getElementById('sequencer-preview');
  if(!el) return;
  const filled = _sequencerSlots.filter(s=>s?.type);
  if(!filled.length) { el.textContent = 'Click slots above to assign session types'; return; }
  let rn=1, gn=1, qn=1;
  const labels = _sequencerSlots.map(s => {
    if(!s?.type) return '—';
    const mult = s.mult && s.mult !== 1 ? ` (${s.mult}x)` : '';
    if(s.type==='Q') return `Qualifying${qn>1?' '+qn++:' '+(qn++,'')}`;
    if(s.type==='G') return `Grid ${gn++}`;
    if(s.type==='R') return `Race ${rn++}${mult}`;
  });
  el.innerHTML = '<strong style="color:var(--simr-text)">Session order:</strong> ' + labels.filter(l=>l!=='—').join(' → ');
}

function buildSessionsFromSequencer() {
  let rn=1, gn=1;
  // Read multiplier values directly from DOM selects to ensure latest values
  const selects = document.querySelectorAll('#sequencer-slots select');
  let selectIdx = 0;
  _builderSessions = _sequencerSlots.filter(s=>s?.type).map((slot, i) => {
    const type = slot.type;
    // Find the select for this slot if it's a race
    let mult = slot.mult || 1;
    if(type === 'R') {
      // find the select in the rendered slots
      const slotDivs = document.querySelectorAll('#sequencer-slots > div');
      if(slotDivs[i]) {
        const sel = slotDivs[i].querySelector('select');
        if(sel) mult = parseFloat(sel.value) || 1;
      }
    }
    const pointsMax = type === 'R' ? Math.round(20 * mult) : 0;
    if(type==='Q') return {type:'grid', is_qualifying:true, race_number:gn++, points_max:0, layoutId:slot.layoutId||null};
    if(type==='G') return {type:'grid', is_qualifying:false, race_number:gn++, points_max:0, layoutId:slot.layoutId||null};
    if(type==='R') return {type:'race', is_qualifying:false, race_number:rn++, points_max:pointsMax, layoutId:slot.layoutId||null};
  }).filter(Boolean);
}

async function saveSessionBuilder() {
  if(!_builderEventId) { toast('No event selected', 'error'); return; }
  buildSessionsFromSequencer();
  if(!_builderSessions.length) { toast('Add at least one session', 'error'); return; }
  const status = document.getElementById('session-builder-status');
  status.textContent = 'Saving...';
  try {
    // delete any existing sessions for this event first
    const existing = await dbGet('sessions', `event_id=eq.${_builderEventId}`);
    for(const s of existing) {
      await dbDelete('results', `session_id=eq.${s.id}`);
    }
    await dbDelete('sessions', `event_id=eq.${_builderEventId}`);
    // get points_max from scoring config
    const ev = await dbGet('events', `id=eq.${_builderEventId}`).then(r=>r[0]);
    let pointsMax = 20;
    if(ev?.season_id) {
      const sc = await dbGet('scoring_config', `season_id=eq.${ev.season_id}&position=eq.1`);
      if(sc.length) pointsMax = sc[0].points;
    }
    // insert sessions — use points_max from buildSessionsFromSequencer which includes multiplier
    await dbPost('sessions', _builderSessions.map(s => ({
      event_id: _builderEventId,
      session_type: s.type,
      race_number: s.race_number,
      is_qualifying: s.is_qualifying,
      points_max: s.points_max !== undefined ? s.points_max : (s.type==='race' ? pointsMax : 0),
      circuit_layout_id: s.layoutId || null
    })));
    // update event session_count
    await dbPatch('events', `id=eq.${_builderEventId}`, {session_count: _builderSessions.length});
    toast(`${_builderSessions.length} sessions saved`);
    cancelSessionBuilder();
    await loadSeasonsList();
  } catch(e) {
    status.textContent = 'Error: '+e.message;
    toast('Error: '+e.message, 'error');
  }
}

async function endEventModal(eventId) {
  const [events, sessions, results, scoringConfig, drivers] = await Promise.all([
    dbGet('events', `id=eq.${eventId}`),
    dbGet('sessions', `event_id=eq.${eventId}`),
    dbGet('results'),
    dbGet('scoring_config'),
    dbGet('drivers', 'order=name')
  ]);
  const ev = events[0];
  if(!ev) return;

  const raceSessions = sessions.filter(s=>s.session_type==='race');
  // For special events use active season's scoring config, or most recent
  let seasonScoring = ev.season_id ? scoringConfig.filter(sc=>sc.season_id===ev.season_id) : [];
  if(!seasonScoring.length) {
    const fallbackSeasons = await dbGet('seasons', `series_id=eq.${state.currentSeriesId}&order=season_number.desc`);
    const fallbackId = fallbackSeasons[0]?.id || null;
    if(fallbackId) seasonScoring = scoringConfig.filter(sc=>sc.season_id===fallbackId);
  }

  // Calculate round totals per driver
  const driverTotals = {};
  raceSessions.forEach(sess => {
    const baseP1Ev = seasonScoring.length ? seasonScoring[0].points : 20;
    const multEv = baseP1Ev > 0 ? (sess.points_max || 20) / baseP1Ev : 1;
    const sessResults = results.filter(r=>r.session_id===sess.id);
    sessResults.forEach(r => {
      if(!driverTotals[r.driver_id]) driverTotals[r.driver_id] = 0;
      if(!r.dnf) {
        const sc = seasonScoring.find(s=>s.position===r.position);
        driverTotals[r.driver_id] += Math.round((sc?.points||0) * multEv);
      }
    });
  });

  const sorted = Object.entries(driverTotals).sort((a,b)=>b[1]-a[1]);
  const winnerId = sorted[0]?.[0];
  const winner = drivers.find(d=>d.id===winnerId);

  const modal = document.createElement('div');
  modal.id = 'end-event-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:var(--simr-surface);border:1px solid var(--simr-border);border-radius:8px;padding:24px;width:100%;max-width:480px">
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:28px;margin-bottom:8px">🏁</div>
        <div style="font-size:18px;font-weight:600;margin-bottom:4px">End Event — ${ev.name||ev.track}</div>
        <div style="font-size:13px;color:var(--simr-muted)">This will crown the round winner and publish results</div>
      </div>
      <div style="background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:6px;padding:14px;margin-bottom:16px">
        <div style="font-size:11px;color:var(--simr-muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">Round totals</div>
        ${sorted.slice(0,5).map(([dId,pts],i)=>{
          const drv = drivers.find(d=>d.id===dId);
          return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--simr-border);font-size:13px">
            <span style="${i===0?'color:#d4a820;font-weight:600':i===1?'color:#8a9aaa':i===2?'color:#c07030':'color:var(--simr-muted)'};width:20px">${i+1}</span>
            <span style="flex:1;font-weight:${i===0?'600':'400'}">${driverLabel(drv)}</span>
            <span style="font-weight:600">${pts} pts</span>
            ${i===0?'<span style="color:var(--simr-amber);font-size:11px">← Round winner</span>':''}
          </div>`;
        }).join('')}
      </div>
      <div style="background:#1e1800;border:1px solid #6a4800;border-radius:6px;padding:14px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:600;color:var(--simr-amber);margin-bottom:4px">🏆 Round winner: ${winner?driverLabel(winner):'Unknown'}</div>
        <div style="font-size:12px;color:var(--simr-muted)">${sorted[0]?.[1]||0} points across ${raceSessions.length} race${raceSessions.length!==1?'s':''}</div>
      </div>
      <div style="margin-bottom:16px">
        <label class="form-label">Override round winner if needed</label>
        <select id="end-event-winner-select" style="width:100%">
          ${drivers.map(d=>`<option value="${d.id}" ${d.id===winnerId?'selected':''}>${driverLabel(d)}</option>`).join('')}
        </select>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-red" style="flex:1" onclick="confirmEndEvent('${eventId}')">🏁 Crown winner & publish</button>
        <button class="btn" onclick="document.getElementById('end-event-modal').remove()">Cancel</button>
      </div>
      <div id="end-event-status" style="font-size:12px;color:var(--simr-muted);margin-top:8px;text-align:center"></div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function confirmEndEvent(eventId) {
  const winnerId = document.getElementById('end-event-winner-select').value;
  const status = document.getElementById('end-event-status');
  status.textContent = 'Publishing...';
  try {
    // Mark event as published with round winner
    await dbPatch('events', `id=eq.${eventId}`, {
      is_published: true,
      round_winner_id: winnerId
    });
    // Increment round_wins in career_stats
    // Find which series this event belongs to
    const evArr = await dbGet('events', `id=eq.${eventId}`);
    const ev = evArr[0];
    if(ev && winnerId) {
      const csArr = await dbGet('career_stats', `driver_id=eq.${winnerId}&series_id=eq.${ev.series_id}`);
      if(csArr.length) {
        await dbPatch('career_stats', `driver_id=eq.${winnerId}&series_id=eq.${ev.series_id}`, {
          round_wins: (csArr[0].round_wins || 0) + 1
        });
      } else {
        await dbPost('career_stats', [{
          driver_id: winnerId,
          series_id: ev.series_id,
          round_wins: 1
        }]);
      }
    }
    document.getElementById('end-event-modal').remove();

    // Check if this event belongs to a group — if all group events published, calculate group winner
    if(ev?.event_group_id) {
      const groupEvents = await dbGet('events', `event_group_id=eq.${ev.event_group_id}`);
      const allPublished = groupEvents.every(ge => ge.is_published);
      if(allPublished && groupEvents.length > 1) {
        // Compute combined standings for the group
        const groupSessions = await dbGet('sessions');
        const groupResults = await dbGet('results');
        const groupEvIds = new Set(groupEvents.map(ge=>ge.id));
        const gSessions = groupSessions.filter(s=>groupEvIds.has(s.event_id)&&s.session_type==='race');
        const gSessionIds = new Set(gSessions.map(s=>s.id));
        const gResults = groupResults.filter(r=>gSessionIds.has(r.session_id));
        const gScConfigs = await dbGet('scoring_config', `event_id=in.(${groupEvents.map(ge=>ge.id).join(',')})`);
        const gScMap = {};
        gScConfigs.forEach(sc => { if(!gScMap[sc.event_id]) gScMap[sc.event_id] = []; gScMap[sc.event_id].push(sc); });
        // Sum points per driver — DNF-aware via shared helper
        const driverPts = {};
        gSessions.forEach(sess => {
          const sc = gScMap[sess.event_id] || [];
          const baseMax = sc.length ? sc[0].points : 20;
          const sessResultsAll = gResults.filter(r=>r.session_id===sess.id);
          const sessMap = calcSessionPointsMap(sess, sessResultsAll, sc, baseMax);
          Object.entries(sessMap).forEach(([dId,pt])=>{ driverPts[dId] = (driverPts[dId]||0) + pt; });
        });
        const groupWinnerId = Object.entries(driverPts).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;
        if(groupWinnerId) {
          await dbPatch('event_groups', `id=eq.${ev.event_group_id}`, {round_winner_id: groupWinnerId});
          toast('Event published — group complete! 🏅 Group winner crowned!');
        } else {
          toast('Event published — round winner crowned! 🏁');
        }
      } else {
        toast('Event published — round winner crowned! 🏁');
      }
    } else {
      toast('Event published — round winner crowned! 🏁');
    }

    await refreshLiveCareerStats();
    await loadSeasonsList();
  } catch(e) {
    status.textContent = 'Error: ' + e.message;
    toast('Error: ' + e.message, 'error');
  }
}

async function endGroupModal(groupId) {
  const groupArr = await dbGet('event_groups', `id=eq.${groupId}`);
  const group = groupArr[0];
  if(!group) return;

  // Compute combined standings for the group
  const groupEvents = await dbGet('events', `event_group_id=eq.${groupId}`);
  const allSessions = await dbGet('sessions');
  const allResults = await dbGet('results');
  const drivers = state.currentDrivers || await dbGet('drivers', 'order=name');
  const gEvIds = new Set(groupEvents.map(e=>e.id));
  const gSessions = allSessions.filter(s=>gEvIds.has(s.event_id)&&s.session_type==='race');
  const gSessionIds = new Set(gSessions.map(s=>s.id));
  const gResults = allResults.filter(r=>gSessionIds.has(r.session_id));
  const gScConfigs = await dbGet('scoring_config', `event_id=in.(${groupEvents.map(e=>e.id).join(',')})`);
  const gScMap = {};
  gScConfigs.forEach(sc => { if(!gScMap[sc.event_id]) gScMap[sc.event_id] = []; gScMap[sc.event_id].push(sc); });
  const driverPts = {};
  gSessions.forEach(sess => {
    const sc = gScMap[sess.event_id] || [];
    const baseMax = sc.length ? sc[0].points : 20;
    const sessResultsAll = gResults.filter(r=>r.session_id===sess.id);
    const sessMap = calcSessionPointsMap(sess, sessResultsAll, sc, baseMax);
    Object.entries(sessMap).forEach(([dId,pt])=>{ driverPts[dId] = (driverPts[dId]||0) + pt; });
  });
  const sortedDrivers = Object.entries(driverPts).sort((a,b)=>b[1]-a[1]);

  const modal = document.createElement('div');
  modal.id = 'end-group-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `<div class="card" style="width:420px;max-height:80vh;overflow-y:auto">
    <div class="card-title">🏅 End Group — ${group.name}</div>
    <div style="font-size:12px;color:var(--simr-muted);margin-bottom:14px">Combined standings across all events in this group</div>
    <table style="table-layout:auto;font-size:13px;margin-bottom:14px">
      <thead><tr><th>Pos</th><th>Driver</th><th style="text-align:right">Pts</th></tr></thead>
      <tbody>${sortedDrivers.map(([dId,pts],i)=>{
        const drv = drivers.find(d=>d.id===dId);
        return `<tr><td style="color:${i===0?'#d4a820':i===1?'#8a9aaa':i===2?'#c07030':'var(--simr-muted)'};font-weight:600">${i+1}</td><td style="font-weight:600">${driverLabel(drv)}</td><td style="text-align:right;font-weight:700;color:var(--simr-amber)">${pts}</td></tr>`;
      }).join('')}</tbody>
    </table>
    <div style="margin-bottom:12px">
      <label class="form-label">Group winner</label>
      <select id="end-group-winner-select" style="width:100%">
        ${sortedDrivers.map(([dId,pts],i)=>{
          const drv = drivers.find(d=>d.id===dId);
          return `<option value="${dId}"${i===0?' selected':''}>${driverLabel(drv)} (${pts} pts)</option>`;
        }).join('')}
      </select>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-red" onclick="confirmEndGroup('${groupId}')">🏅 Crown Group Winner</button>
      <button class="btn" onclick="document.getElementById('end-group-modal').remove()">Cancel</button>
    </div>
    <div id="end-group-status" style="font-size:12px;color:var(--simr-muted);margin-top:8px"></div>
  </div>`;
  document.body.appendChild(modal);
}

async function confirmEndGroup(groupId) {
  const winnerId = document.getElementById('end-group-winner-select').value;
  const status = document.getElementById('end-group-status');
  if(!winnerId) { toast('Select a winner', 'error'); return; }
  status.textContent = 'Saving...';
  try {
    await dbPatch('event_groups', `id=eq.${groupId}`, {round_winner_id: winnerId});
    // Increment round_wins in career_stats for group winner
    const grpArr = await dbGet('event_groups', `id=eq.${groupId}`);
    const grp = grpArr[0];
    if(grp) {
      const csArr = await dbGet('career_stats', `driver_id=eq.${winnerId}&series_id=eq.${grp.series_id}`);
      if(csArr.length) await dbPatch('career_stats', `driver_id=eq.${winnerId}&series_id=eq.${grp.series_id}`, {round_wins: (csArr[0].round_wins||0)+1});
      else await dbPost('career_stats', [{driver_id: winnerId, series_id: grp.series_id, round_wins: 1}]);
    }
    document.getElementById('end-group-modal').remove();
    await refreshLiveCareerStats();
    toast('🏅 Group winner crowned!');
    await loadSeasonsList();
  } catch(e) { status.textContent = 'Error: '+e.message; }
}

async function unpublishEvent(eventId) {
  if(!confirm('Unpublish this event? Results will be hidden from public view until republished.')) return;
  try {
    await dbPatch('events', `id=eq.${eventId}`, {is_published: false, round_winner_id: null});
    toast('Event unpublished');
    await loadSeasonsList();
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

function cancelSessionBuilder() {
  _builderEventId = null;
  _builderSessions = [];
  _sequencerSlots = [];
  document.getElementById('session-builder-card').style.display = 'none';
}

// CSV Import
let csvParsed = [];
function previewCSV(e) {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const lines = ev.target.result.trim().split('\n');
    const headers = lines[0].split(',').map(h=>h.trim().replace(/"/g,''));
    csvParsed = lines.slice(1).map(line => {
      const vals = line.split(',').map(v=>v.trim().replace(/"/g,''));
      const obj = {};
      headers.forEach((h,i) => obj[h] = vals[i]||'');
      return obj;
    }).filter(r=>r[headers[0]]);

    document.getElementById('csv-preview-label').textContent = `${csvParsed.length} drivers found`;
    document.getElementById('csv-count').textContent = csvParsed.length;
    const thead = document.querySelector('#csv-preview-table thead');
    const tbody = document.querySelector('#csv-preview-table tbody');
    thead.innerHTML = `<tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr>`;
    tbody.innerHTML = csvParsed.slice(0,5).map(row=>`<tr>${headers.map(h=>`<td>${row[h]||''}</td>`).join('')}</tr>`).join('');
    document.getElementById('csv-preview').style.display = 'block';
  };
  reader.readAsText(file);
}

async function importCSV() {
  const seriesId = config.series.id;
  if(!csvParsed.length) return;
  let imported = 0; let errors = 0;
  for(const row of csvParsed) {
    const name = row['Driver'] || row['driver'] || Object.values(row)[0];
    if(!name) continue;
    try {
      // upsert driver
      let driver = state.currentDrivers.find(d=>d.name.toLowerCase()===name.toLowerCase());
      if(!driver) {
        const arr = await dbPost('drivers', [{name}]);
        driver = arr[0];
      }
      // upsert career stats
      await dbDelete('career_stats', `driver_id=eq.${driver.id}&series_id=eq.${seriesId}`);
      await dbPost('career_stats', [{
        driver_id: driver.id,
        series_id: seriesId,
        starts: parseInt(row['Starts']||row['starts'])||0,
        wins: parseInt(row['Wins']||row['wins'])||0,
        podiums: parseInt(row['Podiums']||row['podiums'])||0,
        top5s: parseInt(row['Top5s']||row['Top5']||row['top5s'])||0,
        top10s: parseInt(row['Top10s']||row['Top10']||row['top10s'])||0,
        poles: parseInt(row['Poles']||row['poles'])||0,
        round_wins: parseInt(row['RoundWins']||row['Rd Wins']||row['round_wins'])||0,
        championships: parseInt(row['Championships']||row['Champs']||row['championships'])||0
      }]);
      imported++;
    } catch(e) { console.error('Import error for',name,e); errors++; }
  }
  await loadDriverRoster();
  state.currentDrivers = await dbGet('drivers','order=name');
  toast(`Imported ${imported} drivers${errors?', '+errors+' errors':''}`);
  document.getElementById('csv-preview').style.display = 'none';
  document.getElementById('csv-input').value = '';
  csvParsed = [];
}

// ============================================================
// ADMIN AUTH
// ============================================================
async function doLogin() {
  const pw = document.getElementById('admin-pw').value;
  try {
    await loginWithSharedPassword(pw);
    state.isAdmin = true;
    document.getElementById('login-err').style.display = 'none';
    document.getElementById('admin-pw').value = '';
    // update admin button appearance
    const btn = document.getElementById('admin-menu-btn');
    btn.className = 'admin-btn logged-in';
    btn.innerHTML = '⚙ Admin ▾';
    // show logged-in menu state
    document.getElementById('admin-logged-in').style.display = 'block';
    document.getElementById('admin-logged-out').style.display = 'none';
    closeAdminMenu();
    navTo(document.querySelector('.nvb'), 'dashboard');
    toast('Signed in as admin');
  } catch {
    document.getElementById('login-err').style.display = 'block';
  }
}

// ============================================================
// SESSION EDIT / DELETE
// ============================================================
async function editSession(sessionId, evId) {
  const [sessArr, resultsArr, driversArr] = await Promise.all([
    dbGet('sessions', `id=eq.${sessionId}`),
    dbGet('results', `session_id=eq.${sessionId}`),
    dbGet('drivers', 'order=name')
  ]);
  const sess = sessArr[0];
  if(!sess) return;
  const driverOpts = driversArr.map(d=>`<option value="${d.id}">${driverLabel(d)}</option>`).join('');
  const modal = document.createElement('div');
  modal.id = 'edit-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:999;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow-y:auto';
  modal._driverOpts = driverOpts;
  modal.innerHTML = `
    <div style="background:var(--simr-surface);border:1px solid var(--simr-border);border-radius:8px;padding:20px;width:100%;max-width:700px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div style="font-weight:600;font-size:15px">Edit session</div>
        <button class="btn btn-sm" onclick="document.getElementById('edit-modal').remove()">Close</button>
      </div>
      <div style="overflow-x:auto;margin-bottom:12px">
        <table style="table-layout:auto">
          <thead><tr>
            <th style="width:45px">Pos</th><th>Driver</th><th style="width:95px">Time</th>
            <th style="width:45px">Grid</th><th style="width:40px">DNF</th>
            <th style="width:35px">FL</th><th style="width:32px"></th>
          </tr></thead>
          <tbody id="edit-rows"></tbody>
        </table>
      </div>
      <button class="btn btn-sm" onclick="addEditRow()" style="margin-bottom:12px">+ Add driver</button>
      <div style="display:flex;gap:8px">
        <button class="btn btn-red" onclick="saveEditedSession('${sessionId}','${evId}')">Save changes</button>
        <button class="btn" onclick="document.getElementById('edit-modal').remove()">Cancel</button>
      </div>
      <div id="edit-status" style="font-size:12px;color:var(--simr-muted);margin-top:8px"></div>
    </div>`;
  document.body.appendChild(modal);
  const tbody = document.getElementById('edit-rows');
  resultsArr.sort((a,b)=>a.position-b.position).forEach(r => {
    const tr = document.createElement('tr');
    tr.dataset.resultId = r.id;
    tr.innerHTML = `
      <td><input type="number" min="1" value="${r.position||''}" style="width:45px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;padding:4px 6px;color:var(--simr-text)" class="ep"></td>
      <td><select style="width:150px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;padding:4px 8px;color:var(--simr-text)" class="ed"><option value="">— select —</option>${driverOpts}</select></td>
      <td><input type="text" value="${r.lap_time||''}" style="width:90px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;padding:4px 8px;color:var(--simr-text);font-family:monospace;font-size:12px" class="et" placeholder="1:23.456"></td>
      <td><input type="number" min="1" value="${r.grid_position||''}" style="width:45px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;padding:4px 6px;color:var(--simr-text)" class="egrid"></td>
      <td><input type="checkbox" class="ednf" ${r.dnf?'checked':''}></td>
      <td><input type="checkbox" class="edfl" ${r.fastest_lap?'checked':''} onclick="enforceEditFL(this)"></td>
      <td><button class="btn btn-sm" onclick="this.closest('tr').remove()" style="padding:2px 6px;color:var(--simr-muted)">✕</button></td>`;
    tbody.appendChild(tr);
    tr.querySelector('.ed').value = r.driver_id;
  });
}

function enforceEditFL(cb) {
  if(cb.checked) document.querySelectorAll('#edit-rows .edfl').forEach(c=>{ if(c!==cb) c.checked=false; });
}

function addEditRow() {
  const modal = document.getElementById('edit-modal');
  const driverOpts = modal._driverOpts || '';
  const tbody = document.getElementById('edit-rows');
  const tr = document.createElement('tr');
  tr.dataset.resultId = 'new';
  tr.innerHTML = `
    <td><input type="number" min="1" style="width:45px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;padding:4px 6px;color:var(--simr-text)" class="ep"></td>
    <td><select style="width:150px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;padding:4px 8px;color:var(--simr-text)" class="ed"><option value="">— select —</option>${driverOpts}</select></td>
    <td><input type="text" style="width:90px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;padding:4px 8px;color:var(--simr-text);font-family:monospace;font-size:12px" class="et"></td>
    <td><input type="number" min="1" style="width:45px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;padding:4px 6px;color:var(--simr-text)" class="egrid"></td>
    <td><input type="checkbox" class="ednf"></td>
    <td><input type="checkbox" class="edfl" onclick="enforceEditFL(this)"></td>
    <td><button class="btn btn-sm" onclick="this.closest('tr').remove()" style="padding:2px 6px;color:var(--simr-muted)">✕</button></td>`;
  tbody.appendChild(tr);
}

async function saveEditedSession(sessionId, evId) {
  const rows = document.querySelectorAll('#edit-rows tr');
  const newResults = [];
  rows.forEach(row => {
    const driverId = row.querySelector('.ed').value;
    if(!driverId) return;
    newResults.push({
      session_id: sessionId,
      driver_id: driverId,
      position: parseInt(row.querySelector('.ep').value)||99,
      lap_time: row.querySelector('.et').value.trim()||null,
      grid_position: parseInt(row.querySelector('.egrid')?.value)||null,
      dnf: row.querySelector('.ednf').checked,
      fastest_lap: row.querySelector('.edfl')?.checked||false
    });
  });
  if(!newResults.length) { toast('No results to save','error'); return; }
  try {
    document.getElementById('edit-status').textContent = 'Saving...';
    await dbDelete('results', `session_id=eq.${sessionId}`);
    await dbPost('results', newResults);
    document.getElementById('edit-modal').remove();
    await refreshLiveCareerStats();
    toast('Session updated');
    const freshResults = await dbGet('results');
    _resultsData.results = freshResults;
    if(evId) await showEventDetail(evId, _resultsData.events, _resultsData.sessions, freshResults);
  } catch(e) {
    document.getElementById('edit-status').textContent = 'Error: '+e.message;
  }
}

async function deleteSession(sessionId, evId) {
  if(!confirm('Delete this session and all its results?')) return;
  try {
    await dbDelete('results', `session_id=eq.${sessionId}`);
    await dbDelete('sessions', `id=eq.${sessionId}`);
    toast('Session deleted');
    await refreshLiveCareerStats();
    const [freshSessions, freshResults] = await Promise.all([dbGet('sessions'), dbGet('results')]);
    _resultsData.sessions = freshSessions;
    _resultsData.results = freshResults;
    if(evId) await showEventDetail(evId, _resultsData.events, freshSessions, freshResults);
  } catch(e) { toast('Error: '+e.message,'error'); }
}

// ============================================================
// DRIVER STATS MODAL (legacy floor values)
// ============================================================
async function openStatsModal(driverId, driverName) {
  document.getElementById('stats-modal-driver-name').textContent = driverName;
  document.getElementById('stats-modal-driver-id').value = driverId;
  document.getElementById('stats-modal-series-id').value = state.currentSeriesId;
  document.getElementById('stats-modal-status').textContent = '';

  // Load existing career stats
  const csArr = await dbGet('career_stats', `driver_id=eq.${driverId}&series_id=eq.${state.currentSeriesId}`);
  const cs = csArr[0] || {};
  document.getElementById('stats-championships').value = cs.championships || 0;
  document.getElementById('stats-round-wins').value = cs.round_wins || 0;
  document.getElementById('stats-poles').value = cs.poles || 0;
  document.getElementById('stats-wins').value = cs.wins || 0;
  document.getElementById('stats-podiums').value = cs.podiums || 0;
  document.getElementById('stats-starts').value = cs.starts || 0;

  const modal = document.getElementById('driver-stats-modal');
  modal.style.display = 'flex';
}

function closeStatsModal() {
  document.getElementById('driver-stats-modal').style.display = 'none';
}

async function saveDriverStats() {
  const driverId = document.getElementById('stats-modal-driver-id').value;
  const seriesId = document.getElementById('stats-modal-series-id').value;
  const status = document.getElementById('stats-modal-status');
  const payload = {
    driver_id: driverId,
    series_id: seriesId,
    championships: parseInt(document.getElementById('stats-championships').value)||0,
    round_wins: parseInt(document.getElementById('stats-round-wins').value)||0,
    poles: parseInt(document.getElementById('stats-poles').value)||0,
    wins: parseInt(document.getElementById('stats-wins').value)||0,
    podiums: parseInt(document.getElementById('stats-podiums').value)||0,
    starts: parseInt(document.getElementById('stats-starts').value)||0
  };
  try {
    status.textContent = 'Saving...';
    // Check if row exists
    const existing = await dbGet('career_stats', `driver_id=eq.${driverId}&series_id=eq.${seriesId}`);
    if(existing.length) {
      await dbPatch('career_stats', `driver_id=eq.${driverId}&series_id=eq.${seriesId}`, payload);
    } else {
      await dbPost('career_stats', [payload]);
    }
    // Update driver championships on drivers table
    await dbPatch('drivers', `id=eq.${driverId}`, {championships: payload.championships});
    await refreshLiveCareerStats();
    closeStatsModal();
    toast('Legacy stats saved');
  } catch(e) {
    status.textContent = 'Error: ' + e.message;
  }
}

// ============================================================
// SEASON DRIVERS (car/class assignment)
// ============================================================
async function loadSeasonDrivers(seasonId) {
  const [seasonDrivers, drivers, results, sessions, events] = await Promise.all([
    dbGet('season_drivers', `season_id=eq.${seasonId}`),
    dbGet('drivers', 'order=name'),
    dbGet('results'),
    dbGet('sessions'),
    dbGet('events', `season_id=eq.${seasonId}`)
  ]);

  // Find drivers who have results in this season
  const evIds = new Set(events.map(e=>e.id));
  const sessIds = new Set(sessions.filter(s=>evIds.has(s.event_id)).map(s=>s.id));
  const activeDriverIds = new Set(results.filter(r=>sessIds.has(r.session_id)).map(r=>r.driver_id));
  const sdMap = {};
  seasonDrivers.forEach(sd => sdMap[sd.driver_id] = sd);

  const activeDrivers = drivers.filter(d=>activeDriverIds.has(d.id));

  return { activeDrivers, sdMap, seasonDrivers };
}

async function renderSeasonEntrants(seasonId, containerId) {
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML = '<div class="loading">Loading entrants...</div>';

  const { activeDrivers, sdMap } = await loadSeasonDrivers(seasonId);

  if(!activeDrivers.length) {
    el.innerHTML = '<div style="color:var(--simr-muted);font-size:12px;padding:8px 0">No results entered yet for this season</div>';
    return;
  }

  el.innerHTML = `<table style="table-layout:auto">
    <thead><tr><th>Driver</th><th>Car</th><th>Class</th><th></th></tr></thead>
    <tbody>${activeDrivers.map(d => {
      const sd = sdMap[d.id] || {};
      return `<tr>
        <td style="font-weight:600">${driverLabel(d)}</td>
        <td><input type="text" value="${sd.car_model||''}" placeholder="e.g. Mazda Miata" style="width:150px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;padding:4px 8px;color:var(--simr-text);font-size:12px" id="car-model-${d.id}"></td>
        <td><input type="text" value="${sd.car_class||''}" placeholder="optional" style="width:100px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;padding:4px 8px;color:var(--simr-text);font-size:12px" id="car-class-${d.id}"></td>
        <td><button class="btn btn-sm" onclick="saveSeasonDriver('${seasonId}','${d.id}')" style="font-size:10px;padding:2px 8px">Save</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

async function saveSeasonDriver(seasonId, driverId) {
  const carModel = document.getElementById(`car-model-${driverId}`)?.value.trim() || null;
  const carClass = document.getElementById(`car-class-${driverId}`)?.value.trim() || null;
  try {
    const existing = await dbGet('season_drivers', `season_id=eq.${seasonId}&driver_id=eq.${driverId}`);
    if(existing.length) {
      await dbPatch('season_drivers', `season_id=eq.${seasonId}&driver_id=eq.${driverId}`, {car_model: carModel, car_class: carClass});
    } else {
      await dbPost('season_drivers', [{season_id: seasonId, driver_id: driverId, car_model: carModel, car_class: carClass}]);
    }
    toast('Saved');
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

// ============================================================
// EVENT NAME EDITING
// ============================================================
async function editEventName(eventId, currentName) {
  const newName = prompt('Rename event:', currentName);
  if(newName === null) return; // cancelled
  if(!newName.trim()) { toast('Name cannot be empty', 'error'); return; }
  try {
    await dbPatch('events', `id=eq.${eventId}`, {name: newName.trim()});
    toast('Event renamed');
    await loadSeasonsList();
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

// ============================================================
// SCORING PRESETS (saved for reuse)
// ============================================================
async function saveScorePreset() {
  const name = prompt('Name this scoring preset:');
  if(!name?.trim()) return;
  const preset = { name: name.trim(), rows: scoringRows };
  try {
    // Store in admin_config table as JSON
    await dbPost('admin_config', [{key: 'scoring_preset_'+Date.now(), value: JSON.stringify(preset)}]);
    toast('Preset saved: '+name.trim());
    await loadScoringPresets();
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

async function loadScoringPresets() {
  const presets = await dbGet('admin_config', `key=like.scoring_preset_*`);
  const parsed = presets.map(p => {
    try { return {key: p.key, ...JSON.parse(p.value)}; }
    catch { return null; }
  }).filter(Boolean);

  // Render on scoring page
  const scoringBtns = document.getElementById('saved-preset-btns');
  if(scoringBtns) {
    if(!parsed.length) {
      scoringBtns.innerHTML = '<span style="font-size:12px;color:var(--simr-hint)">No saved presets yet</span>';
    } else {
      scoringBtns.innerHTML = parsed.map(p =>
        `<div style="display:inline-flex;align-items:center;gap:0;border:1px solid var(--simr-border);border-radius:4px;overflow:hidden">
          <button class="btn btn-sm" onclick="applyScoredPresetByKey('${p.key}')" style="border:none;border-radius:0;border-right:1px solid var(--simr-border)">${p.name}</button>
          <button class="btn btn-sm" onclick="deleteScorePreset('${p.key}')" style="border:none;border-radius:0;padding:4px 7px;color:var(--simr-muted)" title="Delete preset">✕</button>
        </div>`).join('');
    }
  }

  // Render in event creator
  const evBtns = document.getElementById('ev-saved-preset-btns');
  if(evBtns) {
    evBtns.innerHTML = parsed.map(p =>
      `<button class="btn btn-sm" type="button" onclick="renderEvScoringRows(${JSON.stringify(p.rows)})">${p.name}</button>`
    ).join('');
  }
}

async function applyScoredPresetByKey(key) {
  const arr = await dbGet('admin_config', `key=eq.${key}`);
  if(!arr.length) return;
  try {
    const preset = JSON.parse(arr[0].value);
    scoringRows = preset.rows;
    renderScoringRows();
    toast('Preset loaded: ' + preset.name);
  } catch(e) { toast('Error loading preset', 'error'); }
}

async function deleteScorePreset(key) {
  if(!confirm('Delete this preset?')) return;
  try {
    await dbDelete('admin_config', `key=eq.${key}`);
    toast('Preset deleted');
    await loadScoringPresets();
  } catch(e) { toast('Error deleting preset', 'error'); }
}

// ============================================================
// EXHIBITION CAR ASSIGNMENT
// ============================================================
async function renderExhibitionEntrants(eventId, containerId) {
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML = '<div class="loading">Loading...</div>';

  const [results, sessions, drivers, seasonDrivers] = await Promise.all([
    dbGet('results'),
    dbGet('sessions', `event_id=eq.${eventId}`),
    dbGet('drivers', 'order=name'),
    dbGet('season_drivers', `event_id=eq.${eventId}`)
  ]);

  const sessIds = new Set(sessions.map(s=>s.id));
  const activeDriverIds = new Set(results.filter(r=>sessIds.has(r.session_id)).map(r=>r.driver_id));
  const sdMap = {};
  seasonDrivers.forEach(sd => sdMap[sd.driver_id] = sd);
  const activeDrivers = drivers.filter(d=>activeDriverIds.has(d.id));

  if(!activeDrivers.length) {
    el.innerHTML = '<div style="color:var(--simr-muted);font-size:12px">No results entered yet for this event</div>';
    return;
  }

  el.innerHTML = `<table style="table-layout:auto">
    <thead><tr><th>Driver</th><th>Car</th><th></th></tr></thead>
    <tbody>${activeDrivers.map(d => {
      const sd = sdMap[d.id] || {};
      return `<tr>
        <td style="font-weight:600">${driverLabel(d)}</td>
        <td><input type="text" value="${sd.car_model||''}" placeholder="e.g. Toyota Altezza" style="width:180px;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:3px;padding:4px 8px;color:var(--simr-text);font-size:12px" id="ex-car-${d.id}"></td>
        <td><button class="btn btn-sm" onclick="saveExhibitionDriver('${eventId}','${d.id}')" style="font-size:10px">Save</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

async function saveExhibitionDriver(eventId, driverId) {
  const carModel = document.getElementById(`ex-car-${driverId}`)?.value.trim() || null;
  try {
    const existing = await dbGet('season_drivers', `event_id=eq.${eventId}&driver_id=eq.${driverId}`);
    if(existing.length) {
      await dbPatch('season_drivers', `event_id=eq.${eventId}&driver_id=eq.${driverId}`, {car_model: carModel});
    } else {
      await dbPost('season_drivers', [{event_id: eventId, driver_id: driverId, season_id: null, car_model: carModel}]);
    }
    toast('Saved');
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

// ============================================================
// CAR REGISTRY
// ============================================================
async function loadCarRegistry() {
  const cars = await dbGet('cars', `series_id=eq.${state.currentSeriesId}&order=name.asc`);
  state.currentCars = cars;
  const el = document.getElementById('car-registry-list');
  if(!el) return;

  if(!cars.length) {
    el.innerHTML = '<div style="color:var(--simr-muted);font-size:13px;padding:8px 0">No cars yet — add one above</div>';
    return;
  }

  el.innerHTML = `<table style="table-layout:auto">
    <thead><tr><th>Car</th><th>Class / Era</th><th></th></tr></thead>
    <tbody>${cars.map(c=>`<tr>
      <td style="font-weight:600">${c.name}</td>
      <td style="color:var(--simr-muted);font-size:12px">${c.class||'—'}</td>
      <td style="display:flex;gap:4px">
        <button class="btn btn-sm" onclick="editCar('${c.id}','${c.name.replace(/'/g,String.fromCharCode(39))}','${(c.class||'').replace(/'/g,String.fromCharCode(39))}')" style="font-size:11px;padding:2px 8px">Edit</button>
        <button class="btn btn-sm" onclick="deleteCar('${c.id}')" style="font-size:11px;padding:2px 8px;color:var(--simr-red)">Delete</button>
      </td>
    </tr>`).join('')}</tbody>
  </table>`;

  // Update car selects everywhere
  await loadCarsIntoSelects();
}

async function addCar() {
  const name = document.getElementById('new-car-name').value.trim();
  if(!name) { toast('Enter a car name', 'error'); return; }
  const carClass = document.getElementById('new-car-class').value.trim() || null;
  try {
    await dbPost('cars', [{series_id: state.currentSeriesId, name, class: carClass}]);
    document.getElementById('new-car-name').value = '';
    document.getElementById('new-car-class').value = '';
    await loadCarRegistry();
    toast('Car added');
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

async function editCar(id, currentName, currentClass) {
  const name = prompt('Car name:', currentName);
  if(name === null) return;
  const carClass = prompt('Class / era:', currentClass);
  if(carClass === null) return;
  try {
    await dbPatch('cars', `id=eq.${id}`, {name: name.trim(), class: carClass.trim()||null});
    await loadCarRegistry();
    toast('Car updated');
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

async function deleteCar(id) {
  if(!confirm('Delete this car?')) return;
  try {
    await dbDelete('cars', `id=eq.${id}`);
    await loadCarRegistry();
    toast('Car deleted');
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

async function loadCarsIntoSelects() {
  const cars = state.currentCars || await dbGet('cars', `series_id=eq.${state.currentSeriesId}&order=name.asc`);
  const opts = '<option value="">— select car —</option>' + cars.map(c=>`<option value="${c.id}">${c.name}${c.class?' ('+c.class+')':''}</option>`).join('');
  document.querySelectorAll('.car-select').forEach(sel => { sel.innerHTML = opts; });
}

// ============================================================
// UNIFIED EVENT EDITOR
// ============================================================
function toggleEvType() {
  const type = document.querySelector('input[name="ev-type"]:checked')?.value || 'season';
  const seasonWrap = document.getElementById('ev-season-wrap');
  if(seasonWrap) seasonWrap.style.display = type === 'season' ? 'block' : 'none';
  const scoringWrap = document.getElementById('ev-scoring-wrap');
  if(scoringWrap) scoringWrap.style.display = type !== 'season' ? 'block' : 'none';
  if(type !== 'season') loadScoringPresets();
  const groupWrap = document.getElementById('ev-group-wrap');
  if(groupWrap) groupWrap.style.display = type !== 'season' ? 'block' : 'none';
  if(type !== 'season') loadEventGroupsDropdown();
  document.getElementById('setup-ev-name').placeholder =
    type === 'season' ? 'Round 1' : type === 'special' ? 'Altezza Cup, ANZAC Race...' : 'Test Race, Fun Run...';
}

function toggleEvGroupMode() {
  const mode = document.querySelector('input[name="ev-group-mode"]:checked')?.value || 'none';
  document.getElementById('ev-group-new-wrap').style.display = mode === 'new' ? 'block' : 'none';
  document.getElementById('ev-group-existing-wrap').style.display = mode === 'existing' ? 'block' : 'none';
}

async function loadEventGroupsDropdown() {
  const sel = document.getElementById('ev-group-select');
  if(!sel) return;
  const groups = await dbGet('event_groups', `series_id=eq.${state.currentSeriesId}&order=created_at.desc`);
  sel.innerHTML = '<option value="">— select group —</option>'
    + groups.map(g=>`<option value="${g.id}">${g.name}</option>`).join('');
}

function resetEventEditor() {
  document.getElementById('ev-editor-id').value = '';
  document.getElementById('event-editor-title').textContent = 'New Event';
  document.querySelector('input[name="ev-type"][value="season"]').checked = true;
  toggleEvType();
  document.getElementById('setup-ev-season').value = '';
  document.getElementById('setup-ev-name').value = '';
  document.getElementById('setup-ev-date').value = '';
  document.getElementById('setup-ev-circuit').value = '';
  document.getElementById('setup-ev-layout').innerHTML = '<option value="">— select layout —</option>';
  document.getElementById('setup-ev-car').value = '';
  document.getElementById('setup-ev-notes').value = '';
  // Reset car mode to single
  const singleRadio = document.querySelector('input[name="ev-car-mode"][value="single"]');
  if(singleRadio) { singleRadio.checked = true; toggleCarMode(); }
  // Reset multi-layout toggle
  const mlReset = document.getElementById('multi-layout-toggle');
  if(mlReset) mlReset.checked = false;
  // Clear event scoring
  const evScoreEl = document.getElementById('ev-scoring-rows');
  if(evScoreEl) evScoreEl.innerHTML = '<div style="color:var(--simr-hint);font-size:12px">Select a preset above or load from existing event</div>';
  // Reset group
  const noneRadio = document.querySelector('input[name="ev-group-mode"][value="none"]');
  if(noneRadio) { noneRadio.checked = true; toggleEvGroupMode(); }
  const groupNameEl = document.getElementById('ev-group-name');
  if(groupNameEl) groupNameEl.value = '';
  _sequencerSlots = [];
  renderSequencer();
  document.getElementById('ev-editor-status').textContent = '';
}

function toggleCarMode() {
  const mode = document.querySelector('input[name="ev-car-mode"]:checked')?.value || 'single';
  const sw = document.getElementById('ev-car-single-wrap');
  const mw = document.getElementById('ev-car-multi-wrap');
  if(sw) sw.style.display = mode === 'single' ? '' : 'none';
  if(mw) mw.style.display = mode === 'multi' ? '' : 'none';
  if(mode === 'multi') loadMultiCarCheckboxes([]);
}

async function loadMultiCarCheckboxes(selectedIds=[]) {
  const el = document.getElementById('ev-multi-car-checks');
  if(!el) return;
  const cars = state.currentCars?.length ? state.currentCars : await dbGet('cars', `series_id=eq.${state.currentSeriesId}&order=name.asc`);
  if(!cars.length) { el.innerHTML = '<div style="color:var(--simr-hint);font-size:12px">No cars in registry — add them in Track & Car Registry</div>'; return; }
  el.innerHTML = cars.map(c => `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
    <input type="checkbox" value="${c.id}" ${selectedIds.includes(c.id)?'checked':''} class="multi-car-chk" style="width:auto;accent-color:var(--simr-red)">
    <span>${c.name}${c.class?' <span style="font-size:11px;color:var(--simr-muted)">('+c.class+')</span>':''}</span>
  </label>`).join('');
}

function getMultiCarIds() {
  return [...document.querySelectorAll('.multi-car-chk:checked')].map(el=>el.value);
}

function applyEvScorePreset(preset) {
  const pts = PRESETS[preset];
  if(!pts) return;
  renderEvScoringRows(pts);
}

function renderEvScoringRows(pts=[]) {
  const el = document.getElementById('ev-scoring-rows');
  if(!el) return;
  if(!pts.length) {
    el.innerHTML = '<div style="color:var(--simr-hint);font-size:12px">Select a preset above</div>';
    return;
  }
  el.innerHTML = `<table style="table-layout:fixed;width:180px;font-size:12px;border-collapse:collapse">
    <thead><tr><th style="text-align:left;padding:3px 8px;width:50px">Pos</th><th style="text-align:left;padding:3px 8px">Points</th></tr></thead>
    <tbody>${pts.map((p,i)=>`<tr>
      <td style="padding:2px 8px;color:var(--simr-muted)">P${i+1}</td>
      <td style="padding:2px 8px"><input type="number" value="${p}" min="0" class="ev-score-input" data-pos="${i+1}" style="width:65px;background:var(--simr-surface);border:1px solid var(--simr-border);border-radius:3px;padding:2px 6px;color:var(--simr-text);font-size:12px"></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function getEvScoringRows() {
  return [...document.querySelectorAll('.ev-score-input')]
    .map(inp => ({position: parseInt(inp.dataset.pos), points: parseInt(inp.value)||0}))
    .filter(r => r.points > 0);
}

async function loadEventIntoEditor(eventId) {
  const [evArr, sessions] = await Promise.all([
    dbGet('events', `id=eq.${eventId}`),
    dbGet('sessions', `event_id=eq.${eventId}&order=race_number.asc`)
  ]);
  const ev = evArr[0];
  if(!ev) return;

  document.getElementById('ev-editor-id').value = eventId;
  document.getElementById('event-editor-title').textContent = 'Edit: ' + (ev.name||ev.track||'Event');

  // Set type
  const type = ev.event_type || (ev.is_one_off ? 'special' : 'season');
  const radioEl = document.querySelector(`input[name="ev-type"][value="${type}"]`);
  if(radioEl) radioEl.checked = true;
  toggleEvType();

  // Set season
  if(ev.season_id) document.getElementById('setup-ev-season').value = ev.season_id;

  // Set fields
  document.getElementById('setup-ev-name').value = ev.name || '';
  document.getElementById('setup-ev-date').value = ev.event_date || '';
  document.getElementById('setup-ev-notes').value = ev.director_notes || '';

  // Set circuit/layout
  if(ev.circuit_layout_id) {
    const layoutArr = await dbGet('circuit_layouts', `id=eq.${ev.circuit_layout_id}`);
    const layout = layoutArr[0];
    if(layout) {
      document.getElementById('setup-ev-circuit').value = layout.circuit_id;
      await loadLayoutsForCircuit('setup-ev-circuit', 'setup-ev-layout');
      document.getElementById('setup-ev-layout').value = ev.circuit_layout_id;
    }
  }

  // Set car mode
  if(ev.is_multi_car) {
    const multiRadio = document.querySelector('input[name="ev-car-mode"][value="multi"]');
    if(multiRadio) { multiRadio.checked = true; toggleCarMode(); }
    const selectedIds = JSON.parse(ev.multi_car_ids || '[]');
    await loadMultiCarCheckboxes(selectedIds);
  } else {
    const singleRadio = document.querySelector('input[name="ev-car-mode"][value="single"]');
    if(singleRadio) { singleRadio.checked = true; toggleCarMode(); }
    if(ev.car_id) document.getElementById('setup-ev-car').value = ev.car_id;
  }

  // Rebuild sequencer from existing sessions
  const hasMultiLayout = sessions.some(s=>s.circuit_layout_id);
  const mlToggle = document.getElementById('multi-layout-toggle');
  if(mlToggle) mlToggle.checked = hasMultiLayout;
  _sequencerSlots = sessions.map(s => ({
    type: s.session_type === 'grid' ? (s.is_qualifying ? 'Q' : 'G') : 'R',
    mult: s.points_max > 20 ? s.points_max / 20 : 1,
    layoutId: s.circuit_layout_id || null
  }));
  const countInput = document.getElementById('session-count-input');
  if(countInput) countInput.value = _sequencerSlots.length || 4;
  renderSequencer();

  // Load event-level scoring for one-off events
  if(ev.is_one_off) {
    const evScoring = await dbGet('scoring_config', `event_id=eq.${eventId}&order=position.asc`);
    renderEvScoringRows(evScoring.map(r => r.points));
    // Load group assignment
    await loadEventGroupsDropdown();
    if(ev.event_group_id) {
      const existingRadio = document.querySelector('input[name="ev-group-mode"][value="existing"]');
      if(existingRadio) { existingRadio.checked = true; toggleEvGroupMode(); }
      const groupSel = document.getElementById('ev-group-select');
      if(groupSel) groupSel.value = ev.event_group_id;
    } else {
      const noneRadio = document.querySelector('input[name="ev-group-mode"][value="none"]');
      if(noneRadio) { noneRadio.checked = true; toggleEvGroupMode(); }
    }
  }

  // Scroll to editor
  document.getElementById('event-editor-card').scrollIntoView({behavior:'smooth', block:'start'});
}

async function saveEventEditor() {
  const eventId = document.getElementById('ev-editor-id').value;
  const type = document.querySelector('input[name="ev-type"]:checked')?.value || 'season';
  const isOneOff = type !== 'season';
  const seasonId = !isOneOff ? (document.getElementById('setup-ev-season').value || null) : null;
  const name = document.getElementById('setup-ev-name').value.trim();
  const date = document.getElementById('setup-ev-date').value || null;
  const isMultiCar = document.querySelector('input[name="ev-car-mode"]:checked')?.value === 'multi';
  const carId = isMultiCar ? null : (document.getElementById('setup-ev-car').value || null);
  const multiCarIds = isMultiCar ? JSON.stringify(getMultiCarIds()) : null;
  const layoutId = document.getElementById('setup-ev-layout').value || null;
  const notes = document.getElementById('setup-ev-notes').value.trim() || null;
  const status = document.getElementById('ev-editor-status');

  // Build track display name
  const circuitSel = document.getElementById('setup-ev-circuit');
  const layoutSel = document.getElementById('setup-ev-layout');
  const circuitName = circuitSel.options[circuitSel.selectedIndex]?.text || '';
  const layoutName = layoutSel.options[layoutSel.selectedIndex]?.text || '';
  const trackDisplay = circuitName && layoutName && layoutName !== '— select layout —'
    ? `${circuitName} — ${layoutName}` : circuitName || '';

  if(!isOneOff && !seasonId) { toast('Select a season', 'error'); return; }

  buildSessionsFromSequencer();

  try {
    status.textContent = 'Saving...';
    let evId = eventId;

    const evData = {
      series_id: state.currentSeriesId,
      season_id: seasonId,
      name: name || trackDisplay,
      track: trackDisplay,
      circuit_layout_id: layoutId || null,
      car_id: carId,
      event_date: date,
      is_one_off: isOneOff,
      event_type: type,
      director_notes: notes,
      is_multi_car: isMultiCar,
      multi_car_ids: multiCarIds
    };

    if(eventId) {
      await dbPatch('events', `id=eq.${eventId}`, evData);
    } else {
      const evArr = await dbPost('events', [evData]);
      evId = evArr[0]?.id;
      if(!evId) throw new Error('Event creation failed');
    }

    toast(eventId ? 'Event updated' : 'Event created — use the Sessions button to build sessions');
    status.textContent = '';

    // Save event group assignment for one-off events
    if(isOneOff && evId) {
      const groupMode = document.querySelector('input[name="ev-group-mode"]:checked')?.value || 'none';
      let groupId = null;
      if(groupMode === 'new') {
        const groupName = document.getElementById('ev-group-name')?.value.trim();
        if(groupName) {
          const grpArr = await dbPost('event_groups', [{series_id: state.currentSeriesId, name: groupName}]);
          groupId = grpArr[0]?.id || null;
        }
      } else if(groupMode === 'existing') {
        groupId = document.getElementById('ev-group-select')?.value || null;
      }
      await dbPatch('events', `id=eq.${evId}`, {event_group_id: groupId});
    }

    // Save event-level scoring config for one-off events
    if(isOneOff && evId) {
      const evScoring = getEvScoringRows();
      await dbDelete('scoring_config', `event_id=eq.${evId}`);
      if(evScoring.length) {
        await dbPost('scoring_config', evScoring.map(r => ({
          event_id: evId,
          season_id: null,
          position: r.position,
          points: r.points
        })));
      }
    }
    resetEventEditor();
    await loadSeasonsList();
    await loadCarsIntoSelects();
  } catch(e) {
    status.textContent = 'Error: ' + e.message;
    toast('Error: ' + e.message, 'error');
  }
}


// ============================================================
// SHARE RESULTS PAGE
// ============================================================
async function initShare() {
  await loadSeasonSelects(['share-season-sel'], state.currentSeriesId);
  // Inject event groups and special events options at top of season selector
  const sel = document.getElementById('share-season-sel');
  if(sel) {
    const groups = await dbGet('event_groups', `series_id=eq.${state.currentSeriesId}&order=created_at.desc`);
    const optSpecial = document.createElement('option');
    optSpecial.value = '__special__';
    optSpecial.textContent = '⭐ Special Events & Exhibitions';
    sel.insertBefore(optSpecial, sel.firstChild);
    // Add event groups
    groups.reverse().forEach(g => {
      const opt = document.createElement('option');
      opt.value = `__group__${g.id}`;
      opt.textContent = `🏅 ${g.name}`;
      sel.insertBefore(opt, sel.firstChild);
    });
  }
  await loadShareEvents();
}

async function loadShareEvents() {
  const seasonId = document.getElementById('share-season-sel')?.value;
  const sel = document.getElementById('share-event-sel');
  if(!sel) return;
  if(!seasonId) { sel.innerHTML = '<option value="">— select event —</option>'; return; }

  let events;
  if(seasonId === '__special__') {
    events = await dbGet('events', `series_id=eq.${state.currentSeriesId}&is_one_off=eq.true&order=event_date.desc`);
  } else if(seasonId.startsWith('__group__')) {
    const groupId = seasonId.replace('__group__','');
    events = await dbGet('events', `event_group_id=eq.${groupId}&order=event_date.asc`);
    sel.innerHTML = '<option value="__combined__">📊 Combined Standings</option>'
      + events.map(e => {
          const dateStr = e.event_date ? ' ('+new Date(e.event_date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})+')' : '';
          return `<option value="${e.id}">⭐ ${e.name||e.track}${dateStr}</option>`;
        }).join('');
    document.getElementById('share-view').innerHTML = '<div style="color:var(--simr-muted);font-size:13px;padding:20px 0">Select an event above.</div>';
    return;
  } else {
    events = await dbGet('events', `season_id=eq.${seasonId}&order=event_date.asc`);
  }

  sel.innerHTML = '<option value="">— select event —</option>'
    + events.map(e => {
        const typeTag = e.event_type==='exhibition' ? '🎪 ' : e.is_one_off ? '⭐ ' : '';
        const dateStr = e.event_date ? ' ('+new Date(e.event_date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})+')' : '';
        return `<option value="${e.id}">${typeTag}${e.name||e.track}${dateStr}</option>`;
      }).join('');
  document.getElementById('share-view').innerHTML = '<div style="color:var(--simr-muted);font-size:13px;padding:20px 0">Select an event above.</div>';
}

let _shareLayoutStyle = 'classic';

function setShareStyle(style) {
  _shareLayoutStyle = style;
  const classicBtn = document.getElementById('share-style-classic');
  const blocksBtn = document.getElementById('share-style-blocks');
  if(classicBtn && blocksBtn) {
    if(style === 'classic') {
      classicBtn.style.background = 'var(--simr-red)'; classicBtn.style.color = '#fff'; classicBtn.style.borderColor = 'var(--simr-red)';
      blocksBtn.style.background = ''; blocksBtn.style.color = ''; blocksBtn.style.borderColor = '';
    } else {
      blocksBtn.style.background = 'var(--simr-red)'; blocksBtn.style.color = '#fff'; blocksBtn.style.borderColor = 'var(--simr-red)';
      classicBtn.style.background = ''; classicBtn.style.color = ''; classicBtn.style.borderColor = '';
    }
  }
  renderShareViews();
}

async function renderShareViews() {
  const seasonId = document.getElementById('share-season-sel')?.value;
  const eventId = document.getElementById('share-event-sel')?.value;
  if(!eventId) return;

  const isGroupMode = (seasonId||'').startsWith('__group__');
  const groupId = isGroupMode ? seasonId.replace('__group__','') : null;
  const container = document.getElementById('share-view');

  // ── GROUP COMBINED STANDINGS ──
  if(eventId === '__combined__' && groupId) {
    container.innerHTML = '<div class="loading">Building combined standings...</div>';
    try {
      const [groupArr, groupEvents, allSessions, allResults, drivers, scConfigs] = await Promise.all([
        dbGet('event_groups', `id=eq.${groupId}`),
        dbGet('events', `event_group_id=eq.${groupId}&order=event_date.asc`),
        dbGet('sessions'),
        dbGet('results'),
        dbGet('drivers', 'order=name'),
        dbGet('scoring_config', `event_id=in.(${(await dbGet('events',`event_group_id=eq.${groupId}`)).map(e=>e.id).join(',')})`)
      ]);
      const group = groupArr[0];
      const gEvIds = new Set(groupEvents.map(e=>e.id));
      const gSessions = allSessions.filter(s=>gEvIds.has(s.event_id)&&s.session_type==='race');
      const gSessionIds = new Set(gSessions.map(s=>s.id));
      const gResults = allResults.filter(r=>gSessionIds.has(r.session_id));
      const scMap = {};
      scConfigs.forEach(sc => { if(!scMap[sc.event_id]) scMap[sc.event_id]=[]; scMap[sc.event_id].push(sc); });

      const driverTotals = {};
      gSessions.forEach(sess => {
        const sc = scMap[sess.event_id]||[];
        const baseMax = sc.length ? sc[0].points : 20;
        const sessResultsAll = gResults.filter(r=>r.session_id===sess.id);
        const sessMap = calcSessionPointsMap(sess, sessResultsAll, sc, baseMax);
        Object.entries(sessMap).forEach(([dId,pts])=>{
          if(!driverTotals[dId]) driverTotals[dId]={total:0,perEvent:{}};
          driverTotals[dId].total += pts;
          driverTotals[dId].perEvent[sess.event_id]=(driverTotals[dId].perEvent[sess.event_id]||0)+pts;
        });
      });

      const sorted = Object.entries(driverTotals).sort((a,b)=>b[1].total-a[1].total);
      const winner = group.round_winner_id ? drivers.find(d=>d.id===group.round_winner_id) : null;
      const posColors = ['#d4a820','#8a9aaa','#c07030'];

      const evColHeaders = groupEvents.map(ev =>
        `<th colspan="1" style="text-align:center;border-left:2px solid rgba(255,255,255,0.2);padding:6px 8px;font-size:10px;letter-spacing:.06em;font-weight:600;color:#fff">${ev.name||ev.track}</th>`
      ).join('');

      const rows = sorted.map(([dId,data],i) => {
        const drv = drivers.find(d=>d.id===dId);
        const posColor = i<3?posColors[i]:'#ccc';
        const evCols = groupEvents.map(ev => {
          const pts = data.perEvent[ev.id];
          return `<td style="text-align:center;font-size:13px;padding:8px 8px;border-left:2px solid var(--simr-border)">${pts!=null?pts:'—'}</td>`;
        }).join('');
        return `<tr>
          <td style="width:28px;text-align:center;font-weight:700;color:${posColor};font-size:14px;padding:8px 4px">${i+1}</td>
          <td style="font-weight:600;font-size:13px;padding:8px 8px">${driverLabel(drv)}</td>
          ${evCols}
          <td style="font-weight:700;color:var(--simr-amber);font-size:14px;padding:8px 12px;text-align:right;border-left:1px solid var(--simr-border)">${data.total}</td>
        </tr>`;
      }).join('');

      container.innerHTML = `<div>
        <div class="card" style="padding:0;overflow:hidden">
          <div style="background:#00205B;padding:18px 22px">
            <div style="font-size:10px;color:rgba(255,255,255,0.55);text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px">🏅 Event Group · Combined Standings</div>
            <div style="font-size:24px;font-weight:700;color:#FFFFFF">${group.name}</div>
          </div>
          ${winner?`<div style="padding:10px 22px;border-bottom:1px solid var(--simr-border);display:flex;align-items:center;gap:8px"><span style="font-size:12px;color:var(--simr-muted)">Group Winner:</span><span style="font-weight:700;color:var(--simr-amber)">🏆 ${driverLabel(winner)}</span></div>`:''}
          <div style="overflow-x:auto">
            <table style="table-layout:auto;min-width:400px;width:100%">
              <thead>
                <tr style="background:#00205B">
                  <th style="width:32px;color:#fff;padding:6px 4px"></th>
                  <th style="text-align:left;color:#fff;padding:6px 8px">Driver</th>
                  ${evColHeaders}
                  <th style="text-align:right;color:#fff;border-left:2px solid rgba(255,255,255,0.2);padding:6px 12px">Total</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>`;
    } catch(e) {
      container.innerHTML = `<div style="color:var(--simr-red)">Error: ${e.message}</div>`;
    }
    return;
  }

  const isSpecialMode = seasonId === '__special__' || isGroupMode;

  const [sessions, results, drivers] = await Promise.all([
    dbGet('sessions'),
    dbGet('results'),
    dbGet('drivers', 'order=name')
  ]);

  // Fetch the selected event directly
  const evArr = await dbGet('events', `id=eq.${eventId}`);
  const selEvent = evArr[0];
  if(!selEvent) { container.innerHTML = '<div style="color:var(--simr-red)">Event not found</div>'; return; }

  // Scoring config — use season's if available, else fall back to most recent season
  let sc = [];
  if(selEvent.season_id) {
    sc = await dbGet('scoring_config', `season_id=eq.${selEvent.season_id}&order=position.asc`);
  }
  if(!sc.length) {
    const fallbackSeasons = await dbGet('seasons', `series_id=eq.${state.currentSeriesId}&order=season_number.desc`);
    if(fallbackSeasons.length) sc = await dbGet('scoring_config', `season_id=eq.${fallbackSeasons[0].id}&order=position.asc`);
  }
  const baseMax = sc.length ? sc[0].points : 20;

  // ── ROUND RESULTS ──
  const evSessions = sessions.filter(s=>s.event_id===eventId);
  const raceSessions = evSessions.filter(s=>s.session_type==='race').sort((a,b)=>a.race_number-b.race_number);
  const qualiSessions = evSessions.filter(s=>s.session_type==='grid'&&s.is_qualifying);
  const evResults = results.filter(r=>evSessions.map(s=>s.id).includes(r.session_id));

  const evDriverIds = [...new Set(evResults.map(r=>r.driver_id))];
  const driverRacePts = {};
  evDriverIds.forEach(dId => { driverRacePts[dId] = {}; });

  raceSessions.forEach(sess => {
    const sessResultsAll = evResults.filter(r=>r.session_id===sess.id);
    const sessMap = calcSessionPointsMap(sess, sessResultsAll, sc, baseMax);
    sessResultsAll.forEach(r => {
      const pts = sessMap[r.driver_id] || 0;
      if(!driverRacePts[r.driver_id]) driverRacePts[r.driver_id] = {};
      driverRacePts[r.driver_id][sess.race_number] = {pts, pos: r.dnf?'DNF':r.position, fl: r.fastest_lap};
    });
  });

  const roundTotals = {};
  evDriverIds.forEach(dId => {
    roundTotals[dId] = Object.values(driverRacePts[dId]).reduce((s,r)=>s+(r.pts||0),0);
  });

  const sortedDrivers = evDriverIds.sort((a,b)=>(roundTotals[b]||0)-(roundTotals[a]||0));

  let poleSitter = null;
  if(qualiSessions.length) {
    const poleResult = evResults.find(r=>r.session_id===qualiSessions[0].id&&r.position===1);
    poleSitter = poleResult?.driver_id;
  }

  const trackName = (selEvent.track||selEvent.name||'').replace(/\s*\([^)]+\)/g,'').trim();
  const dateStr = selEvent.event_date
    ? new Date(selEvent.event_date+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'})
    : '';

  const posColors = ['#d4a820','#8a9aaa','#c07030'];

  // Build car map for multi-car events
  const shareCarMap = {};
  if(selEvent.is_multi_car) {
    const sdShare = await dbGet('season_drivers', `event_id=eq.${eventId}`);
    sdShare.forEach(sd => { shareCarMap[sd.driver_id] = sd.car_model; });
    // Also check season-level assignments
    if(selEvent.season_id) {
      const sdSeasonShare = await dbGet('season_drivers', `season_id=eq.${selEvent.season_id}`);
      sdSeasonShare.forEach(sd => { if(!shareCarMap[sd.driver_id]) shareCarMap[sd.driver_id] = sd.car_model; });
    }
  }

  const roundRows = sortedDrivers.map((dId,i) => {
    const drv = drivers.find(d=>d.id===dId);
    const posCls = i===0?posColors[0]:i===1?posColors[1]:i===2?posColors[2]:'#ccc';
    const isPole = dId === poleSitter;
    const raceCols = raceSessions.map(sess=>{
      const cell = driverRacePts[dId]?.[sess.race_number];
      if(!cell) return `<td style="width:44px;text-align:center;color:var(--simr-hint);border-left:2px solid var(--simr-border);padding:8px 6px">—</td><td style="width:44px;text-align:center;color:var(--simr-hint);padding:8px 6px">—</td>`;
      const posColor = cell.pos===1?posColors[0]:cell.pos===2?posColors[1]:cell.pos===3?posColors[2]:'#ccc';
      return `<td style="width:44px;text-align:center;font-weight:600;color:${posColor};border-left:2px solid var(--simr-border);font-size:13px;padding:8px 6px">P${cell.pos}</td>
              <td style="width:44px;text-align:center;font-weight:600;font-size:13px;padding:8px 6px">${cell.pts}</td>`;
    }).join('');
    return `<tr>
      <td style="width:28px;text-align:center;font-weight:700;color:${posCls};font-size:14px;padding:8px 4px">${i+1}</td>
      <td style="font-weight:600;font-size:13px;padding:8px 8px;white-space:nowrap">${driverLabel(drv)}${selEvent.is_multi_car&&shareCarMap[dId]?'<span style="font-size:11px;color:var(--simr-muted);font-weight:400"> — '+shareCarMap[dId]+'</span>':''}${isPole?'<span style="margin-left:4px;font-size:10px;color:var(--simr-amber)">P</span>':''}</td>
      ${raceCols}
      <td style="width:70px;text-align:right;font-weight:700;color:var(--simr-amber);font-size:14px;padding:8px 12px;border-left:1px solid var(--simr-border)">${roundTotals[dId]}</td>
    </tr>`;
  }).join('');

  // Event header context
  const eventTypeLine = isGroupMode
    ? '🏅 Event Group'
    : isSpecialMode
    ? (selEvent.event_type==='exhibition' ? '🎪 Exhibition' : '⭐ Special Event')
    : '';

  // Table header — all th with rowspan so navy bar is unbroken
  const raceGroupHeaders = raceSessions.map(sess =>
    `<th colspan="2" style="text-align:center;border-left:2px solid rgba(255,255,255,0.2);padding:6px 4px;font-size:11px;letter-spacing:.06em;font-weight:600;color:#fff">
      Race ${sess.race_number}${sess.points_max>baseMax?' ('+Math.round(sess.points_max/baseMax)+'x)':''}
    </th>`).join('');

  const raceSubHeaders = raceSessions.map(() =>
    `<th style="width:44px;text-align:center;border-left:2px solid rgba(255,255,255,0.2);font-size:9px;padding:4px 6px;font-weight:500;letter-spacing:.04em;color:#fff">Pos</th>
     <th style="width:44px;text-align:center;font-size:9px;padding:4px 6px;font-weight:500;letter-spacing:.04em;color:#fff">Pts</th>`).join('');

  // ── CHAMPIONSHIP STANDINGS (season events only) ──
  let standingsCardHtml = '';
  if(!isSpecialMode && selEvent.season_id) {
    const [seasonArr, seasonEvents, scoringConfigFull, careerStats] = await Promise.all([
      dbGet('seasons', `id=eq.${selEvent.season_id}`),
      dbGet('events', `season_id=eq.${selEvent.season_id}&order=event_date.asc`),
      dbGet('scoring_config', `season_id=eq.${selEvent.season_id}&order=position.asc`),
      dbGet('career_stats', `series_id=eq.${state.currentSeriesId}`)
    ]);
    const season = seasonArr[0];
    const scFull = scoringConfigFull;
    const baseMaxFull = scFull.length ? scFull[0].points : 20;

    const seasonEvTotals = {};
    seasonEvents.forEach(ev => {
      const evSess = sessions.filter(s=>s.event_id===ev.id&&s.session_type==='race');
      evSess.forEach(sess => {
        const sessResultsAll = results.filter(r=>r.session_id===sess.id);
        const sessMap = calcSessionPointsMap(sess, sessResultsAll, scFull, baseMaxFull);
        Object.entries(sessMap).forEach(([dId,pts])=>{
          if(!seasonEvTotals[dId]) seasonEvTotals[dId] = {};
          seasonEvTotals[dId][ev.id] = (seasonEvTotals[dId][ev.id]||0)+pts;
        });
      });
    });

    const seasonTotalsRaw = {};
    Object.entries(seasonEvTotals).forEach(([dId,evPts])=>{
      seasonTotalsRaw[dId] = Object.values(evPts).reduce((s,p)=>s+p,0);
    });

    // Drop round support — same rule as the live standings page: drop the single
    // lowest-scoring completed round (missed rounds count as 0), requires 2+ completed rounds
    const completedSeasonEvIds = seasonEvents.filter(ev=>{
      const evSess = sessions.filter(s=>s.event_id===ev.id&&s.session_type==='race');
      return evSess.some(sess=>results.some(r=>r.session_id===sess.id));
    }).map(ev=>ev.id);
    const applyDrop = document.getElementById('share-drop-toggle')?.checked !== false;
    const canDropShare = applyDrop && completedSeasonEvIds.length >= 2;

    const seasonTotals = {};
    const droppedEvIdByDriver = {};
    Object.keys(seasonTotalsRaw).forEach(dId => {
      const drop = calculateDropRound(
        seasonEvTotals[dId] || {},
        completedSeasonEvIds,
        applyDrop
      );
      seasonTotals[dId] = seasonTotalsRaw[dId] - drop.droppedPoints;
      droppedEvIdByDriver[dId] = drop.droppedEventId;
    });

    const seasonDrivers = Object.keys(seasonTotals).sort((a,b)=>seasonTotals[b]-seasonTotals[a]);
    const leaderPts = seasonTotals[seasonDrivers[0]]||0;
    const completedEvents = seasonEvents.filter(ev=>sessions.filter(s=>s.event_id===ev.id).some(s=>results.some(r=>r.session_id===s.id)));
    const roundNum = completedEvents.length;

    const evColHeaders = seasonEvents.map(ev=>{
      const short = (ev.name||ev.track||'R').replace(/^S\d+\s+Round\s*/i,'R').replace(/^Round\s*/i,'R');
      const isSelected = ev.id===eventId;
      return `<th style="width:60px;text-align:center;font-size:11px;color:${isSelected?'var(--simr-amber)':'var(--simr-muted)'};padding:8px 6px;border-left:1px solid var(--simr-border);font-weight:${isSelected?'700':'600'}${isSelected?';border-bottom:2px solid var(--simr-amber)':''}" title="${ev.name||ev.track}">${short}</th>`;
    }).join('');

    const standingRows = seasonDrivers.map((dId,i)=>{
      const drv = drivers.find(d=>d.id===dId);
      const posCls = i===0?posColors[0]:i===1?posColors[1]:i===2?posColors[2]:'#ccc';
      const gap = i===0?'—':'-'+(leaderPts-seasonTotals[dId]);
      const evCols = seasonEvents.map(ev=>{
        const pts = seasonEvTotals[dId]?.[ev.id];
        const isSelected = ev.id===eventId;
        const isDropped = canDropShare && droppedEvIdByDriver[dId]===ev.id;
        const dropStyle = isDropped ? ';color:var(--simr-hint);text-decoration:line-through;font-weight:400' : '';
        return `<td style="width:60px;text-align:center;font-size:12px;font-weight:${isSelected?'700':'500'};color:${isSelected?'var(--simr-amber)':pts!=null?'var(--simr-text)':'var(--simr-hint)'};padding:8px 6px;border-left:1px solid var(--simr-border)${isSelected?';background:rgba(212,168,32,0.08)':''}${dropStyle}" ${isDropped?'title="Dropped round"':''}>${pts!=null?pts:'—'}</td>`;
      }).join('');
      return `<tr>
        <td style="width:28px;text-align:center;font-weight:700;color:${posCls};font-size:14px;padding:10px 6px">${i+1}</td>
        <td style="font-weight:600;font-size:13px;padding:10px 10px;white-space:nowrap">${driverLabel(drv)}</td>
        <td style="width:65px;text-align:right;font-weight:700;color:var(--simr-amber);font-size:14px;padding:10px 12px;border-left:1px solid var(--simr-border)">${seasonTotals[dId]}</td>
        <td style="width:65px;text-align:right;font-size:12px;color:${i===0?'var(--simr-hint)':'var(--simr-red)'};padding:10px 12px">${gap}</td>
        ${evCols}
      </tr>`;
    }).join('');

    standingsCardHtml = `
      <div class="card" style="margin-top:16px;padding:20px">
        <div class="section-label" style="margin-top:0;margin-bottom:14px">Championship Standings — After Round ${roundNum} of ${seasonEvents.length}${canDropShare?' <span style="font-weight:400;color:var(--simr-hint);text-transform:none;letter-spacing:normal">(drop round applied)</span>':''}</div>
        <div style="overflow-x:auto">
          <table style="table-layout:fixed;width:100%;border-spacing:0">
            <thead><tr>
              <th style="width:32px"></th>
              <th style="text-align:left;padding:8px 10px">Driver</th>
              <th style="width:65px;text-align:right;border-left:1px solid var(--simr-border);padding:8px 12px">Pts</th>
              <th style="width:65px;text-align:right;padding:8px 12px">Gap</th>
              ${evColHeaders}
            </tr></thead>
            <tbody>${standingRows}</tbody>
          </table>
        </div>
        <div style="margin-top:14px;font-size:10px;color:var(--simr-hint);text-align:right">simr-scoring.netlify.app · ${season?.name||''}</div>
      </div>`;
  }

  // Render
  // FL notes strip
  const flNotes = raceSessions.map(sess => {
    const flRes = evResults.find(r=>r.session_id===sess.id&&r.fastest_lap);
    if(!flRes) return null;
    const flDrv = drivers.find(d=>d.id===flRes.driver_id);
    const lapTime = flRes.lap_time ? ` — ${flRes.lap_time}` : '';
    return `<span style="margin-right:16px"><span style="color:var(--simr-text);font-weight:600">R${sess.race_number} FL:</span> <span style="font-weight:600;color:var(--simr-purple)">${driverLabel(flDrv)}${lapTime}</span></span>`;
  }).filter(Boolean);
  const flStripHtml = flNotes.length ? `
    <div style="padding:10px 16px;background:var(--simr-surface2);border-top:1px solid var(--simr-border);font-size:13px">
      <span style="font-size:11px;color:var(--simr-amber);font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin-right:10px">⚡ Fastest laps</span>
      ${flNotes.join('')}
    </div>` : '';

  // ── RACE BLOCKS LAYOUT ──
  if(_shareLayoutStyle === 'blocks') {
    // Map each race to its preceding grid/quali session for pole marker
    const raceToGridPole = {};
    raceSessions.forEach(sess => {
      const gridSess = evSessions.find(s=>s.session_type==='grid'&&s.race_number===sess.race_number);
      if(gridSess) {
        const poleRes = evResults.find(r=>r.session_id===gridSess.id&&r.position===1);
        if(poleRes) raceToGridPole[sess.race_number] = poleRes.driver_id;
      }
    });

    // Full-width Round Total block
    const roundTotalRows = sortedDrivers.map((dId,i) => {
      const drv = drivers.find(d=>d.id===dId);
      const posColor = i<3?posColors[i]:'var(--simr-muted)';
      const carLabel = selEvent.is_multi_car&&shareCarMap[dId]?`<span style="font-size:11px;color:var(--simr-muted);font-weight:400"> — ${shareCarMap[dId]}</span>`:'';
      return `<tr>
        <td style="width:28px;text-align:center;font-weight:700;color:${posColor};font-size:14px;padding:6px 8px">${i+1}</td>
        <td style="font-weight:600;font-size:13px;padding:6px 8px">${driverLabel(drv)}${carLabel}</td>
        <td style="text-align:right;font-weight:700;color:var(--simr-amber);font-size:14px;padding:6px 12px">${roundTotals[dId]}</td>
      </tr>`;
    }).join('');

    // Race-by-race blocks — full field, sorted by finish order, FL attached to its own block
    const raceBlocksHtml = raceSessions.map(sess => {
      const sessResultsSorted = evResults.filter(r=>r.session_id===sess.id).slice().sort((a,b)=>(a.position||99)-(b.position||99));
      const poleDriverId = raceToGridPole[sess.race_number];
      const rows = sessResultsSorted.map(r => {
        const drv = drivers.find(d=>d.id===r.driver_id);
        const cellData = driverRacePts[r.driver_id]?.[sess.race_number];
        const pts = cellData?.pts || 0;
        const posColor = r.dnf?'var(--simr-red)':r.position===1?posColors[0]:r.position===2?posColors[1]:r.position===3?posColors[2]:'var(--simr-muted)';
        const carLabel = selEvent.is_multi_car&&shareCarMap[r.driver_id]?`<span style="font-size:10px;color:var(--simr-muted);font-weight:400"> — ${shareCarMap[r.driver_id]}</span>`:'';
        const poleTag = r.driver_id===poleDriverId?'<span style="color:var(--simr-amber);font-size:10px;font-weight:500;margin-left:10px">P</span>':'';
        return `<tr>
          <td style="width:16px;text-align:center;font-weight:700;color:${posColor};font-size:12px;padding:4px 8px">${r.dnf?'DNF':r.position}</td>
          <td style="font-weight:500;font-size:12px;padding:4px 8px">${driverLabel(drv)}${carLabel}${poleTag}</td>
          <td style="text-align:right;font-weight:600;font-size:12px;padding:4px 8px">${pts}</td>
        </tr>`;
      }).join('');
      const flRes = sessResultsSorted.find(r=>r.fastest_lap);
      const flDrv = flRes ? drivers.find(d=>d.id===flRes.driver_id) : null;
      const flHtml = flDrv ? `<div style="padding:6px 10px;border-top:1px solid var(--simr-border);font-size:11px">
        <span style="color:var(--simr-amber);font-weight:600">⚡ FL:</span> <span style="color:var(--simr-purple);font-weight:600">${driverLabel(flDrv)}${flRes.lap_time?' — '+flRes.lap_time:''}</span>
      </div>` : '';
      return `<div class="card" style="margin-bottom:0;padding:0;overflow:hidden">
        <div style="padding:6px 10px;background:var(--simr-surface2);font-size:12px;font-weight:600;text-align:center">Race ${sess.race_number}${sess.points_max>baseMax?' ('+Math.round(sess.points_max/baseMax)+'x)':''}</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="width:16px;text-align:center;padding:4px 8px;font-size:10px;color:var(--simr-muted)">Pos</th>
            <th style="text-align:left;padding:4px 8px;font-size:10px;color:var(--simr-muted)">Driver</th>
            <th style="text-align:right;padding:4px 8px;font-size:10px;color:var(--simr-muted)">Pts</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${flHtml}
      </div>`;
    }).join('');

    container.innerHTML = `
      <div>
        <div class="card" style="margin-bottom:14px;padding:0;overflow:hidden">
          <div style="text-align:center;padding:22px 20px 18px;border-bottom:1px solid var(--simr-border)">
            ${eventTypeLine ? `<div style="margin-bottom:10px"><span style="font-size:10px;background:var(--simr-red);color:#fff;padding:3px 10px;border-radius:3px;letter-spacing:.08em;text-transform:uppercase">${eventTypeLine}</span></div>` : ''}
            <div style="font-size:26px;font-weight:700;color:var(--simr-navy, #00205B);display:inline-block;padding-bottom:8px;border-bottom:2px solid var(--simr-red);margin-bottom:10px;--simr-navy:${document.body.classList.contains('theme-usa')?'#00205B':'var(--simr-text)'}">${selEvent.name||selEvent.track}</div>
            <div style="display:flex;justify-content:center;gap:12px;font-size:12px;color:var(--simr-muted);flex-wrap:wrap">
              ${trackName&&trackName!==(selEvent.name||'')?`<span>${trackName}</span><span>·</span>`:''}
              <span>${dateStr||'Date TBD'}</span>
            </div>
          </div>
        </div>
        <div class="card" style="margin-bottom:14px;padding:0;overflow:hidden">
          <div style="padding:6px 10px;background:var(--simr-surface2);font-size:12px;font-weight:600;text-align:center;color:#8a1020">Round total · ${sortedDrivers.length} drivers · ${raceSessions.length} race${raceSessions.length!==1?'s':''}</div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr>
              <th style="width:28px;text-align:center;padding:6px 8px;font-size:10px;color:var(--simr-muted)">Pos</th>
              <th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--simr-muted)">Driver</th>
              <th style="text-align:right;padding:6px 12px;font-size:10px;color:var(--simr-muted)">Points</th>
            </tr></thead>
            <tbody>${roundTotalRows}</tbody>
          </table>
        </div>
        <div style="font-size:11px;color:var(--simr-muted);text-align:center;margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em">Race by race</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:14px">
          ${raceBlocksHtml}
        </div>
        ${standingsCardHtml}
      </div>`;
    return;
  }

  container.innerHTML = `
    <div>
      <div class="card" style="margin-bottom:14px;padding:0;overflow:hidden">
        <!-- Centered Option C header -->
        <div style="text-align:center;padding:22px 20px 18px;border-bottom:1px solid var(--simr-border)">
          ${eventTypeLine ? `<div style="margin-bottom:10px"><span style="font-size:10px;background:var(--simr-red);color:#fff;padding:3px 10px;border-radius:3px;letter-spacing:.08em;text-transform:uppercase">${eventTypeLine}</span></div>` : ''}
          <div style="font-size:26px;font-weight:700;color:var(--simr-navy, #00205B);display:inline-block;padding-bottom:8px;border-bottom:2px solid var(--simr-red);margin-bottom:10px;--simr-navy:${document.body.classList.contains('theme-usa')?'#00205B':'var(--simr-text)'}">${selEvent.name||selEvent.track}</div>
          <div style="display:flex;justify-content:center;gap:12px;font-size:12px;color:var(--simr-muted);flex-wrap:wrap">
            ${trackName&&trackName!==(selEvent.name||'')?`<span>${trackName}</span><span>·</span>`:''}
            <span>${dateStr||'Date TBD'}</span>
          </div>
        </div>
        <!-- Results table -->
        <div style="overflow-x:auto">
          <table style="table-layout:auto;min-width:400px;width:100%">
            <thead>
              <tr style="background:#00205B">
                <th style="width:32px;color:#fff" rowspan="2"></th>
                <th style="text-align:left;padding:6px 8px;color:#fff" rowspan="2">Driver</th>
                ${raceGroupHeaders}
                <th style="width:70px;text-align:right;border-left:2px solid rgba(255,255,255,0.2);padding:6px 12px;color:#fff" rowspan="2">Total</th>
              </tr>
              <tr style="background:#00205B">${raceSubHeaders}</tr>
            </thead>
            <tbody>${roundRows}</tbody>
          </table>
        </div>
        ${flStripHtml}
      </div>
      ${standingsCardHtml}
    </div>`;
}


// ============================================================
// BOOT
// ============================================================
async function refreshLiveCareerStats() {
  try {
    const [drivers, seasons, events, sessions, results, allScoringConfigs] = await Promise.all([
      dbGet('drivers', 'order=name'),
      dbGet('seasons', `series_id=eq.${state.currentSeriesId}&order=season_number.asc`),
      dbGet('events', `series_id=eq.${state.currentSeriesId}`),
      dbGet('sessions'),
      dbGet('results'),
      dbGet('scoring_config')
    ]);
    state.currentDrivers = drivers;
    const scoringConfigMap = {};
    const eventScoringConfigMap = {};
    allScoringConfigs.forEach(sc => {
      if(sc.event_id) {
        if(!eventScoringConfigMap[sc.event_id]) eventScoringConfigMap[sc.event_id] = [];
        eventScoringConfigMap[sc.event_id].push(sc);
      } else if(sc.season_id) {
        if(!scoringConfigMap[sc.season_id]) scoringConfigMap[sc.season_id] = [];
        scoringConfigMap[sc.season_id].push(sc);
      }
    });
    // build career stats map for pole fallback
    const careerStatsArr = await dbGet('career_stats', `series_id=eq.${state.currentSeriesId}`);
    const careerStatsMap = {};
    careerStatsArr.forEach(cs => { careerStatsMap[cs.driver_id] = cs; });
    state._careerStatsMap = careerStatsMap;

    // Filter sessions to only those belonging to this series' events
    const seriesEventIds = new Set(events.map(e=>e.id));
    const seriesSessions = sessions.filter(s=>seriesEventIds.has(s.event_id));
    // Filter results to only those in series sessions
    const seriesSessionIds = new Set(seriesSessions.map(s=>s.id));
    const seriesResults = results.filter(r=>seriesSessionIds.has(r.session_id));

    state._liveEffMap = {};
    drivers.forEach(drv => {
      state._liveEffMap[drv.id] = calcLiveCareerStats(drv.id, seriesResults, seriesSessions, events, seasons, scoringConfigMap, careerStatsMap, eventScoringConfigMap);
    });
    // also cache circuits/layouts if not loaded
    if(!state._circuits) {
      const [circuits, layouts] = await Promise.all([
        dbGet('circuits', 'order=name'),
        dbGet('circuit_layouts', 'order=name')
      ]);
      state._circuits = circuits;
      state._layouts = layouts;
    }
  } catch(e) {
    console.warn('Could not pre-calculate career stats', e);
  }
}

async function loadActiveThresholds() {
  try {
    // find active season for current series, fall back to most recent
    const seasons = await dbGet('seasons', `series_id=eq.${state.currentSeriesId}&order=season_number.desc`);
    if(!seasons.length) return;
    const activeSeason = seasons.find(s=>s.is_active) || seasons[0];
    const cc = await dbGet('classification_config', `season_id=eq.${activeSeason.id}`).then(r=>r[0]||null);
    if(cc) {
      state.activeThresholds = {
        p: cc.platinum_threshold || 72,
        g: cc.gold_threshold || 55,
        s: cc.silver_threshold || 35
      };
    }
  } catch(e) {
    console.warn('Could not load thresholds, using defaults', e);
  }
}

// ============================================================
// RESULTS / EVENTS PAGE
// ============================================================

// State for results page
let _resultsData = { seasons: [], events: [], sessions: [], results: [], series: null };
let _activeResultEventId = null;

async function loadEventsPage() {
  document.getElementById('results-list').innerHTML = '<div class="loading">Loading...</div>';
  document.getElementById('event-detail').innerHTML = '';

  const { seasons, events, sessions, results } = await getSeriesData();
  const drivers = await dbGet('drivers', 'order=name');
  const eventGroups = await dbGet('event_groups', `series_id=eq.${state.currentSeriesId}&order=created_at.asc`);
  seasons.sort((a,b)=>b.season_number-a.season_number);

  state.currentDrivers = drivers;
  _resultsData = { seasons, events, sessions, results, eventGroups };

  // ── Stats bar ──
  const totalRaces = sessions.filter(s=>s.session_type==='race'&&results.some(r=>r.session_id===s.id)).length;
  const completedEvents = events.filter(ev=>sessions.some(s=>s.event_id===ev.id&&results.some(r=>r.session_id===s.id)));
  const seasonEvents = completedEvents.filter(e=>!e.is_one_off);
  const specialEvents = completedEvents.filter(e=>e.is_one_off);
  const uniqueDrivers = [...new Set(results.map(r=>r.driver_id))].length;
  const activeSeason = seasons.find(s=>s.is_active);

  document.getElementById('results-stats-bar').innerHTML = `
    <div style="text-align:center;padding-right:16px;border-right:1px solid var(--simr-border)">
      <div style="font-size:24px;font-weight:700;color:var(--simr-amber)">${totalRaces}</div>
      <div style="font-size:11px;color:var(--simr-muted);text-transform:uppercase;letter-spacing:.06em">Races</div>
    </div>
    <div style="text-align:center;padding:0 16px;border-right:1px solid var(--simr-border)">
      <div style="font-size:24px;font-weight:700">${seasonEvents.length}</div>
      <div style="font-size:11px;color:var(--simr-muted);text-transform:uppercase;letter-spacing:.06em">Rounds</div>
    </div>
    <div style="text-align:center;padding:0 16px;border-right:1px solid var(--simr-border)">
      <div style="font-size:24px;font-weight:700">${seasons.length}</div>
      <div style="font-size:11px;color:var(--simr-muted);text-transform:uppercase;letter-spacing:.06em">Seasons</div>
    </div>
    <div style="text-align:center;padding:0 16px;border-right:1px solid var(--simr-border)">
      <div style="font-size:24px;font-weight:700">${specialEvents.length}</div>
      <div style="font-size:11px;color:var(--simr-muted);text-transform:uppercase;letter-spacing:.06em">Special Events</div>
    </div>
    <div style="text-align:center;padding-left:16px">
      <div style="font-size:24px;font-weight:700">${uniqueDrivers}</div>
      <div style="font-size:11px;color:var(--simr-muted);text-transform:uppercase;letter-spacing:.06em">Drivers</div>
    </div>
    ${activeSeason ? `<div style="margin-left:auto;text-align:right;align-self:center">
      <div style="font-size:11px;color:var(--simr-muted)">Active season</div>
      <div style="font-size:13px;font-weight:600;color:var(--simr-green)">● ${activeSeason.name}</div>
    </div>` : ''}
  `;

  renderResultsList(seasons, events, sessions, results, '', eventGroups);

  // Auto-open most recent event with results
  const lastEventWithResults = [...completedEvents].sort((a,b)=>new Date(b.event_date||0)-new Date(a.event_date||0))[0];
  if(lastEventWithResults) {
    // expand that season section
    const seasonId = lastEventWithResults.season_id;
    const sectionId = lastEventWithResults.is_one_off ? 'results-section-special' : `results-section-${seasonId}`;
    const sectionEl = document.getElementById(sectionId);
    if(sectionEl) sectionEl.style.display = 'block';
    // load results
    await selectResultEvent(lastEventWithResults.id);
    // scroll to it
    setTimeout(() => {
      const evRow = document.getElementById(`ev-row-${lastEventWithResults.id}`);
      if(evRow) evRow.scrollIntoView({behavior:'smooth', block:'nearest'});
    }, 100);
  }
}

function renderResultsList(seasons, events, sessions, results, searchTerm='', eventGroups=[]) {
  const q = searchTerm.toLowerCase().trim();
  const el = document.getElementById('results-list');
  let html = '';

  const hasResults = (evId) => sessions.some(s=>s.event_id===evId&&results.some(r=>r.session_id===s.id));
  const eventMatchesSearch = (ev) => {
    if(!q) return true;
    return (ev.name||'').toLowerCase().includes(q) || (ev.track||'').toLowerCase().includes(q);
  };
  const seasonMatchesSearch = (s) => {
    if(!q) return true;
    if((s.name||'').toLowerCase().includes(q)) return true;
    if((s.car_class||'').toLowerCase().includes(q)) return true;
    if(String(s.season_number).includes(q)) return true;
    return events.filter(e=>e.season_id===s.id).some(eventMatchesSearch);
  };

  // ── Special Events section (grouped + ungrouped) ──
  const allOneOffs = events.filter(e=>e.is_one_off).filter(eventMatchesSearch)
    .sort((a,b)=>new Date(b.event_date||0)-new Date(a.event_date||0));
  if(allOneOffs.length || events.some(e=>e.is_one_off)) {
    // Fetch event groups for this series from cached data or build from events
    const groupIds = [...new Set(allOneOffs.filter(e=>e.event_group_id).map(e=>e.event_group_id))];
    const groupMeta = {};
    eventGroups.filter(g=>groupIds.includes(g.id)).forEach(g => { groupMeta[g.id] = {name: g.name, round_winner_id: g.round_winner_id, events: []}; });
    const ungroupedOneOffs = [];
    allOneOffs.forEach(ev => {
      if(ev.event_group_id && groupMeta[ev.event_group_id]) groupMeta[ev.event_group_id].events.push(ev);
      else ungroupedOneOffs.push(ev);
    });

    // Render groups first
    Object.entries(groupMeta).forEach(([gid, g]) => {
      const sectionId = `results-section-group-${gid}`;
      const eventRows = g.events.map(ev => {
        const hasRes = hasResults(ev.id);
        const dateStr = ev.event_date
          ? new Date(ev.event_date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})
          : '—';
        const evSessions = sessions.filter(s=>s.event_id===ev.id);
        const raceSessions = evSessions.filter(s=>s.session_type==='race');
        return `<div id="ev-row-${ev.id}" onclick="selectResultEvent('${ev.id}')" style="display:flex;align-items:center;gap:12px;padding:10px 20px;border-bottom:1px solid var(--simr-border);cursor:pointer;transition:background .15s" onmouseover="this.style.background='var(--simr-surface2)'" onmouseout="this.style.background=''">
          <span style="font-size:11px;color:var(--simr-muted);width:48px;flex-shrink:0">${dateStr}</span>
          <span style="flex:1;font-size:13px;font-weight:500">${ev.name||ev.track||'Event'}${ev.track&&ev.name&&ev.track!==ev.name?` <span style="color:var(--simr-muted);font-size:11px;font-weight:400">— ${ev.track.replace(/ —.*$/,'')}</span>`:''}</span>
          <span style="font-size:11px;flex-shrink:0;color:${hasRes?'var(--simr-green)':'var(--simr-hint)'}">${hasRes?`✓ ${raceSessions.length} race${raceSessions.length!==1?'s':''}` : 'Upcoming'}</span>
        </div>`;
      }).join('') || `<div style="padding:12px 20px;font-size:12px;color:var(--simr-hint)">No events in this group yet</div>`;

      html += `<div style="margin-bottom:10px;border-radius:8px;overflow:hidden;border:1px solid var(--simr-border)">
        <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--simr-surface2);cursor:pointer;user-select:none" onclick="toggleResultsSection('${sectionId}')">
          <span id="${sectionId}-arrow" style="font-size:12px;color:var(--simr-muted)">▼</span>
          <span style="font-weight:600;font-size:13px">🏅 ${g.name}</span>
          <span style="font-size:11px;color:var(--simr-hint);margin-right:auto">${g.events.length} event${g.events.length!==1?'s':''}</span>
          <button onclick="event.stopPropagation();showGroupStandings('${gid}')" class="btn btn-sm" style="font-size:11px;padding:3px 8px">📊 Combined Standings</button>
        </div>
        <div id="${sectionId}">${eventRows}</div>
      </div>`;
    });

    // Render ungrouped special events and exhibitions separately
    const ungroupedSpecial = ungroupedOneOffs.filter(e=>e.event_type!=='exhibition');
    const ungroupedExhibition = ungroupedOneOffs.filter(e=>e.event_type==='exhibition');
    if(ungroupedSpecial.length) html += renderSeasonSection('special', '⭐ Special Events', '', ungroupedSpecial, sessions, results, hasResults, true, true);
    if(ungroupedExhibition.length) html += renderSeasonSection('exhibition', '🎪 Exhibitions', '', ungroupedExhibition, sessions, results, hasResults, true, true);
  }

  // ── Season sections — newest first ──
  seasons.forEach(s => {
    if(q && !seasonMatchesSearch(s)) return;
    const seasonEvs = events.filter(e=>e.season_id===s.id&&!e.is_one_off)
      .filter(e=>q?eventMatchesSearch(e):true)
      .sort((a,b)=>{
        if(!a.event_date && !b.event_date) return (a.name||'').localeCompare(b.name||'');
        if(!a.event_date) return 1;
        if(!b.event_date) return -1;
        return new Date(a.event_date) - new Date(b.event_date);
      });
    const isOpen = s.is_active || (q && seasonMatchesSearch(s));
    html += renderSeasonSection(s.id, s.name, s.car_class||'', seasonEvs, sessions, results, hasResults, isOpen, false, s);
  });

  el.innerHTML = html || '<div style="color:var(--simr-muted);font-size:13px;padding:16px 0">No results found</div>';
}

function renderSeasonSection(id, name, subtitle, evs, sessions, results, hasResults, isOpen, isSpecial, season) {
  const sectionId = isSpecial ? 'results-section-special' : `results-section-${id}`;
  const statusTag = season?.is_locked
    ? '<span style="color:var(--simr-amber);font-size:11px">🏆 Complete</span>'
    : season?.is_active
      ? '<span style="color:var(--simr-green);font-size:11px">● Active</span>'
      : isSpecial ? '' : '<span style="color:var(--simr-hint);font-size:11px">Scheduled</span>';

  const eventRows = evs.map(ev => {
    const hasRes = hasResults(ev.id);
    const dateStr = ev.event_date
      ? new Date(ev.event_date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})
      : '—';
    const evSessions = sessions.filter(s=>s.event_id===ev.id);
    const raceSessions = evSessions.filter(s=>s.session_type==='race');
    const roundWinner = ev.round_winner_id ? state.currentDrivers.find(d=>d.id===ev.round_winner_id) : null;
    return `<div id="ev-row-${ev.id}" onclick="selectResultEvent('${ev.id}')" style="display:flex;align-items:center;gap:12px;padding:10px 20px;border-bottom:1px solid var(--simr-border);cursor:pointer;transition:background .15s" onmouseover="this.style.background='var(--simr-surface2)'" onmouseout="this.style.background=''">
      <span style="font-size:11px;color:var(--simr-muted);width:48px;flex-shrink:0">${dateStr}</span>
      <span style="flex:1;font-size:13px;font-weight:500">${ev.name||ev.track||'Event'}${ev.track&&ev.name&&ev.track!==ev.name?` <span style="color:var(--simr-muted);font-size:11px;font-weight:400">— ${ev.track.replace(/ —.*$/,'')}</span>`:''}</span>
      ${roundWinner?`<span style="font-size:11px;color:var(--simr-amber)">🏆 ${driverLabel(roundWinner)}</span>`:''}
      <span style="font-size:11px;flex-shrink:0;color:${hasRes?'var(--simr-green)':'var(--simr-hint)'}">${hasRes?`✓ ${raceSessions.length} race${raceSessions.length!==1?'s':''}` : 'Upcoming'}</span>
    </div>`;
  }).join('') || `<div style="padding:12px 20px;font-size:12px;color:var(--simr-hint)">No events${evs.length===0&&id!=='special'?' — add them in Season & Events':''}</div>`;

  return `<div style="margin-bottom:10px;border-radius:8px;overflow:hidden;border:1px solid var(--simr-border)">
    <div onclick="toggleResultsSection('${sectionId}')" style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--simr-surface2);cursor:pointer;user-select:none">
      <span id="${sectionId}-arrow" style="font-size:12px;color:var(--simr-muted)">${isOpen?'▼':'▶'}</span>
      <div style="flex:1">
        <span style="font-weight:600;font-size:13px">${name}</span>
        ${subtitle?`<span style="font-size:11px;color:var(--simr-muted);margin-left:8px">${subtitle}</span>`:''}
      </div>
      ${statusTag}
      <span style="font-size:11px;color:var(--simr-hint)">${evs.length} event${evs.length!==1?'s':''}</span>
    </div>
    <div id="${sectionId}" style="display:${isOpen?'block':'none'}">${eventRows}</div>
  </div>`;
}

function toggleResultsSection(sectionId) {
  const el = document.getElementById(sectionId);
  const arrow = document.getElementById(sectionId+'-arrow');
  if(!el) return;
  const isHidden = el.style.display==='none';
  el.style.display = isHidden?'block':'none';
  if(arrow) arrow.textContent = isHidden?'▼':'▶';
}

function filterResults() {
  const q = document.getElementById('results-search').value;
  const {seasons, events, sessions, results} = _resultsData;
  renderResultsList(seasons, events, sessions, results, q, _resultsData.eventGroups||[]);
}

async function showGroupStandings(groupId) {
  const detailEl = document.getElementById('event-detail');
  detailEl.innerHTML = '<div class="card"><div class="loading">Loading combined standings...</div></div>';
  detailEl.scrollIntoView({behavior:'smooth', block:'nearest'});
  try {
    const [groupArr, groupEvents, allSessions, allResults, drivers, scConfigs] = await Promise.all([
      dbGet('event_groups', `id=eq.${groupId}`),
      dbGet('events', `event_group_id=eq.${groupId}&order=event_date.asc`),
      dbGet('sessions'),
      dbGet('results'),
      dbGet('drivers', 'order=name'),
      dbGet('scoring_config', `event_id=in.(${(await dbGet('events',`event_group_id=eq.${groupId}`)).map(e=>e.id).join(',')})`)
    ]);
    const group = groupArr[0];
    if(!group) { detailEl.innerHTML = ''; return; }

    const gEvIds = new Set(groupEvents.map(e=>e.id));
    const gSessions = allSessions.filter(s=>gEvIds.has(s.event_id)&&s.session_type==='race');
    const gSessionIds = new Set(gSessions.map(s=>s.id));
    const gResults = allResults.filter(r=>gSessionIds.has(r.session_id));

    // Build scoring config map by event_id
    const scMap = {};
    scConfigs.forEach(sc => { if(!scMap[sc.event_id]) scMap[sc.event_id] = []; scMap[sc.event_id].push(sc); });

    // Compute combined standings + per-event breakdown
    const driverTotals = {}; // driverId -> {total, perEvent: {eventId: pts}}
    gSessions.forEach(sess => {
      const sc = scMap[sess.event_id] || [];
      const baseMax = sc.length ? sc[0].points : 20;
      const sessResultsAll = gResults.filter(r=>r.session_id===sess.id);
      const sessMap = calcSessionPointsMap(sess, sessResultsAll, sc, baseMax);
      Object.entries(sessMap).forEach(([dId,pts])=>{
        if(!driverTotals[dId]) driverTotals[dId] = {total:0, perEvent:{}};
        driverTotals[dId].total += pts;
        driverTotals[dId].perEvent[sess.event_id] = (driverTotals[dId].perEvent[sess.event_id]||0) + pts;
      });
    });

    const sorted = Object.entries(driverTotals).sort((a,b)=>b[1].total-a[1].total);
    const winner = group.round_winner_id ? drivers.find(d=>d.id===group.round_winner_id) : null;
    const posColors = ['#d4a820','#8a9aaa','#c07030'];

    const evColHeaders = groupEvents.map(ev =>
      `<th style="text-align:center;padding:6px 10px;border-left:1px solid var(--simr-border);font-size:11px">${ev.name||ev.track||'Event'}</th>`
    ).join('');

    const rows = sorted.map(([dId,data],i) => {
      const drv = drivers.find(d=>d.id===dId);
      const posColor = i<3 ? posColors[i] : 'var(--simr-muted)';
      const evCols = groupEvents.map(ev => {
        const pts = data.perEvent[ev.id];
        return `<td style="text-align:center;font-size:12px;padding:8px 10px;border-left:1px solid var(--simr-border)">${pts!=null?pts:'—'}</td>`;
      }).join('');
      return `<tr>
        <td style="font-weight:700;color:${posColor};padding:8px 10px;text-align:center">${i+1}</td>
        <td style="font-weight:600;padding:8px 10px">${driverLabel(drv)}</td>
        ${evCols}
        <td style="font-weight:700;color:var(--simr-amber);padding:8px 10px;text-align:right;border-left:1px solid var(--simr-border)">${data.total}</td>
      </tr>`;
    }).join('');

    detailEl.innerHTML = `<div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--simr-border)">
        <div>
          <div style="font-size:18px;font-weight:700">🏅 ${group.name}</div>
          <div style="font-size:12px;color:var(--simr-muted);margin-top:2px">Combined standings across ${groupEvents.length} events</div>
        </div>
        ${winner ? `<div style="text-align:right"><div style="font-size:11px;color:var(--simr-muted);margin-bottom:2px">Group Winner</div><div style="font-size:15px;font-weight:700;color:var(--simr-amber)">🏆 ${driverLabel(winner)}</div></div>` : ''}
      </div>
      <div style="overflow-x:auto">
        <table style="table-layout:auto;width:100%">
          <thead><tr>
            <th style="width:32px;padding:6px 10px"></th>
            <th style="text-align:left;padding:6px 10px">Driver</th>
            ${evColHeaders}
            <th style="text-align:right;padding:6px 10px;border-left:1px solid var(--simr-border)">Total</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  } catch(e) {
    detailEl.innerHTML = `<div class="card"><div style="color:var(--simr-red)">Error loading group standings: ${e.message}</div></div>`;
  }
}

async function selectResultEvent(evId) {
  _activeResultEventId = evId;
  document.querySelectorAll('[id^="ev-row-"]').forEach(r=>r.style.fontWeight='');
  const row = document.getElementById(`ev-row-${evId}`);
  if(row) row.style.background = 'var(--simr-surface2)';

  try {
    // Fetch only sessions and results for this specific event — avoids global row limit
    const freshSessions = await dbGet('sessions', `event_id=eq.${evId}`);
    const sessIds = freshSessions.map(s=>s.id);
    const freshResults = sessIds.length
      ? await dbGet('results', `session_id=in.(${sessIds.join(',')})`)
      : [];
    // Merge with cached sessions/results for other events (needed for scoring lookups)
    const mergedSessions = [
      ..._resultsData.sessions.filter(s=>s.event_id!==evId),
      ...freshSessions
    ];
    const mergedResults = [
      ..._resultsData.results.filter(r=>!sessIds.includes(r.session_id)),
      ...freshResults
    ];
    await showEventDetail(evId, _resultsData.events, mergedSessions, mergedResults);
    setTimeout(()=>{
      document.getElementById('event-detail').scrollIntoView({behavior:'smooth', block:'nearest'});
    }, 50);
  } catch(e) {
    console.error('selectResultEvent error:', e);
    document.getElementById('event-detail').innerHTML = `<div class="card"><div style="color:var(--simr-red);font-size:13px">Error loading event: ${e.message}</div></div>`;
  }
}

async function selectEventChip(el, evId) {
  await selectResultEvent(evId);
}


async function showEventDetail(evId, events, sessions, results) {
  const ev = events.find(e=>e.id===evId);
  if(!ev) return;
  const evSessions = sessions.filter(s=>s.event_id===evId);
  const evResults = results.filter(r=>evSessions.map(s=>s.id).includes(r.session_id));

  const seasonId = ev.season_id;
  // For special events with no season, fall back to most recent season's scoring config
  let scoringConfig = [];
  if(seasonId) {
    scoringConfig = await dbGet('scoring_config', `season_id=eq.${seasonId}`);
  } else {
    const fallbackSeasons = await dbGet('seasons', `series_id=eq.${state.currentSeriesId}&order=season_number.desc`);
    if(fallbackSeasons.length) {
      scoringConfig = await dbGet('scoring_config', `season_id=eq.${fallbackSeasons[0].id}`);
    }
  }
  // Load car assignments
  window._seasonDriversCache = {};
  if(seasonId) {
    const sdArr = await dbGet('season_drivers', `season_id=eq.${seasonId}`);
    sdArr.forEach(sd => window._seasonDriversCache[sd.driver_id] = sd);
  }
  // For multi-car events, per-event assignments override season-level
  if(ev.is_multi_car) {
    const sdEvArr = await dbGet('season_drivers', `event_id=eq.${evId}`);
    sdEvArr.forEach(sd => window._seasonDriversCache[sd.driver_id] = sd);
  }

  // Sort sessions: grid and race interleaved by race_number
  const gridSessions = evSessions.filter(s=>s.session_type==='grid').sort((a,b)=>a.race_number-b.race_number);
  const raceSessions = evSessions.filter(s=>s.session_type==='race').sort((a,b)=>a.race_number-b.race_number);

  // Get season name for context
  const seasonArr = seasonId ? await dbGet('seasons', `id=eq.${seasonId}`) : [];
  const season = seasonArr[0];
  const seasonName = season?.name || (ev.is_one_off ? 'Special Event' : '');

  // Event header
  const dateStr = ev.event_date
    ? new Date(ev.event_date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})
    : 'Date TBD';
  const driverIds = [...new Set(evResults.map(r=>r.driver_id))];
  const roundWinner = ev.round_winner_id ? state.currentDrivers.find(d=>d.id===ev.round_winner_id) : null;

  let html = '';

  // Special event banner
  if(ev.is_one_off) {
    html += `<div class="special-banner" style="margin-bottom:14px">${ev.event_type==='exhibition'?'🎪 Exhibition':'⭐ Special Event'} — results count toward career stats but not championship points</div>`;
  }

  // Event header card with season/round context
  html += `<div style="background:var(--simr-surface);border:1px solid var(--simr-border);border-radius:8px;padding:18px 20px;margin-bottom:14px">
    <div style="font-size:11px;color:var(--simr-muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">
      ${ev.is_one_off ? (ev.event_type==='exhibition' ? '🎪 Exhibition' : '⭐ Special Event') : seasonName}
    </div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px">
      <div>
        <div style="font-size:22px;font-weight:700;margin-bottom:4px">${ev.name||ev.track}</div>
        <div style="font-size:13px;color:var(--simr-muted)">${dateStr}</div>
        <div style="font-size:12px;color:var(--simr-muted);margin-top:4px">${driverIds.length} drivers · ${raceSessions.length} race${raceSessions.length!==1?'s':''}</div>
      </div>
      <div style="text-align:right">
        ${roundWinner ? `
          <div style="font-size:11px;color:var(--simr-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em">Round winner</div>
          <div style="font-size:16px;font-weight:600;color:var(--simr-amber)">🏆 ${driverLabel(roundWinner)}</div>
        ` : ''}
        ${ev.is_published ? '<div style="font-size:11px;color:var(--simr-green);margin-top:4px">● Published</div>' : '<div style="font-size:11px;color:var(--simr-hint)">○ Not yet published</div>'}
      </div>
    </div>
  </div>`;

  if(!raceSessions.length) {
    html += '<div class="card"><div style="color:var(--simr-muted);font-size:13px">No race results entered yet</div></div>';
    document.getElementById('event-detail').innerHTML = html;
    return;
  }

  // Build driver totals
  const driverTotals = {};
  driverIds.forEach(dId => { driverTotals[dId] = 0; });
  const baseMax = scoringConfig.length ? scoringConfig[0].points : 20;
  const sessPtsMapsByEvId = {};
  raceSessions.forEach(sess => {
    const sessResultsAll = evResults.filter(r=>r.session_id===sess.id);
    const sessMap = calcSessionPointsMap(sess, sessResultsAll, scoringConfig, baseMax);
    sessPtsMapsByEvId[sess.id] = sessMap;
    Object.entries(sessMap).forEach(([dId,pt])=>{ driverTotals[dId] = (driverTotals[dId]||0) + pt; });
  });
  const sortedDriverIds = [...driverIds].sort((a,b)=>(driverTotals[b]||0)-(driverTotals[a]||0));

  // Build interleaved columns: Q1 R1 Q2 R2 etc
  // Match grid sessions to races by race_number
  const maxRaces = raceSessions.length;
  const columns = []; // {type: 'grid'|'race', sess, num}
  for(let i=1; i<=maxRaces; i++) {
    const q = gridSessions.find(s=>s.race_number===i);
    const r = raceSessions.find(s=>s.race_number===i);
    if(q) columns.push({type:'grid', sess:q, num:i});
    if(r) columns.push({type:'race', sess:r, num:i});
  }
  // Any grid sessions not matched to a race
  gridSessions.forEach(q => {
    if(!columns.find(c=>c.sess.id===q.id)) columns.push({type:'grid', sess:q, num:q.race_number});
  });

  // Load session-level layouts if any sessions have circuit_layout_id
  const sessLayoutMap = {};
  const sessWithLayout = evSessions.filter(s=>s.circuit_layout_id);
  if(sessWithLayout.length) {
    const layoutIds = [...new Set(sessWithLayout.map(s=>s.circuit_layout_id))];
    const sessLayouts = await dbGet('circuit_layouts', `id=in.(${layoutIds.join(',')})`);
    sessLayouts.forEach(l=>sessLayoutMap[l.id]=l.name);
  }

  // Build table headers
  const colHeaders = columns.map(col => {
    const layoutLabel = col.sess.circuit_layout_id && sessLayoutMap[col.sess.circuit_layout_id]
      ? `<div style="font-size:9px;color:rgba(255,255,255,0.6);margin-top:2px">${sessLayoutMap[col.sess.circuit_layout_id]}</div>` : '';
    if(col.type==='grid') {
      const tagCls = col.sess.is_qualifying?'tquali':'tgrid';
      return `<th colspan="1" style="text-align:center;border-left:1px solid var(--simr-border)">
        <span class="tag ${tagCls}" style="font-size:9px">Q${col.num}</span>${layoutLabel}
      </th>`;
    } else {
      const tagCls = col.num===1?'tr1':col.num===2?'tr2':col.num===3?'tr3':'tr1';
      return `<th colspan="2" style="text-align:center;border-left:1px solid var(--simr-border)">
        <span class="tag ${tagCls}" style="font-size:9px">RACE ${col.num}</span>${layoutLabel}
      </th>`;
    }
  }).join('');

  const subHeaders = columns.map(col => {
    if(col.type==='grid') {
      return `<th style="width:40px;border-left:1px solid var(--simr-border);font-size:9px">Grid</th>`;
    } else {
      return `<th style="width:45px;border-left:1px solid var(--simr-border);font-size:9px">Pos</th><th style="width:40px;font-size:9px">Pts</th>`;
    }
  }).join('');

  // Build rows
  const rows = sortedDriverIds.map((dId, i) => {
    const drv = state.currentDrivers.find(d=>d.id===dId);
    const posCls = i===0?'pg':i===1?'ps':i===2?'pb':'';
    const isRoundWinner = dId === ev.round_winner_id;
    const sdEntry = (window._seasonDriversCache||{})[dId];
    const carBadge = ev.is_multi_car && sdEntry?.car_model ? `<span style="font-size:11px;color:var(--simr-muted);font-weight:400;margin-left:6px">— ${sdEntry.car_model}</span>` : '';

    const cols = columns.map(col => {
      const r = evResults.find(res=>res.session_id===col.sess.id&&res.driver_id===dId);
      if(col.type==='grid') {
        if(!r) return `<td style="border-left:1px solid var(--simr-border);color:var(--simr-hint)">—</td>`;
        const isPole = r.position===1 && col.sess.is_qualifying;
        const gridColor = isPole?'color:#d4a820;font-weight:600':r.position===2?'color:#8a9aaa':r.position===3?'color:#c07030':'color:var(--simr-muted)';
        return `<td style="border-left:1px solid var(--simr-border);${gridColor}">P${r.position}</td>`;
      } else {
        if(!r) return `<td style="border-left:1px solid var(--simr-border);color:var(--simr-hint)">—</td><td style="color:var(--simr-hint)">—</td>`;
        const pts = sessPtsMapsByEvId[col.sess.id]?.[r.driver_id] || 0;
        const posStyle = r.dnf?'color:var(--simr-red)':r.position===1?'color:#d4a820;font-weight:600':r.position===2?'color:#8a9aaa;font-weight:600':r.position===3?'color:#c07030;font-weight:600':'';
        return `<td style="border-left:1px solid var(--simr-border);${posStyle}">${r.dnf?'DNF':'P'+r.position}</td>
                <td style="font-weight:600">${pts||'—'}</td>`;
      }
    }).join('');

    return `<tr>
      <td class="${posCls}">${i+1}</td>
      <td style="font-weight:600">${driverLabel(drv)}${isRoundWinner?' 🏆':''}${carBadge}</td>
      ${cols}
      <td style="font-weight:700;color:var(--simr-amber);border-left:2px solid var(--simr-border2)">${driverTotals[dId]||0}</td>
    </tr>`;
  }).join('');

  html += `<div class="card" style="padding:0;overflow:hidden">
    <div style="overflow-x:auto"><table style="table-layout:auto;min-width:500px">
      <thead>
        <tr>
          <th style="width:32px" rowspan="2">Pos</th>
          <th style="min-width:120px" rowspan="2">Driver</th>
          ${colHeaders}
          <th style="width:55px;border-left:2px solid var(--simr-border2)" rowspan="2">Total</th>
        </tr>
        <tr>${subHeaders}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;

  // Fastest lap notes per race
  const flNotes = raceSessions.map(sess => {
    const sessResults = evResults.filter(r=>r.session_id===sess.id);
    const flResult = sessResults.find(r=>r.fastest_lap);
    if(!flResult) return null;
    const flDriver = state.currentDrivers.find(d=>d.id===flResult.driver_id);
    const lapTime = flResult.lap_time ? ` — ${flResult.lap_time}` : '';
    return `<span style="margin-right:16px"><span style="color:var(--simr-text);font-weight:600">R${sess.race_number} FL:</span> <span style="font-weight:600;color:var(--simr-purple)">${driverLabel(flDriver)}${lapTime}</span></span>`;
  }).filter(Boolean);

  if(flNotes.length) {
    html += `<div style="margin-top:10px;padding:10px 14px;background:var(--simr-surface2);border-radius:6px;border:1px solid var(--simr-border);font-size:12px">
      <span style="color:var(--simr-amber);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:6px">⚡ Fastest laps</span>
      ${flNotes.join('')}
    </div>`;
  }

  // Admin edit buttons for race sessions
  if(state.isAdmin) {
    html += `<div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">`;
    // Grid sessions
    gridSessions.forEach((sess, i) => {
      html += `<button class="btn btn-sm" onclick="editSession('${sess.id}','${evId}')" style="font-size:11px">${sess.is_qualifying?'Edit Q':'Edit G'}${i+1}</button>
               <button class="btn btn-sm" onclick="deleteSession('${sess.id}','${evId}')" style="font-size:11px;color:var(--simr-red)">Del ${sess.is_qualifying?'Q':'G'}${i+1}</button>`;
    });
    // Race sessions
    raceSessions.forEach(sess => {
      html += `<button class="btn btn-sm" onclick="editSession('${sess.id}','${evId}')" style="font-size:11px">Edit R${sess.race_number}</button>
               <button class="btn btn-sm" onclick="deleteSession('${sess.id}','${evId}')" style="font-size:11px;color:var(--simr-red)">Del R${sess.race_number}</button>`;
    });
    html += `</div>`;
  }

  // Race director's notes
  const notesContent = ev.director_notes || '';
  const adminEdit = state.isAdmin ? `
    <div style="margin-top:8px">
      <textarea id="director-notes-input" rows="3" style="width:100%;background:var(--simr-surface2);border:1px solid var(--simr-border);border-radius:4px;padding:8px;color:var(--simr-text);font-size:12px;resize:vertical" placeholder="Log incidents, penalties, technical DNFs, post-race decisions...">${notesContent}</textarea>
      <button class="btn btn-sm" onclick="saveDirectorNotes('${evId}')" style="margin-top:6px;font-size:11px">Save notes</button>
    </div>` : notesContent ? `<div style="font-size:13px;color:var(--simr-text);line-height:1.6;white-space:pre-wrap">${notesContent}</div>` : '<div style="font-size:12px;color:var(--simr-hint)">No notes for this event</div>';

  html += `<div class="card" style="margin-top:14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div class="card-title" style="margin-bottom:0">📋 Race director's notes</div>
    </div>
    ${adminEdit}
  </div>`;

  html += `</div>`;
  document.getElementById('event-detail').innerHTML = html;
}

async function saveDirectorNotes(evId) {
  const notes = document.getElementById('director-notes-input').value.trim();
  try {
    await dbPatch('events', `id=eq.${evId}`, {director_notes: notes});
    toast('Notes saved');
    // refresh resultsData
    _resultsData.events = await dbGet('events', `series_id=eq.${state.currentSeriesId}`);
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

// Transitional compatibility for the existing inline event attributes.
// New components should bind events in JavaScript; this surface can then shrink away.
const legacyUiActions = {
  addCar, addCircuitLayout, addDriver, addEditRow, addPointsRow, addResultRow,
  adminLogout, applyAI, applyEvScorePreset, applyPreset, applyScoredPresetByKey,
  cancelSessionBuilder, checkMultiCarAssignment, checkUnmatchedDrivers, clearResults,
  closeAdminMenu, closeStatsModal, confirmEndEvent, confirmEndGroup, confirmEndSeason,
  createSeason, cycleSlot, deleteCar, deleteDriver, deleteEventFromSetup, deleteLayout,
  deleteScorePreset, deleteSeason, deleteSession, doLogin, dzDrop, dzLeave, dzOver,
  editCar, editDriverModal, editEventSessions, editSeasonModal, editSession, endEventModal,
  endGroupModal, endSeasonModal, enforceEditFL, filterAllTime, filterAllTimeClass,
  filterLapRecords, filterResults, handleImg, loadEntrantsForSeason, loadEventIntoEditor,
  loadExhibitionEntrants, loadGridFromSession, loadLayoutsForCircuit, loadScoringConfig,
  loadShareEvents, loadStandings, navTo, onEREventSelect, openStatsModal,
  renderEvScoringRows, renderScoringRows, renderSequencer, renderShareViews,
  resetEventEditor, saveDirectorNotes, saveDriverEdit, saveDriverStats, saveEditedSession,
  saveEventEditor, saveExhibitionDriver, saveResults, saveScorePreset, saveScoringConfig,
  saveSeasonDriver, saveSeasonEdit, saveSessionBuilder, selectDriver, selectResultEvent,
  setShareStyle, showAdminPage, showGroupStandings, showPage, sortAllTime, toggleAdminMenu,
  toggleCarMode, toggleEvGroupMode, toggleEvType, toggleResultsSection, toggleSection,
  toggleTheme, unpublishEvent, updateResultsSessionLabel, updateSequencerPreview
};

Object.assign(window, legacyUiActions);
Object.defineProperties(window, {
  _sequencerSlots: {
    configurable: true,
    get: () => _sequencerSlots,
    set: value => { _sequencerSlots = value; }
  },
  scoringRows: {
    configurable: true,
    get: () => scoringRows,
    set: value => { scoringRows = value; }
  }
});

init();
