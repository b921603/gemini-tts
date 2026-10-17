#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gemini TTS 實機自我檢測 (只需 Python 標準庫;克隆測試的檔案轉換需要 ffmpeg,錄音需要 sounddevice)

用你自己的 API 金鑰,對真實的 Gemini API 逐項檢查本專案依賴的行為,並產生「金鑰已遮蔽」的報告檔。
把報告內容貼給 Claude,就能依真實回應修正尚未驗證的部分 (串流事件格式、人聲 ID、克隆建立等)。

  python selftest.py                              基本檢測 (模型清單、人聲、一般/串流合成、多人、語氣)
  python selftest.py --ref 我的聲音.wav --consent 同意.wav --lang zh-CN
                                                  另外測試「音色克隆」(預設用 voicekey_,不在你的專案留下任何東西)
  python selftest.py --record                     引導式錄音:先用選單選語言,再「照著唸」即可 (自動轉成正確格式並存檔,需 pip install sounddevice)
  python selftest.py --reuse-audio                重用上次錄好的音訊 (local\\selftest_audio),不必重錄
  python selftest.py --ref a.wav --consent b.wav --store
                                                  再測試「儲存在專案」的克隆流程 (建立 → 取得 → 列出 → 合成 → 刪除,最後會自動清理)
選項: --model ID  --voice Kore  --text "..."  --formats (測試 mulaw/取樣率)  --report 路徑

