'use strict';
/*
 * steam-lib.js - zero-dependency Steam local library reader for sidescreen-dashboard.
 * CommonJS, sync-only API (caller is low-frequency / dashboard polling).
 *
 * module.exports = { findSteam, listGames, downloads, launchCmd,
 *                     BIGPICTURE, STORE, LIBRARY, FRIENDS }
 *
 * findSteam() -> string | null
 *   Reads HKCU\Software\Valve\Steam\SteamPath via `reg query`. Falls back to
 *   the default "C:\Program Files (x86)\Steam" if the registry key is
 *   missing/unreadable and that default path exists on disk. Returns null if
 *   nothing can be found. Never throws.
 *
 * listGames() -> [{ appid, name, sizeGB, updating, lastPlayed }]
 *   Parses steamapps/libraryfolders.vdf to find every Steam library folder,
 *   then parses each library's steamapps/appmanifest_*.acf (hand-rolled VDF
 *   text parser). Sorted by lastPlayed descending (never-played games, i.e.
 *   lastPlayed === 0, sort last). Missing files/dirs => [] , never throws.
 *
 * downloads() -> [{ appid, name, bytesDownloaded, bytesToDownload }]
 *   Subset of listGames() sources that are currently updating/downloading
 *   (StateFlags has bit 2 "update required" or bit 1024 "downloading" set,
 *   or bit 4 "fully installed" is NOT set). bytesDownloaded/bytesToDownload
 *   are omitted if not present in the manifest.
 *
 * launchCmd(appid) -> 'steam://rungameid/<appid>'
 *
 * Constants: BIGPICTURE, STORE, LIBRARY, FRIENDS (steam:// URIs).
 */

var fs = require('fs');
var path = require('path');
var execFileSync = require('child_process').execFileSync;

var DEFAULT_STEAM_PATH = 'C:\\Program Files (x86)\\Steam';

// StateFlags bits observed in appmanifest_*.acf (Valve does not document
// these publicly; values below are the commonly-known community mapping).
var STATE_FLAG = {
  UPDATE_REQUIRED: 2,
  FULLY_INSTALLED: 4,
  UPDATE_RUNNING: 8, // sometimes set together with 2 while patching
  DOWNLOADING: 1024
};

// ---------------------------------------------------------------------------
// Registry / path discovery
// ---------------------------------------------------------------------------

function findSteam() {
  try {
    var out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8', windowsHide: true }
    );
    // Example line: "    SteamPath    REG_SZ    D:/software/steam"
    var m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m && m[1]) {
      var p = m[1].trim().replace(/\//g, '\\');
      if (p && dirExists(p)) return p;
    }
  } catch (e) {
    // registry key missing, `reg` unavailable, non-Windows, etc. -> fall through
  }

  if (dirExists(DEFAULT_STEAM_PATH)) return DEFAULT_STEAM_PATH;
  return null;
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Minimal VDF (Valve KeyValues) text parser
//
// Only handles what appmanifest_*.acf / libraryfolders.vdf actually use:
// quoted "key" "value" pairs and quoted "key" { ... } nested blocks. Good
// enough to build a plain nested-object tree; not a general VDF parser.
// ---------------------------------------------------------------------------

function parseVDF(text) {
  var root = {};
  var stack = [root];
  var i = 0;
  var len = text.length;

  function skipWhitespaceAndComments() {
    for (;;) {
      while (i < len && /\s/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < len && text[i] !== '\n') i++;
        continue;
      }
      break;
    }
  }

  function readQuoted() {
    // assumes text[i] === '"'
    i++; // skip opening quote
    var start = i;
    var buf = '';
    while (i < len) {
      var ch = text[i];
      if (ch === '\\' && i + 1 < len) {
        buf += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        return buf;
      }
      buf += ch;
      i++;
    }
    return buf; // unterminated string at EOF, be lenient
  }

  while (i < len) {
    skipWhitespaceAndComments();
    if (i >= len) break;

    if (text[i] === '}') {
      i++;
      if (stack.length > 1) stack.pop();
      continue;
    }

    if (text[i] !== '"') {
      // stray token we don't understand; skip it to avoid infinite loop
      i++;
      continue;
    }

    var key = readQuoted();
    skipWhitespaceAndComments();

    if (text[i] === '{') {
      i++;
      var child = {};
      stack[stack.length - 1][key] = child;
      stack.push(child);
      continue;
    }

    if (text[i] === '"') {
      var value = readQuoted();
      stack[stack.length - 1][key] = value;
      continue;
    }

    // key with neither a block nor a quoted value follows -> ignore
  }

  return root;
}

