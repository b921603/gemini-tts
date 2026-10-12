// core.js — Gemini TTS 核心邏輯 (無 DOM 依賴,可在瀏覽器與 Node 測試)
// 由 tts.py 一對一移植:文本解析、分段、請求組裝、WAV 處理、ffmpeg 參數、完整生成流程。

export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// --------------------------------------------------------------------------- //
// 模型探索:不綁定任何特定世代。平常以 API (GET /v1beta/models) 即時回傳的清單為準,
// 自動挑選「最新世代」的語音模型;下一代模型出現時不需要改程式。
// --------------------------------------------------------------------------- //
/** 只在「從未成功取得過線上清單」(離線/第一次) 時才使用的備援,上線後即被取代 */
export const FALLBACK_TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];

export const stripModelPrefix = (n) => String(n || '').trim().replace(/^models\//, '');
export const isTtsModelId = (id) => /tts/i.test(id || '');

/** 從模型 ID 解析 {version:[3,8], tier, preview}。例: gemini-3.8-flash-lite-tts-preview */
export function parseModelId(id) {
  const m = /(?:^|-)(\d+(?:\.\d+)*)(?=-|$)/.exec(id || '');
  const version = m ? m[1].split('.').map(Number) : [0];
  const tier = /lite/i.test(id) ? 'lite' : /pro/i.test(id) ? 'pro' : /flash/i.test(id) ? 'flash' : 'other';
  return { version, tier, preview: /preview|exp/i.test(id || '') };
}
const TIER_ORDER = { flash: 0, pro: 1, lite: 2, other: 3 };
function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] || 0) - (a[i] || 0);      // 新版本在前
    if (d) return d;
  }
  return 0;
}
/** 最佳在前:語音模型優先 → 版本新 → 正式版優先於 preview → flash(均衡) > pro > lite → ID 字母序 */
export function compareModels(x, y) {
  const a = parseModelId(x.id), b = parseModelId(y.id);
  return (Number(isTtsModelId(y.id)) - Number(isTtsModelId(x.id)))
    || cmpVersion(a.version, b.version)
    || (Number(a.preview) - Number(b.preview))
    || (TIER_ORDER[a.tier] - TIER_ORDER[b.tier])
    || x.id.localeCompare(y.id);
}
/** apiModels: API 回傳的 models[] (name / displayName ...)。showAll=false 時只留名稱含 tts 的模型。 */
export function normalizeModelList(apiModels, showAll = false) {
  const seen = new Set();
  const out = [];
  for (const m of apiModels || []) {
    const id = stripModelPrefix(m.id || m.name);
    if (!id || seen.has(id) || (!showAll && !isTtsModelId(id))) continue;
    seen.add(id);
    out.push({ id, displayName: m.displayName || m.display_name || '' });
  }
  return out.sort(compareModels);
}
export const pickAutoModel = (items) => (items && items.length ? items.find((x) => isTtsModelId(x.id))?.id || items[0].id : '');
/** 'auto' → 目前最新的語音模型;其他值原樣使用 (去掉 models/ 前綴) */
export function resolveModel(model, items) {
  const m = stripModelPrefix(model);
  if (!m || m === 'auto') return pickAutoModel(items) || FALLBACK_TTS_MODELS[0];
  return m;
}

export const BUILTIN_VOICES = [
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'],
  ['Kore', 'Firm'], ['Fenrir', 'Excitable'], ['Leda', 'Youthful'],
  ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'],
  ['Autonoe', 'Bright'], ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'],
  ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'],
  ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'],
  ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'], ['Alnilam', 'Firm'],
  ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'],
  ['Achird', 'Friendly'], ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'],
  ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
];
const BUILTIN_LOOKUP = new Map(BUILTIN_VOICES.map(([n]) => [n.toLowerCase(), n]));

