#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gemini TTS 本機圖形介面 (只需 Python 標準庫,不需 pip 安裝任何東西)

啟動一個「只接受本機連線」的小服務,用 Edge/Chrome 的應用程式視窗開啟與網頁版同一套介面。
和網頁版相比,本機版多了:
  * 原生 ffmpeg (不用下載 wasm、速度快、格式齊全)
  * 生成後自動存進輸出資料夾,附「最近生成」清單 (播放/開啟資料夾/刪除)
  * 設置與 tts.py 命令列版共用 (tts_settings.json)、克隆金鑰庫共用 (tts_voices.json)
  * 經本機服務轉送 Gemini API (不受瀏覽器跨來源限制),可用環境變數 GEMINI_API_KEY
  * 一鍵安裝 ffmpeg (winget)

用法:  python tts_gui.py            (或雙擊「啟動圖形介面.bat」)
選項:  --port N  --no-browser  --no-autoexit
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from glob import glob
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
SETTINGS_FILE = HERE / "tts_settings.json"
LIB_FILE = HERE / "tts_voices.json"
KEY_FILE = HERE / ".gemini_key"
DEFAULT_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".pcm", ".mulaw", ".alaw"}
MAX_BODY = 200 * 1024 * 1024
VERSION = "1.0"

TOKEN = secrets.token_urlsafe(24)
STATE = {"port": 0, "last_ping": 0.0, "pinged": False, "bye_at": 0.0, "active": 0, "api_base": DEFAULT_API_BASE, "site": None}
LOCK = threading.Lock()


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def find_site(override: str | None) -> Path:
    cands = [Path(override)] if override else [HERE / "site", HERE.parent / "site"]
    for c in cands:
        if (c / "index.html").is_file():
            return c.resolve()
    raise SystemExit("找不到 site 資料夾 (需要 index.html)。請確認資料夾結構: <專案>/site 與 <專案>/local/tts_gui.py")


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def api_key_source() -> tuple[str, str]:
    """回傳 (來源, 金鑰)。環境變數優先於檔案。"""
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        v = os.environ.get(name, "").strip()
        if v:
            return "env", v
    try:
        v = KEY_FILE.read_text(encoding="utf-8").strip()
        if v:
            return "file", v
    except Exception:
        pass
    return "", ""


def find_ffmpeg(settings: dict) -> str | None:
    p = str(settings.get("ffmpeg_path") or "").strip().strip('"')
    if p and Path(p).is_file():
        return p
    w = shutil.which("ffmpeg")
    if w:
        return w
    if sys.platform == "win32":  # winget 安裝位置 (新安裝後目前行程的 PATH 尚未更新)
        local = os.environ.get("LOCALAPPDATA", "")
        pats = [
            f"{local}\\Microsoft\\WinGet\\Links\\ffmpeg.exe",
            f"{local}\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg*\\ffmpeg-*\\bin\\ffmpeg.exe",
            "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
        ]
        for pat in pats:
            hits = sorted(glob(pat))
            if hits:
                return hits[-1]
    return None


def ffmpeg_info(settings: dict) -> dict:
    path = find_ffmpeg(settings)
    if not path:
        return {"found": False, "path": "", "version": ""}
    ver = ""
    try:
        r = subprocess.run([path, "-version"], capture_output=True, text=True, timeout=10)
        ver = (r.stdout or "").splitlines()[0] if r.stdout else ""
    except Exception:
        pass
    return {"found": True, "path": path, "version": ver}


def out_dir(settings: dict) -> Path:
    raw = str(settings.get("out_dir") or "output").strip().strip('"') or "output"
    p = Path(raw)
    if not p.is_absolute():
        p = HERE / p
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def safe_name(name: str) -> str:
    name = Path(name.replace("\\", "/")).name
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", name).strip(" .")
    return (name or "tts")[:120]


def unique_path(folder: Path, name: str) -> Path:
    p = folder / name
    stem, ext = p.stem, p.suffix
    n = 2
    while p.exists():
        p = folder / f"{stem}_{n}{ext}"
        n += 1
    return p


