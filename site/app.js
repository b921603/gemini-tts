// app.js — UI 層 (設定儲存、人聲選擇器、ffmpeg.wasm 載入、生成與結果)
import * as C from './core.js';
import { CONSENT_PHRASES } from './consent.js';
import { createHistory } from './history.js';

const $ = (s, r = document) => r.querySelector(s);
const SETTINGS_KEY = 'tts.settings.v1';
const DRAFT_KEY = 'tts.draft';
const KEY_KEY = 'tts.apikey';
const REMEMBER_KEY = 'tts.remember';
const SAVED_AT_KEY = 'tts.savedAt';

const safeGet = (st, k) => { try { return st.getItem(k); } catch { return null; } };
const safeSet = (st, k, v) => { try { st.setItem(k, v); } catch { /* 隱私模式等 */ } };
const safeDel = (st, k) => { try { st.removeItem(k); } catch { /* ignore */ } };

// --------------------------------------------------------------------------- //
// 設定
// --------------------------------------------------------------------------- //
function mergeCfg(saved) {
  const d = structuredClone(C.DEFAULTS);
  if (saved && typeof saved === 'object') for (const k of Object.keys(d)) if (k in saved) d[k] = saved[k];
  return d;
}
// --------------------------------------------------------------------------- //
// 執行環境:網頁版 (GitHub Pages) 或 本機版 (tts_gui.py 提供 /api)
// --------------------------------------------------------------------------- //
const rt = {
  local: false, hello: null,
  token: (() => { const t = document.querySelector('meta[name="tts-token"]')?.content || ''; return t.startsWith('__') ? '' : t; })(),
};
const lfetch = (path, opts = {}) => fetch('api/' + path, { ...opts, headers: { 'X-TTS-Token': rt.token, ...(opts.headers || {}) } });
async function ljson(path, method = 'GET', obj) {
  const res = await lfetch(path, {
    method,
    ...(obj !== undefined ? { body: JSON.stringify(obj), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
async function detectLocal() {
  if (!rt.token) return;
  try { rt.hello = await ljson('hello'); rt.local = true; } catch { rt.local = false; }
}
const keyAvailable = () => !!getKey() || !!(rt.local && rt.hello?.key_source);

let hadSaved = false;
let cfg = (() => {
  try {
    const raw = safeGet(localStorage, SETTINGS_KEY);
    if (raw) { hadSaved = true; return mergeCfg(JSON.parse(raw)); }
  } catch { /* 損毀則用預設 */ }
  return structuredClone(C.DEFAULTS);
})();

let saveTimer = 0;
function saveCfg() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushCfg, 200);
}
async function flushCfg() {
  clearTimeout(saveTimer);
  safeSet(localStorage, SETTINGS_KEY, JSON.stringify(cfg));
  safeSet(localStorage, SAVED_AT_KEY, new Date().toISOString());
  if (rt.local) { try { await ljson('settings', 'POST', cfg); } catch { /* 下次再同步 */ } }
}

const BIND = [
  ['out_format', 'text'], ['sample_rate', 'int'], ['bitrate', 'text'], ['loudnorm', 'bool'],
  ['speed', 'float'], ['keep_wav', 'bool'], ['autoplay', 'bool'], ['retries', 'int'],
  ['conversational', 'bool'], ['force_per_turn', 'bool'], ['gap_ms', 'int'], ['max_chars', 'int'], ['style', 'text'],
  ['batch', 'bool'], ['auto_save', 'bool'], ['out_dir', 'text'], ['ffmpeg_path', 'text'], ['gui_browser', 'text'], ['models_show_all', 'bool'], ['stream', 'bool'], ['preview_mode', 'text'], ['preview_chars', 'int'],
];

function readField(k, t) {
  const el = $('#' + k);
  if (t === 'bool') return el.checked;
  if (t === 'int') return Math.max(0, parseInt(el.value, 10) || 0);
  if (t === 'float') { const v = parseFloat(el.value); return Number.isFinite(v) ? Math.min(4, Math.max(0.25, v)) : 1; }
  return el.value.trim();
}

// --------------------------------------------------------------------------- //
// 模型清單:向 API 取得你帳戶可用的模型,自動挑最新世代的語音模型 (不綁定特定版本)
// --------------------------------------------------------------------------- //
const MODELS_CACHE_KEY = 'tts.models.v2';
const modelState = { raw: [], source: 'fallback', at: 0, loading: false, error: '', customMode: false };
(function loadModelCache() {
  try {
    const j = JSON.parse(safeGet(localStorage, MODELS_CACHE_KEY) || 'null');
    if (j && Array.isArray(j.raw) && j.raw.length) { modelState.raw = j.raw; modelState.at = j.at || 0; modelState.source = 'cache'; }
  } catch { /* 忽略 */ }
})();
function currentModels() {
  if (modelState.raw.length) return C.normalizeModelList(modelState.raw, cfg.models_show_all);
  return C.FALLBACK_TTS_MODELS.map((id) => ({ id, displayName: '' }));
}
const resolveModelNow = () => C.resolveModel(cfg.model, currentModels());
function renderModelSelect() {
  const sel = $('#modelSel');
  if (!sel) return;
  const list = currentModels();
  const auto = C.pickAutoModel(list) || C.FALLBACK_TTS_MODELS[0];
  sel.textContent = '';
  sel.add(new Option(`自動（推薦：${auto}）`, 'auto'));
  for (const it of list) sel.add(new Option(it.displayName && it.displayName !== it.id ? `${it.id}（${it.displayName}）` : it.id, it.id));
  sel.add(new Option('自訂模型 ID…', '__custom'));
  const known = list.some((x) => x.id === cfg.model);
  if (modelState.customMode || (cfg.model && cfg.model !== 'auto' && !known)) {   // 自訂模式 (含「剛選自訂、還沒填」的狀態)
    modelState.customMode = true;
    sel.value = '__custom';
    if (cfg.model && cfg.model !== 'auto') $('#modelCustom').value = cfg.model;
  } else if (!cfg.model || cfg.model === 'auto') { sel.value = 'auto'; $('#modelCustom').value = ''; }
  else { sel.value = cfg.model; $('#modelCustom').value = ''; }
  $('#modelCustomWrap').hidden = sel.value !== '__custom';
  const src = { api: '已即時取得你帳戶可用的模型清單', cache: '使用上次取得的清單（連線後自動更新）', fallback: '離線備援清單（輸入 API Key 後會自動取得最新清單）' }[modelState.source];
  const n = modelState.raw.length ? C.normalizeModelList(modelState.raw, false).length : list.length;
  sel.disabled = modelState.loading;
  sel.parentElement.classList.toggle('loading', modelState.loading);
  $('#modelRefresh').disabled = modelState.loading;
  const note = $('#modelNote');
  note.textContent = '';
  if (modelState.loading) note.append(spin(), ' 正在向 Google 取得你帳戶可用的模型清單…');
  else note.textContent = `偵測到 ${n} 個語音（TTS）模型 · ${src}${modelState.error ? ` · ${modelState.error}` : ''}`;
}
async function refreshModels(force = false) {
  if (!keyAvailable() || modelState.loading) { renderModelSelect(); return; }
  if (!force && modelState.source === 'api') return;
  if (!force && modelState.source === 'cache' && Date.now() - modelState.at < 12 * 3600 * 1000) { renderModelSelect(); return; }
  modelState.loading = true; modelState.error = '';
  renderModelSelect();
  try {
    const all = [];
    let token = '';
    for (let i = 0; i < 10; i++) {
      const res = await apiFetch(`/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
      all.push(...(res.models || []));
      token = res.nextPageToken || '';
      if (!token) break;
    }
    modelState.raw = all.map((m) => ({ id: C.stripModelPrefix(m.name), displayName: m.displayName || '' })).filter((m) => m.id);
    modelState.source = 'api'; modelState.at = Date.now();
    safeSet(localStorage, MODELS_CACHE_KEY, JSON.stringify({ raw: modelState.raw, at: modelState.at }));
    if (!C.normalizeModelList(modelState.raw, false).length) modelState.error = '清單中沒有名稱含 tts 的模型，可在進階選項勾選「顯示全部模型」';
  } catch (e) {
    modelState.error = `取得清單失敗：${e.message}`;
  } finally {
    modelState.loading = false;
    renderModelSelect();
    updateVisibility();
  }
}

// 長金鑰 (voicekey_...) 只顯示頭尾,避免撐寬版面
const showVoice = (v) => (v && v.length > 26 ? `${v.slice(0, 12)}…${v.slice(-6)}` : v);

function parseSpeakers(s) {
  const out = [];
  for (const n of s.split(/[,，、]/)) {
    const t = n.trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

function readForm() {
  for (const [k, t] of BIND) cfg[k] = readField(k, t);
  cfg.mode = document.querySelector('input[name=mode]:checked')?.value || 'single';
  const sel = $('#modelSel').value;
  cfg.model = sel === '__custom' ? (C.stripModelPrefix($('#modelCustom').value) || 'auto') : (sel || 'auto');
  const sp = parseSpeakers($('#speakers').value);
  if (sp.length) cfg.speakers = sp;
  // 講者語氣由各列輸入框即時寫入 cfg.speaker_styles
}

function fillForm() {
  for (const [k, t] of BIND) {
    const el = $('#' + k);
    if (t === 'bool') el.checked = !!cfg[k]; else el.value = cfg[k];
  }
  document.querySelector(`input[name=mode][value=${cfg.mode}]`).checked = true;
  renderModelSelect();
  $('#speakers').value = cfg.speakers.join(', ');
  renderSpeakerRows();
  updateVisibility();
}

function updateVisibility() {
  const multi = cfg.mode === 'multi';
  $('#multiBox').hidden = !multi;
  $('#multiVoices').hidden = !multi;
  $('#singleVoice').hidden = multi;
  document.querySelectorAll('.multi-only').forEach((e) => { e.hidden = !multi; });
  document.querySelectorAll('.single-only').forEach((e) => { e.hidden = multi; });
  $('#modelCustomWrap').hidden = $('#modelSel').value !== '__custom';
  $('#bitrateWrap').hidden = !C.LOSSY.has($('#out_format').value);
  $('#voiceBtn').textContent = showVoice(cfg.voice) || '（尚未選擇）';
  renderChips();
  document.querySelectorAll('.local-only').forEach((e) => { e.hidden = !rt.local; });
  document.querySelectorAll('.web-only').forEach((e) => { e.hidden = rt.local; });
  const needFf = C.needsFfmpeg(cfg, false);
  const note = $('#ffNote');
  if (rt.local) {
    note.hidden = !(needFf && !rt.hello?.ffmpeg?.found);
    if (!note.hidden) note.textContent = '找不到 ffmpeg：請到「進階選項 → 本機工具」按「安裝 ffmpeg」，或指定 ffmpeg.exe 路徑。';
  } else {
    note.hidden = !needFf;
    if (needFf) note.textContent = '此設置需要 ffmpeg.wasm：首次使用會下載約 31 MB（之後由瀏覽器快取），轉檔在你的手機上本機執行。';
  }
  updateCount();
}

function renderSpeakerRows() {
  const box = $('#multiVoices');
  box.textContent = '';
  for (const name of cfg.speakers) {
    const row = document.createElement('div');
    row.className = 'srow';
    const title = document.createElement('div');
    title.className = 'sname';
    title.textContent = `講者 ${name}`;
    const vbtn = document.createElement('button');
    vbtn.type = 'button';
    vbtn.className = 'voice-btn';
    vbtn.textContent = showVoice(cfg.speaker_voices[name]) || '（尚未選擇）';
    vbtn.addEventListener('click', () => openVoicePicker(`講者 ${name}`, cfg.speaker_voices[name] || '', (v) => {
      cfg.speaker_voices[name] = v; vbtn.textContent = showVoice(v); saveCfg();
    }));
    const lab = document.createElement('label');
    lab.textContent = '預設語氣';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = cfg.speaker_styles[name] || '';
    inp.placeholder = '例如 calm and relaxed（單句可用 名稱[語氣]: 覆蓋）';
    inp.addEventListener('input', () => { cfg.speaker_styles[name] = inp.value.trim(); saveCfg(); });
    lab.appendChild(inp);
    const lab0 = document.createElement('label');
    lab0.textContent = '人聲';
    lab0.appendChild(vbtn);
    row.append(title, lab0, lab);
    box.appendChild(row);
  }
}

// --------------------------------------------------------------------------- //
// 文本區
// --------------------------------------------------------------------------- //
const TAGS = ['<short pause>', '<long pause>', '<laugh>', '<sigh>'];
function insertAtCursor(str) {
  const ta = $('#text');
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  ta.setRangeText(str, s, e, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}
function renderChips() {
  const box = $('#chips');
  box.textContent = '';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    box.appendChild(b);
  };
  if (cfg.mode === 'multi') {
    for (const n of cfg.speakers) {
      mk(`${n}:`, () => {
        const ta = $('#text');
        const before = ta.value.slice(0, ta.selectionStart);
        insertAtCursor((before && !before.endsWith('\n') ? '\n' : '') + `${n}: `);
      });
    }
  }
  for (const t of TAGS) mk(t, () => insertAtCursor(t));
}
function updateCount() {
  const n = [...$('#text').value].length;
  $('#charCount').textContent = `${n} 字`;
}

// --------------------------------------------------------------------------- //
// API Key / 網路
// --------------------------------------------------------------------------- //
function getKey() {
  return $('#apiKey').value.trim();
}
function persistKey() {
  const remember = $('#rememberKey').checked;
  safeSet(localStorage, REMEMBER_KEY, remember ? '1' : '0');
  const k = getKey();
  if (rt.local) {   // 本機版:記住 = 存到本機檔案 .gemini_key (已列入 .gitignore),不放瀏覽器儲存
    if (remember && k) ljson('key', 'POST', { key: k }).then(refreshHello).catch((e) => setStatus(`金鑰儲存失敗：${e.message}`, 'error'));
    safeSet(sessionStorage, KEY_KEY, k); safeDel(localStorage, KEY_KEY);
    return;
  }
  if (remember) { safeSet(localStorage, KEY_KEY, k); safeDel(sessionStorage, KEY_KEY); }
  else { safeSet(sessionStorage, KEY_KEY, k); safeDel(localStorage, KEY_KEY); }
}

const SERVICE_DOWN_MSG = '與本機服務的連線中斷（程式可能已被關閉）：請關閉這個視窗，再雙擊「啟動圖形介面.bat」重新開啟。';
const fatal = (msg) => Object.assign(new Error(msg), { noRetry: true });   // 重試也不會好的錯誤 (不要白等重試)
const STALE_MSG = '這個視窗已過期（本機服務曾重新啟動）：請關閉它，再雙擊「啟動圖形介面.bat」重新開啟。';
function showServiceDown(msg) {
  const b = $('#svcBanner');
  b.textContent = msg;
  b.hidden = false;
}
async function explainLocalFailure() {   // fetch 失敗時,判斷是「本機服務已停止」還是「網路/Google 問題」
  try {
    const r = await fetch('api/hello', { headers: { 'X-TTS-Token': rt.token }, signal: AbortSignal.timeout(3000) });
    if (r.status === 403) { showServiceDown(STALE_MSG); return STALE_MSG; }
    if (r.ok) return '連線被中斷，或 Google 沒有回應（請稍後再試）';
  } catch { /* 連不上本機服務 */ }
  showServiceDown(SERVICE_DOWN_MSG);
  return SERVICE_DOWN_MSG;
}

async function apiRaw(path, { method = 'GET', body, signal } = {}) {   // 回傳 Response (成功時不讀取本體,串流用)
  const key = getKey();
  if (!keyAvailable()) throw new Error('請先輸入 API Key');
  let res;
  try {
    if (rt.local) {   // 經本機服務轉送:不受瀏覽器跨來源限制,也可使用環境變數中的金鑰
      res = await fetch('api/g' + path, {
        method,
        headers: { 'X-TTS-Token': rt.token, ...(key ? { 'X-Goog-Api-Key': key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } else {
      res = await fetch(C.API_BASE + path, {
        method,
        headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    if (rt.local) {
      const why = await explainLocalFailure();
      throw why === SERVICE_DOWN_MSG || why === STALE_MSG ? fatal(why) : new Error(why);
    }
    throw new Error('無法連線到 Gemini API（網路中斷，或被瀏覽器的跨來源限制擋下）');
  }
  if (!res.ok) {
    const txt = await res.text();
    if (rt.local && res.status === 403 && /token/.test(txt)) { showServiceDown(STALE_MSG); throw fatal(STALE_MSG); }
    let json = null;
    try { json = JSON.parse(txt); } catch { /* 非 JSON */ }
    const err = new Error(`HTTP ${res.status}: ${json?.error?.message || txt.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}
async function apiFetch(path, opts = {}) {
  const res = await apiRaw(path, opts);
  const txt = await res.text();
  if (!txt.trim()) return {};
  try { return JSON.parse(txt); } catch { throw new Error('伺服器回應不是有效的 JSON'); }
}
const streamApi = (body, { signal } = {}) => apiRaw('/interactions', { method: 'POST', body, signal });   // SSE 串流 (即時進度)

// --------------------------------------------------------------------------- //
// 狀態 / 紀錄
// --------------------------------------------------------------------------- //
function setStatus(msg, cls = '') {
  const el = $('#status');
  el.textContent = msg;
  el.className = cls;
}
function log(msg, level = 'info') {
  const pre = $('#log');
  const line = document.createElement('div');
  if (level !== 'info') line.className = 'log-' + level;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  pre.appendChild(line);
  pre.scrollTop = pre.scrollHeight;
  if (level === 'warn') setStatus(msg, 'warn');
}

// --------------------------------------------------------------------------- //
// ffmpeg.wasm (同源自架,單執行緒核心,不需 COOP/COEP)
// --------------------------------------------------------------------------- //
const FF = { inst: null, loading: null, logs: [] };

async function ensureFfmpeg() {
  if (rt.local) {   // 本機版:使用電腦上的原生 ffmpeg
    if (!rt.hello?.ffmpeg?.found) await refreshHello();
    if (rt.hello?.ffmpeg?.found) return true;
    log('找不到 ffmpeg：請到「進階選項 → 本機工具」安裝或指定路徑。', 'warn');
    return false;
  }
  if (FF.inst) return true;
  if (FF.loading) return FF.loading;
  FF.loading = (async () => {
    try {
      setStatus('載入 ffmpeg（首次下載約 31 MB，請稍候）…');
      log('載入 ffmpeg.wasm …');
      const { FFmpeg } = await import('./vendor/ffmpeg/index.js');
      const ff = new FFmpeg();
      ff.on('log', ({ message }) => { FF.logs.push(message); if (FF.logs.length > 200) FF.logs.shift(); });
      await ff.load({
        coreURL: new URL('./vendor/core/ffmpeg-core.js', location.href).href,
        wasmURL: new URL('./vendor/core/ffmpeg-core.wasm', location.href).href,
      });
      FF.inst = ff;
      log('ffmpeg.wasm 載入完成');
      return true;
    } catch (e) {
      log(`ffmpeg 載入失敗: ${e?.message || e}（請確認網站已依 README 完整部署 vendor 檔案）`, 'error');
      return false;
    } finally {
      FF.loading = null;
    }
  })();
  return FF.loading;
}

async function ffRun(args, input, outName) {
  if (rt.local) {
    const res = await lfetch('ffmpeg?args=' + encodeURIComponent(JSON.stringify(args)), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: input,
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `ffmpeg HTTP ${res.status}`); }
    return new Uint8Array(await res.arrayBuffer());
  }
  const ff = FF.inst;
  FF.logs.length = 0;
  await ff.writeFile('src.wav', input.slice());      // writeFile 會轉移緩衝區,傳副本以免原始資料被清空
  const code = await ff.exec(args);
  if (code !== 0) throw new Error(`ffmpeg 結束碼 ${code}: ${FF.logs.slice(-6).join(' | ')}`);
  const data = await ff.readFile(outName);
  await ff.deleteFile('src.wav').catch(() => {});
  await ff.deleteFile(outName).catch(() => {});
  return data;
}

// --------------------------------------------------------------------------- //
// 人聲選擇器
// --------------------------------------------------------------------------- //
const dlg = $('#voiceDlg');
let pickCb = null;
const vstate = { token: '', filters: {}, loaded: false };

function openVoicePicker(title, current, cb) {
  pickCb = cb;
  $('#voiceDlgTitle').textContent = `選擇人聲 — ${title}`;
  $('#voiceInput').value = current || '';
  vstate.loaded = false;
  switchTab('direct');
  if (!dlg.open) dlg.showModal();
}
function pickVoice(v) {
  const id = C.canonicalVoice(v);
  if (!id) return;
  pickCb?.(id);
  updateVisibility();
  dlg.close();
}
function switchTab(name) {
  dlg.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['direct', 'online', 'builtin', 'mine'].forEach((t) => { $('#tab-' + t).hidden = t !== name; });
  if (name === 'online' && !vstate.loaded) loadVoices(true);
  if (name === 'mine') { renderKeyList(); if (!mine.cloudLoaded) loadCloud(true); }
}
function skeleton(ul, n) {   // 載入中的骨架列
  for (let i = 0; i < n; i++) { const li = document.createElement('li'); li.className = 'skel'; li.innerHTML = '<span></span><span></span>'; ul.appendChild(li); }
}
function readFilters() {
  const list = (id) => $('#' + id).value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return {
    language_code: list('f_language_code'), gender: list('f_gender'), pitch: list('f_pitch'),
    contexts: list('f_contexts'), type: list('f_type'), search: $('#f_search').value.trim(),
  };
}
async function loadVoices(reset) {
  const msg = $('#voiceMsg');
  const ul = $('#voiceList');
  if (reset) { ul.textContent = ''; vstate.token = ''; vstate.filters = readFilters(); }
  if (keyAvailable() && !vstate.token) skeleton(ul, 5);
  if (!keyAvailable()) { msg.textContent = '請先在頁面最上方輸入 API Key，才能載入線上清單。'; return; }
  msg.textContent = '載入中…';
  $('#voiceMore').hidden = true;
  try {
    const res = await apiFetch('/voices?' + C.buildVoicesQuery(vstate.filters, vstate.token, 20));
    vstate.loaded = true;
    ul.querySelectorAll('.skel').forEach((e) => e.remove());
    const voices = res.voices || [];
    for (const v of voices) {
      const id = C.pick(v, 'id');
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const a = document.createElement('span');
      a.className = 'v-id';
      a.textContent = `${id}${C.pick(v, 'display_name', 'displayName') ? ' · ' + C.pick(v, 'display_name', 'displayName') : ''}`;
      const m = document.createElement('span');
      m.className = 'v-meta';
      const pitch = C.pick(v, 'pitch');
      m.textContent = [C.pick(v, 'language_code', 'languageCode'), C.pick(v, 'accent'), C.pick(v, 'gender'),
        pitch ? `pitch=${pitch}` : '', String(C.pick(v, 'description')).slice(0, 80)].filter(Boolean).join(' · ');
      b.append(a, m);
      b.className = 'vsel';
      b.addEventListener('click', () => pickVoice(String(id)));
      li.append(b, mkBtn('▶', (e) => previewVoice(String(id), { lang: String(C.pick(v, 'language_code', 'languageCode')), btn: e.currentTarget }), 'small pv'));
      ul.appendChild(li);
    }
    vstate.token = C.pick(res, 'next_page_token', 'nextPageToken') || '';
    $('#voiceMore').hidden = !vstate.token;
    msg.textContent = ul.children.length ? `已載入 ${ul.children.length} 筆` : '沒有符合條件的人聲（可調整篩選，中文可改用關鍵字）。';
  } catch (e) {
    ul.querySelectorAll('.skel').forEach((x) => x.remove());
    msg.textContent = `載入失敗：${e.message}`;
  }
}

// --------------------------------------------------------------------------- //
// 生成
// --------------------------------------------------------------------------- //
let ctl = null;
let wakeLock = null;
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `tts_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const safeName = (s) => s.replace(/[<>:"/\\|?*\s]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'tts';
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB');

function setBusy(b) {
  $('#genBtn').disabled = b;
  $('#cancelBtn').hidden = !b;
}

// --------------------------------------------------------------------------- //
// 進度面板:四個階段 + 實際已收到的音訊秒數 + 依文字量的預估 (官方沒有百分比進度,預估僅供預期)
// --------------------------------------------------------------------------- //
const STAGE_LABELS = ['已送出', 'Google 處理中', '接收音訊', '處理／存檔'];
const prog = { on: false, timer: 0, tLast: 0, t0: 0, idx: 0, mode: '', pre: '', post: '', i: 1, n: 1, perTurn: false, seconds: 0, est: 0, sec0: 0, tFirst: 0, tSeg: 0, estTotal: 0, tag: '' };
const fmtDur = (ms) => { const t = Math.floor(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
function spin(cls = '') { const e = document.createElement('span'); e.className = `spinner ${cls}`; return e; }

function progBegin() {
  Object.assign(prog, { on: true, t0: performance.now(), idx: 0, mode: '', pre: '', post: '', i: 1, n: 1, perTurn: false, seconds: 0, est: 0, sec0: 0, tFirst: 0, tSeg: performance.now(), estTotal: 0, tag: '' });
  const panel = $('#progPanel');
  const ol = $('#progStages');
  if (!ol.children.length) STAGE_LABELS.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ol.appendChild(li); });
  panel.hidden = false;
  clearInterval(prog.timer);
  prog.timer = setInterval(() => progRender(), 200);
  progRender();
}
function progEnd(ok) {
  prog.on = false;
  clearInterval(prog.timer);
  if (ok) { progRender(true); setTimeout(() => { if (!prog.on) $('#progPanel').hidden = true; }, 1800); }
  else $('#progPanel').hidden = true;
}
function progEvent(p, tag = '') {
  prog.tag = tag;
  const now = performance.now();
  switch (p.stage) {
    case 'ffmpeg-load': prog.pre = rt.local ? '檢查 ffmpeg…' : '載入 ffmpeg…（首次需下載約 31 MB，之後會快取）'; break;
    case 'tts-start': prog.pre = ''; prog.perTurn = p.perTurn; prog.n = p.n; prog.estTotal = p.estSec; break;
    case 'tts': prog.i = p.i; prog.n = p.n; prog.seconds = 0; prog.est = 0; prog.tFirst = 0; prog.idx = 0; break;
    case 'sent': prog.mode = p.mode; prog.tSeg = now; prog.seconds = 0; prog.tFirst = 0; prog.idx = p.mode === 'unary' ? 1 : 0; if (!prog.perTurn) prog.est = prog.estTotal; break;
    case 'accepted': prog.idx = 1; break;
    case 'receiving': prog.idx = 2; prog.seconds = p.seconds; prog.est = p.est; if (!prog.tFirst) { prog.tFirst = now; prog.sec0 = p.seconds; } prog.tLast = now; break;
    case 'received': prog.idx = prog.perTurn ? 2 : 3; prog.seconds = prog.est; break;
    case 'convert': prog.idx = 3; prog.post = 'ffmpeg 轉檔中…'; break;
    case 'post': prog.idx = 3; prog.post = p.text || '整理檔案…'; break;
    default: break;
  }
  progRender();
}
function progRender(final = false) {
  const panel = $('#progPanel');
  if (panel.hidden) return;
  const now = performance.now();
  const idx = final ? 4 : prog.idx;
  panel.querySelectorAll('.stages li').forEach((li, k) => { li.className = k < idx ? 'done' : k === idx ? 'active' : ''; });
  const within = prog.est > 0 ? Math.min(0.95, prog.seconds / prog.est) : 0;
  let frac = null;                                         // null = 不確定 (顯示流動動畫)
  if (final) frac = 1;
  else if (prog.perTurn) frac = Math.min(0.97, ((prog.i - 1) + (prog.idx === 2 ? within : 0)) / prog.n);
  else if (prog.idx === 2 && prog.est > 0) frac = within * 0.92;
  else if (prog.idx >= 3) frac = 0.96;
  const bar = $('#progFill').parentElement;
  bar.classList.toggle('indeterminate', frac === null);
  $('#progFill').style.width = frac === null ? '' : `${Math.round(frac * 100)}%`;

  const seg = prog.perTurn ? `第 ${prog.i}/${prog.n} 段 · ` : '';
  const wait = `${Math.max(0, Math.round((now - prog.tSeg) / 1000))} 秒`;
  const estTxt = prog.estTotal > 0 && !prog.perTurn ? `，預估音訊約 ${Math.round(prog.estTotal)} 秒` : '';
  let main;
  if (final) main = '完成';
  else if (prog.pre) main = prog.pre;
  else if (prog.idx >= 3) main = prog.post || '處理中…';
  else if (prog.idx === 2) {
    const parts = [`已生成 ${prog.seconds.toFixed(1)} 秒音訊`];
    if (prog.est > 0) parts.push(`預估約 ${Math.max(Math.round(prog.est), Math.ceil(prog.seconds))} 秒`);
    if (prog.tFirst && prog.tLast > prog.tFirst && prog.est > prog.seconds) {   // 以「最後一個區塊的時間」為基準,倒數才會平順不跳動
      const rate = (prog.seconds - prog.sec0) / ((prog.tLast - prog.tFirst) / 1000);
      const left = rate > 0.05 ? (prog.est - prog.seconds) / rate - (now - prog.tLast) / 1000 : 0;
      if (prog.seconds >= 1.5 && left > 0.5 && left < 3600) parts.push(`約剩 ${Math.round(left)} 秒（預估）`);
    }
    main = seg + parts.join(' · ');
  } else if (prog.idx === 1) {
    main = seg + (prog.mode === 'stream' ? `Google 已接受請求，正在準備生成…（已等待 ${wait}${estTxt}）`
      : `已送出，等待 Google 回傳完整音訊…此模式不提供即時進度（已等待 ${wait}${estTxt}）`);
  } else main = seg + '正在送出請求…';
  $('#progMain').textContent = prog.tag + main;
  $('#progTime').textContent = `⏱ ${fmtDur(now - prog.t0)}`;
}

function validate(text) {
  if (!keyAvailable()) return '請先輸入 API Key';
  if (!text.trim()) return '請輸入文本';
  if (cfg.mode === 'single') {
    if (!cfg.voice) return '請選擇人聲';
  } else {
    if (cfg.speakers.length < 2) return '多人對話至少需要 2 位講者';
    const miss = cfg.speakers.find((n) => !cfg.speaker_voices[n]);
    if (miss) return `請為講者「${miss}」選擇人聲`;
  }
  return '';
}

async function generate() {
  if (ctl) return;                       // 避免快捷鍵/連點重複觸發
  readForm();
  persistKey();
  saveCfg();
  const text = $('#text').value;
  const err = validate(text);
  if (err) { setStatus(err, 'error'); return; }
  const chunks = cfg.batch ? text.split(/^[ \t]*---[ \t]*$/m).map((x) => x.trim()).filter(Boolean) : [text];
  if (!chunks.length) { setStatus('請輸入文本', 'error'); return; }

  ctl = new AbortController();
  setBusy(true);
  $('#log').textContent = '';
  setStatus('');
  progBegin();
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  const t0 = performance.now();
  const stem = safeName($('#filename').value.trim() || stamp());
  let done = 0, lastRun = null;
  try {
    for (let i = 0; i < chunks.length; i++) {
      const tag = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : '';
      const model = resolveModelNow();
      if (i === 0) log(`使用模型：${model}${cfg.model === 'auto' || !cfg.model ? '（自動選用最新語音模型）' : ''}`);
      const res = await C.runPipeline({
        cfg: { ...structuredClone(cfg), model },
        text: chunks[i],
        signal: ctl.signal,
        callApi: (body) => apiFetch('/interactions', { method: 'POST', body, signal: ctl.signal }),
        ffmpeg: { ensure: ensureFfmpeg, run: ffRun },
        onLog: (m, l) => log(tag + m, l),
        streamApi: cfg.stream !== false ? streamApi : null,
        onProgress: (p) => progEvent(p, tag),
      });
      progEvent({ stage: 'post', text: rt.local && res.runCfg.auto_save !== false ? '儲存到輸出資料夾…' : '整理檔案…' }, tag);
      if (res.usage && Object.keys(res.usage).length) {
        const u = Object.entries(res.usage).map(([k, v]) => `${k}=${v}`).join('、');
        log(`${tag}Google 回報的用量：${u}`);
      }
      addResults(res.outputs, chunks.length > 1 ? `${stem}_${String(i + 1).padStart(3, '0')}` : stem, res.runCfg, i === 0, {
        text: chunks[i].replace(/\s+/g, ' ').slice(0, 60),
        voice: cfg.mode === 'single' ? cfg.voice : cfg.speakers.map((n) => `${n}:${cfg.speaker_voices[n] || ''}`).join(', '),
        model,
      });
      done++;
      lastRun = res.runCfg;
      log(`${tag}完成：${res.outputs.map((o) => o.label).join('、')}`);
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const many = chunks.length > 1 ? `，共 ${chunks.length} 個檔案` : '';
    progEnd(true);
    if (lastRun.out_format !== cfg.out_format) setStatus(`完成（${secs} 秒${many}）。注意：ffmpeg 無法使用，已改輸出 WAV。`, 'warn');
    else setStatus(`完成（${secs} 秒${many}）`, 'ok');
  } catch (e) {
    const part = chunks.length > 1 ? `（已完成 ${done}/${chunks.length} 段）` : '';
    if (e?.name === 'AbortError') { setStatus(`已取消${part}`, 'warn'); log('使用者取消', 'warn'); }
    else { setStatus(`失敗${part}：${e.message}`, 'error'); log(`失敗：${e.stack || e.message}`, 'error'); }
  } finally {
    setBusy(false);
    if (prog.on) progEnd(false);
    try { await wakeLock?.release(); } catch { /* ignore */ }
    wakeLock = null;
    ctl = null;
  }
}

const results = [];
const hist = createHistory();   // 網頁版:最近生成 (IndexedDB)
function addResults(outputs, stem, runCfg, autoplayOk = true, info = {}) {
  const box = $('#results');
  outputs.forEach((o, idx) => {
    const isOriginalCopy = outputs.length > 1 && o.label === '原始 WAV';
    const name = `${stem}${isOriginalCopy ? '_original' : ''}${o.ext}`;
    const blob = new Blob([o.bytes], { type: o.mime });
    const url = URL.createObjectURL(blob);
    const card = document.createElement('div');
    card.className = 'result';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${o.label} · ${fmtSize(o.bytes.length)}${runCfg.sample_rate ? ` · ${runCfg.sample_rate} Hz` : ''}`;
    card.append(nm, meta);
    let audio = null;
    if (o.playable) {
      audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = url;
      card.appendChild(audio);
    } else {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = '此格式無法在瀏覽器內播放，請下載後以其他程式開啟。';
      card.appendChild(p);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const dl = document.createElement('a');
    dl.className = 'btn small';
    dl.href = url;
    dl.download = name;
    dl.textContent = '下載';
    row.appendChild(dl);
    const file = new File([blob], name, { type: o.mime });
    if (navigator.canShare?.({ files: [file] })) {
      const sh = document.createElement('button');
      sh.type = 'button';
      sh.className = 'small';
      sh.textContent = '分享／存到其他 App';
      sh.addEventListener('click', async () => {
        try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e.name !== 'AbortError') setStatus(`分享失敗：${e.message}`, 'error'); }
      });
      row.appendChild(sh);
    }
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'small danger';
    rm.textContent = '移除';
    rm.addEventListener('click', () => { URL.revokeObjectURL(url); card.remove(); });
    row.appendChild(rm);
    card.appendChild(row);
    box.prepend(card);
    results.push(url);
    if (rt.local && runCfg.auto_save !== false) saveToDisk(name, o.bytes, meta, row, rm);
    else if (!rt.local) histAdd(name, o, info, meta);
    if (idx === 0 && audio && runCfg.autoplay && autoplayOk) audio.play().catch(() => {});
    if (idx === 0) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// --- 本機版: 儲存到輸出資料夾 / 最近生成 ---
async function saveToDisk(name, bytes, metaEl, row, beforeEl) {
  try {
    const res = await lfetch('save?name=' + encodeURIComponent(name), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    metaEl.textContent += ` · 已存到 ${j.path}`;
    row.insertBefore(mkBtn('系統播放器', () => ljson('open', 'POST', { name: j.name }), 'small'), beforeEl);
    row.insertBefore(mkBtn('開啟資料夾', () => ljson('open', 'POST', { name: j.name, folder: true }), 'small'), beforeEl);
    refreshHistory();
  } catch (e) { metaEl.textContent += ` · 儲存失敗：${e.message}`; }
}

async function histAdd(name, o, info, metaEl) {
  try {
    await hist.add({ name, ext: o.ext, mime: o.mime, fmt: o.fmt, label: o.label, bytes: o.bytes, text: info.text || '', voice: info.voice || '', model: info.model || '' });
    navigator.storage?.persist?.().catch(() => {});      // 請瀏覽器盡量不要自動清除這些資料
    refreshHistory();
  } catch (e) {
    $('#histNote').textContent = `無法保留到「最近生成」：${e.message}（此瀏覽器可能停用了本機儲存，例如無痕模式）`;
    if (metaEl) metaEl.textContent += ' · 未保留到「最近生成」（此瀏覽器停用了本機儲存，請記得下載）';   // 直接顯示在結果上,使用者才看得到
  }
}

async function refreshHistory() {
  const ul = $('#historyList');
  const note = $('#histNote');
  try {
    let items;
    if (rt.local) {
      items = (await ljson('history')).map((it) => ({ key: it.name, name: it.name, size: it.size, at: it.mtime * 1000, sub: '' }));
      note.textContent = '音檔存放在輸出資料夾（最近 30 個）。';
    } else {
      items = (await hist.list()).map((m) => ({ key: m.id, name: m.name, size: m.size, at: m.createdAt, mime: m.mime, ext: m.ext,
        sub: [m.voice && `人聲 ${showVoice(m.voice)}`, m.text && `「${m.text}」`].filter(Boolean).join(' · ') }));
      const st = await hist.stats();
      let quota = '';
      try { const e = await navigator.storage.estimate(); quota = ` · 瀏覽器儲存空間已用 ${fmtSize(e.usage)}`; } catch { /* 不支援 */ }
      note.textContent = `音檔只存在這個瀏覽器（不會上傳）：${st.count} 筆，共 ${fmtSize(st.bytes)}（最多 ${st.maxItems} 筆／${fmtSize(st.maxBytes)}，超過自動刪除最舊的）${quota}。清除瀏覽器資料也會一併刪除。`;
    }
    ul.textContent = '';
    $('#historyClear').hidden = rt.local || !items.length;
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'hint'; li.textContent = '（還沒有生成紀錄）';
      ul.appendChild(li);
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      const n = document.createElement('div'); n.className = 'm-name'; n.textContent = it.name;
      const m = document.createElement('div'); m.className = 'm-meta';
      m.textContent = `${fmtSize(it.size)} · ${new Date(it.at).toLocaleString()}${it.sub ? ` · ${it.sub}` : ''}`;
      const row = document.createElement('div'); row.className = 'row';
      const holder = document.createElement('div');
      const ext = it.name.slice(it.name.lastIndexOf('.')).toLowerCase();
      const inline = ['.wav', '.mp3', '.flac', '.ogg', '.opus', '.m4a'].includes(ext);
      const toggle = (src) => {
        if (holder.firstChild) { holder.firstChild.pause(); holder.textContent = ''; return; }
        const a = document.createElement('audio');
        a.controls = true; a.autoplay = true; a.className = 'inline'; a.src = src;
        holder.appendChild(a);
      };
      if (rt.local) {
        row.append(
          mkBtn('播放', () => { if (!inline) { ljson('open', 'POST', { name: it.key }); return; } toggle(`api/file?name=${encodeURIComponent(it.key)}&t=${encodeURIComponent(rt.token)}`); }, 'small'),
          mkBtn('開啟資料夾', () => ljson('open', 'POST', { name: it.key, folder: true }), 'small'),
          mkBtn('刪除', async () => {
            if (!confirm(`刪除「${it.name}」？此動作無法復原。`)) return;
            try { await ljson('delete', 'POST', { name: it.key }); refreshHistory(); } catch (e) { setStatus(`刪除失敗：${e.message}`, 'error'); }
          }, 'small danger'),
        );
      } else {
        const blobUrl = async () => {
          const bytes = await hist.getBytes(it.key);
          if (!bytes) throw new Error('找不到音檔 (可能已被瀏覽器清除)');
          return { url: URL.createObjectURL(new Blob([bytes], { type: it.mime })), bytes };
        };
        if (inline) row.append(mkBtn('播放', async () => { if (holder.firstChild) { toggle(); return; } try { toggle((await blobUrl()).url); } catch (e) { setStatus(e.message, 'error'); } }, 'small'));
        row.append(mkBtn('下載', async () => {
          try {
            const { url } = await blobUrl();
            const a = document.createElement('a'); a.href = url; a.download = it.name; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
          } catch (e) { setStatus(e.message, 'error'); }
        }, 'small'));
        if (navigator.canShare) row.append(mkBtn('分享', async () => {
          try {
            const { bytes } = await blobUrl();
            const file = new File([bytes], it.name, { type: it.mime });
            if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: it.name });
            else setStatus('這個瀏覽器無法分享檔案，請改用「下載」', 'warn');
          } catch (e) { if (e.name !== 'AbortError') setStatus(`分享失敗：${e.message}`, 'error'); }
        }, 'small'));
        row.append(mkBtn('刪除', async () => { await hist.remove(it.key); refreshHistory(); }, 'small danger'));
      }
      li.append(n, m, row, holder);
      ul.appendChild(li);
    }
  } catch (e) { ul.textContent = `載入失敗：${e.message}`; note.textContent = ''; }
}

async function refreshHello() {
  if (!rt.local) return;
  try { rt.hello = await ljson('hello'); } catch { /* 服務已關閉 */ }
  const f = rt.hello?.ffmpeg;
  $('#ffStatus').textContent = f?.found ? `ffmpeg：${f.version || f.path}` : '找不到 ffmpeg（只影響 MP3 / FLAC / OGG / Opus / M4A、響度標準化、變速）。';
  updateVisibility();
}

// --------------------------------------------------------------------------- //
// 事件
// --------------------------------------------------------------------------- //
// --------------------------------------------------------------------------- //
// 音色克隆 (Voice replication)
// --------------------------------------------------------------------------- //
const LIB_KEY = 'tts.voicekeys.v1';
const mine = { cloudToken: '', cloudLoaded: false };
const cloneModel = () => { const m = resolveModelNow(); return C.isTtsModelId(m) ? m : (C.pickAutoModel(currentModels()) || C.FALLBACK_TTS_MODELS[0]); };
const labDlg = $('#labDlg');

let libCache = null;
function loadLib() {
  if (libCache) return libCache;
  try { const a = JSON.parse(safeGet(localStorage, LIB_KEY) || '[]'); libCache = Array.isArray(a) ? a : []; } catch { libCache = []; }
  return libCache;
}
function saveLib(a) {
  libCache = a;
  if (rt.local) ljson('lib', 'POST', a).catch(() => {});
  else safeSet(localStorage, LIB_KEY, JSON.stringify(a));
}
const daysLeft = (iso) => (new Date(iso).getTime() - Date.now()) / 86400000;
const shortKey = (k) => (k.length > 18 ? `${k.slice(0, 12)}…${k.slice(-6)}` : k);
function mkBtn(text, fn, cls = '') {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.textContent = text;
  b.addEventListener('click', fn);
  return b;
}

// --------------------------------------------------------------------------- //
// 試聽:依序嘗試 ① 快取 → ② 官方範例音訊 (僅「聲音設計」建立的聲音有) → ③ 合成「一句短範例」。
// 結果會快取:同一聲音 (相同模型/語氣/內容) 再次試聽不會消耗額度。預設只合成一句短範例,不使用整段文本。
// --------------------------------------------------------------------------- //
const SAMPLE_TEXTS = {
  zh: '你好，很高興認識你。', en: 'Hello, nice to meet you.', ja: 'こんにちは、はじめまして。', ko: '안녕하세요, 만나서 반갑습니다.',
  fr: 'Bonjour, ravi de vous rencontrer.', de: 'Hallo, schön, Sie kennenzulernen.', es: 'Hola, encantado de conocerte.',
  pt: 'Olá, prazer em conhecê-lo.', it: 'Ciao, piacere di conoscerti.', ru: 'Здравствуйте, рад знакомству.',
  hi: 'नमस्ते, आपसे मिलकर खुशी हुई।', ar: 'مرحباً، تشرفت بمعرفتك.', th: 'สวัสดี ยินดีที่ได้รู้จัก',
  vi: 'Xin chào, rất vui được gặp bạn.', id: 'Halo, senang bertemu dengan Anda.', tr: 'Merhaba, tanıştığıma memnun oldum.',
};
const sampleFor = (lang = '') => SAMPLE_TEXTS[(lang || navigator.language || 'en').toLowerCase().slice(0, 2)] || SAMPLE_TEXTS.en;
function previewSample(lang = '') {
  if (cfg.preview_mode === 'mytext') {
    let t = $('#text').value.replace(/<[^>]+>/g, ' ').replace(/^\s*[^\s:：]{1,20}(\[[^\]]*\])?[:：]\s*/gm, '').replace(/\s+/g, ' ').trim();
    t = [...t].slice(0, Math.max(5, Number(cfg.preview_chars) || 30)).join('');
    if (t) return { text: t, style: cfg.mode === 'single' ? cfg.style : '', kind: 'mytext' };
  }
  return { text: sampleFor(lang), style: '', kind: 'sample' };
}

const pvCache = (() => {   // IndexedDB:最多保留最近 60 筆試聽 (每筆約 100–200 KB)
  let dbp = null;
  const open = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('tts-cache', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('pv', mode);
      const rq = fn(t.objectStore('pv'));
      t.oncomplete = () => res(rq?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (st) => st.get(k)).then((v) => (v ? v.bytes : null)).catch(() => null),
    async put(k, bytes) {
      try {
        await tx('readwrite', (st) => st.put({ bytes, at: Date.now() }, k));
        const all = await tx('readonly', (st) => st.getAll());
        const keys = await tx('readonly', (st) => st.getAllKeys());
        if (all.length > 60) {
          const order = all.map((v, i) => ({ k: keys[i], at: v.at })).sort((x, y) => x.at - y.at).slice(0, all.length - 60);
          for (const o of order) await tx('readwrite', (st) => st.delete(o.k));
        }
      } catch { /* 快取失敗不影響使用 */ }
    },
    clear: () => tx('readwrite', (st) => st.clear()).catch(() => {}),
  };
})();
const noSample = () => { try { return new Set(JSON.parse(safeGet(sessionStorage, 'tts.nosample') || '[]')); } catch { return new Set(); } };
const markNoSample = (v) => { const set = noSample(); set.add(v); safeSet(sessionStorage, 'tts.nosample', JSON.stringify([...set])); };

const pvState = { ctl: null, timer: 0, url: '' };
function getPvBar(host) {   // 試聽狀態列:固定在對話框最上方 (捲動時也看得到),按下 ▶ 的同一刻就顯示
  let bar = host.querySelector(':scope > .pvbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'pvbar';
    bar.hidden = true;
    bar.innerHTML = '<div class="pvrow"><span class="spinner"></span><span class="pvtext"></span><button type="button" class="small pvcancel">取消</button></div><div class="pbar indeterminate"><i></i></div><audio controls hidden></audio>';
    host.querySelector(':scope > .dlg-head').after(bar);
    bar.querySelector('.pvcancel').addEventListener('click', () => pvState.ctl?.abort());
  }
  return bar;
}
async function previewVoice(voice, { lang = '', btn = null } = {}) {
  pvState.ctl?.abort();
  const host = labDlg.open ? labDlg : dlg;
  const bar = getPvBar(host);
  const $b = (q) => bar.querySelector(q);
  const textEl = $b('.pvtext'), spinEl = $b('.spinner'), cancel = $b('.pvcancel'), audio = $b('audio'), pb = $b('.pbar'), fill = $b('.pbar i');
  const ctl = new AbortController();
  pvState.ctl = ctl;
  const current = () => pvState.ctl === ctl;
  const label = `試聽 ${showVoice(voice)}`;
  const t0 = performance.now();
  let stageText = '準備試聽…';
  const render = () => { if (current()) textEl.textContent = `${label} · ${stageText} · ⏱ ${((performance.now() - t0) / 1000).toFixed(1)} 秒`; };
  const setStage = (t) => { stageText = t; render(); };

  document.querySelectorAll('button.busy').forEach((b) => { b.classList.remove('busy'); b.disabled = false; });
  if (btn) { btn.classList.add('busy'); btn.disabled = true; }
  audio.pause(); audio.hidden = true;
  bar.hidden = false; bar.classList.remove('err');
  spinEl.hidden = false; cancel.hidden = false; pb.hidden = false; pb.classList.add('indeterminate'); fill.style.width = '';
  clearInterval(pvState.timer);
  pvState.timer = setInterval(render, 150);
  render();

  const finish = () => { if (current()) { clearInterval(pvState.timer); spinEl.hidden = true; cancel.hidden = true; pb.hidden = true; } };
  try {
    const model = cloneModel();
    const smp = previewSample(lang);
    const key = [model, voice, smp.style, smp.text].join('\u0001');
    setStage('檢查快取…');
    let wav = await pvCache.get(key);
    let source = wav ? '快取（不消耗額度）' : '';
    if (!wav && /^voice_/.test(voice) && !noSample().has(voice)) {   // 聲音設計建立的聲音附有官方 sample_audio (免合成)
      setStage('查詢官方範例音訊…');
      try {
        const v = await apiFetch('/voices/' + encodeURIComponent(voice), { signal: ctl.signal });
        const sa = C.pick(v, 'sample_audio', 'sampleAudio');
        const d = sa ? C.pick(sa, 'data') : '';
        if (d) { wav = C.b64ToBytes(d); source = '官方範例音訊（免費）'; await pvCache.put(key, wav); } else markNoSample(voice);
      } catch (e) { if (e?.name === 'AbortError') throw e; markNoSample(voice); }
    }
    if (!wav) {
      setStage('① 送出請求…');
      const r = await C.synthesizeOnce({
        model, voice, style: smp.style, text: smp.text, signal: ctl.signal,
        callApi: (b) => apiFetch('/interactions', { method: 'POST', body: b, signal: ctl.signal }),
        streamApi: cfg.stream !== false ? streamApi : null,
        onProgress: (p) => {
          if (!current()) return;
          if (p.stage === 'sent') setStage(p.mode === 'unary' ? '② 已送出，等待 Google 回傳…' : '① 已送出');
          else if (p.stage === 'accepted') setStage('② Google 已接受，生成中…');
          else if (p.stage === 'receiving') {
            setStage(`③ 已收到 ${p.seconds.toFixed(1)} 秒音訊`);
            pb.classList.remove('indeterminate');
            fill.style.width = `${Math.round(Math.min(0.95, p.seconds / Math.max(p.est, p.seconds + 0.1)) * 100)}%`;
          }
        },
      });
      wav = r.wav;
      source = smp.kind === 'mytext' ? '用你的文本開頭合成' : '合成一句短範例';
      await pvCache.put(key, wav);
    }
    finish();
    if (!current()) return;
    if (pvState.url) URL.revokeObjectURL(pvState.url);
    pvState.url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    audio.src = pvState.url; audio.hidden = false;
    textEl.textContent = `${label} · 播放中 · 來源：${source}`;
    await audio.play().catch(() => { textEl.textContent = `${label} · 已就緒，請按播放 · 來源：${source}`; });
  } catch (e) {
    finish();
    if (current()) {
      if (e?.name === 'AbortError') textEl.textContent = `${label} · 已取消`;
      else { bar.classList.add('err'); textEl.textContent = `${label} · 失敗：${e.message}`; }
    }
  } finally {
    if (btn) { btn.classList.remove('busy'); btn.disabled = false; }
    if (pvState.ctl === ctl) pvState.ctl = null;
  }
}

function voiceRow({ title, meta, metaClass = '', voice, expired = false, onDelete }) {
  const li = document.createElement('li');
  const n = document.createElement('div'); n.className = 'm-name'; n.textContent = title;
  const m = document.createElement('div'); m.className = `m-meta ${metaClass}`; m.textContent = meta;
  const row = document.createElement('div'); row.className = 'row';
  const use = mkBtn('選用', () => pickVoice(voice), 'small primary');
  const pv = mkBtn('試聽', (e) => previewVoice(voice, { btn: e.currentTarget }), 'small');
  use.disabled = expired; pv.disabled = expired;
  row.append(use, pv, mkBtn('刪除', onDelete, 'small danger'));
  li.append(n, m, row);
  return li;
}

function renderKeyList() {
  const ul = $('#keyList');
  ul.textContent = '';
  const lib = loadLib();
  if (!lib.length) {
    const li = document.createElement('li');
    li.className = 'hint'; li.textContent = '（尚無。建立「不儲存」模式的克隆聲音後會出現在這裡）';
    ul.appendChild(li);
    return;
  }
  for (const e of lib) {
    const left = daysLeft(e.expires);
    const expired = !(left > 0);
    ul.appendChild(voiceRow({
      title: e.name || '（未命名）',
      meta: `${shortKey(e.voice)} · ${expired ? '已過期' : `剩 ${left.toFixed(1)} 天`}`,
      metaClass: expired ? 'expired' : '', voice: e.voice, expired,
      onDelete: () => {
        if (!confirm('從這台裝置移除這把金鑰？（金鑰遺失後無法找回）')) return;
        saveLib(loadLib().filter((x) => x.voice !== e.voice));
        renderKeyList();
      },
    }));
  }
}

async function loadCloud(reset) {
  const ul = $('#cloudList'), msg = $('#cloudMsg');
  if (reset) { ul.textContent = ''; mine.cloudToken = ''; }
  if (!keyAvailable()) { msg.textContent = '請先在頁面最上方輸入 API Key。'; return; }
  msg.textContent = '';
  msg.append(spin(), ' 載入中…');
  $('#cloudMore').hidden = true;
  try {
    const res = await apiFetch('/voices?' + C.buildVoicesQuery({ type: ['replicated'] }, mine.cloudToken, 50));
    mine.cloudLoaded = true;
    for (const v of res.voices || []) {
      const id = String(C.pick(v, 'id'));
      const name = C.pick(v, 'display_name', 'displayName');
      ul.appendChild(voiceRow({
        title: name || '（未命名）', meta: id, voice: id,
        onDelete: async () => {
          if (!confirm(`從 Google 專案永久刪除「${name || id}」？此動作無法復原。`)) return;
          try { await apiFetch('/voices/' + encodeURIComponent(id), { method: 'DELETE' }); loadCloud(true); }
          catch (e) { $('#mineMsg').textContent = `刪除失敗：${e.message}`; }
        },
      }));
    }
    mine.cloudToken = C.pick(res, 'next_page_token', 'nextPageToken') || '';
    $('#cloudMore').hidden = !mine.cloudToken;
    msg.textContent = ul.children.length ? `已載入 ${ul.children.length} 個` : '雲端尚無已儲存的克隆聲音。';
  } catch (e) { msg.textContent = `載入失敗：${e.message}`; }
}

// --- 音訊處理: 任何瀏覽器可解碼的格式 → 24 kHz / 單聲道 / 16-bit WAV ---
async function toWav24kMono(ab, trimSec = 0) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  let buf;
  try { buf = await ac.decodeAudioData(ab.slice(0)); } finally { ac.close?.(); }
  const rate = C.CLONE.rate;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * rate)), rate);
  const node = off.createBufferSource();
  node.buffer = buf; node.connect(off.destination); node.start();
  let f32 = (await off.startRendering()).getChannelData(0);
  let trimmed = false;
  if (trimSec && f32.length > trimSec * rate) { f32 = f32.subarray(0, trimSec * rate); trimmed = true; }
  const pcm = new Uint8Array(f32.length * 2);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < f32.length; i++) {
    const x = Math.max(-1, Math.min(1, f32[i]));
    dv.setInt16(i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return { wav: C.pcmToWav(pcm, rate), trimmed };
}

// --- 錄音/選檔元件 ---
let activeRec = null;
function makeRecBox(root, { minSec = 0, maxSec = 0, trimTo = 0, autoStop = 60, onChange }) {
  root.textContent = '';
  const box = { wav: null, seconds: 0, ok: false, clear };
  const row = document.createElement('div'); row.className = 'row';
  const recBtn = mkBtn('● 錄音', startRec, 'rec small');
  const stopBtn = mkBtn('■ 停止', stopRec, 'small recording'); stopBtn.hidden = true;
  const fileLbl = document.createElement('label'); fileLbl.className = 'btn small'; fileLbl.textContent = '選擇檔案';
  const fileIn = document.createElement('input');
  fileIn.type = 'file'; fileIn.accept = 'audio/*,.wav,.mp3,.m4a,.ogg,.webm,.flac'; fileIn.hidden = true;
  fileLbl.appendChild(fileIn);
  const clearBtn = mkBtn('清除', clear, 'small'); clearBtn.hidden = true;
  const timer = document.createElement('span'); timer.className = 'timer';
  row.append(recBtn, stopBtn, fileLbl, clearBtn, timer);
  const meter = document.createElement('div'); meter.className = 'meter';
  const bar = document.createElement('i'); meter.appendChild(bar);
  const audio = document.createElement('audio'); audio.controls = true; audio.hidden = true;
  const info = document.createElement('p'); info.className = 'hint';
  root.append(row, meter, audio, info);

  let stream = null, mr = null, chunks = [], t0 = 0, raf = 0, actx = null;
  const setInfo = (t, cls = '') => { info.textContent = t; info.className = `hint ${cls}`; };

  function cleanup() {
    cancelAnimationFrame(raf); bar.style.width = '0';
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
    actx?.close?.(); actx = null;
    recBtn.hidden = false; stopBtn.hidden = true; fileLbl.hidden = false;
    if (activeRec === box) activeRec = null;
  }
  async function startRec() {
    activeRec?.stop?.();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) { setInfo(`無法使用麥克風：${e.message}。可改用「選擇檔案」。`, 'bad'); return; }
    clear(true);
    mr = new MediaRecorder(stream);
    chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = async () => { const type = mr.mimeType; cleanup(); await load(new Blob(chunks, { type })); };
    mr.start(250);
    t0 = performance.now();
    recBtn.hidden = true; stopBtn.hidden = false; fileLbl.hidden = true;
    activeRec = box;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      actx = new AC();
      const an = actx.createAnalyser(); an.fftSize = 1024;
      actx.createMediaStreamSource(stream).connect(an);
      const data = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
        bar.style.width = `${Math.min(100, peak * 140)}%`;
        const el = (performance.now() - t0) / 1000;
        timer.textContent = `${el.toFixed(1)} 秒`;
        if (el >= autoStop) { stopRec(); return; }
        raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* 沒有音量表也能錄音 */ }
    setInfo('錄音中…請自然說話，完成後按「停止」。');
  }
  function stopRec() { if (mr && mr.state !== 'inactive') mr.stop(); }
  box.stop = stopRec;

  async function load(blob) {
    setInfo('處理中…');
    try {
      const { wav, trimmed } = await toWav24kMono(await blob.arrayBuffer(), trimTo);
      const sec = C.wavInfo(wav).seconds;
      box.wav = wav; box.seconds = sec;
      audio.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      audio.hidden = false; clearBtn.hidden = false;
      timer.textContent = `${sec.toFixed(1)} 秒`;
      if (sec < minSec) { box.ok = false; setInfo(`${sec.toFixed(1)} 秒：太短，至少需要 ${minSec} 秒。`, 'bad'); }
      else if (maxSec && sec > maxSec) { box.ok = false; setInfo(`${sec.toFixed(1)} 秒：太長，請控制在 ${maxSec} 秒內。`, 'bad'); }
      else { box.ok = true; setInfo(`${sec.toFixed(1)} 秒 · 已轉為 24 kHz 單聲道 16-bit WAV${trimmed ? `（超過 ${trimTo} 秒，已自動取前 ${trimTo} 秒）` : ''}`, 'ok'); }
    } catch (e) { box.wav = null; box.ok = false; setInfo(`無法解析音訊：${e.message}`, 'bad'); }
    onChange?.();
  }
  function clear(silent = false) {
    box.wav = null; box.ok = false; box.seconds = 0;
    audio.hidden = true; audio.removeAttribute('src'); clearBtn.hidden = true; timer.textContent = '';
    if (silent !== true) { setInfo(''); onChange?.(); }
  }
  fileIn.addEventListener('change', async () => { const f = fileIn.files[0]; if (f) await load(f); fileIn.value = ''; });
  return box;
}

