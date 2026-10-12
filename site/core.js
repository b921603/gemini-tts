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

// callApi(body) -> parsed JSON (由呼叫端注入 fetch 邏輯,便於測試)
async function callTTS(callApi, model, input, speechConfig, responseFormat, retries, hooks) {
  const body = { model, input, response_format: responseFormat, generation_config: { speech_config: speechConfig } };
  return withRetry(async () => extractAudio(await callApi(body)), retries, hooks);
}

async function generateSingleRequest({ cfg, segments, multi, needFf, callApi, hooks, log }) {
  const fmt = cfg.out_format;
  const rf = { type: 'audio' };
  if (!needFf) {
    if (fmt !== 'wav' || cfg.sample_rate) rf.mime_type = NATIVE_FORMATS[fmt].mime;
    if (cfg.sample_rate) rf.sample_rate = Number(cfg.sample_rate);
  }
  const input = makeInput(segments, multi);
  const kind = needFf ? 'wav' : fmt;
  let sc;
  if (multi) {
    sc = { speakers: cfg.speakers.map((n) => ({ speaker: n, voice: cfg.speaker_voices[n] })) };
    if (cfg.conversational) {
      try {
        return { data: await callTTS(callApi, cfg.model, input, { ...sc, mode: 'conversational' }, rf, 0, hooks), kind };
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        log?.(`帶 mode=conversational 失敗 (${e.message}),改用一般多人模式重試。`, 'warn');
      }
    }
  } else {
    sc = [{ voice: segments[0].voice }];
  }
  return { data: await callTTS(callApi, cfg.model, input, sc, rf, cfg.retries, hooks), kind };
}

async function generatePerTurn({ cfg, segments, callApi, hooks, onProgress }) {
  const chunks = [];
  const gap = new Uint8Array(2 * Math.floor(PCM_RATE * cfg.gap_ms / 1000));
  const rf = { type: 'audio', mime_type: 'audio/l16', sample_rate: PCM_RATE };
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    onProgress?.({ stage: 'tts', i: i + 1, n: segments.length, who: s.speaker || '旁白', chars: [...s.text].length });
    const input = makeInput([{ ...s, speaker: null }], false);
    const data = await callTTS(callApi, cfg.model, input, [{ voice: s.voice }], rf, cfg.retries, hooks);
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
 *  ffmpeg    { ensure: async () => bool, run: async (args, inputBytes, outName) => Uint8Array }
 *  onProgress / onLog / signal
 * 回傳 { outputs:[{label, bytes, ext, mime, playable, fmt}], runCfg, perTurn, segments }
 */
export async function runPipeline({ cfg, text, callApi, ffmpeg, onProgress, onLog, signal }) {
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
  onProgress?.({ stage: 'tts-start', perTurn, n: segments.length });
  const gen = perTurn
    ? await generatePerTurn({ cfg: runCfg, segments, callApi, hooks, onProgress })
    : await generateSingleRequest({ cfg: runCfg, segments, multi, needFf, callApi, hooks, log });

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
  return { outputs, runCfg, perTurn, segments };
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
