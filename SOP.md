# SOP：一鍵推送更新到 GitHub（Windows 11）

> 目標：之後每次拿到新的更新檔（`gemini-tts.zip`），**雙擊一個檔案就完成：同步 → 提交 → 推送 → 等待網站部署 → 打開網站**。
> 專案資料夾本身就是 GitHub 儲存庫的本機副本，所以**網站（site/）和本機工具（local/）會一起更新**。

---

## 一、一次性設定（只做一次，約 10 分鐘）

1. **安裝 Git 與 Python**（已安裝可跳過）。在 PowerShell 執行：
   ```powershell
   winget install --id Git.Git -e
   winget install Python.Python.3.12
   ```
   裝完請**關掉 PowerShell 再重開**。
2. **把儲存庫抓到本機**（路徑自己決定，例如 `D:\`）：
   ```powershell
   cd D:\
   git clone https://github.com/b921603/gemini-tts.git
   ```
   會得到資料夾 `D:\gemini-tts`。
3. **放入專案檔**：解壓 `gemini-tts.zip`，把裡面**所有內容**複製到 `D:\gemini-tts`，遇到同名檔案選「取代」。
   完成後資料夾內應該看得到：`site`、`local`、`.github`、`deploy.py`、`一鍵推送.bat`、`啟動圖形介面.bat`…
4. **雙擊 `一鍵推送.bat`**。
   - 第一次推送會**自動跳出瀏覽器要求登入 GitHub**（Git Credential Manager），用 `b921603` 帳號登入並授權即可，之後不會再問。
   - 提示確認時按 **Enter**（預設就是「是」）。
5. 等到畫面出現 `✅ 部署成功`，網站會自動開啟：`https://b921603.github.io/gemini-tts/`

---

## 二、日常更新（每次都一樣，3 步）

1. 從對話下載最新的 `gemini-tts.zip`（放在「下載」資料夾即可）。
2. **雙擊 `一鍵推送.bat`**（或把 zip 直接**拖曳到它上面**）。
3. 看到更新檔路徑與變更清單，連按兩次 **Enter** 確認。

之後它會自動：同步遠端 → 套用更新檔（含刪除已不存在的舊檔）→ **檢查是否夾帶金鑰** → 提交 → 推送 → 等待 GitHub Actions → 成功就開啟網站。

> 想完全免確認：用 PowerShell 在資料夾內執行 `python deploy.py --yes`。

### 指令速查

| 目的 | 指令（在專案資料夾內） |
|---|---|
| 一般更新 | 雙擊 `一鍵推送.bat` |
| 指定更新檔 | `python deploy.py "C:\路徑\gemini-tts.zip"` |
| 自訂提交訊息 | `python deploy.py -m "修正克隆聲音"` |
| **回復上一次推送** | `python deploy.py --rollback`（用 revert，不會改寫歷史，可再回復） |
| 查看最近部署狀態 | `python deploy.py --status` |
| 不等部署結果 | 加上 `--no-wait` |

---

## 三、安全機制（自動，不用你做任何事）

- `.gitignore` 已排除：`local/tts_settings.json`、`local/tts_voices.json`（克隆金鑰）、`local/.gemini_key`、`local/output/`、`*.zip`。這些**只會留在你的電腦**。
- 推送前會掃描：若變更內容含 `AIza…`（Google API Key）或 `voicekey_…`，或夾帶上述機密檔，**整個流程會中止，什麼都不會被提交**。
- 本機資料夾裡的設置、金鑰、輸出音檔，**不會被更新檔覆蓋或刪除**。

---

## 四、疑難排解

