// 나미 투약 알림 발송기 — GitHub Actions가 5분마다 실행한다.
// 오늘(한국 시간) 먹일 시간이 지났는데 아무도 체크하지 않은 약이 있으면
// 알림을 켠 휴대폰마다 푸시를 보낸다. 1차: 시간이 되면, 2차: 30분 뒤에도 기록이 없으면.
import webpush from "web-push";

const env = process.env;
const PROJECT = env.FIREBASE_PROJECT || "nami-meds-app";
const API_KEY = env.FIREBASE_API_KEY;
const FAMILY = env.FAMILY_ID;
const SITE = env.SITE_URL || "https://nami-meds-app.web.app";
const DRY = env.DRY_RUN === "1";
for (const [k, v] of Object.entries({FIREBASE_API_KEY: API_KEY, FAMILY_ID: FAMILY})) if (!v) { console.error(`missing ${k}`); process.exit(1); }
if (!DRY) webpush.setVapidDetails(SITE, env.VAPID_PUBLIC, env.VAPID_PRIVATE);

const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/families/${FAMILY}`;
const REMIND_AFTER = 30;   // 분
const WINDOW = 180;        // 이보다 오래된 투약은 알리지 않는다(분)

/* Firestore REST 값 <-> JS 값 */
function dec(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
  if ("mapValue" in v) return decFields(v.mapValue.fields || {});
  return null;
}
const decFields = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, dec(v)]));
function enc(x) {
  if (x === null || x === undefined) return {nullValue: null};
  if (typeof x === "number") return Number.isInteger(x) ? {integerValue: String(x)} : {doubleValue: x};
  if (typeof x === "boolean") return {booleanValue: x};
  if (typeof x === "string") return {stringValue: x};
  if (Array.isArray(x)) return {arrayValue: {values: x.map(enc)}};
  return {mapValue: {fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, enc(v)]))}};
}
async function api(path, init = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${ROOT}/${path}${sep}key=${API_KEY}`, init);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? {} : res.json();
}
async function list(coll) {
  const out = []; let token = "";
  do {
    const r = await api(`${coll}?pageSize=300${token ? "&pageToken=" + token : ""}`);
    for (const d of (r?.documents || [])) out.push({id: d.name.split("/").pop(), ...decFields(d.fields || {})});
    token = r?.nextPageToken || "";
  } while (token);
  return out;
}
const getDoc = async p => { const r = await api(p); return r ? decFields(r.fields || {}) : null; };
const putDoc = (p, obj) => api(p, {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({fields: enc(obj).mapValue.fields})});
const delDoc = p => api(p, {method: "DELETE"});

/* 날짜(한국 시간) */
const kst = new Date(Date.now() + 9 * 3600e3);
const pad = n => String(n).padStart(2, "0");
const today = `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`;
const nowMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
const dayNum = k => Date.UTC(...k.split("-").map((n, i) => i === 1 ? n - 1 : +n)) / 86400e3;
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
function dueOn(m, k) {
  if (!m.start || k < m.start) return false;
  if (m.end && k > m.end) return false;
  return (dayNum(k) - dayNum(m.start)) % (m.every || 1) === 0;
}

const [meds, log, sentDoc, pet, subs] = await Promise.all([
  list("meds"), getDoc(`logs/${today}`), getDoc(`sent/${today}`), getDoc("meta/pet"), list("subs"),
]);
const entries = log?.entries || {};
const sent = sentDoc?.keys || {};
const petName = pet?.name || "나미";

// 보낼 것 고르기: 시간별로 묶는다
const groups = new Map(); // "t|stage" -> [{m}]
const updates = {};
for (const m of meds) {
  if (!m.name || !dueOn(m, today)) continue;
  for (const t of (m.times || [])) {
    const key = `${m.id}@${t}`;
    const age = nowMin - toMin(t);
    if (age < 0 || age > WINDOW) continue;
    if (entries[key]) continue;               // 누군가 먹였거나 건너뜀
    const stage = sent[key] || 0;
    let next = 0;
    if (stage === 0) next = age >= REMIND_AFTER ? 2 : 1;
    else if (stage === 1 && age >= REMIND_AFTER) next = 2;
    if (!next) continue;
    const g = `${t}|${next}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
    updates[key] = next;
  }
}

const messages = [...groups.entries()].map(([g, ms]) => {
  const [t, stage] = g.split("|");
  const what = ms.map(m => `${m.name}${m.dose ? " " + m.dose : ""}`).join(", ");
  return {
    title: stage === "1" ? `${petName} 약 먹일 시간이에요` : `${petName} 약, 아직 기록이 없어요`,
    body: stage === "1" ? `${t} · ${what}` : `${t} 약을 먹였다면 앱에서 체크해 주세요 · ${what}`,
    tag: `nami-${today}-${t}`,
    url: `${SITE}/?f=${FAMILY}`,
  };
});

console.log(`${today} ${pad(Math.floor(nowMin / 60))}:${pad(nowMin % 60)} KST · meds ${meds.length} · subs ${subs.length} · messages ${messages.length}`);
for (const msg of messages) console.log(` - ${msg.title} / ${msg.body}`);

if (messages.length && !DRY) {
  for (const s of subs) {
    for (const msg of messages) {
      try {
        await webpush.sendNotification({endpoint: s.endpoint, keys: s.keys}, JSON.stringify(msg), {TTL: 3600, urgency: "high"});
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { console.log(`   removing expired subscription (${s.who || s.id})`); await delDoc(`subs/${s.id}`); break; }
        console.error(`   send failed (${s.who || s.id}): ${e.statusCode || ""} ${e.body || e.message}`);
      }
    }
  }
}
if (Object.keys(updates).length && !DRY) await putDoc(`sent/${today}`, {date: today, keys: {...sent, ...updates}});
