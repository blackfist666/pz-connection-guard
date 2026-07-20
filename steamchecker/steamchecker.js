const fs = require("fs");
const path = require("path");
const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

const STEAM_API_KEY = process.env.STEAM_API_KEY || "";
const IPINFO_TOKEN  = process.env.IPINFO_TOKEN  || "";

let whitelist = new Set();

const auditDir = path.join(__dirname, "audit");
if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir);
const logFile = path.join(auditDir, `steamchecker-${new Date().toISOString().slice(0,10)}.log`);
const logStream = fs.createWriteStream(logFile, { flags: "a" });
function log(msg) {
  const line = `[${new Date().toISOString()}] [SteamChecker] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

function loadWhitelist() {
  try {
    const data = fs.readFileSync(path.join(__dirname, "stevies_list.txt"), "utf8");
    const ids = data.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
    whitelist = new Set(ids);
    log(`Loaded ${whitelist.size} whitelist entries`);
  } catch (e) {
    log(`No whitelist file found (${e.message})`);
  }
}

async function getSteamInfo(steamId) {
  log(`Fetching Steam profile info id=${steamId}`);

  const summaryRes = await fetch(
    `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`
  );
  const summaryData = await summaryRes.json();
  const player = summaryData.response?.players?.[0] || {};

  const friendsRes = await fetch(
    `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${STEAM_API_KEY}&steamid=${steamId}&relationship=friend`
  );
  const friendsData = await friendsRes.json();

  const info = {
    steamId,
    personaName: player.personaname || null,
    profileUrl: player.profileurl || null,
    isPrivate: player.communityvisibilitystate !== 3,
    created: player.timecreated || null,
    friendCount: friendsData.friendslist?.friends?.length || 0,
    steamCountry: player.loccountrycode || null
  };

  log(`Steam info id=${steamId}: ${JSON.stringify(info)}`);
  return info;
}

async function getIpInfo(ip) {
  log(`Fetching IP info ip=${ip}`);
  const res = await fetch(`https://ipinfo.io/${ip}?token=${IPINFO_TOKEN}`);
  const data = await res.json();
  const info = { ip: data.ip || ip, ipCountry: data.country || null };
  log(`IP info: ${JSON.stringify(info)}`);
  return info;
}

app.get("/whitelist/:steamid", (req, res) => {
  const id = req.params.steamid;
  const ok = whitelist.has(id);
  log(`Whitelist check id=${id}: ${ok ? "ALLOW" : "MISS"}`);
  res.json({ whitelisted: ok });
});

app.get("/check/:steamId/:ip", async (req, res) => {
  const steamId = req.params.steamId;
  const ip = req.params.ip;

  if (whitelist.has(steamId)) {
    log(`ALLOW (whitelist) id=${steamId}`);
    return res.json({ whitelisted: true });
  }

  try {
    const [steamInfo, ipInfo] = await Promise.all([ getSteamInfo(steamId), getIpInfo(ip) ]);
    const merged = { ...steamInfo, ...ipInfo, whitelisted: false };
    log(`Check result id=${steamId}: ${JSON.stringify(merged)}`);
    res.json(merged);
  } catch (err) {
    log(`Error /check id=${steamId}: ${err.message}`);
    res.status(500).json({ error: "API error" });
  }
});

loadWhitelist();
log(`API listening http://localhost:${PORT}`);
app.listen(PORT);