function readVDFFile(filePath) {
  try {
    var text = fs.readFileSync(filePath, 'utf8');
    return parseVDF(text);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Library folders / appmanifest discovery
// ---------------------------------------------------------------------------

function normalizeLibPath(p) {
  return path.normalize(p.replace(/\\\\/g, '\\')).toLowerCase().replace(/[\\/]+$/, '');
}

function getLibraryFolders(steamPath) {
  var seen = {};
  var libs = [];

  function add(p) {
    var key = normalizeLibPath(p);
    if (!seen[key]) {
      seen[key] = true;
      libs.push(p);
    }
  }

  add(steamPath);

  var vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  var tree = readVDFFile(vdfPath);
  if (!tree) return libs;

  var libraryfolders = tree.libraryfolders || tree.LibraryFolders;
  if (!libraryfolders || typeof libraryfolders !== 'object') return libs;

  // libraryfolders.vdf lists EVERY library including the main Steam install
  // itself (commonly as index "0"), so entries must be deduped against the
  // steamPath we already added, not just against each other.
  Object.keys(libraryfolders).forEach(function (key) {
    var entry = libraryfolders[key];
    var libPath = null;
    if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
      libPath = entry.path;
    } else if (typeof entry === 'string' && /[\\/]/.test(entry)) {
      // older libraryfolders.vdf format: "1" "D:\\SteamLibrary"
      libPath = entry;
    }
    if (libPath) add(libPath);
  });

  return libs;
}

function listAppManifestFiles(libraryPath) {
  var steamappsDir = path.join(libraryPath, 'steamapps');
  var entries;
  try {
    entries = fs.readdirSync(steamappsDir);
  } catch (e) {
    return [];
  }
  return entries
    .filter(function (f) {
      return /^appmanifest_\d+\.acf$/i.test(f);
    })
    .map(function (f) {
      return path.join(steamappsDir, f);
    });
}

function toInt(v, fallback) {
  if (v == null) return fallback;
  var n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

function parseAppManifest(filePath) {
  var tree = readVDFFile(filePath);
  if (!tree) return null;
  var state = tree.AppState || tree.appstate;
  if (!state || typeof state !== 'object') return null;

  var appid = toInt(state.appid, null);
  if (appid == null) return null;

  return {
    appid: appid,
    name: state.name || ('App ' + appid),
    sizeOnDisk: toInt(state.SizeOnDisk, 0),
    stateFlags: toInt(state.StateFlags, 0),
    lastPlayed: toInt(state.LastPlayed, 0),
    bytesDownloaded: state.BytesDownloaded,
    bytesToDownload: state.BytesToDownload
  };
}

function isUpdating(stateFlags) {
  if ((stateFlags & STATE_FLAG.FULLY_INSTALLED) === 0) return true;
  if ((stateFlags & STATE_FLAG.UPDATE_REQUIRED) !== 0) return true;
  if ((stateFlags & STATE_FLAG.DOWNLOADING) !== 0) return true;
  if ((stateFlags & STATE_FLAG.UPDATE_RUNNING) !== 0) return true;
  return false;
}

function collectManifests() {
  var steamPath = findSteam();
  if (!steamPath) return [];

  var libraries = getLibraryFolders(steamPath);
  var manifests = [];

  libraries.forEach(function (lib) {
    listAppManifestFiles(lib).forEach(function (manifestPath) {
      var parsed = parseAppManifest(manifestPath);
      if (parsed) manifests.push(parsed);
    });
  });

  return manifests;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function listGames() {
  var manifests;
  try {
    manifests = collectManifests();
  } catch (e) {
    return [];
  }

  var games = manifests.map(function (m) {
    return {
      appid: m.appid,
      name: m.name,
      sizeGB: Math.round((m.sizeOnDisk / 1073741824) * 100) / 100,
      updating: isUpdating(m.stateFlags),
      lastPlayed: m.lastPlayed
    };
  });

  games.sort(function (a, b) {
    return b.lastPlayed - a.lastPlayed;
  });

  return games;
}

function downloads() {
  var manifests;
  try {
    manifests = collectManifests();
  } catch (e) {
    return [];
  }

  return manifests
    .filter(function (m) {
      return isUpdating(m.stateFlags);
    })
    .map(function (m) {
      var entry = { appid: m.appid, name: m.name };
      if (m.bytesDownloaded != null) {
        entry.bytesDownloaded = toInt(m.bytesDownloaded, 0);
      }
      if (m.bytesToDownload != null) {
        entry.bytesToDownload = toInt(m.bytesToDownload, 0);
      }
      return entry;
    });
}

function launchCmd(appid) {
  return 'steam://rungameid/' + appid;
}

module.exports = {
  findSteam: findSteam,
  listGames: listGames,
  downloads: downloads,
  launchCmd: launchCmd,
  BIGPICTURE: 'steam://open/bigpicture',
  STORE: 'steam://store',
  LIBRARY: 'steam://open/games',
  FRIENDS: 'steam://open/friends'
};
