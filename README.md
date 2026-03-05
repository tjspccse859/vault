# 🔐 Private Digital Vault v5

A self-hosted private cloud storage platform with **file selling**, image previews, real-time sync, and a full admin dashboard.

---

## ✨ Features

### For Users
- 🔐 **Google Sign-In** — secure OAuth2 authentication
- 📁 **Browse & Download** files shared with them
- 🛒 **Buy Files** — purchase paid files and download instantly
- 🖼️ **Image Preview** — view images in a lightbox without downloading
- ⭐ **Star Files** — bookmark favourites
- 🕒 **Recent Files** — quick access to latest uploads
- 🛍️ **My Purchases** — view all purchased files and re-download anytime

### For Admins
- ⬆️ **Upload Files** — any type, up to 2 GB each, drag & drop
- 💲 **Set Prices** — mark files as Free or set a $ price
- ✏️ **Rename Files & Folders** — right-click or button
- 📂 **Folder Management** — create, rename, nest folders
- 🔑 **Access Control** — grant file/folder access per email address
- 💰 **All Sales** — see every purchase with buyer email, amount, download count
- 👥 **Users Table** — full list with email, Google ID, purchases, spending, online status
- 📊 **Analytics** — revenue, uploads, downloads, storage, 7-day charts
- 📋 **Activity Log** — full audit trail of every action
- 🗑️ **Trash** — soft delete with restore and permanent delete
- ⚡ **Real-time** — live file updates via Socket.io

---

## 🚀 Quick Start

### 1. Install