金鑰來源: 環境變數 GEMINI_API_KEY / GOOGLE_API_KEY,或 .gemini_key,或執行時輸入 (不會顯示、不會儲存)。
每項合成只用很短的句子 (約 1–3 秒音訊),整份檢測的用量極小。
"""
from __future__ import annotations

import argparse
import base64
import getpass
import io
import json
import os
import platform
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import tts  # noqa: E402  (重用模型排序、音訊轉換、同意聲明等邏輯)

BASE = "https://generativelanguage.googleapis.com/v1beta"
KEY = ""
REPORT: list[str] = []
RESULTS: list[tuple[str, str, str]] = []     # (名稱, 狀態, 摘要)
USAGE: list[dict] = []


# --------------------------------------------------------------------------- #
# 遮蔽 / 報告
# --------------------------------------------------------------------------- #
def redact(s: str) -> str:
    s = str(s)
    if KEY:
        s = s.replace(KEY, "<API_KEY>")
    s = re.sub(r"AIza[0-9A-Za-z_\-]{30,}", "<API_KEY>", s)
    s = re.sub(r"\bAQ\.[0-9A-Za-z_\-]{20,}", "<API_KEY>", s)
    s = re.sub(r"voicekey_[A-Za-z0-9_\-]{12,}", lambda m: m.group(0)[:16] + "…<已遮蔽>", s)
    s = re.sub(r"[A-Za-z0-9+/=_\-]{120,}", lambda m: f"<長字串 {len(m.group(0))} 字元>", s)
    return s


def out(line: str = "") -> None:
    line = redact(line)
    print(line)
    REPORT.append(line)


def brief(obj, limit: int = 900) -> str:
    def shrink(o):
        if isinstance(o, str):
            return o if len(o) <= 80 else f"<字串 {len(o)} 字元>"
        if isinstance(o, list):
            return [shrink(x) for x in o[:6]] + ([f"…(共 {len(o)} 筆)"] if len(o) > 6 else [])
        if isinstance(o, dict):
            return {k: shrink(v) for k, v in o.items()}
        return o
    t = json.dumps(shrink(obj), ensure_ascii=False)
    return t if len(t) <= limit else t[:limit] + "…"


def section(title: str) -> None:
    out("")
    out("=" * 72)
    out(title)
    out("=" * 72)


def result(name: str, status: str, summary: str = "") -> None:
    RESULTS.append((name, status, summary))
    icon = {"PASS": "[PASS]", "FAIL": "[FAIL]", "WARN": "[WARN]", "SKIP": "[SKIP]", "INFO": "[INFO]"}[status]
    out(f"{icon} {name}" + (f" — {summary}" if summary else ""))


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def api(method: str, path: str, body=None, timeout: int = 180) -> dict:
    headers = {"x-goog-api-key": KEY}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw, st = r.read(), r.status
    except urllib.error.HTTPError as e:
        raw, st = e.read(), e.code
    except Exception as e:
        return {"status": 0, "error": f"{type(e).__name__}: {e}", "elapsed": time.time() - t0, "json": None, "raw": b""}
    js = None
    try:
        js = json.loads(raw.decode("utf-8")) if raw.strip() else {}
    except Exception:
        pass
    return {"status": st, "elapsed": time.time() - t0, "json": js, "raw": raw, "error": ""}


def err_text(r: dict) -> str:
    if r.get("error"):
        return r["error"]
    j = r.get("json")
    if isinstance(j, dict) and "error" in j:
        e = j["error"]
        return f"HTTP {r['status']}: {e.get('message', e) if isinstance(e, dict) else e}"
    return f"HTTP {r['status']}: {r['raw'][:200]!r}"


def explain(r: dict) -> list[str]:
    """依常見原因給出提示 (僅為推測,實際請以完整錯誤訊息為準)"""
    msg = err_text(r).lower()
    hints = []
    if r.get("status") in (401, 403) and "key" in msg:
        hints.append("金鑰無效、已被停用或沒有此服務的權限")
    elif r.get("status") == 403:
        hints.append("帳戶/地區/方案可能尚未開放此功能,或金鑰權限不足")
    if r.get("status") == 429:
        hints.append("超過額度或請求頻率限制")
    if r.get("status") == 404:
        hints.append("模型或路徑不存在 (模型 ID 是否正確?)")
    if "consent" in msg:
        hints.append("同意錄音內容與聲明原文不符,或與參考音訊不是同一位說話者")
    if any(k in msg for k in ("duration", "length", "too short", "too long", "seconds")):
        hints.append("音訊長度可能不符規定 (參考音訊 10–30 秒)")
    if any(k in msg for k in ("format", "sample rate", "sample_rate", "channel", "wav", "mime")):
        hints.append("音訊格式可能不符 (需 24 kHz 單聲道 16-bit WAV)")
    if "speaker" in msg or "verif" in msg:
        hints.append("說話者驗證可能未通過")
    return hints


def get_audio(js) -> bytes:
    for step in (js or {}).get("steps", []) or []:
        if step.get("type") == "model_output":
            for c in step.get("content", []) or []:
                if c.get("type") == "audio" and c.get("data"):
                    return base64.b64decode(c["data"])
    d = ((js or {}).get("output_audio") or {}).get("data")
    if d:
        return base64.b64decode(d)
    raise ValueError("回應中找不到音訊")


def wav_secs(data: bytes) -> float:
    with wave.open(io.BytesIO(data), "rb") as w:
        return w.getnframes() / w.getframerate()


def note_usage(js, label: str) -> None:
    for k in ("usage", "usage_metadata", "usageMetadata"):
        if isinstance(js, dict) and isinstance(js.get(k), dict):
            USAGE.append(js[k])
            out(f"   用量回報 ({label}): {brief(js[k], 300)}")
            return


# --------------------------------------------------------------------------- #
# 請求本體 (與網頁版 core.js 相同)
# --------------------------------------------------------------------------- #
def make_input(text: str, style: str = "") -> list:
    item: dict = {"type": "text", "text": text}
    if style:
        item["annotations"] = [{"type": "speech_metadata", "style": style}]
    return [{"type": "user_input", "content": [item]}]


def synth_body(model: str, voice: str, text: str, style: str = "", stream: bool = False, rf: dict | None = None) -> dict:
    rf = rf or ({"type": "audio", "mime_type": "audio/l16", "sample_rate": 24000} if stream else {"type": "audio"})
    body = {"model": model, "input": make_input(text, style), "response_format": rf,
            "generation_config": {"speech_config": [{"voice": voice}]}}
    if stream:
        body["stream"] = True
    return body


def stream_synth(body: dict) -> dict:
    """串流請求並量測各時間點;回傳事件統計與合併後的 PCM"""
    req = urllib.request.Request(BASE + "/interactions", data=json.dumps(body).encode(), method="POST",
                                 headers={"x-goog-api-key": KEY, "Content-Type": "application/json"})
    t0 = time.time()
    info = {"status": 0, "t_headers": None, "t_first_event": None, "t_first_audio": None, "types": {}, "pcm": b"", "chunks": 0,
            "samples": [], "head": b"", "error": "", "usage": None}
    try:
        r = urllib.request.urlopen(req, timeout=180)
    except urllib.error.HTTPError as e:
        info["status"], info["raw"] = e.code, e.read()
        try:
            info["json"] = json.loads(info["raw"].decode())
        except Exception:
            info["json"] = None
        return info
    except Exception as e:
        info["error"] = f"{type(e).__name__}: {e}"
        return info
    with r:
        info["status"], info["t_headers"] = r.status, time.time() - t0
        info["content_type"] = r.headers.get("Content-Type", "")
        buf = b""
        while True:
            chunk = r.read1(8192)
            if not chunk:
                break
            if len(info["head"]) < 1500:
                info["head"] += chunk
            buf += chunk
            while True:
                m = re.search(rb"\r?\n\r?\n", buf)
                if not m:
                    break
                raw_ev, buf = buf[:m.start()], buf[m.end():]
                data = "\n".join(l[5:].lstrip(" ") for l in raw_ev.decode("utf-8", "replace").splitlines() if l.startswith("data:"))
                if not data.strip() or data.strip() == "[DONE]":
                    continue
                try:
                    ev = json.loads(data)
                except Exception:
                    continue
                if info["t_first_event"] is None:
                    info["t_first_event"] = time.time() - t0
                et = ev.get("event_type", "(無 event_type)") if isinstance(ev, dict) else "(非物件)"
                info["types"][et] = info["types"].get(et, 0) + 1
                if len(info["samples"]) < 4 and not (isinstance(ev, dict) and (ev.get("delta") or {}).get("type") == "audio" and info["types"][et] > 1):
                    info["samples"].append(ev)
                d = (ev.get("delta") if isinstance(ev, dict) else None) or {}
                if d.get("type") == "audio" and d.get("data"):
                    if info["t_first_audio"] is None:
                        info["t_first_audio"] = time.time() - t0
                    info["pcm"] += base64.b64decode(d["data"])
                    info["chunks"] += 1
                if isinstance(ev, dict):
                    u = ev.get("usage") or (ev.get("interaction") or {}).get("usage")
                    if u:
                        info["usage"] = u
    info["elapsed"] = time.time() - t0
    return info


# --------------------------------------------------------------------------- #
# 檢測項目
# --------------------------------------------------------------------------- #
CTX: dict = {"model": "", "voice": "Kore", "voices": []}


def t_models(args) -> None:
    section("1. 模型清單 (GET /models)")
    all_models, token = [], ""
    for _ in range(10):
        r = api("GET", f"/models?pageSize=1000{'&pageToken=' + token if token else ''}")
        if r["status"] != 200:
            result("模型清單", "FAIL", err_text(r))
            for h in explain(r):
                out(f"   提示: {h}")
            CTX["model"] = args.model or tts.FALLBACK_TTS_MODELS[0]
            return
        j = r["json"] or {}
        all_models += j.get("models", [])
        token = j.get("nextPageToken", "")
        if not token:
            break
    out(f"   共 {len(all_models)} 個模型;第一個模型的欄位: {sorted(all_models[0].keys()) if all_models else '(無)'}")
    items = tts.normalize_model_list([{"name": m.get("name"), "display": m.get("displayName", "")} for m in all_models])
    methods = {tts.strip_model_prefix(m.get("name")): m.get("supportedGenerationMethods") for m in all_models}
    out(f"   名稱含 tts 的模型 ({len(items)} 個,依本專案規則排序,最佳在前):")
    for it in items[:12]:
        out(f"     - {it['id']}   supportedGenerationMethods={methods.get(it['id'])}")
    auto = tts.pick_auto_model(items)
    CTX["model"] = args.model or auto or tts.FALLBACK_TTS_MODELS[0]
    if items:
        result("模型清單 + 自動選用", "PASS", f"自動選用 {auto}" + (f";本次測試改用 --model {args.model}" if args.model else ""))
    else:
        others = [tts.strip_model_prefix(m.get("name")) for m in all_models if re.search(r"speech|audio|voice", m.get("name", ""), re.I)]
        result("模型清單 + 自動選用", "WARN", f"清單中沒有名稱含 tts 的模型 (疑似語音相關: {others[:6]});改用備援 {CTX['model']}")


def t_voices(args) -> None:
    section("2. 人聲清單與篩選 (GET /voices)")
    r = api("GET", "/voices?page_size=5")
    if r["status"] != 200:
        result("人聲清單", "FAIL", err_text(r))
        return
    j = r["json"] or {}
    voices = j.get("voices", [])
    out(f"   回應欄位: {sorted(j.keys())};第一筆人聲: {brief(voices[0]) if voices else '(空)'}")
    out(f"   分頁欄位 next_page_token / nextPageToken: {'有' if (j.get('next_page_token') or j.get('nextPageToken')) else '無'}")
    CTX["voices"] = voices
    r2 = api("GET", f"/voices?search={args.voice}&page_size=5")
    hit = [v for v in ((r2["json"] or {}).get("voices", [])) if args.voice.lower() in json.dumps(v, ensure_ascii=False).lower()]
    if hit:
        v = hit[0]
        out(f"   搜尋「{args.voice}」→ id={v.get('id')!r}, display_name={v.get('display_name', v.get('displayName'))!r}")
        same = str(v.get("id")) == args.voice
        out(f"   內建人聲的 id {'等於' if same else '不等於'}名稱 → 本專案選單送出的是 id;" + ("" if same else "若合成報錯請告訴我"))
        CTX["voice_from_list"] = v.get("id")
    for lang in ("zh-TW", "cmn-TW", "zh-CN", "cmn-CN", "en-US"):
        rr = api("GET", f"/voices?language_code={lang}&page_size=3")
        n = len((rr["json"] or {}).get("voices", [])) if rr["status"] == 200 else f"錯誤 {rr['status']}"
        out(f"   language_code={lang}: 回傳 {n} 筆")
    rt = api("GET", "/voices?type=prebuilt&page_size=3")
    out(f"   type=prebuilt 篩選: HTTP {rt['status']},{len((rt['json'] or {}).get('voices', [])) if rt['status'] == 200 else '—'} 筆")
    result("人聲清單與篩選", "PASS", f"取得 {len(voices)} 筆 (page_size=5)")
    vid = CTX.get("voice_from_list") or args.voice
    rg = api("GET", "/voices/" + urllib.request.quote(str(vid), safe=""))
    if rg["status"] == 200:
        has = bool((rg["json"] or {}).get("sample_audio") or (rg["json"] or {}).get("sampleAudio"))
        result("GetVoice (官方範例音訊)", "INFO", f"{vid}: 欄位 {sorted((rg['json'] or {}).keys())};含 sample_audio: {has}")
    else:
        result("GetVoice (官方範例音訊)", "INFO", f"{vid}: {err_text(rg)}")


def t_unary(args) -> None:
    section(f"3. 一般合成 (模型 {CTX['model']},人聲 {args.voice})")
    r = api("POST", "/interactions", synth_body(CTX["model"], args.voice, args.text))
    if r["status"] != 200:
        result("一般合成", "FAIL", err_text(r))
        for h in explain(r):
            out(f"   提示: {h}")
        return
    j = r["json"]
    out(f"   回應頂層欄位: {sorted(j.keys()) if isinstance(j, dict) else type(j)};耗時 {r['elapsed']:.1f} 秒")
    note_usage(j, "一般合成")
    try:
        wav = get_audio(j)
        CTX["unary_secs"] = wav_secs(wav)
        result("一般合成", "PASS", f"收到 {len(wav) / 1024:.0f} KB WAV,長度 {CTX['unary_secs']:.2f} 秒")
    except Exception as e:
        result("一般合成", "FAIL", f"{e};回應: {brief(j)}")
    if CTX.get("voice_from_list") and CTX["voice_from_list"] != args.voice:
        r2 = api("POST", "/interactions", synth_body(CTX["model"], CTX["voice_from_list"], args.text))
        result("用清單中的人聲 id 合成", "PASS" if r2["status"] == 200 else "FAIL", f"id={CTX['voice_from_list']}" + ("" if r2["status"] == 200 else f" → {err_text(r2)}"))


def t_stream(args) -> None:
    section("4. 串流合成 (stream:true) — 驗證即時進度所依賴的事件格式")
    info = stream_synth(synth_body(CTX["model"], args.voice, args.text, stream=True))
    if info["status"] != 200:
        result("串流合成", "FAIL", info.get("error") or err_text({"status": info["status"], "json": info.get("json"), "raw": info.get("raw", b"")}))
        out("   → 若錯誤指出不支援 stream,可在網頁/圖形介面「進階選項」關閉即時進度;本專案也會自動退回一般模式。")
        return
    out(f"   HTTP {info['status']},Content-Type={info.get('content_type')}")
    out(f"   時間: 收到標頭 {info['t_headers']:.2f}s → 第一個事件 {info['t_first_event'] if info['t_first_event'] is None else format(info['t_first_event'], '.2f')}s → "
        f"第一塊音訊 {info['t_first_audio'] if info['t_first_audio'] is None else format(info['t_first_audio'], '.2f')}s → 結束 {info['elapsed']:.2f}s")
    out(f"   事件類型統計: {info['types']}")
    for i, ev in enumerate(info["samples"]):
        out(f"   事件範例 {i + 1}: {brief(ev, 500)}")
    if info["usage"]:
        USAGE.append(info["usage"])
        out(f"   用量回報: {brief(info['usage'], 300)}")
    if not info["pcm"]:
        out("   串流開頭原始內容 (已遮蔽):")
        out("   " + redact(info["head"][:1200].decode("utf-8", "replace")).replace("\n", "\n   "))
        result("串流合成", "FAIL", "連線成功但沒有解析到任何音訊區塊 → 事件格式與本專案的假設不同,請把這份報告貼給 Claude")
        return
    secs = len(info["pcm"]) / 48000
    ref = CTX.get("unary_secs")
    result("串流合成", "PASS", f"{info['chunks']} 個音訊區塊,共 {secs:.2f} 秒" + (f" (一般合成 {ref:.2f} 秒)" if ref else "")
           + f";第一塊音訊在 {info['t_first_audio']:.2f} 秒到達" if info["t_first_audio"] is not None else "")


def t_style(args) -> None:
    section("5. 語氣 (annotations.style) 與停頓標籤")
    r = api("POST", "/interactions", synth_body(CTX["model"], args.voice, "<short pause> 你好。", style="cheerful and friendly"))
    result("語氣 + <short pause> 標籤", "PASS" if r["status"] == 200 else "FAIL", f"耗時 {r['elapsed']:.1f}s" if r["status"] == 200 else err_text(r))


def t_multi(args) -> None:
    section("6. 多人對話 (2 位講者) 與 conversational 模式")
    content = [{"type": "text", "text": "你好。", "annotations": [{"type": "speech_metadata", "speaker": "Joe"}]},
               {"type": "text", "text": "嗨。", "annotations": [{"type": "speech_metadata", "speaker": "Jane"}]}]
    sc = {"speakers": [{"speaker": "Joe", "voice": "Puck"}, {"speaker": "Jane", "voice": "Kore"}]}
    base = {"model": CTX["model"], "input": [{"type": "user_input", "content": content}], "response_format": {"type": "audio"}}
    r = api("POST", "/interactions", {**base, "generation_config": {"speech_config": sc}})
    result("多人對話 (一般)", "PASS" if r["status"] == 200 else "FAIL", f"耗時 {r['elapsed']:.1f}s" if r["status"] == 200 else err_text(r))
    r = api("POST", "/interactions", {**base, "generation_config": {"speech_config": {**sc, "mode": "conversational"}}})
    result("多人對話 mode=conversational", "PASS" if r["status"] == 200 else "WARN",
           "被接受" if r["status"] == 200 else f"被拒絕 (本專案會自動退回一般多人模式): {err_text(r)}")


def t_params(args) -> None:
    section("7. 生成參數 (generation_config) — 哪些參數被接受")
    base = synth_body(CTX["model"], args.voice, "好。")
    cases = [("temperature=0.5", {"temperature": 0.5}), ("top_p=0.9", {"top_p": 0.9}), ("seed=7", {"seed": 7}),
             ("max_output_tokens=2000", {"max_output_tokens": 2000}), ("top_k=40 (Interactions API 官方沒有)", {"top_k": 40}),
             ("stop_sequences=['END']", {"stop_sequences": ["END"]})]
    for label, extra in cases:
        body = json.loads(json.dumps(base))
        body["generation_config"].update(extra)
        r = api("POST", "/interactions", body)
        ok = r["status"] == 200
        st = "PASS" if ok else ("INFO" if "top_k" in label else "FAIL")
        result(f"參數 {label}", st, "被接受" if ok else err_text(r))
    out("   種子重現性 (同樣的文字與種子,結果是否一致):")
    audio = {}
    for tag, seed in (("A", 123), ("B", 123), ("C", 456)):
        body = json.loads(json.dumps(synth_body(CTX["model"], args.voice, args.text)))
        body["generation_config"]["seed"] = seed
        r = api("POST", "/interactions", body)
        try:
            audio[tag] = get_audio(r["json"])
        except Exception:
            audio[tag] = None
    if all(audio.values()):
        same_ab = audio["A"] == audio["B"]
        out(f"   seed=123 兩次: {'位元組完全相同' if same_ab else ('長度相同但內容不同' if len(audio['A']) == len(audio['B']) else '長度與內容都不同')} "
            f"({len(audio['A'])} / {len(audio['B'])} 位元組);seed=456: {len(audio['C'])} 位元組 ({'與 seed=123 不同' if audio['C'] != audio['A'] else '與 seed=123 相同'})")
        result("種子重現性", "INFO", "完全重現" if same_ab else "不保證完全重現 (取決於模型)")
    else:
        result("種子重現性", "WARN", "請求失敗,無法比較")


def t_formats(args) -> None:
    section("8. 原生輸出格式 (mime_type / sample_rate)")
    for label, rf in (("mulaw 8 kHz", {"type": "audio", "mime_type": "audio/mulaw", "sample_rate": 8000}),
                      ("wav 16 kHz", {"type": "audio", "mime_type": "audio/wav", "sample_rate": 16000}),
                      ("l16 (PCM)", {"type": "audio", "mime_type": "audio/l16"})):
        r = api("POST", "/interactions", synth_body(CTX["model"], args.voice, "好。", rf=rf))
        if r["status"] == 200:
            try:
                n = len(get_audio(r["json"]))
                result(f"格式 {label}", "PASS", f"收到 {n} 位元組")
            except Exception as e:
                result(f"格式 {label}", "FAIL", str(e))
        else:
            result(f"格式 {label}", "FAIL", err_text(r))


AUDIO_DIR = HERE / "selftest_audio"


def prepare_clone_audio(args):
    cfg = dict(tts.DEFAULTS)
    if args.reuse_audio:
        last = (AUDIO_DIR / "last_lang.txt")
        code = args.lang or (last.read_text(encoding="utf-8").strip() if last.exists() else "")
        ref, cons = AUDIO_DIR / f"ref_{code}.wav", AUDIO_DIR / f"consent_{code}.wav"
        if not (code and ref.exists() and cons.exists()):
            raise RuntimeError(f"找不到上次錄好的音訊 ({AUDIO_DIR});請先用 --record 錄製一次")
        args.lang = code
        out(f"   重用上次錄好的音訊: {ref.name}、{cons.name}")
        return ref.read_bytes(), cons.read_bytes()
    if args.record:
        src, consent, code = tts.guided_clone_recording(AUDIO_DIR, args.lang)
        args.lang = code
        return src, consent
    src, trimmed = tts.prepare_audio(Path(args.ref.strip('"')), cfg, tts.CLONE_MAX_SEC)
    consent, _ = tts.prepare_audio(Path(args.consent.strip('"')), cfg, 60)
    if trimmed:
        out(f"   (參考音訊超過 {tts.CLONE_MAX_SEC} 秒,已自動取前 {tts.CLONE_MAX_SEC} 秒)")
    return src, consent


def clone_body(model: str, name: str, store: bool, src: bytes, consent: bytes) -> dict:
    voice = {"type": "replicated", "replicated": {
        "source_audio": {"mime_type": "audio/wav", "data": base64.b64encode(src).decode()},
        "consent_audio": {"mime_type": "audio/wav", "data": base64.b64encode(consent).decode()}}}
    if model:
        voice["model"] = model
    if name:
        voice["display_name"] = name
    return {"store": store, "voice": voice}


def t_clone(args) -> None:
    section("9. 音色克隆 (Voice replication)")
    try:
        src, consent = prepare_clone_audio(args)
    except Exception as e:
        result("克隆: 準備音訊", "FAIL", f"{type(e).__name__}: {e}")
        return
    args.lang = args.lang or "zh-CN"
    statement = next((tx for c, _, tx in tts.CONSENT_PHRASES if c == args.lang), "(未知語言代碼)")
    out(f"   同意聲明語言 {args.lang},同意錄音內容必須是:\n     {statement}")
    si, ci = tts.wav_info(src), tts.wav_info(consent)
    out(f"   參考音訊: {si[3]:.1f} 秒,{si[1]} Hz,{si[0]} 聲道,{si[2]}-bit;同意錄音: {ci[3]:.1f} 秒,{ci[1]} Hz")
    if si[3] < tts.CLONE_MIN_SEC:
        out(f"   [!] 參考音訊只有 {si[3]:.1f} 秒,官方建議 10–30 秒,可能被拒絕")
    cleanup: list[str] = []
    # ---- (A) 不儲存: voicekey_ ----
    r = api("POST", "/voices", clone_body(CTX["model"], "selftest-key", False, src, consent), timeout=300)
    out(f"   建立 (store=false) 耗時 {r['elapsed']:.1f}s,HTTP {r['status']}")
    if r["status"] != 200:
        result("克隆: 建立 voicekey (不儲存)", "FAIL", err_text(r))
        out(f"   完整回應 (已遮蔽): {brief(r['json'], 1200)}")
        for h in explain(r):
            out(f"   提示: {h}")
        return
    j = r["json"] or {}
    out(f"   回應欄位: {sorted(j.keys())};內容: {brief(j, 500)}")
    key = j.get("key") or j.get("voice_key") or j.get("voiceKey")
    result("克隆: 建立 voicekey (不儲存)", "PASS" if key else "WARN",
           f"取得金鑰 {str(key)[:16]}… (7 天有效)" if key else "建立成功,但回應中找不到 key 欄位 → 請把上面的「回應欄位」貼給 Claude")
    if key:
        rs = api("POST", "/interactions", synth_body(CTX["model"], key, args.text))
        result("克隆: 用 voicekey 合成", "PASS" if rs["status"] == 200 else "FAIL",
               "成功" if rs["status"] == 200 else err_text(rs))
        info = stream_synth(synth_body(CTX["model"], key, args.text, stream=True))
        result("克隆: 用 voicekey 串流合成", "PASS" if info["pcm"] else "WARN", f"{info['chunks']} 個區塊" if info["pcm"] else "沒有音訊區塊")
    # ---- (B) 儲存在專案: voice_ ----
    if args.store:
        r = api("POST", "/voices", clone_body(CTX["model"], "selftest-stored", True, src, consent), timeout=300)
        if r["status"] != 200:
            result("克隆: 建立 voice_ (儲存在專案)", "FAIL", err_text(r))
            return
        vid = (r["json"] or {}).get("id")
        result("克隆: 建立 voice_ (儲存在專案)", "PASS" if vid else "WARN", f"id={vid};欄位 {sorted((r['json'] or {}).keys())}")
        if vid:
            cleanup.append(vid)
            rg = api("GET", "/voices/" + vid)
            result("克隆: GetVoice", "PASS" if rg["status"] == 200 else "FAIL", f"欄位 {sorted((rg['json'] or {}).keys())}" if rg["status"] == 200 else err_text(rg))
            rl = api("GET", "/voices?type=replicated&page_size=50")
            ids = [v.get("id") for v in (rl["json"] or {}).get("voices", [])] if rl["status"] == 200 else []
            result("克隆: 出現在 type=replicated 清單", "PASS" if vid in ids else "WARN", f"清單 {len(ids)} 筆")
            rs = api("POST", "/interactions", synth_body(CTX["model"], vid, args.text))
            result("克隆: 用 voice_ 合成", "PASS" if rs["status"] == 200 else "FAIL", "成功" if rs["status"] == 200 else err_text(rs))
    for vid in cleanup:      # 一律清理,不在你的專案留下測試聲音
        rd = api("DELETE", "/voices/" + vid)
        gone = api("GET", "/voices/" + vid)["status"] in (404, 400)
        result("克隆: 刪除測試聲音 (清理)", "PASS" if rd["status"] in (200, 204) and gone else "WARN",
               f"DELETE HTTP {rd['status']},之後 GET {'已不存在' if gone else '仍可取得'}")


# --------------------------------------------------------------------------- #
def main() -> int:
    global KEY, BASE
    ap = argparse.ArgumentParser(description="Gemini TTS 實機自我檢測")
    ap.add_argument("--model", default="")
    ap.add_argument("--voice", default="Kore")
    ap.add_argument("--text", default="你好，這是測試。")
    ap.add_argument("--formats", action="store_true", help="另外測試 mulaw / 取樣率")
    ap.add_argument("--ref", help="克隆: 參考音訊檔 (10–30 秒)")
    ap.add_argument("--consent", help="克隆: 同意錄音檔 (朗讀聲明原文)")
    ap.add_argument("--lang", default=None, help="同意聲明語言代碼 (例如 zh-CN);--record 時省略會跳出語言選單")
    ap.add_argument("--reuse-audio", action="store_true", help="克隆: 重用上次錄好的音訊")
    ap.add_argument("--skip-params", action="store_true", help="略過生成參數檢測")
    ap.add_argument("--record", action="store_true", help="克隆: 用麥克風錄音")
    ap.add_argument("--store", action="store_true", help="克隆: 另外測試儲存在專案的流程 (結束後自動刪除)")
    ap.add_argument("--report", default=str(HERE / "selftest_report.txt"))
    ap.add_argument("--api-base", default=os.environ.get("TTS_API_BASE", BASE), help=argparse.SUPPRESS)
    args = ap.parse_args()
    BASE = args.api_base.rstrip("/")

    src, k = tts_key_source()
    KEY = k or getpass.getpass("請貼上 API Key (輸入不會顯示,不會儲存): ").strip()
    if not KEY:
        print("沒有金鑰,結束。")
        return 2
    out("Gemini TTS 實機自我檢測")
    out(f"時間 {time.strftime('%Y-%m-%d %H:%M:%S')} | Python {platform.python_version()} | {platform.system()} {platform.release()} | 金鑰來源: {src or '手動輸入'} (金鑰不會寫入報告)")
    out(f"金鑰格式: 長度 {len(KEY)},前綴 {KEY[:3]!r}…")

    for fn in (t_models, t_voices, t_unary, t_stream, t_style, t_multi):
        try:
            fn(args)
        except Exception as e:     # 單項失敗不影響其他項目
            result(fn.__name__, "FAIL", f"程式例外 {type(e).__name__}: {e}")
    if not args.skip_params:
        try:
            t_params(args)
        except Exception as e:
            result("t_params", "FAIL", f"程式例外 {type(e).__name__}: {e}")
    if args.formats:
        t_formats(args)
    if not (args.record or args.reuse_audio or (args.ref and args.consent)) and sys.stdin.isatty():
        # 互動式 (例如雙擊 .bat):詢問要不要測試克隆
        print("\n音色克隆測試:")
        print("  1) 跳過")
        print("  2) 引導式錄音 (選語言 → 照著唸;需要麥克風與 pip install sounddevice)  [推薦]")
        if (AUDIO_DIR / "last_lang.txt").exists():
            print("  3) 重用上次錄好的音訊")
        pick = input("請選擇 [1]: ").strip() or "1"
        args.record, args.reuse_audio = pick == "2", pick == "3"
    if args.record or args.reuse_audio or (args.ref and args.consent):
        try:
            t_clone(args)
        except Exception as e:
            result("克隆", "FAIL", f"程式例外 {type(e).__name__}: {e}")
    else:
        section("9. 音色克隆")
        result("音色克隆", "SKIP", "未提供 --record / --ref+--consent / --reuse-audio (加上就會測試;預設用 voicekey_,不在你的專案留下東西)")

    section("總結")
    for n, s, m in RESULTS:
        out(f"  {s:<5} {n}" + (f" — {m[:110]}" if m else ""))
    nums: dict = {}
    for u in USAGE:
        for kk, vv in u.items():
            if isinstance(vv, (int, float)):
                nums[kk] = nums.get(kk, 0) + vv
    out(f"\nGoogle 回報的用量合計: {nums or '(此次回應沒有提供用量欄位)'}")
    fails = [r for r in RESULTS if r[1] == "FAIL"]
    out(f"\n通過 {sum(1 for r in RESULTS if r[1] == 'PASS')} 項,失敗 {len(fails)} 項,警告 {sum(1 for r in RESULTS if r[1] == 'WARN')} 項。")
    try:
        Path(args.report).write_text("\n".join(REPORT), encoding="utf-8")
        print(f"\n報告已存到 {args.report} (金鑰已自動遮蔽,可安全貼給 Claude)")
    except Exception as e:
        print(f"[!] 無法寫入報告: {e}")
    return 1 if fails else 0


def tts_key_source() -> tuple[str, str]:
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        v = os.environ.get(name, "").strip()
        if v:
            return f"環境變數 {name}", v
    try:
        v = (HERE / ".gemini_key").read_text(encoding="utf-8").strip()
        if v:
            return ".gemini_key 檔案", v
    except Exception:
        pass
    return "", ""


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已中斷。")
        sys.exit(130)