// --- 克隆精靈 ---
const lab = { built: false, src: null, consent: null, onDone: null };
function updateLabCreate() {
  $('#labCreate').disabled = !(lab.src?.ok && lab.consent?.ok && $('#labConsentChk').checked);
}
function renderStatement() {
  const p = CONSENT_PHRASES.find((x) => x.lang === $('#labLang').value) || CONSENT_PHRASES[0];
  $('#labStatement').textContent = p.text;
  $('#labLangNote').textContent = p.lang === 'zh-CN'
    ? '官方目前沒有繁體中文版聲明：請以國語逐字朗讀這句原文（文字為簡體中文，發音與國語相同）。'
    : '請逐字朗讀上面的原文（必須是這個語言的原句）。';
}
function openLab(onDone) {
  lab.onDone = onDone || null;
  if (!lab.built) {
    const sel = $('#labLang');
    for (const p of CONSENT_PHRASES) sel.add(new Option(`${p.name}（${p.lang}）`, p.lang));
    const nav = (navigator.language || 'en-US');
    const guess = CONSENT_PHRASES.find((p) => p.lang.toLowerCase() === nav.toLowerCase())
      || CONSENT_PHRASES.find((p) => p.lang.slice(0, 2) === nav.slice(0, 2)) || CONSENT_PHRASES.find((p) => p.lang === 'en-US');
    sel.value = (nav.startsWith('zh') ? 'zh-CN' : guess.lang);
    sel.addEventListener('change', renderStatement);
    lab.src = makeRecBox($('#recSrc'), { minSec: C.CLONE.minSec, trimTo: C.CLONE.maxSec, autoStop: C.CLONE.maxSec, onChange: updateLabCreate });
    lab.consent = makeRecBox($('#recConsent'), { minSec: 1, maxSec: 60, autoStop: 60, onChange: updateLabCreate });
    $('#labConsentChk').addEventListener('change', updateLabCreate);
    $('#labCreate').addEventListener('click', labCreate);
    $('#labClose').addEventListener('click', () => labDlg.close());
    labDlg.addEventListener('close', () => activeRec?.stop?.());
    renderStatement();
    lab.built = true;
  }
  $('#labResult').hidden = true;
  $('#labMsg').textContent = '';
  updateLabCreate();
  if (!labDlg.open) labDlg.showModal();
}

