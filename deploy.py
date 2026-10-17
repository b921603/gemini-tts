#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一鍵推送更新到 GitHub (只需 Python 標準庫 + Git)

典型用法 (雙擊「一鍵推送.bat」即可,或把更新檔 zip 拖到它上面):
    python deploy.py                    自動找 Downloads 裡最新的 gemini-tts*.zip → 同步 → 推送 → 等待部署結果
    python deploy.py 更新檔.zip         指定更新檔
    python deploy.py -m "修正克隆聲音"   自訂提交訊息
    python deploy.py --rollback         回復上一次推送 (用 git revert,不會改寫歷史)
    python deploy.py --status           查看最近一次部署狀態
    python deploy.py --meta             只同步專案頁資訊 (About 說明 / 網站連結 / Topics,定義在 .github/repo-meta.json)
選項: --yes 不詢問  --no-wait 不等待部署  --no-open 不開啟瀏覽器
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import webbrowser
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
MANAGED_DIRS = ["site", ".github", "local", "docs"]          # 以更新檔為準同步 (只會刪除「已被追蹤」且更新檔裡沒有的檔案)
MANAGED_FILES = ["README.md", "README.en.md", "deploy.py", ".gitignore", "啟動圖形介面.bat", "啟動命令列.bat", "啟動自我檢測.bat"]
# 注意: 「一鍵推送.bat」不在清單內,因為它正在執行時不能被覆蓋
UNTRACK_FILES = ["SOP.md"]      # 維護者私人文件:不放進公開倉庫。若曾被推送過,會自動從倉庫移除 (本機檔案保留)
SECRET_PATTERNS = [
    (re.compile(r"AIza[0-9A-Za-z_\-]{35}"), "Google API Key"),
    (re.compile(r"\bAQ\.[0-9A-Za-z_\-]{30,}"), "Google API Key (新格式 AQ.…)"),
    (re.compile(r"voicekey_[A-Za-z0-9_\-]{20,}"), "克隆聲音金鑰 (voicekey_…)"),
]
FORBIDDEN_NAMES = {"tts_settings.json", "tts_voices.json", ".gemini_key", ".env"}
# ---- 第二層保護:只允許推送「專案本身」的檔案 (即使 .gitignore 被改壞/被 git add -f 強制加入也一樣) ----
BLOCKED_SUFFIXES = {".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".pcm", ".mulaw", ".alaw", ".srt", ".vtt", ".lrc",
                    ".log", ".tmp", ".bak", ".swp", ".zip", ".key", ".pem", ".p12", ".pfx"}
BLOCKED_DIRS = {"output", "selftest_audio", "__pycache__", "node_modules", "ffbuild", ".venv", "venv"}
BLOCKED_NAME_RE = re.compile(r"^(tts_(settings|voices).*\.json|\.gemini_key|selftest_report.*|\.env.*|Thumbs\.db|desktop\.ini|\.DS_Store)$", re.I)
ALLOWED_ROOT_FILES = set(MANAGED_FILES) | {".gitignore", "一鍵推送.bat", "LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE", "CONTRIBUTING.md",
                                          "CODE_OF_CONDUCT.md", "SECURITY.md", "CHANGELOG.md", "CITATION.cff", ".gitattributes"}
DOC_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".md"}
MAX_FILE_MB = 50
STATE_FILE = ROOT / ".git" / "deploy_state.json"
META_FILE = ROOT / ".github" / "repo-meta.json"        # 專案頁「About」說明 / 網站 / Topics 的定義 (跟著更新檔一起維護)
GITHUB_API = os.environ.get("TTS_GITHUB_API", "https://api.github.com")
TOPIC_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,49}$")


class DeployError(Exception):
    pass


# --------------------------------------------------------------------------- #
# git 小工具
# --------------------------------------------------------------------------- #
def git(*args: str, check: bool = True) -> str:
    r = subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=ROOT, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise DeployError(f"git {' '.join(args)} 失敗:\n{(r.stderr or r.stdout).strip()}")
    return (r.stdout or "").strip()


def git_live(*args: str) -> int:
    """不攔截輸出 (讓 Git Credential Manager 能跳出登入視窗/提示)"""
    return subprocess.run(["git", *args], cwd=ROOT).returncode


