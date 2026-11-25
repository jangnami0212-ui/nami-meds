// 나미 투약 알림 발송기 (Cloudflare Workers) — 5분마다 정확히 실행된다.
// 오늘(한국 시간) 먹일 시간이 지났는데 아무도 체크하지 않은 약이 있으면
// 알림을 켠 휴대폰마다 푸시를 보낸다. 1차: 시간이 되면, 2차: 15분 뒤에도 기록이 없으면.
// 웹 푸시 암호화(aes128gcm)와 VAPID 서명은 WebCrypto로 직접 한다.

const REMIND_AFTER = 15; // 분
const WINDOW = 180;      // 이보다 오래된 투약은 알리지 않는다(분)

export default {
  async scheduled(_ev, env, ctx) { ctx.waitUntil(run(env).then(r => console.log(r.summary))); },
  // 수동 확인용: /run?key=<RUN_KEY>&dry=1
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname !== "/run" || !env.RUN_KEY || u.searchParams.get("key") !== env.RUN_KEY) return new Response("ok");
    const r = await run(env, {dry: u.searchParams.get("dry") === "1"});
    return Response.json(r);
  },
};

/* ---------- Firestore REST ---------- */
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
function store(env) {
  const ROOT = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT || "nami-meds-app"}/databases/(default)/documents/families/${env.FAMILY_ID}`;
  async function api(path, init = {}) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${ROOT}/${path}${sep}key=${env.FIREBASE_API_KEY}`, init);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return res.status === 204 ? {} : res.json();
  }
  return {
    async list(coll) {
      const out = []; let token = "";
      do {
        const r = await api(`${coll}?pageSize=300${token ? "&pageToken=" + token : ""}`);
        for (const d of (r?.documents || [])) out.push({id: d.name.split("/").pop(), ...decFields(d.fields || {})});
        token = r?.nextPageToken || "";
      } while (token);
      return out;
    },
    getDoc: async p => { const r = await api(p); return r ? decFields(r.fields || {}) : null; },
    putDoc: (p, obj) => api(p, {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({fields: enc(obj).mapValue.fields})}),
    delDoc: p => api(p, {method: "DELETE"}),
  };
}

/* ---------- 할 일 고르기 ---------- */
async function run(env, {dry = false} = {}) {
  const db = store(env);
  const SITE = env.SITE_URL || "https://nami-meds-app.web.app";
  const kst = new Date(Date.now() + 9 * 3600e3);
  const pad = n => String(n).padStart(2, "0");
  const today = `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`;
  const nowMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const dayNum = k => Date.UTC(...k.split("-").map((n, i) => i === 1 ? n - 1 : +n)) / 86400e3;
  const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const dueOn = (m, k) => !!m.start && k >= m.start && !(m.end && k > m.end) && (dayNum(k) - dayNum(m.start)) % (m.every || 1) === 0;

  const [meds, log, sentDoc, pet, subs] = await Promise.all([
    db.list("meds"), db.getDoc(`logs/${today}`), db.getDoc(`sent/${today}`), db.getDoc("meta/pet"), db.list("subs"),
  ]);
  const entries = log?.entries || {};
  const sent = sentDoc?.keys || {};
  const petName = pet?.name || "나미";

  const groups = new Map();
  const updates = {};
  for (const m of meds) {
    if (!m.name || !dueOn(m, today)) continue;
    for (const t of (m.times || [])) {
      const key = `${m.id}@${t}`;
      const age = nowMin - toMin(t);
      if (age < 0 || age > WINDOW) continue;
      if (entries[key]) continue;
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
      url: `${SITE}/?f=${env.FAMILY_ID}`,
    };
  });

  // 같은 투약을 두 번 보내지 않도록, 보내기 전에 기록부터 남긴다
  if (Object.keys(updates).length && !dry) await db.putDoc(`sent/${today}`, {date: today, keys: {...sent, ...updates}});

  const results = [];
  if (messages.length && !dry) {
    for (const s of subs) {
      for (const msg of messages) {
        try {
          const status = await sendPush(s, JSON.stringify(msg), env, SITE);
          results.push(`${s.who || s.id}: ${status}`);
          if (status === 404 || status === 410) { await db.delDoc(`subs/${s.id}`); break; }
        } catch (e) { results.push(`${s.who || s.id}: error ${e.message}`); }
      }
    }
  }
  const summary = `${today} ${pad(Math.floor(nowMin / 60))}:${pad(nowMin % 60)} KST · meds ${meds.length} · subs ${subs.length} · messages ${messages.length}` +
    messages.map(m => `\n - ${m.title} / ${m.body}`).join("") + (results.length ? "\n " + results.join(", ") : "");
  return {summary, messages, results};
}

/* ---------- 웹 푸시 (RFC 8291 aes128gcm + RFC 8292 VAPID) ---------- */
const te = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({name: "HKDF", hash: "SHA-256", salt, info}, key, len * 8));
}

let vapidKey;
async function vapidJwt(aud, env, site) {
  if (!vapidKey) {
    const pub = unb64u(env.VAPID_PUBLIC);
    vapidKey = await crypto.subtle.importKey("jwk", {
      kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true,
    }, {name: "ECDSA", namedCurve: "P-256"}, false, ["sign"]);
  }
  const header = b64u(te.encode(JSON.stringify({typ: "JWT", alg: "ES256"})));
  const claims = b64u(te.encode(JSON.stringify({aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: site})));
  const sig = await crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, vapidKey, te.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64u(sig)}`;
}

async function sendPush(sub, payload, env, site) {
  const uaPub = unb64u(sub.keys.p256dh);
  const auth = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, {name: "ECDH", namedCurve: "P-256"}, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name: "ECDH", public: uaKey}, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv: nonce}, key, concat(te.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  const body = concat(salt, rs, new Uint8Array([asPub.length]), asPub, cipher);

  const aud = new URL(sub.endpoint).origin;
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "3600",
      Urgency: "high",
      Authorization: `vapid t=${await vapidJwt(aud, env, site)}, k=${env.VAPID_PUBLIC}`,
    },
    body,
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`${res.status} ${await res.text()}`);
  return res.status;
}