// API 原生可直接輸出的格式
export const NATIVE_FORMATS = {
  wav: { mime: 'audio/wav', ext: '.wav' },
  pcm: { mime: 'audio/l16', ext: '.pcm' },
  mulaw: { mime: 'audio/mulaw', ext: '.mulaw' },
  alaw: { mime: 'audio/alaw', ext: '.alaw' },
};
// 需要 ffmpeg 轉檔的格式
export const FFMPEG_FORMATS = { mp3: '.mp3', flac: '.flac', ogg: '.ogg', opus: '.opus', m4a: '.m4a' };
export const LOSSY = new Set(['mp3', 'ogg', 'opus', 'm4a']);
export const PCM_RATE = 24000;

const BLOB_MIME = {
  wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
  opus: 'audio/ogg', m4a: 'audio/mp4',
  pcm: 'application/octet-stream', mulaw: 'application/octet-stream', alaw: 'application/octet-stream',
};
export const PLAYABLE = new Set(['wav', 'mp3', 'flac', 'ogg', 'opus', 'm4a']);

export const DEFAULTS = {
  model: 'auto',                // 'auto' = 自動選用目前最新的語音(TTS)模型;也可填具體模型 ID
  models_show_all: false,       // 模型清單是否包含名稱不含 tts 的模型 (萬一新世代命名改變時的後路)
  mode: 'single',               // single / multi
  voice: 'Kore',
  style: '',
  speakers: ['Joe', 'Jane'],
  speaker_voices: { Joe: 'Puck', Jane: 'Kore' },
  speaker_styles: {},
  conversational: false,        // 多人 mode=conversational (REST 原生支援)
  force_per_turn: false,        // 強制逐段合成再拼接
  gap_ms: 300,                  // 逐段合成時段間靜音
  max_chars: 0,                 // 單人長文分段上限 (0=不分段)
  out_format: 'wav',
  sample_rate: 0,               // 0 = 預設
  bitrate: '192k',
  loudnorm: false,
  speed: 1.0,
  keep_wav: false,              // 經 ffmpeg 轉檔時,另外保留原始 WAV
  autoplay: true,               // 生成後自動播放預覽
  retries: 2,
  stream: true,                 // 使用串流取得即時進度 (官方支援 stream:true;失敗會自動退回一般模式)
  preview_mode: 'sample',       // 試聽內容: sample = 一句短範例 (省額度,預設) / mytext = 我的文本開頭
  preview_chars: 30,            // 試聽用我的文本開頭時的字數上限
  batch: false,                 // 批次模式: 文本以單獨一行 --- 分隔,每段各產生一個檔案
  auto_save: true,              // (本機版) 生成後自動存進輸出資料夾
  out_dir: 'output',            // (本機版) 輸出資料夾
  ffmpeg_path: '',              // (本機版) ffmpeg.exe 路徑,留空=自動尋找
  gui_browser: 'auto',          // (本機版) 開啟視窗用的瀏覽器: auto(優先 Chrome) / chrome / edge / default
};

// --------------------------------------------------------------------------- //
// 人聲
// --------------------------------------------------------------------------- //
export function canonicalVoice(name) {
  const n = String(name).trim();
  return BUILTIN_LOOKUP.get(n.toLowerCase()) || n;
}
export const isCustomVoice = (v) => /^(voice_|voicekey_)/.test(v || '');

export function pick(o, ...keys) {
  if (!o) return '';
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return '';
}

export function buildVoicesQuery(filters = {}, pageToken = '', pageSize = 20) {
  const q = new URLSearchParams();
  q.set('page_size', String(pageSize));
  if (pageToken) q.set('page_token', pageToken);
  const multi = { language_code: 'language_code', gender: 'gender', pitch: 'pitch', contexts: 'context', type: 'type' };
  for (const [fk, qk] of Object.entries(multi)) for (const v of filters[fk] || []) if (v) q.append(qk, v);
  if (filters.search) q.set('search', filters.search);
  return q;
}