def confirm(prompt: str, default: bool = True, yes: bool = False) -> bool:
    if yes:
        return True
    d = "Y/n" if default else "y/N"
    s = input(f"{prompt} [{d}]: ").strip().lower()
    return default if not s else s in ("y", "yes", "是")


def parse_github(url: str):
    m = re.search(r"github\.com[:/]+([^/]+)/([^/]+?)(?:\.git)?/?$", url.strip())
    return (m.group(1), m.group(2)) if m else None


def ensure_environment() -> None:
    try:
        subprocess.run(["git", "--version"], capture_output=True, check=True)
    except Exception:
        raise DeployError("找不到 Git。請先安裝: winget install --id Git.Git -e  (裝完請重新開啟這個視窗)")
    if git("rev-parse", "--is-inside-work-tree", check=False) != "true":
        raise DeployError("這個資料夾還不是 Git 儲存庫。請先執行一次性設定: "
                          "git clone https://github.com/<帳號>/<儲存庫>.git  然後把這些檔案放進該資料夾 (見你的 SOP 文件)")
    if not git("remote", "get-url", "origin", check=False):
        raise DeployError("找不到遠端 origin。請用 git clone 取得的資料夾,或執行: git remote add origin <網址>")


def ensure_identity(yes: bool) -> None:
    if git("config", "user.email", check=False) and git("config", "user.name", check=False):
        return
    gh = parse_github(git("remote", "get-url", "origin"))
    owner = gh[0] if gh else "user"
    print("Git 還沒有設定提交者身分 (只需設定一次,只套用在這個資料夾)。")
    name = owner if yes else (input(f"名稱 [{owner}]: ").strip() or owner)
    mail_default = f"{owner}@users.noreply.github.com"
    mail = mail_default if yes else (input(f"Email [{mail_default}]: ").strip() or mail_default)
    git("config", "user.name", name)
    git("config", "user.email", mail)


# --------------------------------------------------------------------------- #
# 更新檔
# --------------------------------------------------------------------------- #
def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(st: dict) -> None:
    try:
        STATE_FILE.write_text(json.dumps(st, indent=2), encoding="utf-8")
    except Exception:
        pass


def find_latest_zip() -> Path | None:
    dirs = [Path.home() / "Downloads", ROOT, ROOT.parent, Path.cwd()]
    found: dict[Path, float] = {}
    for d in dirs:
        if d.is_dir():
            for f in d.glob("gemini-tts*.zip"):
                found[f.resolve()] = f.stat().st_mtime
    return max(found, key=found.get) if found else None


def sync_from_zip(zpath: Path) -> int:
    """把更新檔內容同步進儲存庫。回傳複製的檔案數。"""
    copied = 0
    with tempfile.TemporaryDirectory() as td:
        base = Path(td).resolve()
        with zipfile.ZipFile(zpath) as z:
            for m in z.namelist():                                   # 防止 zip-slip
                if not str((base / m).resolve()).startswith(str(base)):
                    raise DeployError(f"更新檔含有不安全的路徑: {m}")
            z.extractall(base)
        if not (base / "site" / "index.html").is_file():
            subs = [d for d in base.iterdir() if d.is_dir()]
            if len(subs) == 1 and (subs[0] / "site" / "index.html").is_file():
                base = subs[0]
            else:
                raise DeployError("更新檔裡找不到 site/index.html,這不是本專案的更新檔。")
        for d in MANAGED_DIRS:
            src = base / d
            if not src.is_dir():
                continue
            in_zip = set()
            for f in src.rglob("*"):
                if not f.is_file() or "__pycache__" in f.parts or f.suffix == ".pyc":
                    continue
                rel = f.relative_to(base)
                dst = ROOT / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dst)
                in_zip.add(rel.as_posix())
                copied += 1
            for tracked in git("ls-files", "--", d).splitlines():   # 只刪除「已追蹤」的舊檔,不碰本機資料
                if tracked not in in_zip:
                    (ROOT / tracked).unlink(missing_ok=True)
        for name in MANAGED_FILES:
            f = base / name
            if f.is_file():
                shutil.copy2(f, ROOT / name)
                copied += 1
    return copied