```bash
git clone <your-repo>
cd vault_enhanced
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` with your values — see [Configuration](#configuration) below.

### 3. Run

```bash
node server.js
```

Open [http://localhost:3000](http://localhost:3000)

---

## ⚙️ Configuration

All config is done via the `.env` file. Copy `.env.example` to get started.

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port to listen on (default: `3000`) |
| `BASE_URL` | Yes | Full public URL e.g. `https://yourapp.render.com` |
| `SESSION_SECRET` | Yes | Long random string for session security |
| `ADMIN_PASSWORD` | Yes | Password for `/admin` login page |
| `ADMIN_EMAILS` | No | Comma-separated emails auto-granted admin |
| `GOOGLE_CLIENT_ID` | Yes | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Yes | From Google Cloud Console |
| `R2_ACCOUNT_ID` | No | Cloudflare R2 account ID |
| `R2_ACCESS_KEY_ID` | No | Cloudflare R2 access key |
| `R2_SECRET_ACCESS_KEY` | No | Cloudflare R2 secret key |
| `R2_BUCKET_NAME` | No | Cloudflare R2 bucket name |

> **Tip:** Generate a secure session secret:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## 🔑 Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a new project (or use existing)
3. Enable the **Google+ API** / **People API**
4. Create **OAuth 2.0 Client ID** → Web application
5. Add Authorised redirect URI:
   ```
   http://localhost:3000/auth/google/callback
   ```
   *(replace with your live URL when deploying)*
6. Copy **Client ID** and **Client Secret** into `.env`

---

## ☁️ File Storage

### Local Disk (default)
Files are stored in the `uploads/` folder. Simple, no setup needed.

⚠️ **Warning:** Local storage does NOT persist on most free hosting platforms (Render, Railway, Fly.io). Files will be lost on redeploy. Use R2 for production.

### Cloudflare R2 (recommended for production)
Free tier: **10 GB storage, zero egress fees**

1. Sign up at [cloudflare.com](https://cloudflare.com)
2. Go to **R2 → Create Bucket**
3. Go to **Manage R2 API Tokens** → Create token with R2 edit permissions
4. Fill in all `R2_*` variables in `.env`

---

## 🌐 Free Hosting Options

### Render *(easiest)*
1. Push to GitHub
2. [render.com](https://render.com) → New Web Service → connect repo
3. Build: `npm install` · Start: `node server.js`
4. Add `.env` variables under **Environment**

> Keep it awake: Add a [UptimeRobot](https://uptimerobot.com) monitor pointing to `https://yourapp.render.com/ping` every 5 minutes.

### Railway
1. [railway.app](https://railway.app) → New Project → GitHub repo
2. Add environment variables
3. Auto-deploys on push · $5 free credit/month

### Fly.io
```bash
npm install -g flyctl
flyctl auth login
flyctl launch
flyctl secrets set SESSION_SECRET=xxx ADMIN_PASSWORD=xxx GOOGLE_CLIENT_ID=xxx ...
flyctl deploy
```

### Oracle Cloud *(free forever, persistent storage)*
1. Sign up at [oracle.com/cloud/free](https://oracle.com/cloud/free)
2. Create an **Ampere ARM** VM (4 CPU / 24 GB RAM — always free)
3. SSH in:
```bash
git clone <your-repo> && cd vault_enhanced
npm install
cp .env.example .env && nano .env
npm install -g pm2
pm2 start server.js --name vault
pm2 save && pm2 startup
```

---

## 📁 Project Structure

```
vault_enhanced/
├── server.js          # Express backend + all API routes
├── package.json       # Dependencies
├── .env.example       # Environment variable template
├── .env               # Your config (never commit this!)
├── public/
│   ├── index.html     # Full single-page frontend (HTML + CSS + JS)
│   └── favicon.png
├── data/
│   └── db.json        # LowDB JSON database (auto-created)
└── uploads/           # Local file storage (auto-created)
```

---

## 🛣️ API Routes

### Auth
| Method | Route | Description |
|---|---|---|
| GET | `/auth/google` | Start Google OAuth |
| GET | `/auth/google/callback` | OAuth callback |
| POST | `/auth/logout` | Sign out |
| POST | `/auth/admin-password` | Admin password login |
| GET | `/api/me` | Current user info |

### Files
| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/files` | User | List files |
| POST | `/api/files` | Admin | Upload file (multipart) |
| PATCH | `/api/files/:id` | Admin | Rename / move / update price |
| PUT | `/api/files/:id/permissions` | Admin | Set allowed emails |
| DELETE | `/api/files/:id` | Admin | Move to trash |
| GET | `/download/:id` | User | Download file |
| GET | `/preview/:id` | User | Stream image preview |

### Purchases
| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/files/:id/buy` | User | Purchase a file |
| GET | `/api/my-purchases` | User | Own purchase list |
| GET | `/api/purchases` | Admin | All purchases |
| DELETE | `/api/purchases/:id` | Admin | Revoke a purchase |

### Admin
| Method | Route | Description |
|---|---|---|
| GET | `/api/folders` | List folders |
| POST | `/api/folders` | Create folder |
| PUT | `/api/folders/:id` | Update folder |
| DELETE | `/api/folders/:id` | Trash folder |
| GET | `/api/users` | All users with emails |
| GET | `/api/activity` | Activity log |
| GET | `/api/analytics` | Analytics data |
| GET | `/api/trash` | Trash contents |
| GET | `/ping` | Health check |

---

## 💡 Tips

- **First run:** Go to `/admin` and log in with your `ADMIN_PASSWORD` to set up folders and upload files
- **Payment:** The buy system is a simulation — integrate [Stripe](https://stripe.com) or [Razorpay](https://razorpay.com) into the `/api/files/:id/buy` route to collect real payments
- **Backup:** Regularly back up `data/db.json` (your database) and the `uploads/` folder
- **HTTPS:** Always use HTTPS in production — all free hosting platforms provide this automatically

---

## 🛠️ Built With

- **[Express](https://expressjs.com)** — web server
- **[Socket.io](https://socket.io)** — real-time updates
- **[Passport.js](https://passportjs.org)** — Google OAuth
- **[Multer](https://github.com/expressjs/multer)** — file uploads
- **[LowDB](https://github.com/typicode/lowdb)** — JSON database
- **[AWS SDK v3](https://github.com/aws/aws-sdk-js-v3)** — Cloudflare R2 / S3 storage

---

## 📄 License

MIT — free to use, modify, and deploy.
