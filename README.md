# 長庚科技大學校車查詢系統
## CGUST Bus Query System

---

## 專案結構

```
cgust-bus/
├── api/
│   ├── tdx-token.js      # TDX Token 取得 Proxy
│   └── tdx-bus.js        # TDX 公車到站查詢 Proxy
├── public/
│   ├── index.html        # 查詢介面（前台）
│   ├── admin-cgu2024.html # 管理後台
│   └── logo.png          # 學校 LOGO 
├── .gitignore
├── package.json
├── vercel.json
└── README.md
```

---

## 部署步驟（Vercel）

### 步驟一：申請 GitHub 帳號
1. 前往 https://github.com 註冊免費帳號
2. 登入後點右上角 **+** → **New repository**
3. Repository name 填入 `cgust-bus`
4. 選 **Private**（私有，保護程式碼）
5. 點 **Create repository**

### 步驟二：上傳專案檔案
1. 在新建的 Repository 頁面，點 **uploading an existing file**
2. 將整個 `cgust-bus` 資料夾內的所有檔案拖曳上傳
   - 注意：需保留資料夾結構（api/ 和 public/ 子資料夾）
3. 點 **Commit changes**

### 步驟三：申請 Vercel 帳號並部署
1. 前往 https://vercel.com 點 **Sign Up**
2. 選擇 **Continue with GitHub**（用 GitHub 帳號登入，最方便）
3. 登入後點 **Add New Project**
4. 找到 `cgust-bus` 並點 **Import**
5. 設定保持預設，直接點 **Deploy**
6. 等待約 1 分鐘，看到 **Congratulations** 即部署成功

### 步驟四：設定 TDX API 金鑰（環境變數）
**這步驟讓 TDX 金鑰安全存在伺服器，不會暴露在程式碼中**

1. 在 Vercel 專案頁面，點上方 **Settings**
2. 左側選 **Environment Variables**
3. 新增以下三個變數：

| Name | Value |
|------|-------|
| `TDX_CLIENT_ID` | 您的 TDX Client ID |
| `TDX_CLIENT_SECRET` | 您的 TDX Client Secret |
| `ALLOWED_ORIGIN` | `https://cgust-bus.vercel.app`（部署後的網址）|

4. 每個變數填完後點 **Save**
5. 回到 **Deployments** 頁面，點最新部署右側的 **⋯** → **Redeploy**

### 步驟五：啟用 TDX 真實資料
1. 開啟 `public/index.html`
2. 找到這一行：
   ```javascript
   ENABLED: false  // ← 改為 true
   ```
3. 改為 `true` 後存檔，重新上傳並 redeploy

### 步驟六：確認上線網址
部署成功後，Vercel 會給您一個網址，例如：
```
https://cgust-bus.vercel.app
```
管理後台：
```
https://cgust-bus.vercel.app/admin-cgu2024.html
```

---

## 嵌入學校網站（R-page 自定模組）

在學校 R-page 後台的「自定模組」中貼入以下 HTML：

```html
<iframe
  src="https://cgust-bus.vercel.app"
  width="100%"
  height="720"
  frameborder="0"
  style="border:none;border-radius:12px;"
  title="長庚科技大學校車查詢"
  loading="lazy">
</iframe>
```

---

## 日後更新班表

1. 登入管理後台 `/admin-cgu2024.html`
2. 在「CSV 匯入/匯出」頁面匯出現有班表
3. 用 Excel 修改後存成 CSV
4. 重新匯入即可

---

## 預設管理員帳號
- 帳號：`admin`
- 密碼：`cgu2024`
- **請在首次登入後立即至「變更密碼」修改！**

---

## 安全性注意事項
- TDX 金鑰僅存在 Vercel 環境變數，不在任何程式碼中
- 管理後台網址含隨機字串，不易被猜測
- 帳號連續錯誤 5 次將鎖定 15 分鐘
- 閒置 30 分鐘自動登出