# --------------------------------------------------------------------------- #
# 安全檢查
# --------------------------------------------------------------------------- #
def is_dangerous(path: str) -> bool:
    """明確屬於「生成物/機密/本機資料」的檔案 (若已被追蹤,會自動從倉庫移除;本機檔案保留)"""
    p = PurePosixPath(path)
    if p.suffix.lower() in BLOCKED_SUFFIXES or BLOCKED_NAME_RE.match(p.name) or p.name in FORBIDDEN_NAMES:
        return True
    return any(part in BLOCKED_DIRS for part in p.parts) or ("site" == p.parts[0] and "vendor" in p.parts)


def is_allowed(path: str) -> bool:
    """只有專案本身的檔案可以推送"""
    p = PurePosixPath(path)
    if is_dangerous(path):
        return False
    if len(p.parts) == 1:
        return p.name in ALLOWED_ROOT_FILES
    top = p.parts[0]
    if top in ("site", ".github"):
        return True
    if top == "local":
        return len(p.parts) == 2 and p.suffix == ".py"
    if top == "docs":
        return p.suffix.lower() in DOC_SUFFIXES
    return False


def enforce_allowlist() -> tuple[list[str], list[str]]:
    """① 已被追蹤的危險檔案 (音檔、金鑰、報告…) 自動從倉庫移除 (本機保留);② 本次新增/修改但不屬於專案的檔案自動排除。
    回傳 (已從追蹤移除, 本次排除)"""
    untracked, excluded = [], []
    for f in git("ls-files").splitlines():
        if f and is_dangerous(f):
            git("rm", "--cached", "-q", "--", f)
            untracked.append(f)
    for f in git("diff", "--cached", "--name-only", "--diff-filter=AMRC").splitlines():
        if f and not is_allowed(f):
            git("reset", "-q", "--", f, check=False)
            excluded.append(f)
    return untracked, excluded


def untrack_private_files() -> list[str]:
    """把「不該在倉庫裡」的私人檔案從追蹤中移除 (git rm --cached,本機檔案保留;.gitignore 會防止再被加入)"""
    removed = []
    for f in UNTRACK_FILES:
        if git("ls-files", "--error-unmatch", "--", f, check=False):
            git("rm", "--cached", "-q", "--", f)
            removed.append(f)
    return removed


def scan_staged() -> list[str]:
    problems = []
    files = [f for f in git("diff", "--cached", "--name-only").splitlines() if f]
    for f in files:
        if Path(f).name in FORBIDDEN_NAMES:
            problems.append(f"{f}: 這是機密/本機檔案,不應該推送")
        p = ROOT / f
        if p.is_file() and p.stat().st_size > MAX_FILE_MB * 1024 * 1024:
            problems.append(f"{f}: 檔案超過 {MAX_FILE_MB} MB")
    cur = ""
    for line in git("diff", "--cached", "-U0", "--no-color").splitlines():
        if line.startswith("+++ "):
            cur = line[6:] if line.startswith("+++ b/") else line[4:]
        elif line.startswith("+") and not line.startswith("+++"):
            for pat, label in SECRET_PATTERNS:
                if pat.search(line):
                    problems.append(f"{cur}: 疑似含有 {label}")
    return sorted(set(problems))


