#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gemini TTS 互動式命令列工具 (Windows 11 / Python 3.10+)

功能
  * 人聲選擇: (1) 直接輸入名稱/ID  (2) 動態載入線上人聲清單並篩選  (3) 內建 30 種精選人聲
  * 單人 / 多人對話 (超過 2 位或使用自訂人聲時自動改為逐段合成後拼接)
  * 語氣控制 (style)、輸出格式、取樣率、長文分段、重試等,全部於執行時設定
  * 沿用上次設置 (tts_settings.json,不會儲存 API Key 與文本)
  * ffmpeg 整合: 轉 mp3/flac/ogg/opus/m4a、響度標準化、變速
  * 音色克隆: 錄音或選檔 → 同意聲明驗證 → 建立 voice_/voicekey_ → 試聽、列出、刪除

用法
  python tts.py                 # 互動模式
  python tts.py --reuse         # 直接沿用上次設置,只問文本
  python tts.py --text-file a.txt
  python tts.py --text "你好"
  python tts.py --gui           # 圖形介面 (本機網頁視窗,與網頁版同一套介面)
  python tts.py --clone         # 音色克隆:建立 / 管理 / 試聽 (人聲選單的第 4 項也能進入)
"""
from __future__ import annotations

import argparse
import base64
import copy
import getpass
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_SETTINGS_FILE = SCRIPT_DIR / "tts_settings.json"

# --------------------------------------------------------------------------- #
# 模型探索:不綁定任何特定世代。平常以 API (models.list) 即時回傳的清單為準,
# 自動挑「最新世代」的語音模型;下一代模型出現時不需要改程式。(邏輯與網頁版 core.js 完全一致)
# --------------------------------------------------------------------------- #
FALLBACK_TTS_MODELS = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]   # 僅在無法取得線上清單時使用
_TIER_ORDER = {"flash": 0, "pro": 1, "lite": 2, "other": 3}
_MODELS_CACHE: list[dict] | None = None


def strip_model_prefix(n) -> str:
    return re.sub(r"^models/", "", str(n or "").strip())


def is_tts_model(mid: str) -> bool:
    return bool(re.search(r"tts", mid or "", re.I))


def parse_model_id(mid: str):
    m = re.search(r"(?:^|-)(\d+(?:\.\d+)*)(?=-|$)", mid or "")
    version = [int(x) for x in m.group(1).split(".")] if m else [0]
    tier = "lite" if re.search("lite", mid, re.I) else "pro" if re.search("pro", mid, re.I) else \
        "flash" if re.search("flash", mid, re.I) else "other"
    return version, tier, bool(re.search(r"preview|exp", mid or "", re.I))


def _model_sort_key(item: dict):
    mid = item["id"]
    version, tier, preview = parse_model_id(mid)
    # 最佳在前: 語音模型 → 版本新 → 正式版優先於 preview → flash(均衡) > pro > lite → ID 字母序
    return (0 if is_tts_model(mid) else 1, [-v for v in version] + [0] * (6 - len(version)), preview, _TIER_ORDER[tier], mid)


def normalize_model_list(raw: list[dict], show_all: bool = False) -> list[dict]:
    seen, out = set(), []
    for m in raw or []:
        mid = strip_model_prefix(m.get("id") or m.get("name"))
        if not mid or mid in seen or (not show_all and not is_tts_model(mid)):
            continue
        seen.add(mid)
        out.append({"id": mid, "display": m.get("display") or m.get("display_name") or ""})
    return sorted(out, key=_model_sort_key)


def pick_auto_model(items: list[dict]) -> str:
    for it in items or []:
        if is_tts_model(it["id"]):
            return it["id"]
    return items[0]["id"] if items else ""


def resolve_model(model: str, items: list[dict] | None = None) -> str:
    m = strip_model_prefix(model)
    if not m or m == "auto":
        return pick_auto_model(items or []) or FALLBACK_TTS_MODELS[0]
    return m


def discover_models(client, show_all: bool = False, refresh: bool = False) -> list[dict]:
    """向 API 取得可用模型 (含快取於本次執行);失敗時回傳備援清單"""
    global _MODELS_CACHE
    if _MODELS_CACHE is None or refresh:
        try:
            raw = [{"name": g(m, "name"), "display": g(m, "display_name")} for m in client.models.list()]
            _MODELS_CACHE = raw if raw else []
        except Exception as e:
            print(f"[!] 無法取得模型清單 ({type(e).__name__}: {e}),改用備援清單。")
            _MODELS_CACHE = []
    items = normalize_model_list(_MODELS_CACHE, show_all)
    return items or [{"id": m, "display": ""} for m in FALLBACK_TTS_MODELS]

BUILTIN_VOICES = [
    ("Zephyr", "Bright"), ("Puck", "Upbeat"), ("Charon", "Informative"),
    ("Kore", "Firm"), ("Fenrir", "Excitable"), ("Leda", "Youthful"),
    ("Orus", "Firm"), ("Aoede", "Breezy"), ("Callirrhoe", "Easy-going"),
    ("Autonoe", "Bright"), ("Enceladus", "Breathy"), ("Iapetus", "Clear"),
    ("Umbriel", "Easy-going"), ("Algieba", "Smooth"), ("Despina", "Smooth"),
    ("Erinome", "Clear"), ("Algenib", "Gravelly"), ("Rasalgethi", "Informative"),
    ("Laomedeia", "Upbeat"), ("Achernar", "Soft"), ("Alnilam", "Firm"),
    ("Schedar", "Even"), ("Gacrux", "Mature"), ("Pulcherrima", "Forward"),
    ("Achird", "Friendly"), ("Zubenelgenubi", "Casual"), ("Vindemiatrix", "Gentle"),
    ("Sadachbia", "Lively"), ("Sadaltager", "Knowledgeable"), ("Sulafat", "Warm"),
]
BUILTIN_LOOKUP = {n.lower(): n for n, _ in BUILTIN_VOICES}

# API 原生可直接輸出的格式: key -> (mime_type, 副檔名)
NATIVE_FORMATS = {
    "wav": ("audio/wav", ".wav"),
    "pcm": ("audio/l16", ".pcm"),
    "mulaw": ("audio/mulaw", ".mulaw"),
    "alaw": ("audio/alaw", ".alaw"),
}
# 需要 ffmpeg 轉檔的格式
FFMPEG_FORMATS = {
    "mp3": ".mp3",
    "flac": ".flac",
    "ogg": ".ogg",
    "opus": ".opus",
    "m4a": ".m4a",
}
LOSSY = {"mp3", "ogg", "opus", "m4a"}
PCM_RATE = 24000

# --------------------------------------------------------------------------- #
# 音色克隆 (Voice replication) 常數
# --------------------------------------------------------------------------- #
LIB_FILE = SCRIPT_DIR / "tts_voices.json"   # 本機金鑰庫 (voicekey_...) — 內含機密,請勿分享或上傳
CLONE_MIN_SEC, CLONE_MAX_SEC, CLONE_RATE = 10, 30, 24000
KEY_TTL_DAYS = 7
PREVIEW_TEXT = "你好，這是我的克隆聲音測試。Hello, this is a voice test."

# 官方「同意聲明」逐字文本 (30 種語言);同意錄音必須朗讀對應語言的原文
CONSENT_PHRASES = [
 [
  "ar-XA",
  "Arabic",
  "أنا مالك هذا الصوت وأوافق على أن تستخدم Google هذا الصوت لإنشاء نموذج صوتي اصطناعي."
 ],
 [
  "bn-IN",
  "Bengali",
  "আমি এই ভয়েসের মালিক এবং আমি একটি সিন্থেটিক ভয়েস মডেল তৈরি করতে এই ভয়েস ব্যবহার করে Google-এর সাথে সম্মতি দিচ্ছি।"
 ],
 [
  "zh-CN",
  "Chinese (Simplified)",
  "我是此声音的拥有者并授权谷歌使用此声音创建语音合成模型"
 ],
 [
  "nl-NL",
  "Dutch",
  "Ik ben de eigenaar van deze stem en ik geef Google toestemming om deze stem te gebruiken om een synthetisch stemmodel te maken."
 ],
 [
  "en-US",
  "English (US)",
  "I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model."
 ],
 [
  "en-GB",
  "English (UK)",
  "I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model."
 ],
 [
  "en-IN",
  "English (India)",
  "I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model."
 ],
 [
  "en-AU",
  "English (Australia)",
  "I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model."
 ],
 [
  "fr-FR",
  "French (France)",
  "Je suis le propriétaire de cette voix et j'autorise Google à utiliser cette voix pour créer un modèle de voix synthétique."
 ],
 [
  "fr-CA",
  "French (Canada)",
  "Je suis le propriétaire de cette voix et j'autorise Google à utiliser cette voix pour créer un modèle de voix synthétique."
 ],
 [
  "de-DE",
  "German",
  "Ich bin der Eigentümer dieser Stimme und bin damit einverstanden, dass Google diese Stimme zur Erstellung eines synthetischen Stimmmodells verwendet."
 ],
 [
  "gu-IN",
  "Gujarati",
  "હું આ વોઈસનો માલિક છું અને સિન્થેટિક વોઈસ મોડલ બનાવવા માટે આ વોઈસનો ઉપયોગ કરીને google ને હું સંમતિ આપું છું"
 ],
 [
  "hi-IN",
  "Hindi",
  "मैं इस आवाज का मालिक हूं और मैं सिंथेटिक आवाज मॉडल बनाने के लिए Google को इस आवाज का उपयोग करने की सहमति देता हूं"
 ],
 [
  "id-ID",
  "Indonesian",
  "Saya pemilik suara ini dan saya menyetujui Google menggunakan suara ini untuk membuat model suara sintetis."
 ],
 [
  "it-IT",
  "Italian",
  "Sono il proprietario di questa voce e acconsento che Google la utilizzi per creare un modello di voce sintetica."
 ],
 [
  "ja-JP",
  "Japanese",
  "私はこの音声の所有者であり、Googleがこの音声を使用して音声合成モデルを作成することを承認します。"
 ],
 [
  "kn-IN",
  "Kannada",
  "ನಾನು ಈ ಧ್ವನಿಯ ಮಾಲಿಕ ಮತ್ತು ಸಂಶ್ಲೇಷಿತ ಧ್ವನಿ ಮಾದರಿಯನ್ನು ರಚಿಸಲು ಈ ಧ್ವನಿಯನ್ನು ಬಳಸಿಕೊಂಡುಗೂಗಲ್ ಗೆ ನಾನು ಸಮ್ಮತಿಸುತ್ತೇನೆ."
 ],
 [
  "ko-KR",
  "Korean",
  "나는 이 음성의 소유자이며 구글이 이 음성을 사용하여 음성 합성 모델을 생성할 것을 허용합니다."
 ],
 [
  "ml-IN",
  "Malayalam",
  "ഈ ശബ്ദത്തിന്റെ ഉടമ ഞാനാണ്, ഒരു സിന്തറ്റിക് വോയ്സ് മോഡൽ സൃഷ്ടിക്കാൻ ഈ ശബ്ദം ഉപയോഗിക്കുന്നതിന് ഞാൻ Google-ന് സമ്മതം നൽകുന്നു."
 ],
 [
  "mr-IN",
  "Marathi",
  "मी या आवाजाचा मालक आहे आणि सिंथेटिक व्हॉइस मॉडेल तयार करण्यासाठी हा आवाज वापरण्यासाठी मी Google ला संमती देतो"
 ],
 [
  "pl-PL",
  "Polish",
  "Jestem właścicielem tego głosu i wyrażam zgodę na wykorzystanie go przez Google w celu utworzenia syntetycznego modelu głosu."
 ],
 [
  "pt-BR",
  "Portuguese (Brazil)",
  "Eu sou o proprietário desta voz e autorizo o Google a usá-la para criar um modelo de voz sintética."
 ],
 [
  "ru-RU",
  "Russian",
  "Я являюсь владельцем этого голоса и даю согласие Google на использование этого голоса для создания модели синтетического голоса."
 ],
 [
  "es-ES",
  "Spanish (Spain)",
  "Soy el propietario de esta voz y doy mi consentimiento para que Google la utilice para crear un modelo de voz sintética."
 ],
 [
  "es-US",
  "Spanish (US)",
  "Soy el propietario de esta voz y doy mi consentimiento para que Google la utilice para crear un modelo de voz sintética."
 ],
 [
  "ta-IN",
  "Tamil",
  "நான் இந்த குரலின் உரிமையாளர் மற்றும் செயற்கை குரல் மாதிரியை உருவாக்க இந்த குரலை பயன்படுத்த குகல்க்கு நான் ஒப்புக்கொள்கிறேன்."
 ],
 [
  "te-IN",
  "Telugu",
  "నేను ఈ వాయిస్ యజమానిని మరియు సింతటిక్ వాయిస్ మోడల్ ని రూపొందించడానికి ఈ వాయిస్ ని ఉపయోగించడానికి googleకి నేను సమ్మతిస్తున్నాను."
 ],
 [
  "th-TH",
  "Thai",
  "ฉันเป็นเจ้าของเสียงนี้ และฉันยินยอมให้ Google ใช้เสียงนี้เพื่อสร้างแบบจำลองเสียงสังเคราะห์"
 ],
 [
  "tr-TR",
  "Turkish",
  "Bu sesin sahibi benim ve Google'ın bu sesi kullanarak sentetik bir ses modeli oluşturmasına izin veriyorum."
 ],
 [
  "vi-VN",
  "Vietnamese",
  "Tôi là chủ sở hữu giọng nói này và tôi đồng ý cho Google sử dụng giọng nói này để tạo mô hình giọng nói tổng hợp."
 ]
]

DEFAULTS = {
    "model": "auto",                # auto = 自動選用目前最新的語音(TTS)模型;也可填具體模型 ID
    "models_show_all": False,
    "mode": "single",              # single / multi
    "voice": "Kore",
    "style": "",
    "speakers": ["Joe", "Jane"],
    "speaker_voices": {"Joe": "Puck", "Jane": "Kore"},
    "speaker_styles": {},
    "conversational": False,       # 多人對話 mode=conversational (REST 文件提及,SDK 不支援時自動退回)
    "force_per_turn": False,       # 強制逐段合成再拼接
    "gap_ms": 300,                 # 逐段合成時,段與段之間的靜音
    "max_chars": 0,                # 單人長文分段上限 (0 = 不分段)
    "out_format": "wav",
    "sample_rate": 0,              # 0 = 預設
    "bitrate": "192k",
    "loudnorm": False,
    "speed": 1.0,
    "keep_wav": False,
    "out_dir": "output",
    "autoplay": False,
    "retries": 2,
    "ffmpeg_path": "",
}

STYLE_HINT = (
    "  語氣範例: cheerful and friendly / whispering / speaking slowly / 溫暖沉穩\n"
    "  (整段文字的情緒、語速、音調寫在這裡;單一時間點的笑聲/停頓請直接寫進文本,\n"
    "   例如 <laugh> <sigh> <short pause> <long pause>,標籤請用英文)"
)


# --------------------------------------------------------------------------- #
# 輸入小工具
# --------------------------------------------------------------------------- #
def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default != "" else ""
    s = input(f"{prompt}{suffix}: ").strip()
    return s if s else default


def ask_menu(title: str, options: list[tuple[str, str]], default: str) -> str:
    print(f"\n{title}")
    for key, label in options:
        mark = "  <- 目前" if key == default else ""
        print(f"  {key}) {label}{mark}")
    lookup = {k.lower(): k for k, _ in options}
    while True:
        s = input(f"請選擇 [{default}]: ").strip().lower()
        if not s:
            return default
        if s in lookup:
            return lookup[s]
        print("  無效選項,請重新輸入。")


def ask_yes_no(prompt: str, default: bool) -> bool:
    d = "Y/n" if default else "y/N"
    while True:
        s = input(f"{prompt} [{d}]: ").strip().lower()
        if not s:
            return default
        if s in ("y", "yes", "是"):
            return True
        if s in ("n", "no", "否"):
            return False


def ask_number(prompt, default, cast=float, lo=None, hi=None):
    while True:
        s = input(f"{prompt} [{default}]: ").strip()
        if not s:
            return default
        try:
            v = cast(s)
        except ValueError:
            print("  請輸入數字。")
            continue
        if (lo is not None and v < lo) or (hi is not None and v > hi):
            print(f"  範圍必須在 {lo} ~ {hi}。")
            continue
        return v


def ask_keep_or_clear(prompt: str, current: str) -> str:
    """Enter=沿用, '-'=清空, 其他=新值"""
    shown = current if current else "(空)"
    s = input(f"{prompt} [Enter 沿用: {shown} | 輸入 - 清空]: ").strip()
    if not s:
        return current
    if s == "-":
        return ""
    return s


def read_multiline(end_token: str = "/end") -> str:
    print(f"(貼上或輸入多行文字;最後單獨一行輸入 {end_token} 並按 Enter 結束)")
    lines = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line.strip() == end_token:
            break
        lines.append(line)
    return "\n".join(lines).strip()


def strip_quotes(s: str) -> str:
    return s.strip().strip('"').strip("'")


# --------------------------------------------------------------------------- #
# 設置存取
# --------------------------------------------------------------------------- #
def load_settings(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[!] 讀取設置檔失敗,將使用預設值: {e}")
        return {}


def save_settings(path: Path, cfg: dict) -> None:
    try:
        path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[!] 無法儲存設置: {e}")


def describe_format(cfg: dict) -> str:
    s = cfg["out_format"]
    if cfg["out_format"] in LOSSY:
        s += f" @ {cfg['bitrate']}"
    if cfg["sample_rate"]:
        s += f", {cfg['sample_rate']} Hz"
    extras = []
    if cfg["loudnorm"]:
        extras.append("響度標準化")
    if abs(cfg["speed"] - 1.0) > 1e-6:
        extras.append(f"速度x{cfg['speed']}")
    if extras:
        s += " + " + "、".join(extras)
    return s


def print_summary(cfg: dict) -> None:
    print("\n---------------- 目前設置 ----------------")
    print(f" 模型      : {cfg['model']}")
    if cfg["mode"] == "single":
        print(" 模式      : 單人")
        print(f" 人聲      : {short_voice(cfg['voice'])}")
        print(f" 語氣      : {cfg['style'] or '(無)'}")
        if cfg["max_chars"]:
            print(f" 長文分段  : 每段約 {cfg['max_chars']} 字")
    else:
        print(" 模式      : 多人對話")
        for n in cfg["speakers"]:
            v = short_voice(cfg["speaker_voices"].get(n, "?"))
            st = cfg["speaker_styles"].get(n, "")
            print(f"   講者 {n}: {v}  語氣: {st or '(無)'}")
        print(f" conversational: {cfg['conversational']}  強制逐段: {cfg['force_per_turn']}"
              f"  段間靜音: {cfg['gap_ms']} ms")
    print(f" 輸出格式  : {describe_format(cfg)}")
    print(f" 輸出資料夾: {cfg['out_dir']}   自動播放: {cfg['autoplay']}   重試: {cfg['retries']}")
    print("------------------------------------------")


# --------------------------------------------------------------------------- #
# 人聲選擇
# --------------------------------------------------------------------------- #
def g(obj, key, default=""):
    v = obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)
    return default if v is None else v


def canonical_voice(name: str) -> str:
    return BUILTIN_LOOKUP.get(name.lower(), name)


def is_custom_voice(voice: str) -> bool:
    return voice.startswith(("voice_", "voicekey_"))


def list_voices_page(client, filters: dict, page_token=None, page_size=20):
    kwargs = {k: v for k, v in filters.items() if v}
    if page_token:
        kwargs["page_token"] = page_token
    resp = client.voices.list(page_size=page_size, **kwargs)
    voices = list(g(resp, "voices", None) or [])
    return voices, (g(resp, "next_page_token", None) or None)


def edit_filters(filters: dict) -> dict:
    print("\n設定篩選 (Enter 沿用舊值,輸入 - 清空,多個值用逗號分隔)")
    print("  語言範例: en-US, ja-JP, zh-TW (若無結果,可改用「關鍵字」搜尋)")
    new = dict(filters)
    for key, label in [
        ("language_code", "語言代碼 language_code"),
        ("gender", "性別 gender (female/male/neutral)"),
        ("pitch", "音高 pitch (low/medium/high)"),
        ("contexts", "用途 contexts (Audiobook/Conversational/News...)"),
        ("type_", "來源 type (prebuilt/prompted/replicated)"),
    ]:
        cur = ", ".join(new.get(key, []))
        s = input(f"  {label} [{cur or '無'}]: ").strip()
        if s == "-":
            new[key] = []
        elif s:
            new[key] = [x.strip() for x in re.split(r"[,，]", s) if x.strip()]
    cur = new.get("search", "")
    s = input(f"  關鍵字 search [{cur or '無'}]: ").strip()
    if s == "-":
        new["search"] = ""
    elif s:
        new["search"] = s
    return new


def browse_voices(client, current: str):
    if not hasattr(client, "voices"):
        print("[!] 目前 SDK 沒有 client.voices,請升級: pip install -U google-genai")
        return None
    filters: dict = {}
    if ask_yes_no("先設定篩選條件 (語言/性別/關鍵字…)?", False):
        filters = edit_filters(filters)
    tokens = [None]
    idx = 0
    while True:
        try:
            voices, next_tok = list_voices_page(client, filters, tokens[idx])
        except Exception as e:
            print(f"[!] 載入人聲清單失敗: {type(e).__name__}: {e}")
            return None
        print(f"\n--- 線上人聲清單 第 {idx + 1} 頁 ({len(voices)} 筆) ---")
        if not voices:
            print("  (沒有符合條件的人聲,輸入 f 調整篩選)")
        for i, v in enumerate(voices, 1):
            vid = g(v, "id")
            name = g(v, "display_name")
            meta = ", ".join(str(x) for x in [
                g(v, "language_code"), g(v, "accent"), g(v, "gender"),
                (f"pitch={g(v, 'pitch')}" if g(v, "pitch") else ""),
            ] if x)
            desc = str(g(v, "description"))[:70]
            print(f" {i:>2}) {vid} | {name} ({meta}) {desc}")
        print("輸入編號選擇 | n 下一頁 | p 上一頁 | f 篩選 | q 返回")
        s = input("> ").strip().lower()
        if s == "q":
            return None
        if s == "n":
            if next_tok:
                if idx + 1 >= len(tokens):
                    tokens.append(next_tok)
                idx += 1
            else:
                print("  已經是最後一頁。")
        elif s == "p":
            idx = max(0, idx - 1)
        elif s == "f":
            filters = edit_filters(filters)
            tokens, idx = [None], 0
        elif s.isdigit() and 1 <= int(s) <= len(voices):
            vid = str(g(voices[int(s) - 1], "id"))
            print(f"  已選擇: {vid}")
            return vid
        else:
            print("  無效輸入。")


def pick_builtin(current: str):
    print("\n--- 內建 30 種精選人聲 ---")
    for i, (n, d) in enumerate(BUILTIN_VOICES, 1):
        print(f" {i:>2}) {n:<14} {d}")
    s = input("輸入編號或名稱 (Enter 返回): ").strip()
    if not s:
        return None
    if s.isdigit() and 1 <= int(s) <= len(BUILTIN_VOICES):
        return BUILTIN_VOICES[int(s) - 1][0]
    if s.lower() in BUILTIN_LOOKUP:
        return BUILTIN_LOOKUP[s.lower()]
    print("  找不到該人聲。")
    return None


def choose_voice(client, label: str, current: str = "", cfg: dict | None = None) -> str:
    opts = []
    if current:
        opts.append(("0", f"沿用目前人聲: {current}"))
    opts += [
        ("1", "直接輸入人聲名稱 / ID (例如 Kore、voice_xxx)"),
        ("2", "從線上可用人聲清單選擇 (動態載入,可篩選)"),
        ("3", "從內建 30 種精選人聲選擇 (離線)"),
        ("4", "我的克隆聲音 (建立 / 管理 / 選用)"),
    ]
    default = "0" if current else "2"
    while True:
        k = ask_menu(f"選擇人聲 — {label}", opts, default)
        if k == "0":
            return current
        if k == "1":
            v = ask("人聲名稱 / ID", current).strip()
            if v:
                return canonical_voice(v)
        elif k == "2":
            v = browse_voices(client, current)
            if v:
                return v
        elif k == "3":
            v = pick_builtin(current)
            if v:
                return v
        elif k == "4":
            v = voice_lab(client, cfg or dict(DEFAULTS))
            if v:
                return v


# --------------------------------------------------------------------------- #
# 音色克隆
# --------------------------------------------------------------------------- #
def short_voice(v: str) -> str:
    """長金鑰只顯示頭尾"""
    return v if len(v) <= 26 else f"{v[:12]}…{v[-6:]}"


def load_lib() -> list[dict]:
    try:
        data = json.loads(LIB_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_lib(items: list[dict]) -> None:
    try:
        LIB_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[!] 無法儲存金鑰庫: {e}")


def clone_model(cfg: dict) -> str:
    m = resolve_model(cfg["model"], normalize_model_list(_MODELS_CACHE or [], cfg.get("models_show_all", False)))
    return m if is_tts_model(m) else (pick_auto_model(normalize_model_list(_MODELS_CACHE or [])) or FALLBACK_TTS_MODELS[0])


def wav_info(data: bytes) -> tuple[int, int, int, float]:
    """(聲道, 取樣率, 位元數, 秒數)"""
    with wave.open(io.BytesIO(data), "rb") as w:
        return w.getnchannels(), w.getframerate(), w.getsampwidth() * 8, w.getnframes() / w.getframerate()


def trim_wav(data: bytes, max_sec: float) -> tuple[bytes, bool]:
    with wave.open(io.BytesIO(data), "rb") as w:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        limit = int(max_sec * rate)
        if n <= limit:
            return data, False
        frames = w.readframes(limit)
    out = io.BytesIO()
    with wave.open(out, "wb") as o:
        o.setnchannels(ch); o.setsampwidth(width); o.setframerate(rate)
        o.writeframes(frames)
    return out.getvalue(), True


def prepare_audio(path: Path, cfg: dict, trim_to: float = 0) -> tuple[bytes, bool]:
    """任意音訊檔 → 24 kHz / 單聲道 / 16-bit WAV。已符合規格的 WAV 不需要 ffmpeg。"""
    raw = path.read_bytes()
    data = None
    try:
        ch, rate, bits, _ = wav_info(raw)
        if (ch, rate, bits) == (1, CLONE_RATE, 16):
            data = raw
    except Exception:
        pass
    if data is None:
        ff = ensure_ffmpeg(cfg)
        if not ff:
            raise RuntimeError("此檔案不是 24 kHz 單聲道 16-bit WAV,需要 ffmpeg 才能轉換。")
        with tempfile.TemporaryDirectory() as td:
            dst = Path(td) / "out.wav"
            run_ffmpeg([ff, "-y", "-hide_banner", "-loglevel", "error", "-i", str(path),
                        "-ar", str(CLONE_RATE), "-ac", "1", "-c:a", "pcm_s16le", str(dst)])
            data = dst.read_bytes()
    trimmed = False
    if trim_to:
        data, trimmed = trim_wav(data, trim_to)
    return data, trimmed


def play_bytes(wav: bytes) -> None:
    p = Path(tempfile.gettempdir()) / f"tts_preview_{int(time.time())}.wav"
    p.write_bytes(wav)
    try:
        os.startfile(str(p))  # Windows
    except Exception:
        print(f"  (已存到 {p},請自行播放)")


def record_mic(max_sec: int) -> bytes:
    try:
        import sounddevice as sd
    except ImportError:
        raise RuntimeError("尚未安裝 sounddevice,請執行: pip install sounddevice  (或改用現有音訊檔)")
    frames: list[bytes] = []

    def cb(indata, n, t, status):
        frames.append(bytes(indata))

    input("  準備好後按 Enter 開始錄音 …")
    with sd.RawInputStream(samplerate=CLONE_RATE, channels=1, dtype="int16", callback=cb):
        print(f"  ● 錄音中 (最長 {max_sec} 秒) … 完成後再按 Enter 停止")
        ev = threading.Event()
        threading.Thread(target=lambda: (input(), ev.set()), daemon=True).start()
        if not ev.wait(max_sec):
            print("  已達最長錄音時間,請按 Enter 繼續")
            ev.wait()
    return pcm_to_wav_bytes(b"".join(frames), CLONE_RATE)


def collect_clip(label: str, cfg: dict, min_sec: float, max_sec: float, trim_to: float = 0) -> bytes | None:
    while True:
        k = ask_menu(label, [
            ("1", "用麥克風錄音 (需要 pip install sounddevice)"),
            ("2", "使用現有音訊檔 (wav / mp3 / m4a …)"),
            ("0", "取消"),
        ], "1")
        if k == "0":
            return None
        try:
            if k == "1":
                wav = record_mic(int(trim_to or max_sec))
                if trim_to:
                    wav, _ = trim_wav(wav, trim_to)
            else:
                path = Path(strip_quotes(input("  音訊檔路徑 (可直接把檔案拖進視窗): ")))
                wav, trimmed = prepare_audio(path, cfg, trim_to)
                if trimmed:
                    print(f"  (超過 {trim_to} 秒,已自動取前 {trim_to} 秒)")
            sec = wav_info(wav)[3]
        except Exception as e:
            print(f"  [!] {e}")
            continue
        print(f"  長度 {sec:.1f} 秒 (24 kHz 單聲道 16-bit WAV)")
        if sec < min_sec:
            print(f"  [!] 太短,至少需要 {min_sec:g} 秒。")
            continue
        if sec > max_sec:
            print(f"  [!] 太長,請控制在 {max_sec:g} 秒內。")
            continue
        if ask_yes_no("  先試聽這段音訊?", False):
            play_bytes(wav)
        if ask_yes_no("  接受這段音訊?", True):
            return wav


def pick_consent():
    guess = "zh-CN" if (os.environ.get("LANG", "") + os.environ.get("LC_ALL", "")).lower().startswith("zh") else "en-US"
    try:
        import locale
        if (locale.getdefaultlocale()[0] or "").lower().startswith("zh"):
            guess = "zh-CN"
    except Exception:
        pass
    print("\n同意聲明語言 (同意錄音必須朗讀對應語言的原句):")
    for i, (code, name, _) in enumerate(CONSENT_PHRASES, 1):
        print(f" {i:>2}) {code:<6} {name}")
    default = str(next(i for i, (c, _, _) in enumerate(CONSENT_PHRASES, 1) if c == guess))
    while True:
        s = ask("選擇語言編號", default)
        if s.isdigit() and 1 <= int(s) <= len(CONSENT_PHRASES):
            return CONSENT_PHRASES[int(s) - 1]


def preview_voice(client, cfg: dict, voice: str) -> None:
    print("  試聽生成中 …")
    try:
        data = call_tts(client, clone_model(cfg), make_input([{"speaker": None, "style": "", "text": PREVIEW_TEXT}], False),
                        [{"voice": voice}], {"type": "audio"}, 0)
        play_bytes(data)
    except Exception as e:
        print(f"  [!] 試聽失敗: {type(e).__name__}: {e}")


def lab_create(client, cfg: dict) -> str | None:
    print("\n=== 建立克隆聲音 ===")
    print("僅限複製你本人的聲音,或已取得該成年說話者明確同意的聲音。")
    print("Google 會驗證「同意錄音」與「參考音訊」是否為同一人。")
    if not ask_yes_no("我確認這是我本人的聲音,或已取得該成年說話者的明確同意", False):
        print("已取消。")
        return None
    code, lname, statement = pick_consent()
    print(f"\n同意聲明 ({code}) — 同意錄音請逐字朗讀:\n\n    {statement}\n")
    if code == "zh-CN":
        print("  (官方沒有繁體中文版聲明:請以國語逐字朗讀這句原文)")

    print("\n[1/2] 參考音訊:10–30 秒乾淨、自然的說話 (超過 30 秒會自動取前 30 秒)")
    src = collect_clip("參考音訊來源", cfg, CLONE_MIN_SEC, 3600, trim_to=CLONE_MAX_SEC)
    if src is None:
        return None
    print(f"\n[2/2] 同意錄音:請朗讀\n\n    {statement}\n\n  建議與參考音訊使用同一支麥克風、同一個安靜環境。")
    consent = collect_clip("同意錄音來源", cfg, 1, 60)
    if consent is None:
        return None

    name = ask("名稱 (選填)", "")
    k = ask_menu("儲存方式", [
        ("1", "儲存在我的 Google 專案 (voice_…,保留 1 年,每專案上限 200 個)"),
        ("2", "不儲存,由我自己保管金鑰 (voicekey_…,7 天有效,存於本機 tts_voices.json)"),
    ], "1")
    store = k == "1"
    voice_body = {
        "model": clone_model(cfg),
        "type": "replicated",
        "replicated": {
            "source_audio": {"mime_type": "audio/wav", "data": base64.b64encode(src).decode()},
            "consent_audio": {"mime_type": "audio/wav", "data": base64.b64encode(consent).decode()},
        },
    }
    if name:
        voice_body["display_name"] = name
    print("\n上傳並建立中 (可能需要數十秒) …")
    try:
        res = client.voices.create(store=store, voice=voice_body)
    except Exception as e:
        print(f"[X] 建立失敗: {type(e).__name__}: {e}")
        return None
    vid, key = str(g(res, "id")), str(g(res, "key"))
    voice = key if (not store and key) else (vid or key)
    if not voice:
        print(f"[X] 建立成功但找不到 voice ID/key,原始回應: {str(res)[:300]}")
        return None
    if not store:
        lib = [x for x in load_lib() if x.get("voice") != voice]
        now = datetime.now(timezone.utc)
        lib.insert(0, {"voice": voice, "name": name or str(g(res, "display_name")),
                       "created": now.isoformat(), "expires": (now + timedelta(days=KEY_TTL_DAYS)).isoformat()})
        save_lib(lib)
        print(f"已建立 (金鑰 7 天有效,已存入 {LIB_FILE.name}): {short_voice(voice)}")
    else:
        print(f"已建立: {voice}  (保留約 1 年)")
    if ask_yes_no("試聽一下?", True):
        preview_voice(client, cfg, voice)
    return voice


def list_cloud(client) -> list:
    out, token = [], None
    for _ in range(10):
        kw = {"type_": ["replicated"], "page_size": 50}
        if token:
            kw["page_token"] = token
        resp = client.voices.list(**kw)
        out += list(g(resp, "voices", None) or [])
        token = g(resp, "next_page_token", None) or None
        if not token:
            break
    return out


def manage_list(title: str, rows: list[tuple[str, str, str, bool]], client, cfg, on_delete) -> str | None:
    """rows: (voice, 標題, 說明, 是否過期)。指令: 編號=選用, pN=試聽, dN=刪除, q=返回"""
    while True:
        print(f"\n--- {title} ---")
        if not rows:
            print("  (沒有項目)")
            return None
        for i, (_, t, m, exp) in enumerate(rows, 1):
            print(f" {i:>2}) {t}  {m}{'  [已過期]' if exp else ''}")
        s = input("編號=選用 | pN=試聽 | dN=刪除 | q=返回 > ").strip().lower()
        if s == "q" or s == "":
            return None
        m = re.fullmatch(r"([pd]?)(\d+)", s)
        if not m or not (1 <= int(m.group(2)) <= len(rows)):
            print("  無效輸入。")
            continue
        idx = int(m.group(2)) - 1
        voice, t, _, exp = rows[idx]
        if m.group(1) == "p":
            preview_voice(client, cfg, voice)
        elif m.group(1) == "d":
            if ask_yes_no(f"確定刪除「{t}」?此動作無法復原", False):
                try:
                    on_delete(voice)
                    rows.pop(idx)
                    print("  已刪除。")
                except Exception as e:
                    print(f"  [!] 刪除失敗: {type(e).__name__}: {e}")
        else:
            if exp:
                print("  [!] 這把金鑰已過期,無法使用。")
                continue
            return voice


def voice_lab(client, cfg: dict) -> str | None:
    """音色克隆選單。回傳選用的 voice 字串 (voice_… / voicekey_…),或 None。"""
    discover_models(client, cfg.get("models_show_all", False))   # 取得模型清單,建立克隆/試聽時使用最新語音模型
    while True:
        k = ask_menu("我的克隆聲音", [
            ("1", "建立新的克隆聲音"),
            ("2", "雲端已儲存的克隆聲音 (voice_…) — 選用 / 試聽 / 刪除"),
            ("3", "本機金鑰庫 (voicekey_…) — 選用 / 試聽 / 刪除"),
            ("0", "返回"),
        ], "1")
        if k == "0":
            return None
        if k == "1":
            v = lab_create(client, cfg)
            if v and ask_yes_no("使用這個聲音?", True):
                return v
        elif k == "2":
            try:
                voices = list_cloud(client)
            except Exception as e:
                print(f"[!] 載入失敗: {type(e).__name__}: {e}")
                continue
            rows = [(str(g(v, "id")), str(g(v, "display_name")) or "(未命名)", str(g(v, "id")), False) for v in voices]
            v = manage_list("雲端已儲存的克隆聲音", rows, client, cfg, lambda vid: client.voices.delete(id=vid))
            if v:
                return v
        elif k == "3":
            def rows_now():
                out = []
                for e in load_lib():
                    try:
                        left = (datetime.fromisoformat(e["expires"]) - datetime.now(timezone.utc)).total_seconds() / 86400
                    except Exception:
                        left = 0
                    out.append((e["voice"], e.get("name") or "(未命名)",
                                f"{short_voice(e['voice'])} · {'已過期' if left <= 0 else f'剩 {left:.1f} 天'}", left <= 0))
                return out
            rows = rows_now()
            v = manage_list("本機金鑰庫", rows, client, cfg,
                            lambda voice: save_lib([x for x in load_lib() if x.get("voice") != voice]))
            if v:
                return v


# --------------------------------------------------------------------------- #
# 設定流程
# --------------------------------------------------------------------------- #
def choose_model(client, cfg: dict) -> None:
    items = discover_models(client, cfg.get("models_show_all", False))
    auto = pick_auto_model(items)
    cur = cfg["model"]
    opts = [("0", f"自動 (推薦: {auto})")]
    for i, it in enumerate(items, 1):
        label = it["id"] + (f"  ({it['display']})" if it["display"] and it["display"] != it["id"] else "")
        opts.append((str(i), label))
    opts += [("a", "顯示全部模型 (含名稱不含 tts 的) / 重新載入清單"), ("c", "自訂模型 ID")]
    default = "0" if cur in ("", "auto") else next((str(i) for i, it in enumerate(items, 1) if it["id"] == cur), "c")
    while True:
        k = ask_menu(f"選擇模型 (偵測到 {len([x for x in items if is_tts_model(x['id'])])} 個語音模型)", opts, default)
        if k == "a":
            cfg["models_show_all"] = not cfg.get("models_show_all", False)
            print(f"  已{'開啟' if cfg['models_show_all'] else '關閉'}「顯示全部模型」,重新載入 …")
            discover_models(client, cfg["models_show_all"], refresh=True)
            return choose_model(client, cfg)
        break
    if k == "0":
        cfg["model"] = "auto"
    elif k == "c":
        cfg["model"] = strip_model_prefix(ask("模型 ID", cur if cur != "auto" else auto)) or "auto"
    else:
        cfg["model"] = items[int(k) - 1]["id"]


def configure_general(cfg: dict, client=None) -> None:
    if client is not None:
        choose_model(client, cfg)
    else:
        cfg["model"] = strip_model_prefix(ask("模型 ID (auto = 自動選用最新語音模型)", cfg["model"])) or "auto"

    k = ask_menu("生成模式", [("1", "單人旁白"), ("2", "多人對話")],
                 "1" if cfg["mode"] == "single" else "2")
    cfg["mode"] = "single" if k == "1" else "multi"

    if cfg["mode"] == "multi":
        while True:
            s = ask("講者名稱 (逗號分隔,至少 2 位)", ", ".join(cfg["speakers"]))
            names = []
            for n in re.split(r"[,，、]", s):
                n = n.strip()
                if n and n.lower() not in [x.lower() for x in names]:
                    names.append(n)
            if len(names) >= 2:
                cfg["speakers"] = names
                break
            print("  至少需要 2 位不重複的講者。")
        cfg["conversational"] = ask_yes_no(
            "啟用 conversational 對話節奏 (mode=conversational,若 SDK 不支援會自動退回)?",
            cfg["conversational"])

    fmt_opts = [
        ("wav", "WAV (API 原生,無損)"),
        ("pcm", "原始 PCM L16 (API 原生,無檔頭)"),
        ("mulaw", "G.711 mu-law (API 原生,電話系統)"),
        ("alaw", "G.711 A-law (API 原生,電話系統)"),
        ("mp3", "MP3 (需 ffmpeg)"),
        ("flac", "FLAC (需 ffmpeg)"),
        ("ogg", "OGG Vorbis (需 ffmpeg)"),
        ("opus", "Opus (需 ffmpeg)"),
        ("m4a", "M4A / AAC (需 ffmpeg)"),
    ]
    cfg["out_format"] = ask_menu("輸出格式", fmt_opts, cfg["out_format"])

    if ask_yes_no("是否調整進階選項 (取樣率、後處理、資料夾、重試等)?", False):
        cfg["sample_rate"] = ask_number("取樣率 Hz (0=預設 24000;電話格式常用 8000)",
                                        cfg["sample_rate"], int, 0, 192000)
        if cfg["out_format"] in LOSSY:
            cfg["bitrate"] = ask("位元率 (如 128k / 192k / 256k)", cfg["bitrate"])
        cfg["loudnorm"] = ask_yes_no("響度標準化 loudnorm (ffmpeg)?", cfg["loudnorm"])
        cfg["speed"] = ask_number("播放速度 (ffmpeg atempo, 1.0=原速, 範圍 0.25~4.0)",
                                  cfg["speed"], float, 0.25, 4.0)
        if cfg["out_format"] in FFMPEG_FORMATS or cfg["loudnorm"] or abs(cfg["speed"] - 1) > 1e-6:
            cfg["keep_wav"] = ask_yes_no("同時保留原始 WAV?", cfg["keep_wav"])
        cfg["ffmpeg_path"] = ask("ffmpeg.exe 路徑 (留空=自動從 PATH 尋找)", cfg["ffmpeg_path"])
        if cfg["mode"] == "single":
            cfg["max_chars"] = ask_number("長文自動分段字數上限 (0=不分段)", cfg["max_chars"], int, 0, 100000)
        else:
            cfg["force_per_turn"] = ask_yes_no("強制逐段合成再拼接 (可穩定各段聲音,但較慢)?",
                                               cfg["force_per_turn"])
            cfg["gap_ms"] = ask_number("逐段合成時,段與段之間的靜音 (毫秒)", cfg["gap_ms"], int, 0, 5000)
        cfg["out_dir"] = ask("輸出資料夾 (相對路徑以本腳本所在位置為基準)", cfg["out_dir"])
        cfg["autoplay"] = ask_yes_no("生成後自動播放?", cfg["autoplay"])
        cfg["retries"] = ask_number("失敗自動重試次數", cfg["retries"], int, 0, 10)


def configure_voices(client, cfg: dict, reuse: bool) -> None:
    printed_hint = False
    if cfg["mode"] == "single":
        if not (reuse and cfg["voice"]):
            cfg["voice"] = choose_voice(client, "單人旁白", cfg["voice"], cfg)
        if not reuse:
            print("\n語氣控制 style:")
            print(STYLE_HINT)
            cfg["style"] = ask_keep_or_clear("語氣", cfg["style"])
    else:
        for name in cfg["speakers"]:
            cur = cfg["speaker_voices"].get(name, "")
            if not (reuse and cur):
                cfg["speaker_voices"][name] = choose_voice(client, f"講者 {name}", cur, cfg)
            if not reuse:
                if not printed_hint:
                    print("\n語氣控制 style (每位講者的預設語氣,單句可再用 名稱[語氣]: 內容 覆蓋):")
                    print(STYLE_HINT)
                    printed_hint = True
                cfg["speaker_styles"][name] = ask_keep_or_clear(
                    f"講者 {name} 預設語氣", cfg["speaker_styles"].get(name, ""))


# --------------------------------------------------------------------------- #
# 文本處理
# --------------------------------------------------------------------------- #
def get_text(cfg: dict, args) -> str:
    if args.text:
        return args.text.strip()
    if args.text_file:
        return Path(strip_quotes(args.text_file)).read_text(encoding="utf-8-sig").strip()

    multi = cfg["mode"] == "multi"
    print("\n========== 輸入要生成的文本 ==========")
    if multi:
        print("多人對話格式 (每行一句,可用 名稱[語氣]: 內容 指定該句語氣):")
        a, b = cfg["speakers"][0], cfg["speakers"][1]
        print(f"  {a}: 你好,今天過得如何?")
        print(f"  {b}[calm and relaxed]: 還不錯,你呢? <short pause> 準備好了嗎?")
        print("沒有「名稱:」開頭的行,會接在上一句後面。")
    else:
        print("可直接寫入 <short pause> <laugh> <sigh> 等英文標籤;用大寫字母可強調英文單字。")
    k = ask_menu("文本輸入方式", [
        ("1", "單行輸入"),
        ("2", "多行輸入 (以單獨一行 /end 結束)"),
        ("3", "從文字檔讀取 (.txt,UTF-8)"),
    ], "2" if multi else "1")
    while True:
        if k == "1":
            text = input("文本: ").strip()
        elif k == "2":
            text = read_multiline()
        else:
            p = strip_quotes(input("檔案路徑 (可直接把檔案拖進視窗): "))
            try:
                text = Path(p).read_text(encoding="utf-8-sig").strip()
            except Exception as e:
                print(f"  讀取失敗: {e}")
                continue
        if text:
            return text
        print("  文本不能為空。")


def parse_dialogue(text: str, speakers: list[str]) -> list[dict]:
    canon = {n.lower(): n for n in speakers}
    names = sorted(speakers, key=len, reverse=True)
    pat = re.compile(
        r"^\s*(" + "|".join(re.escape(n) for n in names) + r")\s*"
        r"(?:[\[\(（【]([^\]\)）】]*)[\]\)）】])?\s*[:：]\s*(.*)$",
        re.IGNORECASE,
    )
    turns: list[dict] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        m = pat.match(line)
        if m:
            turns.append({
                "speaker": canon[m.group(1).lower()],
                "style": (m.group(2) or "").strip(),
                "text": m.group(3).strip(),
            })
        elif turns:
            turns[-1]["text"] += "\n" + line.strip()
        else:
            raise ValueError(f"第一行必須以講者名稱開頭 ({', '.join(speakers)}),例如「{speakers[0]}: 你好」")
    turns = [t for t in turns if t["text"].strip()]
    if not turns:
        raise ValueError("沒有解析到任何有內容的對話。")
    return turns


def split_text(text: str, limit: int) -> list[str]:
    units: list[str] = []
    for para in re.split(r"\n+", text):
        para = para.strip()
        if not para:
            continue
        parts = re.split(r"(?<=[。！？!?…])|(?<=[.;；])\s+", para)
        units.extend(p.strip() for p in parts if p and p.strip())
    chunks: list[str] = []
    cur = ""
    for u in units:
        while len(u) > limit:  # 超長單句硬切
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(u[:limit])
            u = u[limit:]
        if not u:
            continue
        sep = " " if cur and cur[-1].isascii() else ""
        if cur and len(cur) + len(sep) + len(u) > limit:
            chunks.append(cur)
            cur = u
        else:
            cur = cur + sep + u if cur else u
    if cur:
        chunks.append(cur)
    return chunks


def build_segments(cfg: dict, text: str) -> list[dict]:
    if cfg["mode"] == "single":
        pieces = split_text(text, cfg["max_chars"]) if cfg["max_chars"] and len(text) > cfg["max_chars"] else [text]
        return [{"speaker": None, "voice": cfg["voice"], "style": cfg["style"], "text": p} for p in pieces]
    turns = parse_dialogue(text, cfg["speakers"])
    segs = []
    for t in turns:
        n = t["speaker"]
        segs.append({
            "speaker": n,
            "voice": cfg["speaker_voices"][n],
            "style": t["style"] or cfg["speaker_styles"].get(n, ""),
            "text": t["text"],
        })
    return segs


# --------------------------------------------------------------------------- #
# API 呼叫
# --------------------------------------------------------------------------- #
def make_client():
    try:
        from google import genai
    except ImportError:
        print("[!] 找不到 google-genai,請先執行: pip install -U \"google-genai>=2.25.0\"")
        sys.exit(1)
    try:
        from importlib.metadata import version
        ver = tuple(int(x) for x in re.findall(r"\d+", version("google-genai"))[:3])
        if ver < (2, 25, 0):
            print(f"[!] google-genai 版本 {ver} 過舊,建議升級: pip install -U \"google-genai>=2.25.0\"")
    except Exception:
        pass
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        key = getpass.getpass("未偵測到環境變數 GEMINI_API_KEY,請貼上 API Key (輸入不會顯示,也不會儲存): ").strip()
    client = genai.Client(api_key=key)
    if not hasattr(client, "interactions"):
        print("[!] 目前 SDK 沒有 client.interactions,請升級 google-genai。")
        sys.exit(1)
    return client


def extract_audio(interaction) -> bytes:
    oa = getattr(interaction, "output_audio", None)
    data = g(oa, "data", None) if oa is not None else None
    if not data:
        raise RuntimeError(f"回應中沒有音訊資料,原始回應: {str(interaction)[:500]}")
    return data if isinstance(data, (bytes, bytearray)) else base64.b64decode(data)


def with_retry(fn, retries: int):
    for attempt in range(retries + 1):
        try:
            return fn()
        except KeyboardInterrupt:
            raise
        except Exception as e:
            if attempt >= retries:
                raise
            wait = 2 ** attempt
            print(f"  [!] 失敗 ({type(e).__name__}: {e});{wait} 秒後重試 ({attempt + 1}/{retries})")
            time.sleep(wait)


def call_tts(client, model, input_, speech_config, response_format, retries) -> bytes:
    def _do():
        it = client.interactions.create(
            model=model,
            input=input_,
            response_format=response_format,
            generation_config={"speech_config": speech_config},
        )
        return extract_audio(it)
    return with_retry(_do, retries)


def make_input(segments: list[dict], multi: bool) -> list[dict]:
    items = []
    for s in segments:
        item = {"type": "text", "text": s["text"]}
        ann = {}
        if multi:
            ann["speaker"] = s["speaker"]
        if s.get("style"):
            ann["style"] = s["style"]
        if ann:
            item["annotations"] = [{"type": "speech_metadata", **ann}]
        items.append(item)
    return [{"type": "user_input", "content": items}]


def generate_single_request(client, cfg, segments, multi, need_ff) -> tuple[bytes, str]:
    fmt = cfg["out_format"]
    rf: dict = {"type": "audio"}
    if not need_ff:
        if fmt != "wav" or cfg["sample_rate"]:
            rf["mime_type"] = NATIVE_FORMATS[fmt][0]
        if cfg["sample_rate"]:
            rf["sample_rate"] = int(cfg["sample_rate"])
    input_ = make_input(segments, multi)

    if multi:
        speakers = [{"speaker": n, "voice": cfg["speaker_voices"][n]} for n in cfg["speakers"]]
        sc = {"speakers": speakers}
        if cfg["conversational"]:
            try:
                data = call_tts(client, cfg["model"], input_, {**sc, "mode": "conversational"}, rf, 0)
                return data, ("wav" if need_ff else fmt)
            except Exception as e:
                print(f"  [!] 帶 mode=conversational 失敗 ({type(e).__name__}: {e}),改用一般多人模式重試。")
    else:
        sc = [{"voice": segments[0]["voice"]}]
    data = call_tts(client, cfg["model"], input_, sc, rf, cfg["retries"])
    return data, ("wav" if need_ff else fmt)


def pcm_to_wav_bytes(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def wav_to_pcm(data: bytes) -> bytes:
    with wave.open(io.BytesIO(data), "rb") as w:
        return w.readframes(w.getnframes())


def generate_per_turn(client, cfg, segments) -> tuple[bytes, str]:
    pcm = bytearray()
    gap = b"\x00\x00" * int(PCM_RATE * cfg["gap_ms"] / 1000)
    rf = {"type": "audio", "mime_type": "audio/l16", "sample_rate": PCM_RATE}
    for i, s in enumerate(segments, 1):
        who = s["speaker"] or "旁白"
        print(f"  合成第 {i}/{len(segments)} 段 ({who},{len(s['text'])} 字) ...")
        input_ = make_input([{**s, "speaker": None}], multi=False)
        data = call_tts(client, cfg["model"], input_, [{"voice": s["voice"]}], rf, cfg["retries"])
        if i > 1 and gap:
            pcm += gap
        pcm += data
    return pcm_to_wav_bytes(bytes(pcm), PCM_RATE), "wav"


# --------------------------------------------------------------------------- #
# ffmpeg
# --------------------------------------------------------------------------- #
def find_ffmpeg(cfg: dict):
    p = cfg.get("ffmpeg_path")
    if p and Path(strip_quotes(p)).exists():
        return strip_quotes(p)
    return shutil.which("ffmpeg")


def ensure_ffmpeg(cfg: dict):
    ff = find_ffmpeg(cfg)
    if ff:
        return ff
    print("\n[!] 找不到 ffmpeg。安裝方式 (PowerShell): winget install Gyan.FFmpeg  (裝完請重開終端機)")
    p = strip_quotes(input("或直接輸入 ffmpeg.exe 完整路徑 (Enter 放棄,改存 WAV): "))
    if p and Path(p).exists():
        cfg["ffmpeg_path"] = p
        return p
    return None


def needs_ffmpeg(cfg: dict, per_turn: bool) -> bool:
    fmt = cfg["out_format"]
    if fmt in FFMPEG_FORMATS:
        return True
    if cfg["loudnorm"] or abs(cfg["speed"] - 1.0) > 1e-6:
        return True
    if per_turn and (fmt in ("mulaw", "alaw") or (cfg["sample_rate"] and fmt in ("wav", "pcm"))):
        return True
    return False


def atempo_chain(speed: float) -> str:
    parts = []
    while speed > 2.0:
        parts.append("atempo=2.0")
        speed /= 2.0
    while speed < 0.5:
        parts.append("atempo=0.5")
        speed /= 0.5
    parts.append(f"atempo={speed:.4f}")
    return ",".join(parts)


def vorbis_quality(br: str) -> int:
    """libvorbis 在單聲道/低取樣率下無法指定高位元率 (encoder setup failed),改用品質等級"""
    try:
        k = int(re.findall(r"\d+", str(br))[0])
    except Exception:
        k = 192
    return 2 if k <= 64 else 3 if k <= 96 else 4 if k <= 128 else 5 if k <= 160 else 6 if k <= 192 else 7


def build_ffmpeg_cmd(ff: str, cfg: dict, src: str, dst: str) -> list[str]:
    fmt = cfg["out_format"]
    cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-i", src]
    filters = []
    if abs(cfg["speed"] - 1.0) > 1e-6:
        filters.append(atempo_chain(cfg["speed"]))
    if cfg["loudnorm"]:
        filters.append("loudnorm=I=-16:TP=-1.5:LRA=11")
    if filters:
        cmd += ["-af", ",".join(filters)]
    sr = int(cfg["sample_rate"] or 0)
    if fmt == "opus" and sr and sr not in (8000, 12000, 16000, 24000, 48000):
        sr = 48000  # libopus 只支援特定取樣率
    if sr:
        cmd += ["-ar", str(sr)]
    elif cfg["loudnorm"]:
        cmd += ["-ar", str(PCM_RATE)]  # loudnorm 內部會升頻到 192kHz,明確指定以維持原取樣率
    cmd += ["-ac", "1"]
    br = cfg["bitrate"]
    cmd += {
        "wav": ["-c:a", "pcm_s16le"],
        "pcm": ["-f", "s16le", "-c:a", "pcm_s16le"],
        "mulaw": ["-f", "mulaw"],
        "alaw": ["-f", "alaw"],
        "mp3": ["-c:a", "libmp3lame", "-b:a", br],
        "flac": ["-c:a", "flac"],
        "ogg": ["-c:a", "libvorbis", "-q:a", str(vorbis_quality(br))],
        "opus": ["-c:a", "libopus", "-b:a", br],
        "m4a": ["-c:a", "aac", "-b:a", br],
    }[fmt]
    cmd.append(dst)
    return cmd


def run_ffmpeg(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg 失敗 (code {r.returncode}):\n{r.stderr.strip()}")


# --------------------------------------------------------------------------- #
# 輸出
# --------------------------------------------------------------------------- #
def safe_name(s: str) -> str:
    return re.sub(r'[<>:"/\\|?*\s]+', "_", s).strip("._") or "tts"


def unique_path(folder: Path, stem: str, ext: str) -> Path:
    p = folder / f"{stem}{ext}"
    n = 2
    while p.exists():
        p = folder / f"{stem}_{n}{ext}"
        n += 1
    return p


def resolve_out_dir(cfg: dict) -> Path:
    p = Path(strip_quotes(cfg["out_dir"]))
    if not p.is_absolute():
        p = SCRIPT_DIR / p
    p.mkdir(parents=True, exist_ok=True)
    return p


def write_output(cfg, data: bytes, kind: str, per_turn: bool, need_ff: bool, ff, stem: str, out_dir: Path) -> Path:
    fmt = cfg["out_format"]
    if not need_ff:
        if per_turn:  # data 是 wav
            if fmt == "pcm":
                path = unique_path(out_dir, stem, ".pcm")
                path.write_bytes(wav_to_pcm(data))
            else:
                path = unique_path(out_dir, stem, ".wav")
                path.write_bytes(data)
        else:
            path = unique_path(out_dir, stem, NATIVE_FORMATS[fmt][1])
            path.write_bytes(data)
        return path

    ext = FFMPEG_FORMATS.get(fmt) or NATIVE_FORMATS[fmt][1]
    path = unique_path(out_dir, stem, ext)
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "src.wav"
        src.write_bytes(data)
        if cfg["keep_wav"]:
            keep = unique_path(out_dir, stem + "_original", ".wav")
            keep.write_bytes(data)
            print(f"  已保留原始 WAV: {keep}")
        run_ffmpeg(build_ffmpeg_cmd(ff, cfg, str(src), str(path)))
    return path


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(description="Gemini TTS 互動式工具")
    ap.add_argument("--reuse", action="store_true", help="直接沿用上次設置,只詢問文本")
    ap.add_argument("--text", help="直接指定文本 (略過文本輸入選單)")
    ap.add_argument("--text-file", help="從文字檔讀取文本 (UTF-8)")
    ap.add_argument("--gui", action="store_true", help="開啟圖形介面 (本機網頁視窗,等同執行 tts_gui.py)")
    ap.add_argument("--clone", action="store_true", help="直接進入「我的克隆聲音」選單 (建立/管理/試聽)")
    ap.add_argument("--settings", default=str(DEFAULT_SETTINGS_FILE), help="設置檔路徑")
    args = ap.parse_args()
    settings_path = Path(args.settings)

    saved = load_settings(settings_path)
    cfg = copy.deepcopy(DEFAULTS)
    cfg.update(saved)
    reuse = False

    if args.gui:
        gui = SCRIPT_DIR / "tts_gui.py"
        if not gui.is_file():
            print("[!] 找不到 tts_gui.py (需與 tts.py 放在同一個資料夾)")
            return
        sys.exit(subprocess.call([sys.executable, str(gui)]))
    print("=== Gemini TTS 互動式工具 ===")
    if args.clone:   # 只做音色克隆管理,不進入生成流程
        client = make_client()
        v = voice_lab(client, cfg)
        if v and ask_yes_no(f"把 {short_voice(v)} 設為單人模式的人聲並儲存?", True):
            cfg["voice"] = v
            save_settings(settings_path, cfg)
            print("已儲存。下次生成時在人聲選單選「沿用目前」即可。")
        return
    if saved:
        print_summary(cfg)
        if args.reuse:
            reuse = True
        else:
            k = ask_menu("偵測到上次設置", [
                ("y", "沿用上次設置 (只需輸入文本)"),
                ("e", "逐項修改 (Enter 保留舊值)"),
                ("n", "全新設定 (忽略舊值)"),
            ], "y")
            if k == "y":
                reuse = True
            elif k == "n":
                cfg = copy.deepcopy(DEFAULTS)
    elif args.reuse:
        print("[!] 尚無上次設置,改為完整設定流程。")

    client = make_client()

    if not reuse:
        configure_general(cfg, client)
    configure_voices(client, cfg, reuse)
    save_settings(settings_path, cfg)

    text = get_text(cfg, args)
    multi = cfg["mode"] == "multi"
    try:
        segments = build_segments(cfg, text)
    except ValueError as e:
        print(f"[!] 文本格式錯誤: {e}")
        sys.exit(1)

    custom_voice = any(is_custom_voice(s["voice"]) for s in segments)
    n_speakers = len({s["speaker"] for s in segments}) if multi else 1
    per_turn = (len(segments) > 1 and not multi) or (multi and (
        cfg["force_per_turn"] or custom_voice or len(cfg["speakers"]) > 2 or n_speakers > 2))
    if multi and custom_voice:
        print("[i] 使用了自訂人聲 (voice_...),多人對話將改為逐段合成後拼接。")
    if multi and len(cfg["speakers"]) > 2:
        print("[i] 講者超過 2 位,將改為逐段合成後拼接。")
    if not multi and len(segments) > 1:
        print(f"[i] 文本已自動分成 {len(segments)} 段,將逐段合成後拼接。")

    run_cfg = dict(cfg)  # 本次實際使用 (ffmpeg 不可用時會降級,不寫回設置檔)
    if cfg["model"] in ("", "auto"):
        run_cfg["model"] = resolve_model("auto", discover_models(client, cfg.get("models_show_all", False)))
        print(f"[i] 自動選用模型: {run_cfg['model']}")
    need_ff = needs_ffmpeg(run_cfg, per_turn)
    ff = None
    if need_ff:
        ff = ensure_ffmpeg(run_cfg)
        if ff is None:
            print("[i] 無 ffmpeg,本次改為輸出 WAV,並略過響度/變速/轉檔。")
            run_cfg.update(out_format="wav", loudnorm=False, speed=1.0, sample_rate=0)
            need_ff = False
        elif run_cfg["ffmpeg_path"] != cfg["ffmpeg_path"]:
            cfg["ffmpeg_path"] = run_cfg["ffmpeg_path"]
            save_settings(settings_path, cfg)

    if not reuse:
        print_summary(cfg)
        print(f" 文本長度  : {len(text)} 字,共 {len(segments)} 段   生成方式: "
              f"{'逐段合成' if per_turn else '單次請求'}")
        if not ask_yes_no("開始生成?", True):
            print("已取消。")
            return

    out_dir = resolve_out_dir(run_cfg)
    default_stem = f"tts_{datetime.now():%Y%m%d_%H%M%S}"
    name = ask("輸出檔名 (不含副檔名,Enter 自動命名)", "")
    stem = safe_name(name) if name else default_stem

    print("\n生成中,請稍候 ...")
    t0 = time.time()
    try:
        if per_turn:
            data, kind = generate_per_turn(client, run_cfg, segments)
        else:
            data, kind = generate_single_request(client, run_cfg, segments, multi, need_ff)
        path = write_output(run_cfg, data, kind, per_turn, need_ff, ff, stem, out_dir)
    except Exception as e:
        print(f"\n[X] 生成失敗: {type(e).__name__}: {e}")
        sys.exit(1)

    size_kb = path.stat().st_size / 1024
    print(f"\n完成! 已儲存: {path}  ({size_kb:.1f} KB,耗時 {time.time() - t0:.1f} 秒)")
    if run_cfg["autoplay"]:
        try:
            os.startfile(str(path))  # Windows
        except Exception as e:
            print(f"[!] 無法自動播放: {e}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已中斷。")
        sys.exit(130)
