// JSON ファイルによるシンプルな永続化。単一サーバー運用を前提にしている。
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let data = { users: [], sessions: [], events: [] };
let saveTimer = null;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    data = { users: [], sessions: [], events: [], ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  }
  const now = Date.now();
  data.sessions = data.sessions.filter((s) => s.expiresAt > now);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// カウントは高頻度で変わるので書き込みをまとめる
function save() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 1000);
}

module.exports = {
  load,
  save,
  saveNow,
  get data() {
    return data;
  },
};