// --------------------------------------------------------------------------- //
// 文本處理
// --------------------------------------------------------------------------- //
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseDialogue(text, speakers) {
  const canon = new Map(speakers.map((n) => [n.toLowerCase(), n]));
  const names = [...speakers].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pat = new RegExp(
    '^\\s*(' + names.join('|') + ')\\s*(?:[\\[\\(（【]([^\\]\\)）】]*)[\\]\\)）】])?\\s*[:：]\\s*(.*)$', 'i');
  const turns = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = pat.exec(line);
    if (m) {
      turns.push({ speaker: canon.get(m[1].toLowerCase()), style: (m[2] || '').trim(), text: (m[3] || '').trim() });
    } else if (turns.length) {
      turns[turns.length - 1].text += '\n' + line.trim();
    } else {
      throw new Error(`第一行必須以講者名稱開頭 (${speakers.join(', ')}),例如「${speakers[0]}: 你好」`);
    }
  }
  const out = turns.filter((t) => t.text.trim());
  if (!out.length) throw new Error('沒有解析到任何有內容的對話。');
  return out;
}

export function splitText(text, limit) {
  const units = [];
  for (let para of text.split(/\n+/)) {
    para = para.trim();
    if (!para) continue;
    for (const p of para.split(/(?<=[。！？!?…])|(?<=[.;；])\s+/)) if (p && p.trim()) units.push(p.trim());
  }
  const chunks = [];
  let cur = '';
  for (let u of units) {
    while ([...u].length > limit) {           // 超長單句硬切 (以字元計,避免切壞代理對)
      if (cur) { chunks.push(cur); cur = ''; }
      const arr = [...u];
      chunks.push(arr.slice(0, limit).join(''));
      u = arr.slice(limit).join('');
    }
    if (!u) continue;
    const sep = cur && /^[\x00-\x7F]$/.test(cur[cur.length - 1]) ? ' ' : '';
    if (cur && [...cur].length + sep.length + [...u].length > limit) { chunks.push(cur); cur = u; }
    else cur = cur ? cur + sep + u : u;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function buildSegments(cfg, text) {
  if (cfg.mode === 'single') {
    const pieces = cfg.max_chars && [...text].length > cfg.max_chars ? splitText(text, cfg.max_chars) : [text];
    return pieces.map((p) => ({ speaker: null, voice: cfg.voice, style: cfg.style, text: p }));
  }
  return parseDialogue(text, cfg.speakers).map((t) => ({
    speaker: t.speaker,
    voice: cfg.speaker_voices[t.speaker],
    style: t.style || cfg.speaker_styles[t.speaker] || '',
    text: t.text,
  }));
}

export function makeInput(segments, multi) {
  const content = segments.map((s) => {
    const item = { type: 'text', text: s.text };
    const ann = {};
    if (multi) ann.speaker = s.speaker;
    if (s.style) ann.style = s.style;
    if (Object.keys(ann).length) item.annotations = [{ type: 'speech_metadata', ...ann }];
    return item;
  });
  return [{ type: 'user_input', content }];
}

// --------------------------------------------------------------------------- //
// 位元組 / WAV
// --------------------------------------------------------------------------- //
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concatBytes(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function pcmToWav(pcm, rate = PCM_RATE) {
  const buf = new ArrayBuffer(44 + pcm.length);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

export function wavToPcm(wav) {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let o = 12;
  while (o + 8 <= wav.length) {
    const id = String.fromCharCode(wav[o], wav[o + 1], wav[o + 2], wav[o + 3]);
    const size = v.getUint32(o + 4, true);
    if (id === 'data') return wav.subarray(o + 8, Math.min(wav.length, o + 8 + size));
    o += 8 + size + (size % 2);
  }
  throw new Error('不是有效的 WAV 資料');
}

// --------------------------------------------------------------------------- //
// ffmpeg 參數
// --------------------------------------------------------------------------- //
export function needsFfmpeg(cfg, perTurn) {
  const fmt = cfg.out_format;
  if (fmt in FFMPEG_FORMATS) return true;
  if (cfg.loudnorm || Math.abs(cfg.speed - 1) > 1e-6) return true;
  if (perTurn && (fmt === 'mulaw' || fmt === 'alaw' || (cfg.sample_rate && (fmt === 'wav' || fmt === 'pcm')))) return true;
  return false;
}

export function atempoChain(speed) {
  const parts = [];
  while (speed > 2.0) { parts.push('atempo=2.0'); speed /= 2.0; }
  while (speed < 0.5) { parts.push('atempo=0.5'); speed /= 0.5; }
  parts.push(`atempo=${speed.toFixed(4)}`);
  return parts.join(',');
}

const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];

// libvorbis 在單聲道/低取樣率下無法指定高位元率 (會 encoder setup failed),改用品質等級
function vorbisQuality(br) {
  const k = parseInt(String(br), 10) || 192;
  return k <= 64 ? 2 : k <= 96 ? 3 : k <= 128 ? 4 : k <= 160 ? 5 : k <= 192 ? 6 : 7;
}

export function buildFfmpegArgs(cfg, src, dst) {
  const fmt = cfg.out_format;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', src];
  const filters = [];
  if (Math.abs(cfg.speed - 1) > 1e-6) filters.push(atempoChain(cfg.speed));
  if (cfg.loudnorm) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  if (filters.length) args.push('-af', filters.join(','));
  let sr = cfg.sample_rate ? Number(cfg.sample_rate) : 0;
  if (fmt === 'opus' && sr && !OPUS_RATES.includes(sr)) sr = 48000;   // libopus 只支援特定取樣率
  if (sr) args.push('-ar', String(sr));
  else if (cfg.loudnorm) args.push('-ar', String(PCM_RATE));          // loudnorm 內部會升頻到 192kHz
  args.push('-ac', '1');
  const br = cfg.bitrate;
  const codec = {
    wav: ['-c:a', 'pcm_s16le'],
    pcm: ['-f', 's16le', '-c:a', 'pcm_s16le'],
    mulaw: ['-f', 'mulaw'],
    alaw: ['-f', 'alaw'],
    mp3: ['-c:a', 'libmp3lame', '-b:a', br],
    flac: ['-c:a', 'flac'],
    ogg: ['-c:a', 'libvorbis', '-q:a', String(vorbisQuality(br))],
    opus: ['-c:a', 'libopus', '-b:a', br],
    m4a: ['-c:a', 'aac', '-b:a', br],
  }[fmt];
  args.push(...codec, dst);
  return args;
}

export function outputMeta(fmt) {
  const ext = FFMPEG_FORMATS[fmt] || NATIVE_FORMATS[fmt].ext;
  return { ext, mime: BLOB_MIME[fmt], playable: PLAYABLE.has(fmt) };
}

// --------------------------------------------------------------------------- //
// API 呼叫
// --------------------------------------------------------------------------- //
export function extractAudio(json) {
  let last = null;
  for (const s of json?.steps || []) {
    if (s?.type !== 'model_output') continue;
    for (const c of s.content || []) if (c?.type === 'audio' && c.data) last = c.data;
  }
  if (!last) last = json?.output_audio?.data || json?.outputAudio?.data || null;
  if (!last) throw new Error('回應中沒有音訊資料: ' + JSON.stringify(json).slice(0, 400));
  return b64ToBytes(last);
}

export async function withRetry(fn, retries, { onRetry, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const st = e?.status;
      const clientErr = st >= 400 && st < 500 && st !== 408 && st !== 429;   // 金鑰錯誤/參數錯誤重試也沒用
      if (e?.name === 'AbortError' || signal?.aborted || clientErr || e?.noRetry || attempt >= retries) throw e;
      const wait = 2 ** attempt;
      onRetry?.(e, wait, attempt + 1, retries);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

// --------------------------------------------------------------------------- //
// 進度:串流 (SSE) 與估算
// 官方文件: stream:true 時,音訊以 step.delta 事件 (delta.type==='audio', delta.data 為 base64 的 24 kHz 單聲道 16-bit PCM) 分塊傳回。
// 官方沒有「百分比」進度,所以顯示「已收到幾秒音訊」+ 依文字量估算的總長度 (估算值,僅供預期)。
// --------------------------------------------------------------------------- //
/** 依文字量粗估語音長度 (秒):CJK ≈ 4.2 字/秒、其他 ≈ 14 字元/秒;<short pause>/<long pause> 另加 */
export function estimateSpeechSeconds(text) {
  const raw = String(text || '');
  const pauses = (raw.match(/<short pause>/gi) || []).length * 0.5 + (raw.match(/<long pause>/gi) || []).length * 1.2;
  const t = raw.replace(/<[^>]*>/g, ' ');
  const cjk = (t.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  const rest = t.replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\s]/g, '').length;
  return Math.max(1, cjk / 4.2 + rest / 14 + pauses);
}

/** 讀取 SSE (text/event-stream):body 是 ReadableStream;每個 data: JSON 事件呼叫 onEvent(obj) */
export async function readSSE(body, onEvent) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const handle = (raw) => {
    const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data.trim() || data.trim() === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    onEvent(obj);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      handle(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
  }
  buf += dec.decode();
  if (buf.trim()) handle(buf);
}

const deltaAudio = (ev) => {
  const d = ev?.delta ?? ev?.data?.delta;
  return d && d.type === 'audio' && typeof d.data === 'string' ? d.data : null;
};
function deepAudio(o, out = [], depth = 0) {   // 事件格式萬一不同時的寬鬆後備:找出所有 type:'audio' 的 base64 區塊
  if (!o || typeof o !== 'object' || depth > 6) return out;
  if (o.type === 'audio' && typeof o.data === 'string' && o.data.length > 64) out.push(o.data);
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepAudio(v, out, depth + 1);
  return out;
}
const findUsage = (ev) => ev?.usage || ev?.interaction?.usage || ev?.usage_metadata || ev?.usageMetadata || null;

/** 合併多段的用量 (數字欄位相加) */
export function mergeUsage(list) {
  const out = {};
  for (const u of list || []) for (const [k, v] of Object.entries(u || {})) if (typeof v === 'number') out[k] = (out[k] || 0) + v;
  return out;
}

async function streamPcm(streamApi, body, { signal, onOpen, onChunk }) {
  const res = await streamApi(body, { signal });
  onOpen?.();
  const deltas = [];
  let finals = [];
  let usage = null;
  let total = 0, nEvents = 0;
  const types = new Set();
  await readSSE(res.body, (ev) => {
    nEvents++;
    if (ev?.event_type) types.add(ev.event_type);
    if (ev?.error) throw Object.assign(new Error(ev.error.message || JSON.stringify(ev.error)), { status: ev.error.code });
    const b64 = deltaAudio(ev);
    if (b64) {
      const u8 = b64ToBytes(b64);
      deltas.push(u8);
      total += u8.length;
      onChunk?.(total);
    } else if (/complete|done|stop/i.test(ev?.event_type || '')) finals = finals.concat(deepAudio(ev));
    usage = findUsage(ev) || usage;
  });
  const parts = deltas.length ? deltas : finals.map(b64ToBytes);
  if (!parts.length) {
    throw Object.assign(new Error(`串流沒有收到音訊（${nEvents} 個事件：${[...types].join(', ') || '無類型'}）`), { emptyStream: true, noRetry: true });   // 重試只會重複生成 (重複計費),直接退回一般模式
  }
  const data = concatBytes(parts);
  const isWav = String.fromCharCode(data[0], data[1], data[2], data[3]) === 'RIFF';
  return isWav ? { wav: data, usage } : { pcm: data, usage };
}

// --------------------------------------------------------------------------- //
// API 呼叫
// --------------------------------------------------------------------------- //
const bodyFor = (model, input, speechConfig, rf) => ({ model, input, response_format: rf, generation_config: { speech_config: speechConfig } });

/**
 * 合成一次。out: 'pcm' → 24 kHz 單聲道原始 PCM;'wav' → 含檔頭 WAV;'native' → 依 rf 原樣 (mulaw/alaw/自訂取樣率,不走串流)。
 * ctx.streamApi 可用且 cfg.stream !== false 時走串流 (取得即時進度);還沒收到任何音訊就失敗時,自動退回一般請求。
 */
async function synth(ctx, { input, speechConfig, rf, out, segInfo = {}, estSec = 0, retries }) {
  const { cfg, callApi, streamApi, hooks, onProgress } = ctx;
  const tag = (o) => ({ ...segInfo, ...o });
  if (streamApi && cfg.stream !== false && !ctx.streamBroken && out !== 'native') {
    let got = false;
    try {
      return await withRetry(async () => {
        try {
          onProgress?.(tag({ stage: 'sent', mode: 'stream' }));
          const body = { ...bodyFor(cfg.model, input, speechConfig, { type: 'audio', mime_type: 'audio/l16', sample_rate: PCM_RATE }), stream: true };
          const r = await streamPcm(streamApi, body, {
            signal: hooks.signal,
            onOpen: () => onProgress?.(tag({ stage: 'accepted', mode: 'stream' })),
            onChunk: (total) => { got = true; onProgress?.(tag({ stage: 'receiving', mode: 'stream', seconds: total / (PCM_RATE * 2), est: estSec })); },
          });
          if (r.usage) ctx.usage.push(r.usage);
          if (r.wav) return out === 'wav' ? r.wav : wavToPcm(r.wav);
          return out === 'wav' ? pcmToWav(r.pcm, PCM_RATE) : r.pcm;
        } catch (e) {
          if (got && e && typeof e === 'object') e.noRetry = true;     // 已收到部分音訊就不要整段重來 (避免重複計費)
          throw e;
        }
      }, retries, hooks);
    } catch (e) {
      const streamUnsupported = e?.emptyStream || (e?.status === 400 && /stream/i.test(e.message || ''));
      if (!streamUnsupported || got) throw e;
      ctx.streamBroken = true;
      ctx.log?.(`串流模式無法使用 (${e.message})，改用一般模式。`, 'warn');
    }
  }
  onProgress?.(tag({ stage: 'sent', mode: 'unary' }));
  const data = await withRetry(async () => extractAudio(await callApi(bodyFor(cfg.model, input, speechConfig, rf))), retries, hooks);
  onProgress?.(tag({ stage: 'received', mode: 'unary' }));
  return data;
}

/** 試聽等「單句合成」:回傳含檔頭的 WAV */
export async function synthesizeOnce({ model, voice, style = '', text, callApi, streamApi, onProgress, signal, stream = true }) {
  const ctx = { cfg: { model, stream }, callApi, streamApi, hooks: { signal }, onProgress, usage: [] };
  const input = makeInput([{ speaker: null, voice, style, text }], false);
  const wav = await synth(ctx, { input, speechConfig: [{ voice }], rf: { type: 'audio' }, out: 'wav', estSec: estimateSpeechSeconds(text), retries: 0 });
  return { wav, usage: mergeUsage(ctx.usage) };
}

async function generateSingleRequest(ctx, { segments, multi, needFf }) {
  const { cfg, callApi, hooks, log } = ctx;
  const fmt = cfg.out_format;
  const wantWav = needFf || (fmt === 'wav' && !cfg.sample_rate);
  const rf = { type: 'audio' };
  if (!needFf) {
    if (fmt !== 'wav' || cfg.sample_rate) rf.mime_type = NATIVE_FORMATS[fmt].mime;
    if (cfg.sample_rate) rf.sample_rate = Number(cfg.sample_rate);
  }
  const input = makeInput(segments, multi);
  const kind = needFf ? 'wav' : fmt;
  const estSec = estimateSpeechSeconds(segments.map((s) => s.text).join(' '));
  const run = (speechConfig, retries) => synth(ctx, { input, speechConfig, rf, out: wantWav ? 'wav' : 'native', estSec, retries });
  let sc;
  if (multi) {
    sc = { speakers: cfg.speakers.map((n) => ({ speaker: n, voice: cfg.speaker_voices[n] })) };
    if (cfg.conversational) {
      try {
        return { data: await run({ ...sc, mode: 'conversational' }, 0), kind };
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        log?.(`帶 mode=conversational 失敗 (${e.message}),改用一般多人模式重試。`, 'warn');
      }
    }
  } else {
    sc = [{ voice: segments[0].voice }];
  }
  return { data: await run(sc, cfg.retries), kind };
}

async function generatePerTurn(ctx, { segments }) {
  const { cfg, onProgress } = ctx;
  const chunks = [];
  const gap = new Uint8Array(2 * Math.floor(PCM_RATE * cfg.gap_ms / 1000));
  const rf = { type: 'audio', mime_type: 'audio/l16', sample_rate: PCM_RATE };
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const info = { i: i + 1, n: segments.length, who: s.speaker || '旁白', chars: [...s.text].length };
    onProgress?.({ stage: 'tts', ...info });
    const input = makeInput([{ ...s, speaker: null }], false);
    const data = await synth(ctx, { input, speechConfig: [{ voice: s.voice }], rf, out: 'pcm', segInfo: info, estSec: estimateSpeechSeconds(s.text), retries: cfg.retries });
    if (i > 0 && gap.length) chunks.push(gap);
    chunks.push(data);
  }
  return { data: pcmToWav(concatBytes(chunks), PCM_RATE), kind: 'wav' };
}

// --------------------------------------------------------------------------- //
// 完整流程
// --------------------------------------------------------------------------- //
export function planGeneration(cfg, segments) {
  const multi = cfg.mode === 'multi';
  const custom = segments.some((s) => isCustomVoice(s.voice));
  const nSpeakers = multi ? new Set(segments.map((s) => s.speaker)).size : 1;
  const perTurn = (segments.length > 1 && !multi) ||
    (multi && (cfg.force_per_turn || custom || cfg.speakers.length > 2 || nSpeakers > 2));
  const notes = [];
  if (multi && custom) notes.push('使用了自訂人聲 (voice_...),多人對話改為逐段合成後拼接。');
  if (multi && cfg.speakers.length > 2) notes.push('講者超過 2 位,改為逐段合成後拼接。');
  if (!multi && segments.length > 1) notes.push(`文本已自動分成 ${segments.length} 段,將逐段合成後拼接。`);
  return { multi, perTurn, notes };
}

/**
 * runPipeline
 *  cfg       設定
 *  text      文本
 *  callApi   async (body) => JSON
 *  streamApi async (body, {signal}) => Response(SSE)   (選用;有提供且 cfg.stream !== false 時顯示即時進度)
 *  ffmpeg    { ensure: async () => bool, run: async (args, inputBytes, outName) => Uint8Array }
 *  onProgress / onLog / signal
 * 回傳 { outputs:[{label, bytes, ext, mime, playable, fmt}], runCfg, perTurn, segments, usage }
 */
export async function runPipeline({ cfg, text, callApi, streamApi, ffmpeg, onProgress, onLog, signal }) {
  const log = (m, level = 'info') => onLog?.(m, level);
  const segments = buildSegments(cfg, text);
  const { multi, perTurn, notes } = planGeneration(cfg, segments);
  notes.forEach((n) => log(n));

  const runCfg = { ...cfg };
  let needFf = needsFfmpeg(runCfg, perTurn);
  if (needFf) {
    onProgress?.({ stage: 'ffmpeg-load' });
    const ok = ffmpeg ? await ffmpeg.ensure() : false;
    if (!ok) {
      log('ffmpeg 無法載入,本次改為輸出 WAV,並略過響度/變速/轉檔。', 'warn');
      Object.assign(runCfg, { out_format: 'wav', loudnorm: false, speed: 1.0, sample_rate: 0 });
      needFf = false;
    }
  }

  const hooks = {
    signal,
    onRetry: (e, wait, n, total) => log(`失敗 (${e.message});${wait} 秒後重試 (${n}/${total})`, 'warn'),
  };
  const ctx = { cfg: runCfg, callApi, streamApi, hooks, onProgress, log, usage: [], streamBroken: false };
  onProgress?.({ stage: 'tts-start', perTurn, n: segments.length, estSec: estimateSpeechSeconds(segments.map((s) => s.text).join(' ')) });
  const gen = perTurn ? await generatePerTurn(ctx, { segments }) : await generateSingleRequest(ctx, { segments, multi, needFf });

  const fmt = runCfg.out_format;
  const outputs = [];
  if (!needFf) {
    if (perTurn) {
      if (fmt === 'pcm') outputs.push({ label: 'PCM', bytes: wavToPcm(gen.data), fmt, ...outputMeta('pcm') });
      else outputs.push({ label: 'WAV', bytes: gen.data, fmt: 'wav', ...outputMeta('wav') });
    } else {
      outputs.push({ label: fmt.toUpperCase(), bytes: gen.data, fmt, ...outputMeta(fmt) });
    }
  } else {
    onProgress?.({ stage: 'convert' });
    const meta = outputMeta(fmt);
    const outName = 'out' + meta.ext;
    if (runCfg.keep_wav) outputs.push({ label: '原始 WAV', bytes: gen.data, fmt: 'wav', ...outputMeta('wav') });
    try {
      const bytes = await ffmpeg.run(buildFfmpegArgs(runCfg, 'src.wav', outName), gen.data, outName);
      outputs.unshift({ label: fmt.toUpperCase(), bytes, fmt, ...meta });
    } catch (e) {
      // 轉檔失敗時不要浪費已付費生成的音訊:保留原始 WAV
      log(`ffmpeg 轉檔失敗 (${e.message}),已保留原始 WAV。`, 'error');
      if (!outputs.length) outputs.push({ label: '原始 WAV (轉檔失敗)', bytes: gen.data, fmt: 'wav', ...outputMeta('wav') });
    }
  }
  return { outputs, runCfg, perTurn, segments, usage: mergeUsage(ctx.usage) };
}

// --------------------------------------------------------------------------- //
// 音色克隆 (Voice replication) — POST/GET/DELETE /v1beta/voices
// --------------------------------------------------------------------------- //
export const CLONE = {
  minSec: 10, maxSec: 30, rate: 24000,
  statefulTtlDays: 365, keyTtlDays: 7, projectLimit: 200,
};

export function bytesToB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

/** 解析 WAV 檔頭,回傳 {channels, rate, bits, seconds};不是 PCM WAV 則丟錯 */
export function wavInfo(u8) {
  if (u8.length < 44 || String.fromCharCode(...u8.subarray(0, 4)) !== 'RIFF') throw new Error('不是有效的 WAV 檔');
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 12, fmt = null, dataSize = 0;
  while (o + 8 <= u8.length) {
    const id = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    if (id === 'data') { dataSize = Math.min(size, u8.length - o - 8); break; }
    o += 8 + size + (size % 2);
  }
  if (!fmt) throw new Error('WAV 缺少 fmt 區塊');
  return { ...fmt, seconds: dataSize / (fmt.rate * fmt.channels * (fmt.bits / 8)) };
}

/** 建立克隆聲音的請求本體。store=true → voice_ ID (存在 Google 專案);false → voicekey_ 金鑰 (自行保管) */
export function buildCreateVoiceBody({ model, name, store, sourceB64, consentB64 }) {
  const voice = {
    type: 'replicated',
    replicated: {
      source_audio: { mime_type: 'audio/wav', data: sourceB64 },
      consent_audio: { mime_type: 'audio/wav', data: consentB64 },
    },
  };
  if (model) voice.model = model;
  if (name) voice.display_name = name;
  return { store: !!store, voice };
}

/** 解析建立結果:voice 為之後填進 speech_config 的字串 */
export function parseCreatedVoice(res, store) {
  const id = pick(res, 'id');
  const key = pick(res, 'key', 'voice_key', 'voiceKey');
  const voice = (!store && key) ? key : (id || key);
  if (!voice) throw new Error('建立成功但回應中找不到 voice ID/key: ' + JSON.stringify(res).slice(0, 300));
  return {
    voice: String(voice), id: String(id || ''), key: String(key || ''),
    name: String(pick(res, 'display_name', 'displayName') || ''),
    expires: String(pick(res, 'expire_time', 'expireTime', 'expires_at') || ''),
  };
}

/** 試聽用的單句請求 */
export function previewBody(model, voice, text, style = '') {
  return {
    model,
    input: makeInput([{ speaker: null, voice, style, text }], false),
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] },
  };
}