async function labCreate() {
  const btn = $('#labCreate');
  const msg = $('#labMsg');
  if (!keyAvailable()) { msg.textContent = '請先在頁面最上方輸入 API Key。'; return; }
  const store = document.querySelector('input[name=labStore]:checked').value === 'stored';
  const name = $('#labName').value.trim();
  btn.disabled = true;
  msg.textContent = '上傳並建立中（可能需要數十秒）…';
  try {
    const body = C.buildCreateVoiceBody({
      model: cloneModel(), name, store,
      sourceB64: C.bytesToB64(lab.src.wav), consentB64: C.bytesToB64(lab.consent.wav),
    });
    const res = await apiFetch('/voices', { method: 'POST', body });
    const v = C.parseCreatedVoice(res, store);
    if (!store) {
      const exp = Date.parse(v.expires) ? new Date(v.expires).toISOString()
        : new Date(Date.now() + C.CLONE.keyTtlDays * 86400000).toISOString();
      const lib = loadLib().filter((x) => x.voice !== v.voice);
      lib.unshift({ voice: v.voice, name: name || v.name, created: new Date().toISOString(), expires: exp });
      saveLib(lib);
    } else mine.cloudLoaded = false;
    msg.textContent = '';
    const box = $('#labResult');
    box.textContent = '';
    const t = document.createElement('div'); t.className = 'name'; t.textContent = '✅ 已建立克隆聲音';
    const m = document.createElement('div'); m.className = 'meta';
    m.textContent = `${name || v.name || '（未命名）'} · ${store ? `${v.voice}（保留約 1 年）` : `${shortKey(v.voice)}（金鑰 7 天有效，已存入本機金鑰庫）`}`;
    const row = document.createElement('div'); row.className = 'row';
    row.append(
      mkBtn('使用這個聲音', () => { labDlg.close(); lab.onDone?.(v.voice); }, 'small primary'),
      mkBtn('試聽', (e) => previewVoice(v.voice, { btn: e.currentTarget }), 'small'),
    );
    box.append(t, m, row);
    box.hidden = false;
    lab.src.clear(); lab.consent.clear(); $('#labConsentChk').checked = false;
  } catch (e) {
    msg.textContent = `建立失敗：${e.message}`;
  }
  updateLabCreate();
}