| 畫面訊息 | 原因 / 處理 |
|---|---|
| 找不到 Git / 找不到 Python | 依第一節安裝後，**重新開啟**視窗再試 |
| 推送失敗（登入 / 權限） | 確認用 `b921603` 登入；沒跳出登入視窗時執行 `git credential-manager github login`；也可先執行 `git config --global credential.helper manager` |
| 同步遠端失敗（可能有衝突） | 通常是你在 GitHub 網頁上改過同一個檔案。把畫面訊息貼給 Claude；最後手段：重新 `git clone` 到新資料夾，再從第一節第 3 步做起 |
| 偵測到可能的機密 | 依訊息指出的檔案，刪掉金鑰字串後重新更新（不要把金鑰寫進程式或 README） |
| ❌ 部署失敗 | 畫面會直接印出「失敗的步驟」與「訊息」，**整段貼給 Claude** 即可定位 |
| 網站沒變 | 電腦：Ctrl + F5。Android：完全關閉 App 後再開兩次（程式為「網路優先」，會自動取得新版） |
| 想看每次推送做了什麼 | `https://github.com/b921603/gemini-tts/commits/main` |

---

## 五、本機工具

- **圖形介面**：雙擊 `啟動圖形介面.bat`，會開出和網頁版同一套介面的應用程式視窗（原生 ffmpeg、自動存檔、最近生成清單）。關閉視窗後程式自動結束。
- **使用哪個瀏覽器開啟**：預設優先 **Chrome**，找不到才用 Edge。可在視窗「進階選項 → 本機工具 → 開啟本機視窗使用的瀏覽器」改成 Chrome / Edge / 系統預設（下次啟動生效），或用指令 `啟動圖形介面.bat --browser edge`。
- **命令列**：雙擊 `啟動命令列.bat`，或 `python local\tts.py`（`--gui` 開圖形介面、`--clone` 管理克隆聲音）。
- 兩者共用同一份設置（`local\tts_settings.json`）與克隆金鑰庫（`local\tts_voices.json`）。
- 沒有 ffmpeg 時，圖形介面「進階選項 → 本機工具」有一鍵安裝按鈕（winget）。
- API Key：可設定環境變數 `GEMINI_API_KEY`，或在視窗中貼上並勾「記住」（存成 `local\.gemini_key`，不會被推送）。

---

## 六、專案介紹與搜尋曝光（也是一鍵維護）

GitHub 專案頁的內容分兩類，**這套流程都會處理**：

| 內容 | 在哪裡定義 | 怎麼更新 |
|---|---|---|
| 說明文件：`README.md`（中文）、`README.en.md`（英文）、`SOP.md`、截圖 `docs/img/*` | 專案檔案本身 | 跟著更新檔，**推送時自動更新** |
| 專案頁 **About 說明、網站連結、Topics（搜尋標籤）** | `.github/repo-meta.json` | 推送後**自動同步到 GitHub**；內容相同就不動作；只想同步這個：`python deploy.py --meta` |

- `repo-meta.json` 是唯一準則：GitHub 網頁上手動改的 About / Topics，下次推送會被還原成這個檔案的內容。想改介紹，就請 Claude 更新這個檔案（或自己編輯它的 `description` 與 `topics`），再照第二節推送。
- 同步用的是你推送時已登入的同一組 GitHub 憑證，不需要另外設定。若出現「權限不足」警告，不影響推送，可：①到專案頁右側 About 區塊的齒輪圖示手動貼上；或 ②設定環境變數 `GH_TOKEN`（需 repo 權限）後執行 `python deploy.py --meta`。
- 限制：`description` 最多 350 字；topics 最多 20 個，只能是小寫英數與連字號。

### 需要你手動做一次的（GitHub 沒有提供自動化）

1. **社群預覽圖**（別人分享連結時顯示的大圖）：專案頁 → **Settings → General → Social preview → Edit → Upload an image**，選 `docs/social-preview.png`。
2. **授權條款（License）**：沒有授權條款時，別人法律上不能自由使用或散布你的程式。想開放給同好請選一個（例如 MIT 或 Apache-2.0），專案頁 → **Add file → Create new file**，檔名輸入 `LICENSE`，右側會出現 **Choose a license template**。這是你的決定，我不代選。
3. 確認 **Settings → Pages → Source** 是 **GitHub Actions**（部署用，做過就不用再做）。

### 提升被搜尋到的機會（建議）

- 邀請同好給專案按 ⭐（Star）；GitHub 搜尋與 Topics 頁面會依此排序。
- 把線上網址放在 README、社群貼文與影片說明中。
- 想讓更多人看到：把專案貼到相關社群時，附上 `docs/img/` 的截圖。
