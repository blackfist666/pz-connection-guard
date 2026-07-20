const { Tail } = require("tail");
const { exec } = require("child_process");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const zomboidLog = process.env.ZOMBOID_LOG_PATH || "/home/pzserver/Zomboid/server-console.txt";

const RCON_HOST = process.env.RCON_HOST || "localhost";
const RCON_PORT = process.env.RCON_PORT || "27015";
const RCON_PASSWORD = process.env.RCON_PASSWORD;
if (!RCON_PASSWORD) {
  console.error("RCON_PASSWORD is not set. Export it before starting steviewonder.");
  process.exit(1);
}
const rcon = `mcrcon -H ${RCON_HOST} -P ${RCON_PORT} -p '${RCON_PASSWORD}'`;

const STEAMCHECKER_URL = process.env.STEAMCHECKER_URL || "http://127.0.0.1:3000";

// ──────────────────────────────
// ✅ CONFIGURATION
// ──────────────────────────────

// Minimum account age (years)
const MIN_ACCOUNT_AGE_YEARS = 8;

// Minimum friend count
const MIN_FRIEND_COUNT = 15;

// Kick if Steam vs IP country mismatch
const KICK_ON_COUNTRY_MISMATCH = false;

// API cache TTL (minutes)
const API_CACHE_MINUTES = 10;

// Delays (seconds) from join time
const FIRST_KICK_DELAY_SECONDS = 45;
const SECOND_KICK_DELAY_SECONDS = 96;

// Kick threshold before ban
const KICK_THRESHOLD = 10;

// Kick even if passed checks
const KICK_ON_PASS = false;

// Kick messages
const KICK_MESSAGE_FAIL = ""
const KICK_MESSAGE_PASS = "";

// ──────────────────────────────

const auditDir = path.join(__dirname, "audit");
if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir);
const auditFile = path.join(
  auditDir,
  `steviewonder-${new Date().toISOString().slice(0, 10)}.log`
);
const logStream = fs.createWriteStream(auditFile, { flags: "a" });