# --------------------------------------------------------------------------- #
# GitHub Actions
# --------------------------------------------------------------------------- #
def gh(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "gemini-tts-deploy", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def pages_url(owner: str, repo: str) -> str:
    return f"https://{owner}.github.io/" + ("" if repo.lower() == f"{owner.lower()}.github.io" else f"{repo}/")


def print_failure_details(owner: str, repo: str, run_id: int) -> None:
    try:
        jobs = gh(f"https://api.github.com/repos/{owner}/{repo}/actions/runs/{run_id}/jobs").get("jobs", [])
        for job in jobs:
            if job.get("conclusion") == "success":
                continue
            print(f"\n  失敗的工作: {job.get('name')}")
            for step in job.get("steps", []):
                if step.get("conclusion") == "failure":
                    print(f"  失敗的步驟: {step.get('name')}")
            for a in gh(f"https://api.github.com/repos/{owner}/{repo}/check-runs/{job['id']}/annotations"):
                if a.get("annotation_level") == "failure":
                    print("  訊息:", (a.get("message") or "").replace("||", "\n        "))
    except Exception as e:
        print(f"  (無法自動取得失敗原因: {e})")


def wait_actions(owner: str, repo: str, sha: str, timeout: int = 900) -> bool | None:
    print("\n等待 GitHub Actions 開始部署 …")
    run, t0 = None, time.time()
    while time.time() - t0 < 90 and not run:
        try:
            runs = gh(f"https://api.github.com/repos/{owner}/{repo}/actions/runs?head_sha={sha}&per_page=5").get("workflow_runs", [])
            run = runs[0] if runs else None
        except Exception:
            pass
        if not run:
            time.sleep(4)
    if not run:
        print("(沒有找到對應的部署執行,請到 Actions 頁面確認)")
        return None
    print(f"部署執行: {run['html_url']}")
    last = ""
    while time.time() - t0 < timeout:
        try:
            run = gh(f"https://api.github.com/repos/{owner}/{repo}/actions/runs/{run['id']}")
        except Exception:
            time.sleep(5)
            continue
        if run["status"] != last:
            last = run["status"]
            print(f"  狀態: {last}")
        if run["status"] == "completed":
            break
        time.sleep(5)
    ok = run.get("conclusion") == "success"
    print("\n✅ 部署成功" if ok else f"\n❌ 部署失敗 ({run.get('conclusion') or '逾時'})")
    if not ok:
        print_failure_details(owner, repo, run["id"])
        print("\n把上面的「訊息」貼給 Claude 就能快速定位問題。")
    return ok


# --------------------------------------------------------------------------- #
# 專案頁資訊 (About 說明、網站連結、Topics) — 這些是儲存庫「設定」,不是檔案,需要透過 API 同步
# --------------------------------------------------------------------------- #
def load_meta(owner: str, repo: str) -> dict:
    try:
        data = json.loads(META_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        raise DeployError(f"無法讀取 {META_FILE.name}: {e}")
    desc = " ".join(str(data.get("description", "")).split())
    if len(desc) > 350:
        raise DeployError(f"repo-meta.json 的 description 超過 350 字 (目前 {len(desc)})")
    home = str(data.get("homepage", "auto")).strip()
    if home == "auto":
        home = pages_url(owner, repo)
    topics: list[str] = []
    for t in data.get("topics", []):
        t = str(t).strip().lower()
        if not TOPIC_RE.fullmatch(t):
            raise DeployError(f"repo-meta.json 的 topic 不合法: {t!r} (只能是小寫英數與連字號,最長 50 字)")
        if t not in topics:
            topics.append(t)
    if len(topics) > 20:
        raise DeployError("repo-meta.json 的 topics 最多 20 個")
    return {"description": desc, "homepage": home, "topics": topics}


def get_token() -> str:
    """優先用環境變數 GH_TOKEN / GITHUB_TOKEN;否則向 Git Credential Manager 取得你推送時用的同一組登入憑證 (不會顯示或儲存)"""
    for k in ("GH_TOKEN", "GITHUB_TOKEN"):
        if os.environ.get(k):
            return os.environ[k].strip()
    try:
        r = subprocess.run(["git", "credential", "fill"], cwd=ROOT, input="protocol=https\nhost=github.com\n\n",
                           capture_output=True, text=True, timeout=25,
                           env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"})
        for line in r.stdout.splitlines():
            if line.startswith("password="):
                return line[len("password="):].strip()
    except Exception:
        pass
    return ""


def gh_api(method: str, path: str, token: str, body: dict | None = None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(GITHUB_API + path, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "gemini-tts-deploy",
        "X-GitHub-Api-Version": "2022-11-28", **({"Content-Type": "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read().decode("utf-8")
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"message": f"{type(e).__name__}: {e}"}


def sync_repo_meta(owner: str, repo: str) -> bool:
    """把 .github/repo-meta.json 的內容同步到 GitHub 專案頁。內容相同就不會有任何寫入。失敗只警告,不影響推送。"""
    if not META_FILE.is_file():
        print("(沒有 .github/repo-meta.json,略過專案頁資訊同步)")
        return False
    meta = load_meta(owner, repo)
    token = get_token()
    hint = "請改到 GitHub 專案頁右側 About 區塊的齒輪圖示手動編輯,或設定環境變數 GH_TOKEN(需有 repo 權限)後執行 python deploy.py --meta"
    if not token:
        print(f"\n[!] 取不到 GitHub 憑證,略過專案頁資訊同步。{hint}")
        return False
    base = f"/repos/{owner}/{repo}"
    st, cur = gh_api("GET", base, token)
    if st != 200:
        print(f"\n[!] 無法讀取專案資訊 (HTTP {st} {cur.get('message', '')})。{hint}")
        return False
    done, ok = [], True
    if (cur.get("description") or "") != meta["description"] or (cur.get("homepage") or "") != meta["homepage"]:
        st, r = gh_api("PATCH", base, token, {"description": meta["description"], "homepage": meta["homepage"]})
        if st == 200:
            done.append("說明 / 網站連結")
        else:
            ok = False
            print(f"\n[!] 更新說明/網站連結失敗 (HTTP {st} {r.get('message', '')})。{hint}")
    st, cur_t = gh_api("GET", base + "/topics", token)
    if st == 200 and sorted(cur_t.get("names", [])) != sorted(meta["topics"]):
        st, r = gh_api("PUT", base + "/topics", token, {"names": meta["topics"]})
        if st == 200:
            done.append(f"Topics ({len(meta['topics'])} 個)")
        else:
            ok = False
            print(f"\n[!] 更新 Topics 失敗 (HTTP {st} {r.get('message', '')})。{hint}")
    print(f"\n專案頁資訊已更新: {'、'.join(done)}" if done else ("\n專案頁資訊已是最新 (說明 / 網站 / Topics)" if ok else ""))
    return ok


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def push_and_report(args, owner_repo) -> None:
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    print("\n推送到 GitHub …  (第一次可能會跳出瀏覽器要求登入 GitHub,請依指示授權)")
    if git_live("push", "-u", "origin", branch) != 0:
        raise DeployError("推送失敗。常見原因: 尚未登入 GitHub / 沒有這個儲存庫的寫入權限 / 網路問題 (見你的 SOP 文件的疑難排解)")
    sha = git("rev-parse", "HEAD")
    print(f"已推送 {sha[:7]}")
    if not owner_repo:
        return
    owner, repo = owner_repo
    print(f"Actions : https://github.com/{owner}/{repo}/actions")
    print(f"網站    : {pages_url(owner, repo)}")
    if not args.no_meta:
        try:
            sync_repo_meta(owner, repo)
        except DeployError as e:
            print(f"\n[!] 專案頁資訊同步略過: {e}")
    ok = None if args.no_wait else wait_actions(owner, repo, sha)
    if ok and not args.no_open:
        webbrowser.open(pages_url(owner, repo))
    elif ok is None and not args.no_open:
        webbrowser.open(f"https://github.com/{owner}/{repo}/actions")


def main() -> int:
    ap = argparse.ArgumentParser(description="一鍵推送更新到 GitHub")
    ap.add_argument("zip", nargs="?", help="更新檔 zip (省略則自動尋找 Downloads 內最新的 gemini-tts*.zip)")
    ap.add_argument("-m", "--message", help="提交訊息")
    ap.add_argument("--rollback", action="store_true", help="回復上一次提交並推送")
    ap.add_argument("--status", action="store_true", help="只查看最近一次部署狀態")
    ap.add_argument("--yes", action="store_true", help="全部自動確認")
    ap.add_argument("--no-wait", action="store_true", help="推送後不等待部署結果")
    ap.add_argument("--no-open", action="store_true", help="不自動開啟瀏覽器")
    ap.add_argument("--meta", action="store_true", help="只同步專案頁資訊 (About 說明 / 網站 / Topics),不推送程式")
    ap.add_argument("--no-meta", action="store_true", help="這次推送不同步專案頁資訊")
    args = ap.parse_args()

    print("=== 一鍵推送 ===")
    ensure_environment()
    owner_repo = parse_github(git("remote", "get-url", "origin"))
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    if branch == "HEAD":
        raise DeployError("目前處於分離 HEAD 狀態,請先切換到 main: git switch main")

    if args.status:
        if not owner_repo:
            raise DeployError("遠端不是 GitHub,無法查詢狀態")
        runs = gh(f"https://api.github.com/repos/{owner_repo[0]}/{owner_repo[1]}/actions/runs?per_page=3").get("workflow_runs", [])
        for r in runs:
            print(f"  {r['created_at']}  {r['status']}/{r.get('conclusion')}  {r['head_commit']['message'].splitlines()[0][:50]}  {r['html_url']}")
        print(f"網站: {pages_url(*owner_repo)}")
        return 0

    if args.meta:
        if not owner_repo:
            raise DeployError("遠端不是 GitHub,無法同步專案頁資訊")
        return 0 if sync_repo_meta(*owner_repo) else 1

    ensure_identity(args.yes)

    # 先同步遠端 (避免你曾在 GitHub 網頁上直接改過檔案造成衝突)
    if git("ls-remote", "--heads", "origin", branch, check=False):
        print("同步遠端最新內容 …")
        if git_live("pull", "--rebase", "--autostash", "origin", branch) != 0:
            git("rebase", "--abort", check=False)
            raise DeployError("同步遠端失敗 (可能有衝突)。請把上面的訊息貼給 Claude,或參考你的 SOP 文件「疑難排解」一節。")

    if args.rollback:
        last = git("log", "-1", "--pretty=%h %s")
        if not confirm(f"要回復這次提交嗎?\n  {last}", False, args.yes):
            print("已取消。")
            return 0
        git("revert", "--no-edit", "HEAD")
        push_and_report(args, owner_repo)
        return 0

    state = load_state()
    zpath = Path(args.zip.strip('"')).resolve() if args.zip else find_latest_zip()
    if zpath and not zpath.is_file():
        raise DeployError(f"找不到更新檔: {zpath}")
    msg_src = ""
    if zpath:
        digest = sha256(zpath)
        age = (time.time() - zpath.stat().st_mtime) / 3600
        print(f"更新檔: {zpath}  ({datetime.fromtimestamp(zpath.stat().st_mtime):%Y-%m-%d %H:%M}, {age:.1f} 小時前)")
        if state.get("last_zip_sha") == digest:
            print("  這個更新檔已經推送過了,略過同步。(只處理資料夾裡手動修改的內容)")
            zpath = None
        elif confirm("要用這個更新檔同步並推送嗎?", True, args.yes):
            print(f"同步 {sync_from_zip(zpath)} 個檔案 …")
            msg_src = f" (from {zpath.name})"
            state["pending_sha"] = digest
        else:
            zpath = None
    else:
        print("沒有找到更新檔,只處理資料夾裡手動修改的內容。")

    for f in untrack_private_files():
        print(f"已從儲存庫移除 {f}（只移除追蹤，你電腦上的檔案保留；之後不會再被推送）")
    git("add", "-A")
    untracked, excluded = enforce_allowlist()
    if untracked:
        print("\n已從儲存庫移除這些不該公開的檔案 (只移除追蹤,你電腦上的檔案保留):\n  - " + "\n  - ".join(untracked[:20]) + (f"\n  …共 {len(untracked)} 個" if len(untracked) > 20 else ""))
    if excluded:
        print(f"\n已自動排除 {len(excluded)} 個不屬於專案的檔案 (不會上傳):\n  - " + "\n  - ".join(excluded[:20]) + (f"\n  …共 {len(excluded)} 個" if len(excluded) > 20 else ""))
    problems = scan_staged()
    if problems:
        git("reset", "-q", check=False)
        raise DeployError("偵測到可能的機密或不該推送的檔案,已中止 (沒有任何東西被提交):\n  - " + "\n  - ".join(problems))
    if not git("status", "--porcelain"):
        print("\n沒有任何變更,不需要推送。")
        if state.get("pending_sha"):
            state["last_zip_sha"] = state.pop("pending_sha")
            save_state(state)
        return 0

    print("\n即將提交的變更:")
    print(git("diff", "--cached", "--stat", "--stat-width=100"))
    if not confirm("確認提交並推送?", True, args.yes):
        git("reset", "-q", check=False)
        print("已取消 (變更保留在資料夾內,尚未提交)。")
        return 0
    message = args.message or f"update: {datetime.now():%Y-%m-%d %H:%M}{msg_src}"
    git("commit", "-q", "-m", message)
    if state.get("pending_sha"):
        state["last_zip_sha"] = state.pop("pending_sha")
        save_state(state)
    push_and_report(args, owner_repo)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except DeployError as e:
        print(f"\n[X] {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n已中斷。")
        sys.exit(130)
