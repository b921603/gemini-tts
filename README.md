<div align="center">

# Gemini TTS

**語音生成工具：手機與電腦都能用 · 音色克隆 · 多人對話 · MP3 / FLAC / Opus 輸出**

網頁版（Android PWA）＋ Windows 本機圖形介面，使用 Google **Gemini 文字轉語音（TTS）** API。**自動偵測並使用你帳戶可用的最新語音模型，不綁定特定版本。**

[**▶ 線上使用**](https://b921603.github.io/gemini-tts/) · [English](README.en.md)

<img src="docs/img/01-main.png" width="240" alt="主畫面"> <img src="docs/img/02-voice-picker.png" width="240" alt="人聲選擇與試聽"> <img src="docs/img/03-voice-clone.png" width="240" alt="音色克隆精靈">

</div>

## 特色

- **自動使用最新模型**：向 Google 取得你帳戶可用的模型清單，預設自動挑選最新世代的語音（TTS）模型；新一代模型上線後不需要更新程式。也能手動指定或輸入任何模型 ID。
- **看得見的進度**：生成時顯示四個階段（已送出 → Google 處理中 → 接收音訊 → 處理／存檔），並用官方串流顯示「已生成 N 秒音訊」與預估剩餘時間（官方不提供百分比，預估僅供參考）；不支援串流時自動退回一般模式。
- **省額度試聽**：▶ 試聽只合成**一句短範例**（約 2–3 秒），結果快取在你的裝置，同一聲音再聽不會再消耗額度；聲音設計建立的聲音直接使用官方範例音訊。
- **最近生成**：網頁版把音檔保留在你的瀏覽器（IndexedDB，不會上傳；最多 50 筆／200 MB），重新整理或關閉再開都還在，可播放、下載、分享、刪除；本機版則存在輸出資料夾。
- **兩種用法，同一套介面**：網頁版可安裝到 Android 主畫面；本機版是 Windows 應用程式視窗，使用原生 ffmpeg、自動存檔。
- **人聲**：直接輸入名稱／ID、線上清單（可篩選語言／性別／音高）、內建 30 種；每個都能 ▶ **試聽**。
- **單人旁白／多人對話**：`名稱[語氣]: 內容`，超過 2 位講者或使用自訂人聲時自動逐段合成。
- **音色克隆（Voice replication）**：錄音或上傳 → 同意聲明驗證 → 建立 `voice_…`（保留 1 年）或不儲存的 `voicekey_…`（7 天，自行保管）。
- **輸出格式**：WAV、PCM、μ-law、A-law、**MP3、FLAC、OGG、Opus、M4A**；取樣率、位元率、響度標準化、變速。
- **批次模式**、長文自動分段、語氣控制（style）、`<short pause>` `<laugh>` 等標籤快速插入。
- **你的 API Key 自己保管**：網頁版只存在你的瀏覽器；本機版可用環境變數。不經過任何第三方伺服器。

## 快速開始

**網頁版**：開啟 <https://b921603.github.io/gemini-tts/> → 貼上你自己的 [Gemini API Key](https://aistudio.google.com/apikey) → 輸入文本 → 生成。
Android Chrome：選單 →「安裝應用程式」。

**本機版（Windows）**：安裝 [Python 3.10+](https://www.python.org/downloads/)，下載專案後雙擊 `啟動圖形介面.bat`
（命令列版：`啟動命令列.bat`）。

| | 網頁版 | 本機版 |
|---|---|---|
| 介面 | 瀏覽器／手機 PWA | Chrome（優先）或 Edge 的應用程式視窗 |
| ffmpeg | ffmpeg.wasm（首次下載約 31 MB） | 電腦上的原生 ffmpeg（可一鍵安裝） |
| 儲存 | 下載／分享到其他 App | 自動存入輸出資料夾＋最近生成清單 |
| 呼叫 Gemini | 瀏覽器直接呼叫 | 經本機服務轉送 |

<img src="docs/img/04-local-gui.png" width="520" alt="本機圖形介面">

## 音色克隆

人聲選單 →「我的克隆」→「建立新的克隆聲音」：選同意聲明語言（官方 30 種；中文只有簡體 `zh-CN`，請以國語朗讀）→
錄製或上傳 **10–30 秒**參考音訊 → 錄製或上傳**同意錄音** → 選儲存方式 → 建立。

只能複製**你本人**或已取得**明確同意的成年人**的聲音；Google 會驗證兩段錄音是否為同一人。

## 專案結構

```
site/        網頁版（部署到 GitHub Pages）
local/       本機版：tts_gui.py（圖形介面）、tts.py（命令列）、selftest.py（用你的金鑰實機檢測 API 行為，報告自動遮蔽金鑰）
docs/        README 截圖與社群預覽圖
.github/     自動部署流程、專案頁資訊定義（repo-meta.json）
deploy.py    維護者用的一鍵推送工具
```

## 模型自動選擇

輸入 API Key 後，工具會呼叫 Google 的模型清單 API（`models.list`），列出名稱含 `tts` 的語音模型，並依「世代越新越優先 → 正式版優先於 preview → flash（均衡）優先於 pro、lite」自動推薦。
預設選項「自動」會在每次生成時使用目前最新的語音模型；你也可以固定選某個版本，或輸入任何模型 ID。
無法連線時會使用上次取得的清單；若新世代的命名不含 `tts`，可在「進階選項」勾選「顯示全部模型」。

## 常見問題

**這是什麼？** 一個使用 Gemini 文字轉語音（text-to-speech, TTS）API 的免費工具，可在手機瀏覽器或 Windows 上生成語音檔，支援音色克隆與多人對話。

**費用？** 工具本身免費；呼叫 Gemini API 的費用由你的 API Key 帳戶負擔，請見 [Gemini API 定價](https://ai.google.dev/gemini-api/docs/pricing)。

**我的金鑰安全嗎？** 網頁版金鑰只存在你自己的瀏覽器；本機版存於 `local/.gemini_key`（已被 `.gitignore` 排除，推送前也會自動掃描）。建議在 Google AI Studio 為金鑰設定用量上限。

**支援哪些語言？** 介面為繁體中文；語音生成語言由 Gemini TTS 模型決定（可自動偵測輸入語言）。

## 安全設計（本機版）

服務只綁定 `127.0.0.1`，驗證 Host 標頭與隨機 token，拒絕跨來源請求；Gemini 轉送只開放 `/interactions` 與 `/voices`；
ffmpeg 參數採白名單；檔案存取限制在輸出資料夾內。

---

<sub>關鍵字：Gemini TTS、Gemini Flash TTS、文字轉語音、語音合成、音色克隆、聲音克隆、多人對話、Android PWA、ffmpeg.wasm、GitHub Pages、繁體中文。
本專案為非官方社群工具，與 Google 無隸屬關係。</sub>