function log(msg) {
  const line = `[${new Date().toISOString()}] [StevieWonder] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

const recentSeen = new Map();
const lastKicked = new Map();
const kicksHistory = new Map();
const sessions = new Map(); // steamId -> { username, joinTime }
const checkedUsers = new Map(); // steamId -> lastChecked timestamp

function seenRecently(steamId, ms = 1500) {
  const now = Date.now();
  const last = recentSeen.get(steamId) || 0;
  if (now - last < ms) return true;
  recentSeen.set(steamId, now);
  return false;
}

function extractIp(line) {
  const eq = line.match(/ip=([\d.]+)/);
  if (eq && eq[1]) return eq[1];
  const v4 = line.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  if (v4 && v4[1]) return v4[1];
  return "127.0.0.1";
}

function sanitizeUserForRcon(name) {
  return `${String(name).replace(/"/g, '\\"')}`;
}

function recordKick(steamId) {
  const nowSec = Math.floor(Date.now() / 1000);
  const arr = kicksHistory.get(steamId) || [];
  arr.push(nowSec);
  const cutoff = nowSec - 3600;
  const filtered = arr.filter((ts) => ts >= cutoff);
  kicksHistory.set(steamId, filtered);
  return filtered.length;
}

function clearCache(steamId) {
  checkedUsers.delete(steamId);
}

function banUser(username, steamId) {
  log(`BANNING user=${username} id=${steamId} (threshold reached)`);
  const cmd = `${rcon} "banid ${steamId}"`;
  exec(cmd, (err) => {
    if (err) log(`ban error for ${username} (${steamId}): ${err.message}`);
    else {
      log(`Banned ${username} (${steamId})`);
      clearCache(steamId);
    }
  });
}

function doKickExec(username, steamId, message) {
  const sanitizedName = sanitizeUserForRcon(username);
  const reason = message ? ` ${message}` : "";
  const cmd = `${rcon} "kickuser ${sanitizedName}${reason}"`;
  exec(cmd, (err) => {
    if (err)
      log(`kick error for ${username} (${steamId}): ${err.message}`);
    else log(`Kicked ${username} (${steamId})`);
  });
}

function prettyPrintAPI(label, steamId, info) {
  log(`${label} for ${steamId}:\n${JSON.stringify(info, null, 2)}`);
}

function scheduleKicks(username, steamId, joinTime, message) {
  // First kick
  setTimeout(() => {
    log(
      `Scheduled first kick for user=${username} id=${steamId} (${FIRST_KICK_DELAY_SECONDS}s from join)`
    );
    doKickExec(username, steamId, message);
    const count = recordKick(steamId);
    log(`Kick history user=${username} id=${steamId}: ${count} kicks in last 1 hour`);
    if (count >= KICK_THRESHOLD) banUser(username, steamId);
    clearCache(steamId);
  }, FIRST_KICK_DELAY_SECONDS * 1000 - (Date.now() - joinTime));

  // Second kick
  setTimeout(() => {
    log(
      `Scheduled second kick for user=${username} id=${steamId} (${SECOND_KICK_DELAY_SECONDS}s from join)`
    );
    doKickExec(username, steamId, message);
    const newCount = recordKick(steamId);
    log(
      `Post re-kick history user=${username} id=${steamId}: ${newCount} kicks in last 1 hour`
    );
    if (newCount >= KICK_THRESHOLD) banUser(username, steamId);
    clearCache(steamId);
  }, SECOND_KICK_DELAY_SECONDS * 1000 - (Date.now() - joinTime));
}

async function checkUser(username, steamId, ip) {
  try {
    log(`Checking user=${username} steamId=${steamId} ip=${ip}`);

    const wl = await axios.get(`${STEAMCHECKER_URL}/whitelist/${steamId}`);
    if (wl.data && wl.data.whitelisted) {
      log(`ALLOW (whitelist) user=${username} id=${steamId}`);
      return;
    }

    const res = await axios.get(
      `${STEAMCHECKER_URL}/check/${steamId}/${ip}`
    );
    const info = res.data;

    const now = Math.floor(Date.now() / 1000);
    const ageYears = info.created
      ? (now - info.created) / (60 * 60 * 24 * 365)
      : 0;

    // FAIL checks
    if (MIN_ACCOUNT_AGE_YEARS > 0 && ageYears < MIN_ACCOUNT_AGE_YEARS) {
      log(`Decision: FAIL (account too new) user=${username} id=${steamId}`);
      prettyPrintAPI("API data (fail)", steamId, info);
      scheduleKicks(
        username,
        steamId,
        sessions.get(steamId).joinTime,
        KICK_MESSAGE_FAIL
      );
      return;
    }

    if (MIN_FRIEND_COUNT > 0 && info.friendCount < MIN_FRIEND_COUNT) {
      log(`Decision: FAIL (too few friends) user=${username} id=${steamId}`);
      prettyPrintAPI("API data (fail)", steamId, info);
      scheduleKicks(
        username,
        steamId,
        sessions.get(steamId).joinTime,
        KICK_MESSAGE_FAIL
      );
      return;
    }

    if (
      KICK_ON_COUNTRY_MISMATCH &&
      info.steamCountry &&
      info.ipCountry &&
      info.steamCountry !== info.ipCountry
    ) {
      log(
        `Decision: FAIL (country mismatch Steam=${info.steamCountry} IP=${info.ipCountry}) user=${username} id=${steamId}`
      );
      prettyPrintAPI("API data (fail)", steamId, info);
      scheduleKicks(
        username,
        steamId,
        sessions.get(steamId).joinTime,
        KICK_MESSAGE_FAIL
      );
      return;
    }

    // PASS checks
    log(`Decision: PASS user=${username} id=${steamId}`);
    prettyPrintAPI("API data (passed)", steamId, info);

    if (KICK_ON_PASS) {
      log(
        `KICKING user=${username} id=${steamId} despite passing checks (KICK_ON_PASS enabled)`
      );
      scheduleKicks(
        username,
        steamId,
        sessions.get(steamId).joinTime,
        KICK_MESSAGE_PASS
      );
    }
  } catch (e) {
    log(`API error check for ${username} id=${steamId} (${e.message})`);
    scheduleKicks(
      username,
      steamId,
      sessions.get(steamId).joinTime,
      KICK_MESSAGE_FAIL
    );
  }
}

function endSession(steamId) {
  const session = sessions.get(steamId);
  if (session) {
    const durationMs = Date.now() - session.joinTime;
    const mins = Math.floor(durationMs / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);
    log(
      `DISCONNECT user=${session.username} steamId=${steamId} sessionLength=${mins}m${secs}s`
    );
    sessions.delete(steamId);
    checkedUsers.delete(steamId);
  } else {
    log(`DISCONNECT steamId=${steamId} (no session record)`);
  }
}

// ──────────────────────────────
// Tail the Zomboid log
// ──────────────────────────────

const tail = new Tail(zomboidLog);

tail.on("line", (line) => {
  // ---- JOIN detection ----
  if (line.includes("steam-id=") && line.includes("username=")) {
    const idMatch = line.match(/steam-id=(\d{5,})/);
    const userMatch = line.match(/username="([^"]+)"/);
    if (idMatch && userMatch) {
      const steamId = idMatch[1];
      const username = userMatch[1];
      if (!seenRecently(steamId)) {
        const ip = extractIp(line);
        log(`Detected user=${username} steamId=${steamId} ip=${ip}`);
        const now = Date.now();
        if (!sessions.has(steamId)) {
          sessions.set(steamId, { username, joinTime: now });
        }
        const lastChecked = checkedUsers.get(steamId) || 0;
        if (now - lastChecked < API_CACHE_MINUTES * 60 * 1000) {
          log(`ALLOW (cached) user=${username} id=${steamId}`);
        } else {
          checkedUsers.set(steamId, now);
          checkUser(username, steamId, ip);
        }
      }
    }
  }

  // ---- DISCONNECT detection ----
  if (
    line.includes("playerDisconnected") &&
    !line.includes("PlayerConnectionMessage")
  ) {
    const userMatch = line.match(/playerDisconnected\s+(\w+)/);
    if (userMatch) {
      log(`DISCONNECT user=${userMatch[1]}`);
    }
  }

  if (line.includes("Finally disconnected client")) {
    const idMatch = line.match(/Finally disconnected client (\d{5,})/);
    if (idMatch) endSession(idMatch[1]);
  }

  if (line.includes("CloseConnection: Finally disconnected")) {
    const idMatch = line.match(/SteamID=(\d{5,})/);
    if (idMatch) endSession(idMatch[1]);
  }
});

tail.on("error", (err) => log(`Tail error: ${err.message}`));

log(`Started monitoring ${zomboidLog}`);
