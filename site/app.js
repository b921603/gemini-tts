// app.js — UI 層 (設定儲存、人聲選擇器、ffmpeg.wasm 載入、生成與結果)
import * as C from './core.js';

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
  saveTimer = setTimeout(() => {
    safeSet(localStorage, SETTINGS_KEY, JSON.stringify(cfg));
    safeSet(localStorage, SAVED_AT_KEY, new Date().toISOString());
  }, 200);
}

const BIND = [
  ['out_format', 'text'], ['sample_rate', 'int'], ['bitrate', 'text'], ['loudnorm', 'bool'],
  ['speed', 'float'], ['keep_wav', 'bool'], ['autoplay', 'bool'], ['retries', 'int'],
  ['conversational', 'bool'], ['force_per_turn', 'bool'], ['gap_ms', 'int'], ['max_chars', 'int'], ['style', 'text'],
];

function readField(k, t) {
  const el = $('#' + k);
  if (t === 'bool') return el.checked;
  if (t === 'int') return Math.max(0, parseInt(el.value, 10) || 0);
  if (t === 'float') { const v = parseFloat(el.value); return Number.isFinite(v) ? Math.min(4, Math.max(0.25, v)) : 1; }
  return el.value.trim();
}

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
  $('#voiceBtn').textContent = cfg.voice || '（尚未選擇）';
  renderChips();
  const needFf = C.needsFfmpeg(cfg, false);
  const note = $('#ffNote');
  note.hidden = !needFf;
  if (needFf) note.textContent = '此設置需要 ffmpeg.wasm：首次使用會下載約 31 MB（之後由瀏覽器快取），轉檔在你的手機上本機執行。';
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
    vbtn.textContent = cfg.speaker_voices[name] || '（尚未選擇）';
    vbtn.addEventListener('click', () => openVoicePicker(`講者 ${name}`, cfg.speaker_voices[name] || '', (v) => {
      cfg.speaker_voices[name] = v; vbtn.textContent = v; saveCfg();
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
  if (remember) { safeSet(localStorage, KEY_KEY, k); safeDel(sessionStorage, KEY_KEY); }
  else { safeSet(sessionStorage, KEY_KEY, k); safeDel(localStorage, KEY_KEY); }
}

async function apiFetch(path, { method = 'GET', body, signal } = {}) {
  const key = getKey();
  if (!key) throw new Error('請先輸入 API Key');
  let res;
  try {
    res = await fetch(C.API_BASE + path, {
      method,
      headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('無法連線到 Gemini API（網路中斷，或被瀏覽器的跨來源限制擋下）');
  }
  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${json?.error?.message || txt.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
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
  ['direct', 'online', 'builtin'].forEach((t) => { $('#tab-' + t).hidden = t !== name; });
  if (name === 'online' && !vstate.loaded) loadVoices(true);
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
  if (!getKey()) { msg.textContent = '請先在頁面最上方輸入 API Key，才能載入線上清單。'; return; }
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
      b.addEventListener('click', () => pickVoice(String(id)));
      li.appendChild(b);
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
  if (!getKey()) return '請先輸入 API Key';
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
  readForm();
  persistKey();
  saveCfg();
  const text = $('#text').value;
  const err = validate(text);
  if (err) { setStatus(err, 'error'); return; }

  ctl = new AbortController();
  setBusy(true);
  $('#log').textContent = '';
  setStatus('準備中…');
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  const t0 = performance.now();
  try {
    const res = await C.runPipeline({
      cfg: structuredClone(cfg),
      text,
      signal: ctl.signal,
      callApi: (body) => apiFetch('/interactions', { method: 'POST', body, signal: ctl.signal }),
      ffmpeg: { ensure: ensureFfmpeg, run: ffRun },
      onLog: log,
      onProgress: (p) => {
        const prog = $('#prog');
        if (p.stage === 'ffmpeg-load') setStatus('載入 ffmpeg…');
        else if (p.stage === 'tts-start') { setStatus(p.perTurn ? `逐段合成中（共 ${p.n} 段）…` : '生成中，請稍候…'); if (p.perTurn) { prog.max = p.n; prog.value = 0; } }
        else if (p.stage === 'tts') { setStatus(`合成第 ${p.i}/${p.n} 段（${p.who}，${p.chars} 字）…`); prog.max = p.n; prog.value = p.i - 1; }
        else if (p.stage === 'convert') { prog.removeAttribute('value'); setStatus('ffmpeg 轉檔中…'); }
      },
    });
    const stem = safeName($('#filename').value.trim() || stamp());
    addResults(res.outputs, stem, res.runCfg);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (res.runCfg.out_format !== cfg.out_format) setStatus(`完成（${secs} 秒）。注意：ffmpeg 無法載入，已改輸出 WAV。`, 'warn');
    else setStatus(`完成（${secs} 秒）`, 'ok');
    log(`完成：${res.outputs.map((o) => o.label).join('、')}`);
  } catch (e) {
    if (e?.name === 'AbortError') { setStatus('已取消', 'warn'); log('使用者取消', 'warn'); }
    else { setStatus(`失敗：${e.message}`, 'error'); log(`失敗：${e.stack || e.message}`, 'error'); }
  } finally {
    setBusy(false);
    try { await wakeLock?.release(); } catch { /* ignore */ }
    wakeLock = null;
    ctl = null;
  }
}

const results = [];
function addResults(outputs, stem, runCfg) {
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
    if (idx === 0 && audio && runCfg.autoplay) audio.play().catch(() => {});
    if (idx === 0) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// --------------------------------------------------------------------------- //
// 事件
// --------------------------------------------------------------------------- //
function onFormChange() {
  readForm();
  updateVisibility();
  saveCfg();
}

function init() {
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
  $('#keyClear').addEventListener('click', () => {
    $('#apiKey').value = '';
    safeDel(localStorage, KEY_KEY); safeDel(sessionStorage, KEY_KEY);
    setStatus('已清除 API Key', 'ok');
  });

  // 人聲
  $('#voiceBtn').addEventListener('click', () => openVoicePicker('單人旁白', cfg.voice, (v) => { cfg.voice = v; saveCfg(); }));
  $('#voiceClose').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#voiceUse').addEventListener('click', () => pickVoice($('#voiceInput').value));
  $('#voiceInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') pickVoice($('#voiceInput').value); });
  $('#voiceSearch').addEventListener('click', () => loadVoices(true));
  $('#voiceMore').addEventListener('click', () => loadVoices(false));
  const grid = $('#builtinGrid');
  for (const [n, d] of C.BUILTIN_VOICES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '';
    const s = document.createElement('span');
    s.textContent = n;
    const sm = document.createElement('small');
    sm.textContent = d;
    b.append(s, sm);
    b.addEventListener('click', () => pickVoice(n));
    grid.appendChild(b);
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

  // PWA
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