function onFormChange() {
  readForm();
  updateVisibility();
  saveCfg();
}

async function init() {
  await detectLocal();
  if (rt.local) {   // 本機版:設置與克隆金鑰庫以本機檔案為準 (與 tts.py 共用)
    try { const srv = await ljson('settings'); if (srv && Object.keys(srv).length) { cfg = mergeCfg(srv); hadSaved = true; } } catch { /* 用瀏覽器內的設置 */ }
    try { const lib = await ljson('lib'); if (Array.isArray(lib)) libCache = lib; } catch { /* ignore */ }
    const og = [...document.querySelectorAll('#out_format optgroup')][1];
    if (og) og.label = '需 ffmpeg 轉檔（使用本機 ffmpeg）';
    const src = rt.hello.key_source;
    if (src) $('#apiKey').placeholder = src === 'env' ? '已使用環境變數中的金鑰（可留空；貼上新金鑰可覆蓋）' : '已使用本機儲存的金鑰（可留空；貼上新金鑰可覆蓋）';
    $('#rememberKey').parentElement.lastChild.textContent = ' 記住（存成本機檔案 .gemini_key，不會被推送到 GitHub）';
  }
  // API Key 還原
  const remember = safeGet(localStorage, REMEMBER_KEY) === '1';
  $('#rememberKey').checked = remember;
  $('#apiKey').value = (remember ? safeGet(localStorage, KEY_KEY) : safeGet(sessionStorage, KEY_KEY)) || '';
  $('#text').value = safeGet(localStorage, DRAFT_KEY) || '';

  fillForm();
  if (hadSaved) {
    const at = safeGet(localStorage, SAVED_AT_KEY);
    const note = $('#restoreNote');
    note.hidden = false;
    note.textContent = `已沿用上次設置${at ? `（${new Date(at).toLocaleString()}）` : ''}。可在「進階選項」重設或匯出。`;
  }

  // 表單
  for (const [k] of BIND) $('#' + k).addEventListener('change', onFormChange);
  $('#style').addEventListener('input', onFormChange);
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', onFormChange));
  $('#modelSel').addEventListener('change', () => {
    modelState.customMode = $('#modelSel').value === '__custom';
    if (modelState.customMode) { $('#modelCustomWrap').hidden = false; $('#modelCustom').focus(); readForm(); saveCfg(); return; }
    onFormChange();
    renderModelSelect();
  });
  $('#modelRefresh').addEventListener('click', () => refreshModels(true));
  $('#clearPreviewCache').addEventListener('click', async () => { await pvCache.clear(); setStatus('已清除試聽快取', 'ok'); });
  $('#models_show_all').addEventListener('change', () => { onFormChange(); renderModelSelect(); });
  $('#modelCustom').addEventListener('input', onFormChange);
  $('#speakers').addEventListener('change', () => {
    readForm();
    for (const n of cfg.speakers) if (!(n in cfg.speaker_voices)) cfg.speaker_voices[n] = '';
    renderSpeakerRows();
    updateVisibility();
    saveCfg();
  });
  $('#text').addEventListener('input', () => { updateCount(); safeSet(localStorage, DRAFT_KEY, $('#text').value); });
  $('#textClear').addEventListener('click', () => { $('#text').value = ''; updateCount(); safeDel(localStorage, DRAFT_KEY); });
  $('#txtFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $('#text').value = (await f.text()).replace(/^\uFEFF/, '');
    $('#text').dispatchEvent(new Event('input'));
    e.target.value = '';
  });
  const ta = $('#text');
  ta.addEventListener('dragover', (e) => e.preventDefault());
  ta.addEventListener('drop', async (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    ta.value = (await f.text()).replace(/^\uFEFF/, '');
    ta.dispatchEvent(new Event('input'));
  });

  // API Key
  $('#keyToggle').addEventListener('click', () => {
    const i = $('#apiKey');
    i.type = i.type === 'password' ? 'text' : 'password';
    $('#keyToggle').textContent = i.type === 'password' ? '顯示' : '隱藏';
  });
  $('#apiKey').addEventListener('change', () => { persistKey(); refreshModels(true); });
  $('#rememberKey').addEventListener('change', persistKey);
  $('#keyClear').addEventListener('click', async () => {
    $('#apiKey').value = '';
    safeDel(localStorage, KEY_KEY); safeDel(sessionStorage, KEY_KEY);
    if (rt.local) { try { await ljson('key', 'DELETE'); await refreshHello(); } catch { /* ignore */ } }
    setStatus(rt.local && rt.hello?.key_source === 'env' ? '已清除；注意環境變數 GEMINI_API_KEY 仍然有效' : '已清除 API Key', 'ok');
  });

  // 人聲
  $('#voiceBtn').addEventListener('click', () => openVoicePicker('單人旁白', cfg.voice, (v) => { cfg.voice = v; saveCfg(); }));
  $('#voiceClose').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#voiceUse').addEventListener('click', () => pickVoice($('#voiceInput').value));
  $('#voiceInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') pickVoice($('#voiceInput').value); });
  $('#voiceSearch').addEventListener('click', () => loadVoices(true));
  $('#voiceMore').addEventListener('click', () => loadVoices(false));
  $('#labOpen').addEventListener('click', () => openLab((v) => pickVoice(v)));
  $('#cloudRefresh').addEventListener('click', () => loadCloud(true));
  $('#cloudMore').addEventListener('click', () => loadCloud(false));
  const grid = $('#builtinGrid');
  for (const [n, d] of C.BUILTIN_VOICES) {
    const cell = document.createElement('div');
    cell.className = 'bcell';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick';
    const sp = document.createElement('span');
    sp.textContent = n;
    const sm = document.createElement('small');
    sm.textContent = d;
    b.append(sp, sm);
    b.addEventListener('click', () => pickVoice(n));
    cell.append(b, mkBtn('▶', (e) => previewVoice(n, { btn: e.currentTarget }), 'small pv'));
    grid.appendChild(cell);
  }

  // 進階工具
  $('#preloadFf').addEventListener('click', async () => {
    const ok = await ensureFfmpeg();
    setStatus(ok ? 'ffmpeg 已就緒（已快取，之後可離線轉檔）' : 'ffmpeg 載入失敗，請看執行紀錄', ok ? 'ok' : 'error');
  });
  $('#exportCfg').addEventListener('click', () => {
    readForm();
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tts_settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $('#importCfg').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { cfg = mergeCfg(JSON.parse(await f.text())); fillForm(); saveCfg(); setStatus('已匯入設置', 'ok'); }
    catch (err) { setStatus(`匯入失敗：${err.message}`, 'error'); }
    e.target.value = '';
  });
  $('#resetCfg').addEventListener('click', () => {
    if (!confirm('確定重設所有設置為預設值？（不會清除 API Key）')) return;
    cfg = structuredClone(C.DEFAULTS);
    fillForm();
    saveCfg();
    setStatus('已重設為預設', 'ok');
  });

  $('#historyRefresh').addEventListener('click', refreshHistory);
  $('#historyClear').addEventListener('click', async () => { if (!confirm('清除所有「最近生成」的音檔？此動作無法復原。')) return; await hist.clear(); refreshHistory(); });
  $('#genBtn').addEventListener('click', generate);
  $('#cancelBtn').addEventListener('click', () => ctl?.abort());
  $('#text').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); } });

  // 本機版專用
  if (rt.local) {
    $('#openOut').addEventListener('click', () => ljson('open', 'POST', {}).catch((e) => setStatus(e.message, 'error')));
    $('#ffmpeg_path').addEventListener('change', async () => { await flushCfg(); await refreshHello(); });
    $('#out_dir').addEventListener('change', async () => { await flushCfg(); await refreshHello(); refreshHistory(); });
    $('#installFf').addEventListener('click', async () => {
      if (!confirm('使用 winget 安裝 ffmpeg（Gyan.FFmpeg）？約需 1–2 分鐘。')) return;
      setStatus('安裝 ffmpeg 中（約 1–2 分鐘，請勿關閉視窗）…');
      progBegin(); prog.pre = '安裝 ffmpeg 中…（約 1–2 分鐘，請勿關閉視窗）';
      try {
        const j = await ljson('install-ffmpeg', 'POST', {});
        await refreshHello();
        setStatus(j.found ? 'ffmpeg 安裝完成' : `安裝未完成：${j.output}`, j.found ? 'ok' : 'error');
      } catch (e) { setStatus(`安裝失敗：${e.message}`, 'error'); }
      progEnd(false);
    });
    $('#quitApp').addEventListener('click', async () => {
      if (!confirm('結束本機服務並關閉程式？')) return;
      try { await ljson('shutdown', 'POST', {}); } catch { /* ignore */ }
      document.body.innerHTML = '<p style="padding:2rem">程式已結束，可以關閉這個視窗。</p>';
    });
    // 心跳:讓本機服務知道視窗還在;連續失敗就明確告訴使用者服務已停止 (而不是等到按下按鈕才發現)
    let pingFails = 0;
    const ping = async () => {
      try {
        const r = await lfetch('ping', { method: 'POST' });
        if (r.status === 403) { showServiceDown(STALE_MSG); return; }
        if (!r.ok) throw new Error('ping');
        pingFails = 0; $('#svcBanner').hidden = true;
      } catch { if (++pingFails >= 2) showServiceDown(SERVICE_DOWN_MSG); }
    };
    setInterval(ping, 5000);
    ping();
    // 視窗關閉時通知服務 (它會等幾秒確認不是重新整理,再自動結束)
    window.addEventListener('pagehide', () => { try { navigator.sendBeacon(`api/bye?t=${encodeURIComponent(rt.token)}`); } catch { /* ignore */ } });
    await refreshHello();
    refreshHistory();
  }

  refreshModels();   // 取得你帳戶可用的最新模型清單 (有快取時會直接使用)
  if (!rt.local) refreshHistory();

  // PWA (本機版不需要)
  if (rt.local) return;
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null;
    $('#installBtn').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

init();