def inside(folder: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(folder.resolve())
        return True
    except Exception:
        return False


# 每個選項只接受 core.js 會產生的值 (白名單),避免本機服務被拿去讀寫任意檔案或啟用奇怪的輸入/輸出裝置
OPT_VALUES = {
    "-loglevel": re.compile(r"error"),
    "-af": re.compile(r"(atempo=[0-9.]+|loudnorm=I=-16:TP=-1\.5:LRA=11)(,(atempo=[0-9.]+|loudnorm=I=-16:TP=-1\.5:LRA=11))*"),
    "-ar": re.compile(r"[0-9]{4,6}"),
    "-ac": re.compile(r"[12]"),
    "-c:a": re.compile(r"pcm_s16le|libmp3lame|flac|libvorbis|libopus|aac"),
    "-b:a": re.compile(r"[0-9]{2,3}k"),
    "-q:a": re.compile(r"[0-9]"),
    "-f": re.compile(r"s16le|mulaw|alaw"),
}


def validate_ffmpeg_args(args) -> None:
    """只允許前端 core.js 產生的參數形態。"""
    if not isinstance(args, list) or not (3 <= len(args) <= 40) or not all(isinstance(a, str) for a in args):
        raise ValueError("參數格式不合法")
    if not re.fullmatch(r"out\.[a-z0-9]{2,6}", args[-1]):
        raise ValueError("輸出檔名不合法")
    body, i, seen_in = args[:-1], 0, False
    while i < len(body):
        a = body[i]
        if a in ("-y", "-hide_banner"):
            i += 1
            continue
        if a not in OPT_VALUES and a != "-i":
            raise ValueError(f"不允許的參數: {a}")
        if i + 1 >= len(body):
            raise ValueError("參數缺少值")
        v = body[i + 1]
        if a == "-i":
            if v != "src.wav":
                raise ValueError("輸入檔名不合法")
            seen_in = True
        elif not OPT_VALUES[a].fullmatch(v):
            raise ValueError(f"參數值不合法: {a} {v}")
        i += 2
    if not seen_in:
        raise ValueError("缺少 -i")


def run_ffmpeg(settings: dict, args: list[str], data: bytes) -> bytes:
    validate_ffmpeg_args(args)
    ff = find_ffmpeg(settings)
    if not ff:
        raise RuntimeError("找不到 ffmpeg。請在「進階選項 → 本機工具」指定路徑,或按「安裝 ffmpeg」。")
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / "src.wav").write_bytes(data)
        r = subprocess.run([ff, *args], cwd=td, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=900)
        out = Path(td) / args[-1]
        if r.returncode != 0 or not out.is_file():
            raise RuntimeError(f"ffmpeg 失敗 (code {r.returncode}): {(r.stderr or '').strip()[-600:]}")
        return out.read_bytes()


