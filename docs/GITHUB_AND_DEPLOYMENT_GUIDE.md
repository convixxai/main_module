# Convixx: GitHub Setup & AWS Deployment Guide

Complete step-by-step guide for pushing code to GitHub and deploying the Convixx backend on your AWS server. Written for beginners.

---

## Part 1: Push Code to GitHub

### Prerequisites

- GitHub account ([github.com](https://github.com) – sign up if needed)
- Git installed on your Windows PC ([git-scm.com/download/win](https://git-scm.com/download/win))

---

### Step 1.1: Install Git (if not already installed)

1. Download Git for Windows from the link above.
2. Run the installer and accept default options.
3. Open **Command Prompt** or **PowerShell** and run:
   ```bash
   git --version
   ```
   You should see something like `git version 2.x.x`.

---

### Step 1.2: Create a New Repository on GitHub

1. Log in to [github.com](https://github.com).
2. Click the **"+"** icon (top right) → **"New repository"**.
3. Fill in:
   - **Repository name:** `main_module` (or any name you like)
   - **Description:** Optional, e.g. "Convixx RAG + LLM Backend"
   - **Visibility:** Choose **Private** (recommended) or **Public**
   - **Do NOT** check "Initialize with README" – your project already has files
4. Click **"Create repository"**.

---

### Step 1.3: Initialize Git in Your Project (if not already done)

1. Open **Command Prompt** or **PowerShell**.
2. Go to your project folder:
   ```bash
   cd d:\Sandesh\Private\Convixx\nodejs_main
   ```
3. Check if Git is already initialized:
   ```bash
   git status
   ```
   - If you see "fatal: not a git repository" → run:
     ```bash
     git init
     ```
   - If you see a list of files → Git is already initialized, skip to Step 1.4.

---

### Step 1.4: Create/Verify Root .gitignore

Make sure sensitive files and build artifacts are never pushed. Create or edit `.gitignore` in the project root (`d:\Sandesh\Private\Convixx\nodejs_main\.gitignore`):

```
# Environment and secrets
.env
.env.*
!.env.example

# Dependencies
node_modules/

# Build output
dist/

# IDE and OS
.idea/
.vscode/
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
```

---

### Step 1.5: Add All Files and Make First Commit

```bash
cd d:\Sandesh\Private\Convixx\nodejs_main

# Add all files (respecting .gitignore)
git add .

# Check what will be committed (ensure .env is NOT listed)
git status

# Create first commit
git commit -m "Initial commit: Convixx RAG + LLM backend"
```

**Important:** If you see `.env` in the list, **do not commit**. Remove it:
```bash
git reset HEAD apps/api/.env
```
And ensure `apps/api/.env` is in `.gitignore`.

---

### Step 1.6: Connect to GitHub and Push

1. On your GitHub repository page, copy the repository URL (e.g. `https://github.com/YourUsername/main_module.git`).

2. Add the remote and push:
   ```bash
   # Replace with YOUR repository URL
   git remote add origin https://github.com/YourUsername/main_module.git

   # Rename branch to main (if needed)
   git branch -M main

   # Push to GitHub
   git push -u origin main
   ```

3. If prompted for credentials:
   - **Username:** Your GitHub username
   - **Password:** Use a **Personal Access Token** (GitHub no longer accepts account passwords)
   - To create a token: GitHub → Settings → Developer settings → Personal access tokens → Generate new token (classic). Give it `repo` scope.

---

### Step 1.7: Future Updates (After Making Changes)

Whenever you change code and want to update GitHub:

```bash
cd d:\Sandesh\Private\Convixx\nodejs_main

git add .
git status   # Double-check .env is not included
git commit -m "Description of your changes"
git push
```

---

## Part 2: Deploy on AWS Server

### Prerequisites

- SSH access to your AWS server (PuTTY)
- Domain name pointing to your server (or server IP)
- PostgreSQL already installed on the server (you mentioned it is)
- LLM API at `https://ai.convixx.in` (already set up)

---

### Step 2.1: Connect to Your Server via PuTTY

1. Open **PuTTY**.
2. Enter your server's **Host Name** (IP or domain).
3. Port: **22**.
4. Connection type: **SSH**.
5. Click **Open**.
6. Log in with your username and password (or SSH key if configured).

---

### Step 2.2: Check Existing Setup (Python System to Remove)

Run these commands to understand what is currently running:

```bash
# List running Python processes
ps aux | grep python

# Check for systemd services (common for web apps)
sudo systemctl list-units --type=service | grep -E "python|gunicorn|uvicorn|flask|django"

# Check what is using port 80 (HTTP) and 443 (HTTPS)
sudo lsof -i :80
sudo lsof -i :443

# Check Nginx configuration (if Nginx is used)
ls -la /etc/nginx/sites-enabled/
cat /etc/nginx/sites-enabled/default

# Nginx is not installed then run below command
# To install Nginx (if not already installed), run:
sudo apt-get update
sudo apt-get install -y nginx

# After installation, check its status:
sudo systemctl status nginx

# Start Nginx if not running:
sudo systemctl start nginx

# Enable Nginx to start automatically on reboot:
sudo systemctl enable nginx

```

**Share the output with your developer/team** so we know exactly what to stop and what config files to edit.

---

### Step 2.3: Install Node.js on the Server

1. Install Node.js 18.x (LTS):
   ```bash
   # For Ubuntu/Debian
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs

   # Verify
   node -v   # Should show v20.x.x
   npm -v    # Should show 10.x.x
   ```

2. If you use Amazon Linux 2:
   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
   source ~/.bashrc
   nvm install 20
   nvm use 20
   node -v
   ```

---

### Step 2.4: Install PM2 (Process Manager)

PM2 keeps your Node.js app running and restarts it if it crashes:

```bash
   sudo npm install -g pm2
pm2 --version
```

---

### Step 2.5: Clone Your Repository from GitHub

```bash
# Create a directory for apps (or use existing structure)
sudo mkdir -p /var/www
cd /var/www

# Clone (replace with YOUR repo URL)
sudo git clone https://github.com/YourUsername/main_module.git
cd main_module
```

If the repo is **private**, you have two options:

- **Option A (HTTPS):** Use a Personal Access Token when Git asks for password.
- **Option B (SSH):** Set up SSH keys on the server and add the server's public key to GitHub. Then clone using:
  ```bash
  git clone git@github.com:YourUsername/main_module.git
  ```

---

### Step 2.6: Create .env File on the Server

**Never commit .env to GitHub.** Create it manually on the server:

```bash
cd /var/www/main_module/apps/api
sudo nano .env
```

**Generate a secure encryption key:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save and exit: `Ctrl+O`, `Enter`, `Ctrl+X`.

---

### Step 2.7: Build and Run the Application

```bash
cd /var/www/main_module/apps/api

# Install dependencies
npm install

# Build TypeScript
npm run build

# Test run (Ctrl+C to stop after verifying)
npm run start
```

Visit `http://YOUR_SERVER_IP:8080/health` in a browser. If you see `{"status":"ok",...}`, the app works.

---

### Step 2.8: Run with PM2 (Production)

```bash
cd /var/www/main_module/apps/api

# Start with PM2 (pick one)
pm2 start dist/index.js --name convixx-api
# or: pm2 start ecosystem.config.cjs

# Save PM2 process list (so it survives reboot)
pm2 save
pm2 startup   # Follow the command it prints to enable on boot

# Useful commands
pm2 status          # Check status
pm2 logs convixx-api   # View logs
pm2 restart convixx-api   # Restart (only works after the app was started once)
pm2 stop convixx-api      # Stop
```

**If you see `Process or Namespace convixx-api not found`:** PM2 has never registered that name on this machine (or PM2’s process list was cleared). Run **`pm2 start`** as above first, then `pm2 save`. After changing `.env`, use **`pm2 restart convixx-api --update-env`** so new variables load.

---

### Step 2.9: Install and Configure Nginx (Reverse Proxy)

Nginx will receive requests on port 80/443 and forward them to your Node.js app on port 8080.

1. **Install Nginx:**
   ```bash
   sudo apt-get update
   sudo apt-get install -y nginx
   ```

2. **Create Nginx config for your domain:**
   ```bash
   sudo nano /etc/nginx/sites-available/convixx
   ```

3. **Paste this configuration** (replace `yourdomain.com` with your actual domain, e.g. `convixx.in`):

   ```nginx
   server {
       listen 80;
       server_name yourdomain.com;

       location / {
           proxy_pass http://127.0.0.1:8080;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

4. **Enable the site:**
   ```bash
   sudo ln -s /etc/nginx/sites-available/convixx /etc/nginx/sites-enabled/
   sudo nginx -t    # Test config
   sudo systemctl reload nginx
   ```

---

### Step 2.10: Point Your Domain to the Server

1. Go to your domain registrar (e.g. GoDaddy, Namecheap, AWS Route 53).
2. Add an **A record**:
   - **Name:** `@` (apex `convixx.in`) or another subdomain if you use one (e.g. `api` for `api.convixx.in`)
   - **Type:** A
   - **Value:** Your AWS server's public IP
   - **TTL:** 300

3. Wait 5–30 minutes for DNS to propagate.

4. Test: `curl http://yourdomain.com/health`

---

### Step 2.11: (Optional) HTTPS with Let's Encrypt

For production, use HTTPS:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

Follow the prompts. Certbot will configure SSL automatically.

---

### Step 2.12: Stop the Old Python System

After confirming the new system works:

1. **Find the Python process or service:**
   ```bash
   ps aux | grep python
   sudo systemctl list-units | grep -i python
   ```

2. **Stop the service** (example – adjust name to match what you find):
   ```bash
   sudo systemctl stop old-python-service
   sudo systemctl disable old-python-service
   ```

3. **Update Nginx** so the domain serves only the new Node.js app (remove or disable old site configs):
   ```bash
   sudo rm /etc/nginx/sites-enabled/old-site-config
   sudo nginx -t
   sudo systemctl reload nginx
   ```

---

## Part 3: Updating the Deployed App

### 3.1 Production update from `main` (default)

When you merge to **`main`** on GitHub and want the **main server** to run that code:

```bash
cd /var/www/main_module
sudo git pull origin main

cd apps/api
npm install
npm run build

pm2 restart convixx-api
```

**If `pm2 restart convixx-api` says the process was not found:** run `pm2 status`. If `convixx-api` is missing, the app was never started under that name on this server (or PM2’s list was cleared). From `apps/api`, run **`pm2 start ecosystem.config.cjs`** or **`pm2 start dist/index.js --name convixx-api`**, then **`pm2 save`**. See Step 2.8. After that, future deploys can use `pm2 restart convixx-api` as usual.

---

### 3.2 Deploy from a GitHub sub-branch to the main server

Use this when the code you want on the server lives on a **branch other than `main`** (for example `feature/settings`, `release/2026-04`, or `hotfix/exotel`). The server will **track that branch** until you switch back to `main`.

**Recommended pattern for real production:** merge the branch into **`main`** on GitHub (via Pull Request), then use **§3.1** so production always tracks `main`. Use **direct branch checkout on the server** only when you intentionally want the server to run a pre-merge branch (staging, customer pilot, or emergency test).

**On the server (SSH), from the repo root:**

```bash
cd /var/www/main_module

# Download latest refs from GitHub (all branches)
git fetch origin

# Switch to your branch (replace BRANCH_NAME)
git checkout BRANCH_NAME

# Update that branch to match GitHub (fast-forward or merge as configured)
git pull origin BRANCH_NAME

# Rebuild and restart the API
cd apps/api
npm install
npm run build
pm2 restart convixx-api --update-env
```

**First time this branch is used on this machine:** after `git fetch origin`, if `git checkout BRANCH_NAME` says the branch does not exist locally, create a local branch that tracks the remote:

```bash
git fetch origin
git checkout -b BRANCH_NAME origin/BRANCH_NAME
```

**If you see `fatal: a branch named '…' already exists`:** do not use `-b`. The branch is already on the server; switch and update:

```bash
git fetch origin
git checkout BRANCH_NAME
git pull origin BRANCH_NAME
```

**Check which branch the server is on before and after:**

```bash
cd /var/www/main_module
git branch --show-current
git status -sb
```

**Switch the main server back to `main` after testing a branch:**

```bash
cd /var/www/main_module
git fetch origin
git checkout main
git pull origin main

cd apps/api
npm install
npm run build
pm2 restart convixx-api --update-env
```

**Avoid `sudo git pull` if you can:** it makes new files owned by `root` and can break `npm install` for your deploy user. Prefer fixing repo ownership once (`sudo chown -R YOUR_USER:YOUR_USER /var/www/main_module`) and run `git` as that user. If you already used `sudo`, see **EACCES** in Part 5.

**If you have local edits on the server** (never ideal), `git pull` may fail. Either discard them (only if you are sure they are not needed):

```bash
cd /var/www/main_module
git reset --hard origin/BRANCH_NAME
```

…or stash them: `git stash`, pull, then `git stash pop` (advanced). Prefer deploying only from a clean clone and changing code only on GitHub.

---

## Part 4: Quick Reference Commands

| Task                | Command                                        |
|---------------------|------------------------------------------------|
| Check app status   | `pm2 status`                                   |
| View logs          | `pm2 logs convixx-api`                         |
| Restart app        | `pm2 restart convixx-api`                      |
| Test health        | `curl http://localhost:8080/health`            |
| Check Nginx        | `sudo nginx -t && sudo systemctl status nginx` |
| Update from GitHub (`main`) | `cd /var/www/main_module && git pull origin main && cd apps/api && npm install && npm run build && pm2 restart convixx-api --update-env` |
| Update from a **branch** | `cd /var/www/main_module && git fetch origin && git checkout BRANCH_NAME && git pull origin BRANCH_NAME && cd apps/api && npm install && npm run build && pm2 restart convixx-api --update-env` |

---

## Part 5: Troubleshooting

| Problem                     | What to check                                               |
|----------------------------|-------------------------------------------------------------|
| "Connection refused"       | Is the app running? `pm2 status`                            |
| "502 Bad Gateway"          | See **502 Bad Gateway** below (upstream not reachable — not specific to `/docs`). |
| "Database connection" error | Is PostgreSQL reachable? Check PG_HOST, firewall, pg_hba.conf |
| Old Python still responding| Ensure old service is stopped and Nginx serves only new config |
| **EACCES on npm install**  | Files owned by root after `sudo git pull`. Run: `sudo chown -R YOUR_USER:YOUR_GROUP /var/www/main_module` (e.g. `convixx-main:convixx-main`) |
| **`insufficient permission for adding an object to repository database .git/objects`** | Same cause: repo or `.git` owned by `root`. Fix ownership (below), then `git fetch` again. |

### Git: `insufficient permission` / `failed to write object` on `git fetch`

This almost always means the repository was created or updated with **`sudo`** (`sudo git clone`, `sudo git pull`), so **`root` owns `.git/objects`** and your deploy user (e.g. `convixx-main`) cannot write new objects.

**Fix (run once, or after any accidental `sudo git` in this folder):**

```bash
sudo chown -R convixx-main:convixx-main /var/www/main_module
```

Use your real Linux username if it is not `convixx-main`. Then:

```bash
cd /var/www/main_module
git fetch origin
```

**Why `git checkout Milestone-4` said “pathspec did not match”:** `git fetch` never completed, so Git never downloaded the branch list. After `fetch` succeeds, list remote branches and match the exact name (case-sensitive):

```bash
git branch -r | grep -i milestone
```

Then either:

```bash
git checkout Milestone-4
```

or, if the branch only exists on the remote:

```bash
git checkout -b Milestone-4 origin/Milestone-4
```

### 502 Bad Gateway on `/docs`, `/health`, or every URL

Nginx returns **502** when it cannot get a valid HTTP response from the **upstream** (`proxy_pass`, usually `http://127.0.0.1:8080`). That affects **all** routes the same way, including Swagger at `/docs`. It is not a separate Swagger bug.

Work through this on the **server** (SSH):

1. **Is Node listening on the port Nginx uses?**  
   Your Nginx config must match **`PORT` in `apps/api/.env`** (default **8080**). If `.env` has `PORT=3000` but Nginx still proxies to `8080`, you will get 502.  
   Check: `grep ^PORT /var/www/main_module/apps/api/.env` and compare to `proxy_pass` in `/etc/nginx/sites-enabled/…`.

2. **Bypass Nginx and hit Node directly:**
   ```bash
   curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/health
   ```
   If this fails or is not `200`, fix the app first (`pm2 logs convixx-api`, see below). If this works but the domain still returns 502, the problem is Nginx config or which `server_name` block is handling the request.

3. **Is the process running and stable?**
   ```bash
   pm2 status
   pm2 logs convixx-api --lines 80
   ```
   Look for **crash loops** (missing `.env`, bad `PG_*`, failed `npm run build`, `EADDRINUSE`). Restart after fixing: `cd /var/www/main_module/apps/api && npm run build && pm2 restart convixx-api --update-env`.

4. **Confirm something is bound to the port:**
   ```bash
   sudo ss -tlnp | grep 8080
   ```
   You should see `node` (or `PM2`). If nothing listens, the API is not running.

5. **Read Nginx’s error log** (often says `Connection refused` to upstream):
   ```bash
   sudo tail -n 50 /var/log/nginx/error.log
   ```

6. **Wrong site / default server:** If you have several configs, ensure `server_name` matches the host you open in the browser and that this site’s `location /` proxies to the correct port. Disable duplicate or old `sites-enabled` configs if two servers fight for the same domain.

After Node responds on `curl http://127.0.0.1:8080/health`, reload Nginx (`sudo nginx -t && sudo systemctl reload nginx`) and test the domain again.

### EACCES: permission denied on package-lock.json

If `npm install` fails with `EACCES: permission denied` on `package-lock.json`, or `git fetch` fails with **insufficient permission** under `.git/objects`, the directory was likely updated with `sudo git pull` / `sudo git clone`, so root owns the files and your deploy user cannot write. Fix ownership, then retry:

```bash
sudo chown -R convixx-main:convixx-main /var/www/main_module
cd /var/www/main_module/apps/api
npm install
npm run build
```

To avoid this after future updates, run **`git fetch` / `git pull` / `git checkout` without `sudo`** once the tree is owned by your deploy user. If you must use `sudo` for some other reason, run **`chown` again** afterward.

---

## Summary Checklist

- [ ] Git installed, repo created on GitHub
- [ ] Code pushed to GitHub (no .env committed)
- [ ] SSH access to AWS server working
- [ ] Node.js 20 and PM2 installed
- [ ] Repository cloned, .env created on server
- [ ] App built and running with PM2
- [ ] Nginx configured and domain pointing to server
- [ ] Old Python system stopped
- [ ] HTTPS configured (optional but recommended)
- [ ] Know how to deploy: from `main` (§3.1) or from a feature branch (§3.2); production usually stays on `main` after merge
