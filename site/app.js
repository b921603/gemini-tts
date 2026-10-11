// app.js — UI 層 (設定儲存、人聲選擇器、ffmpeg.wasm 載入、生成與結果)
import * as C from './core.js';
import { CONSENT_PHRASES } from './consent.js';

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
  ['batch', 'bool'], ['auto_save', 'bool'], ['out_dir', 'text'], ['ffmpeg_path', 'text'],
];

function readField(k, t) {
  const el = $('#' + k);
  if (t === 'bool') return el.checked;
  if (t === 'int') return Math.max(0, parseInt(el.value, 10) || 0);
  if (t === 'float') { const v = parseFloat(el.value); return Number.isFinite(v) ? Math.min(4, Math.max(0.25, v)) : 1; }
  return el.value.trim();
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
  cfg.model = sel === '__custom' ? ($('#modelCustom').value.trim() || C.DEFAULTS.model) : sel;
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
  const known = [...$('#modelSel').options].some((o) => o.value === cfg.model && o.value !== '__custom');
  $('#modelSel').value = known ? cfg.model : '__custom';
  $('#modelCustom').value = known ? '' : cfg.model;
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

async function apiFetch(path, { method = 'GET', body, signal } = {}) {
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
    throw new Error(rt.local ? '無法連線到本機服務或網路中斷' : '無法連線到 Gemini API（網路中斷，或被瀏覽器的跨來源限制擋下）');
  }
  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${json?.error?.message || txt.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (!txt.trim()) return {};
  if (!json) throw new Error('伺服器回應不是有效的 JSON');
  return json;
}

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
  if (!keyAvailable()) { msg.textContent = '請先在頁面最上方輸入 API Key，才能載入線上清單。'; return; }
  msg.textContent = '載入中…';
  $('#voiceMore').hidden = true;
  try {
    const res = await apiFetch('/voices?' + C.buildVoicesQuery(vstate.filters, vstate.token, 20));
    vstate.loaded = true;
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
      li.append(b, mkBtn('▶', () => previewVoice(String(id)), 'small pv'));
      ul.appendChild(li);
    }
    vstate.token = C.pick(res, 'next_page_token', 'nextPageToken') || '';
    $('#voiceMore').hidden = !vstate.token;
    msg.textContent = ul.children.length ? `已載入 ${ul.children.length} 筆` : '沒有符合條件的人聲（可調整篩選，中文可改用關鍵字）。';
  } catch (e) {
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
  $('#prog').hidden = !b;
  if (b) $('#prog').removeAttribute('value');
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
  setStatus('準備中…');
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  const t0 = performance.now();
  const stem = safeName($('#filename').value.trim() || stamp());
  let done = 0, lastRun = null;
  try {
    for (let i = 0; i < chunks.length; i++) {
      const tag = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : '';
      const res = await C.runPipeline({
        cfg: structuredClone(cfg),
        text: chunks[i],
        signal: ctl.signal,
        callApi: (body) => apiFetch('/interactions', { method: 'POST', body, signal: ctl.signal }),
        ffmpeg: { ensure: ensureFfmpeg, run: ffRun },
        onLog: (m, l) => log(tag + m, l),
        onProgress: (p) => {
          const prog = $('#prog');
          if (p.stage === 'ffmpeg-load') setStatus(`${tag}載入 ffmpeg…`);
          else if (p.stage === 'tts-start') { setStatus(`${tag}${p.perTurn ? `逐段合成中（共 ${p.n} 段）…` : '生成中，請稍候…'}`); if (p.perTurn) { prog.max = p.n; prog.value = 0; } else prog.removeAttribute('value'); }
          else if (p.stage === 'tts') { setStatus(`${tag}合成第 ${p.i}/${p.n} 段（${p.who}，${p.chars} 字）…`); prog.max = p.n; prog.value = p.i - 1; }
          else if (p.stage === 'convert') { prog.removeAttribute('value'); setStatus(`${tag}ffmpeg 轉檔中…`); }
        },
      });
      addResults(res.outputs, chunks.length > 1 ? `${stem}_${String(i + 1).padStart(3, '0')}` : stem, res.runCfg, i === 0);
      done++;
      lastRun = res.runCfg;
      log(`${tag}完成：${res.outputs.map((o) => o.label).join('、')}`);
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const many = chunks.length > 1 ? `，共 ${chunks.length} 個檔案` : '';
    if (lastRun.out_format !== cfg.out_format) setStatus(`完成（${secs} 秒${many}）。注意：ffmpeg 無法使用，已改輸出 WAV。`, 'warn');
    else setStatus(`完成（${secs} 秒${many}）`, 'ok');
  } catch (e) {
    const part = chunks.length > 1 ? `（已完成 ${done}/${chunks.length} 段）` : '';
    if (e?.name === 'AbortError') { setStatus(`已取消${part}`, 'warn'); log('使用者取消', 'warn'); }
    else { setStatus(`失敗${part}：${e.message}`, 'error'); log(`失敗：${e.stack || e.message}`, 'error'); }
  } finally {
    setBusy(false);
    try { await wakeLock?.release(); } catch { /* ignore */ }
    wakeLock = null;
    ctl = null;
  }
}

const results = [];
function addResults(outputs, stem, runCfg, autoplayOk = true) {
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

async function refreshHistory() {
  if (!rt.local) return;
  const ul = $('#historyList');
  try {
    const items = await ljson('history');
    ul.textContent = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'hint'; li.textContent = '（輸出資料夾目前沒有音檔）';
      ul.appendChild(li);
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      const n = document.createElement('div'); n.className = 'm-name'; n.textContent = it.name;
      const m = document.createElement('div'); m.className = 'm-meta';
      m.textContent = `${fmtSize(it.size)} · ${new Date(it.mtime * 1000).toLocaleString()}`;
      const row = document.createElement('div'); row.className = 'row';
      const holder = document.createElement('div');
      const ext = it.name.slice(it.name.lastIndexOf('.')).toLowerCase();
      const inline = ['.wav', '.mp3', '.flac', '.ogg', '.opus', '.m4a'].includes(ext);
      row.append(
        mkBtn('播放', () => {
          if (!inline) { ljson('open', 'POST', { name: it.name }); return; }
          if (holder.firstChild) { holder.firstChild.pause(); holder.textContent = ''; return; }
          const a = document.createElement('audio');
          a.controls = true; a.autoplay = true; a.className = 'inline';
          a.src = `api/file?name=${encodeURIComponent(it.name)}&t=${encodeURIComponent(rt.token)}`;
          holder.appendChild(a);
        }, 'small'),
        mkBtn('開啟資料夾', () => ljson('open', 'POST', { name: it.name, folder: true }), 'small'),
        mkBtn('刪除', async () => {
          if (!confirm(`刪除「${it.name}」？此動作無法復原。`)) return;
          try { await ljson('delete', 'POST', { name: it.name }); refreshHistory(); } catch (e) { setStatus(`刪除失敗：${e.message}`, 'error'); }
        }, 'small danger'),
      );
      li.append(n, m, row, holder);
      ul.appendChild(li);
    }
  } catch (e) { ul.textContent = `載入失敗：${e.message}`; }
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
const PREVIEW_TEXT = '你好，這是我的克隆聲音測試。Hello, this is a voice test.';
const mine = { cloudToken: '', cloudLoaded: false };
const cloneModel = () => (Object.values(C.MODELS).includes(cfg.model) ? cfg.model : C.MODELS['1']);
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

function previewSample() {   // 單人模式且已輸入文本時,用文本開頭試聽 (含目前語氣),更貼近實際效果
  if (cfg.mode === 'single') {
    const t = $('#text').value.replace(/<[^>]+>/g, '').trim().slice(0, 80);
    if (t) return { text: t, style: cfg.style };
  }
  return { text: PREVIEW_TEXT, style: '' };
}
async function previewVoice(voice, msgEl = $('#pvMsg')) {
  msgEl.textContent = '試聽生成中…';
  try {
    const smp = previewSample();
    const json = await apiFetch('/interactions', { method: 'POST', body: C.previewBody(cloneModel(), voice, smp.text, smp.style) });
    const url = URL.createObjectURL(new Blob([C.extractAudio(json)], { type: 'audio/wav' }));
    const a = new Audio(url);
    a.addEventListener('ended', () => URL.revokeObjectURL(url));
    await a.play();
    msgEl.textContent = '正在播放試聽…';
  } catch (e) { msgEl.textContent = `試聽失敗：${e.message}`; }
}

function voiceRow({ title, meta, metaClass = '', voice, expired = false, onDelete }) {
  const li = document.createElement('li');
  const n = document.createElement('div'); n.className = 'm-name'; n.textContent = title;
  const m = document.createElement('div'); m.className = `m-meta ${metaClass}`; m.textContent = meta;
  const row = document.createElement('div'); row.className = 'row';
  const use = mkBtn('選用', () => pickVoice(voice), 'small primary');
  const pv = mkBtn('試聽', () => previewVoice(voice, $('#mineMsg')), 'small');
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
  msg.textContent = '載入中…';
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
    const pmsg = document.createElement('p'); pmsg.className = 'hint';
    row.append(
      mkBtn('使用這個聲音', () => { labDlg.close(); lab.onDone?.(v.voice); }, 'small primary'),
      mkBtn('試聽', () => previewVoice(v.voice, pmsg), 'small'),
    );
    box.append(t, m, row, pmsg);
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
  $('#modelSel').addEventListener('change', onFormChange);
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
  $('#apiKey').addEventListener('change', persistKey);
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
    cell.append(b, mkBtn('▶', () => previewVoice(n), 'small pv'));
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

  $('#genBtn').addEventListener('click', generate);
  $('#cancelBtn').addEventListener('click', () => ctl?.abort());
  $('#text').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); } });

  // 本機版專用
  if (rt.local) {
    $('#openOut').addEventListener('click', () => ljson('open', 'POST', {}).catch((e) => setStatus(e.message, 'error')));
    $('#historyRefresh').addEventListener('click', refreshHistory);
    $('#ffmpeg_path').addEventListener('change', async () => { await flushCfg(); await refreshHello(); });
    $('#out_dir').addEventListener('change', async () => { await flushCfg(); await refreshHello(); refreshHistory(); });
    $('#installFf').addEventListener('click', async () => {
      if (!confirm('使用 winget 安裝 ffmpeg（Gyan.FFmpeg）？約需 1–2 分鐘。')) return;
      setStatus('安裝 ffmpeg 中（約 1–2 分鐘，請勿關閉視窗）…');
      $('#prog').hidden = false; $('#prog').removeAttribute('value');
      try {
        const j = await ljson('install-ffmpeg', 'POST', {});
        await refreshHello();
        setStatus(j.found ? 'ffmpeg 安裝完成' : `安裝未完成：${j.output}`, j.found ? 'ok' : 'error');
      } catch (e) { setStatus(`安裝失敗：${e.message}`, 'error'); }
      $('#prog').hidden = true;
    });
    $('#quitApp').addEventListener('click', async () => {
      if (!confirm('結束本機服務並關閉程式？')) return;
      try { await ljson('shutdown', 'POST', {}); } catch { /* ignore */ }
      document.body.innerHTML = '<p style="padding:2rem">程式已結束，可以關閉這個視窗。</p>';
    });
    setInterval(() => { lfetch('ping', { method: 'POST' }).catch(() => {}); }, 5000);
    lfetch('ping', { method: 'POST' }).catch(() => {});
    await refreshHello();
    refreshHistory();
  }

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