def open_path(path: Path, folder: bool) -> None:
    if sys.platform == "win32":
        if folder:
            subprocess.Popen(["explorer", f"/select,{path}"])
        else:
            os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)] if folder else ["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent if folder else path)])


# --------------------------------------------------------------------------- #
# HTTP 服務
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = f"TTSLocal/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 不印出請求 (避免洩漏金鑰/查詢字串)
        pass

    # ---- 回應 ----
    def _send(self, code: int, body: bytes = b"", ctype: str = "application/json; charset=utf-8", extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if self.close_connection:
            self.send_header("Connection", "close")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _err(self, code: int, msg: str) -> None:
        self._json(code, {"error": msg})

    # ---- 驗證 ----
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        return host in {f"127.0.0.1:{STATE['port']}", f"localhost:{STATE['port']}"}

    def _auth_ok(self) -> bool:
        tok = self.headers.get("X-TTS-Token") or parse_qs(urlparse(self.path).query).get("t", [""])[0]
        return bool(tok) and secrets.compare_digest(tok, TOKEN)

    def _read_raw(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("內容過大")
        return self.rfile.read(n) if n else b""

    def _body(self) -> bytes:
        return self._raw

    # ---- 路由 ----
    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_DELETE(self):
        self._route("DELETE")

    def do_HEAD(self):
        self._route("GET")

    def do_OPTIONS(self):
        self._err(405, "不支援跨來源請求")

    def _route(self, method: str):
        with LOCK:
            STATE["active"] += 1          # 有請求處理中 (上傳/生成/轉檔) 時,程式不會自動結束
        self._raw = b""
        try:
            if not self._host_ok():
                self.close_connection = True
                return self._err(403, "Host 不允許")
            if method in ("POST", "DELETE"):   # 先把本體讀完,再決定回應 (大型上傳被拒絕時才不會變成「連線中斷」)
                try:
                    self._raw = self._read_raw()
                except ValueError:
                    self.close_connection = True
                    return self._err(413, "內容過大")
            u = urlparse(self.path)
            if u.path.startswith("/api/"):
                if not self._auth_ok():
                    return self._err(403, "缺少或錯誤的 token")
                return self._api(method, u)
            if method != "GET":
                return self._err(405, "不支援")
            return self._static(u.path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # 不洩漏內部細節
            try:
                self._err(500, f"{type(e).__name__}: {e}")
            except Exception:
                pass
        finally:
            with LOCK:
                STATE["active"] -= 1

    # ---- 靜態檔 ----
    def _static(self, path: str):
        site: Path = STATE["site"]
        rel = unquote(path).lstrip("/") or "index.html"
        target = (site / rel).resolve()
        if not inside(site, target) or not target.is_file():
            return self._err(404, "找不到")
        data = target.read_bytes()
        if target.name == "index.html":
            data = data.replace(b"__TTS_TOKEN__", TOKEN.encode())
        ctype = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".wasm": "application/wasm", ".webmanifest": "application/manifest+json"}.get(
            target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/html"):
            ctype += "; charset=utf-8"
        self._send(200, data, ctype)

    # ---- API ----
    def _api(self, method: str, u):
        p = u.path[len("/api/"):]
        q = parse_qs(u.query)
        settings = read_json(SETTINGS_FILE, {})

        if p == "hello" and method == "GET":
            src, _ = api_key_source()
            return self._json(200, {"ok": True, "version": VERSION, "platform": sys.platform, "key_source": src,
                                    "ffmpeg": ffmpeg_info(settings), "out_dir": str(out_dir(settings))})
        if p == "ping":
            with LOCK:
                STATE["last_ping"], STATE["pinged"], STATE["bye_at"] = time.time(), True, 0.0
            return self._json(200, {"ok": True})
        if p == "bye":   # 視窗關閉 (pagehide)。短暫等待後自動結束;若只是重新整理,新頁面的 ping 會取消它
            with LOCK:
                STATE["bye_at"] = time.time()
            return self._json(200, {"ok": True})
        if p == "shutdown" and method == "POST":
            self._json(200, {"ok": True})
            threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)), daemon=True).start()
            return
        if p == "settings":
            if method == "GET":
                return self._json(200, settings)
            data = json.loads(self._body() or b"{}")
            if not isinstance(data, dict):
                return self._err(400, "格式錯誤")
            settings.update(data)
            write_json(SETTINGS_FILE, settings)
            return self._json(200, {"ok": True})
        if p == "lib":
            if method == "GET":
                lib = read_json(LIB_FILE, [])
                return self._json(200, lib if isinstance(lib, list) else [])
            data = json.loads(self._body() or b"[]")
            if not isinstance(data, list):
                return self._err(400, "格式錯誤")
            write_json(LIB_FILE, data)
            return self._json(200, {"ok": True})
        if p == "key":
            if method == "POST":
                k = str(json.loads(self._body() or b"{}").get("key", "")).strip()
                if not re.fullmatch(r"[A-Za-z0-9_\-]{20,200}", k):
                    return self._err(400, "金鑰格式看起來不正確")
                KEY_FILE.write_text(k, encoding="utf-8")
                try:
                    os.chmod(KEY_FILE, 0o600)
                except Exception:
                    pass
                return self._json(200, {"ok": True})
            if method == "DELETE":
                try:
                    KEY_FILE.unlink()
                except FileNotFoundError:
                    pass
                return self._json(200, {"ok": True})
        if p.startswith("g/"):
            return self._proxy(method, "/" + p[2:] + (("?" + u.query) if u.query else ""))
        if p == "ffmpeg" and method == "POST":
            try:
                args = json.loads(q.get("args", ["[]"])[0])
                data = run_ffmpeg(settings, args, self._body())
            except ValueError as e:
                return self._err(400, str(e))
            except Exception as e:
                return self._err(500, str(e))
            return self._send(200, data, "application/octet-stream")
        if p == "install-ffmpeg" and method == "POST":
            return self._install_ffmpeg(settings)
        if p == "save" and method == "POST":
            name = safe_name(q.get("name", ["tts"])[0])
            folder = out_dir(settings)
            path = unique_path(folder, name)
            path.write_bytes(self._body())
            return self._json(200, {"ok": True, "path": str(path), "name": path.name, "size": path.stat().st_size})
        if p == "history" and method == "GET":
            folder = out_dir(settings)
            files = [f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in AUDIO_EXTS]
            files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
            return self._json(200, [{"name": f.name, "size": f.stat().st_size, "mtime": f.stat().st_mtime}
                                    for f in files[:30]])
        if p == "file" and method == "GET":
            f = out_dir(settings) / safe_name(q.get("name", [""])[0])
            if not f.is_file() or f.suffix.lower() not in AUDIO_EXTS:
                return self._err(404, "找不到檔案")
            ctype = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg",
                     ".opus": "audio/ogg", ".m4a": "audio/mp4"}.get(f.suffix.lower(), "application/octet-stream")
            return self._send(200, f.read_bytes(), ctype)
        if p == "open" and method == "POST":
            d = json.loads(self._body() or b"{}")
            folder = out_dir(settings)
            name = d.get("name")
            if name:
                f = folder / safe_name(name)
                if not f.is_file():
                    return self._err(404, "找不到檔案")
                open_path(f, bool(d.get("folder")))
            else:
                open_path(folder, False)
            return self._json(200, {"ok": True})
        if p == "delete" and method == "POST":
            name = safe_name(json.loads(self._body() or b"{}").get("name", ""))
            f = out_dir(settings) / name
            if not f.is_file() or f.suffix.lower() not in AUDIO_EXTS:
                return self._err(404, "找不到檔案")
            f.unlink()
            return self._json(200, {"ok": True})
        return self._err(404, "未知的 API")

    # ---- Gemini 轉送 ----
    def _proxy(self, method: str, rest: str):
        path_only = rest.split("?", 1)[0]
        allowed = (path_only == "/interactions" or path_only == "/voices" or path_only.startswith("/voices/")
                   or (method == "GET" and (path_only == "/models" or path_only.startswith("/models/"))))   # 模型清單 (唯讀)
        if not allowed:
            return self._err(403, "不允許的 API 路徑")
        key = (self.headers.get("X-Goog-Api-Key") or "").strip() or api_key_source()[1]
        if not key:
            return self._err(401, "尚未提供 API Key (頁面上輸入,或設定環境變數 GEMINI_API_KEY)")
        body = self._body() if method in ("POST", "PUT", "PATCH") else None
        headers = {"x-goog-api-key": key}
        if body:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(STATE["api_base"] + rest, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                data, code, ctype = r.read(), r.status, r.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            data, code, ctype = e.read(), e.code, e.headers.get("Content-Type", "application/json")
        except Exception as e:
            return self._err(502, f"無法連線到 Gemini API: {type(e).__name__}")
        self._send(code, data, ctype)

    def _install_ffmpeg(self, settings: dict):
        if sys.platform != "win32":
            return self._err(400, "一鍵安裝只支援 Windows (winget)。請用套件管理員安裝 ffmpeg。")
        try:
            r = subprocess.run(["winget", "install", "--id", "Gyan.FFmpeg", "-e",
                                "--accept-source-agreements", "--accept-package-agreements"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900)
        except FileNotFoundError:
            return self._err(500, "找不到 winget。請先到 Microsoft Store 更新「應用程式安裝程式」。")
        except Exception as e:
            return self._err(500, f"{type(e).__name__}: {e}")
        info = ffmpeg_info(settings)
        self._json(200, {"ok": r.returncode == 0 or info["found"], "found": info["found"],
                         "output": ((r.stdout or "") + (r.stderr or ""))[-600:]})


# --------------------------------------------------------------------------- #
# 啟動
# --------------------------------------------------------------------------- #
def _registry_app_path(exe: str) -> str | None:
    """從 Windows 登錄檔 (App Paths) 找瀏覽器位置,涵蓋非標準安裝路徑"""
    try:
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}") as k:
                    return winreg.QueryValue(k, None)
            except OSError:
                continue
    except Exception:
        pass
    return None


def browser_paths(name: str) -> list[str]:
    pf, pf86, loc = (os.environ.get(k, "") for k in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"))
    if name == "chrome":
        c = [f"{pf}\\Google\\Chrome\\Application\\chrome.exe", f"{pf86}\\Google\\Chrome\\Application\\chrome.exe",
             f"{loc}\\Google\\Chrome\\Application\\chrome.exe", _registry_app_path("chrome.exe") or ""]
    else:
        c = [f"{pf86}\\Microsoft\\Edge\\Application\\msedge.exe", f"{pf}\\Microsoft\\Edge\\Application\\msedge.exe",
             _registry_app_path("msedge.exe") or ""]
    return [x for x in c if x and not x.startswith("\\")]


def find_browser(pref: str = "auto") -> tuple[str | None, str | None]:
    """依偏好找瀏覽器。auto = 優先 Chrome,其次 Edge;找不到偏好的就退而求其次。"""
    order = {"chrome": ["chrome", "edge"], "edge": ["edge", "chrome"], "default": []}.get(pref, ["chrome", "edge"])
    for name in order:
        for path in browser_paths(name):
            if Path(path).is_file():
                return name, path
    return None, None


def open_app_window(url: str, pref: str = "auto") -> None:
    """用「應用程式視窗」模式開啟 (沒有網址列/分頁);找不到 Chrome/Edge 或選了 default 就用系統預設瀏覽器。"""
    if sys.platform == "win32" and pref != "default":
        name, exe = find_browser(pref)
        if exe:
            if pref in ("chrome", "edge") and name != pref:
                print(f"[!] 找不到 {pref},改用 {name}")
            print(f"以 {name} 應用程式視窗開啟 …")
            subprocess.Popen([exe, f"--app={url}", "--window-size=760,980"])
            return
    import webbrowser
    print("以系統預設瀏覽器開啟 …")
    webbrowser.open(url)


def make_server(port: int) -> ThreadingHTTPServer:
    last = None
    for p in ([port] if port else [8765]) + [0]:
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            srv.daemon_threads = True
            return srv
        except OSError as e:
            last = e
    raise SystemExit(f"無法啟動本機服務: {last}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Gemini TTS 本機圖形介面")
    ap.add_argument("--port", type=int, default=0, help="指定連接埠 (預設 8765,被占用時自動換)")
    ap.add_argument("--no-browser", action="store_true", help="不自動開啟視窗")
    ap.add_argument("--browser", choices=["auto", "chrome", "edge", "default"], default=None,
                    help="開啟視窗用的瀏覽器 (預設讀取設置檔 gui_browser,再預設 auto = 優先 Chrome,其次 Edge)")
    ap.add_argument("--no-autoexit", action="store_true", help="關閉視窗後不自動結束程式")
    ap.add_argument("--idle-timeout", type=float, default=900.0, help="完全沒有心跳多久後自動結束 (秒,預設 15 分鐘;正常關閉視窗會立刻通知,幾秒內結束)")
    ap.add_argument("--api-base", default=os.environ.get("TTS_API_BASE", DEFAULT_API_BASE), help=argparse.SUPPRESS)
    ap.add_argument("--site", default=None, help=argparse.SUPPRESS)
    args = ap.parse_args()

    STATE["site"] = find_site(args.site)
    STATE["api_base"] = args.api_base.rstrip("/")
    srv = make_server(args.port)
    STATE["port"] = srv.server_address[1]
    url = f"http://127.0.0.1:{STATE['port']}/"

    print("=== Gemini TTS 本機圖形介面 ===")
    print(f"網址 : {url}   (只接受本機連線)")
    print(f"設置 : {SETTINGS_FILE}")
    print(f"輸出 : {out_dir(read_json(SETTINGS_FILE, {}))}")
    src, _ = api_key_source()
    print(f"金鑰 : {'已偵測到 ' + ('環境變數' if src == 'env' else '本機檔案') if src else '尚未設定 (請在視窗中貼上)'}")
    ff = ffmpeg_info(read_json(SETTINGS_FILE, {}))
    print(f"ffmpeg: {ff['version'] or '未找到 (需要轉 mp3/flac 等格式時,請在視窗中安裝或指定路徑)'}")
    if not args.no_autoexit:
        print("(關閉視窗後,此程式會自動結束)")

    if not args.no_autoexit:
        def watchdog():
            started = time.time()
            while True:
                time.sleep(1)
                with LOCK:
                    pinged, last, bye, active = STATE["pinged"], STATE["last_ping"], STATE["bye_at"], STATE["active"]
                if active > 0:      # 還有請求在處理 (上傳/生成/轉檔中),不要結束
                    continue
                now = time.time()
                if bye and now - bye > 8:
                    print("視窗已關閉,程式結束。")
                    os._exit(0)
                if pinged and now - last > args.idle_timeout:
                    print(f"超過 {args.idle_timeout:.0f} 秒沒有收到視窗心跳 (視窗可能已被強制關閉),程式結束。")
                    os._exit(0)
                if not pinged and now - started > 300:
                    print("5 分鐘內沒有開啟視窗,程式結束。")
                    os._exit(0)
        threading.Thread(target=watchdog, daemon=True).start()

    pref = args.browser or os.environ.get("TTS_BROWSER") or read_json(SETTINGS_FILE, {}).get("gui_browser") or "auto"
    if not args.no_browser:
        threading.Timer(0.6, open_app_window, args=(url, pref)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
