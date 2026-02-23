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
   - **Repository name:** `convixx-backend` (or any name you like)
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

1. On your GitHub repository page, copy the repository URL (e.g. `https://github.com/YourUsername/convixx-backend.git`).

2. Add the remote and push:
   ```bash
   # Replace with YOUR repository URL
   git remote add origin https://github.com/YourUsername/convixx-backend.git

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
sudo git clone https://github.com/YourUsername/convixx-backend.git
cd convixx-backend
```

If the repo is **private**, you have two options:

- **Option A (HTTPS):** Use a Personal Access Token when Git asks for password.
- **Option B (SSH):** Set up SSH keys on the server and add the server's public key to GitHub. Then clone using:
  ```bash
  git clone git@github.com:YourUsername/convixx-backend.git
  ```

---

### Step 2.6: Create .env File on the Server

**Never commit .env to GitHub.** Create it manually on the server:

```bash
cd /var/www/convixx-backend/apps/api
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
cd /var/www/convixx-backend/apps/api

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
cd /var/www/convixx-backend/apps/api

# Start with PM2
pm2 start dist/index.js --name convixx-api

# Save PM2 process list (so it survives reboot)
pm2 save
pm2 startup   # Follow the command it prints to enable on boot

# Useful commands
pm2 status          # Check status
pm2 logs convixx-api   # View logs
pm2 restart convixx-api   # Restart
pm2 stop convixx-api      # Stop
```

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

3. **Paste this configuration** (replace `yourdomain.com` with your actual domain, e.g. `api.convixx.in`):

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
   - **Name:** `api` (for api.convixx.in) or `@` (for root domain)
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

When you push new code to GitHub:

```bash
cd /var/www/main_module
sudo git pull origin main

cd apps/api
npm install
npm run build

pm2 restart convixx-api
```

---

## Part 4: Quick Reference Commands

| Task                | Command                                        |
|---------------------|------------------------------------------------|
| Check app status   | `pm2 status`                                   |
| View logs          | `pm2 logs convixx-api`                         |
| Restart app        | `pm2 restart convixx-api`                      |
| Test health        | `curl http://localhost:8080/health`            |
| Check Nginx        | `sudo nginx -t && sudo systemctl status nginx` |
| Update from GitHub | `cd /var/www/convixx-backend && git pull && cd apps/api && npm run build && pm2 restart convixx-api` |

---

## Part 5: Troubleshooting

| Problem                     | What to check                                               |
|----------------------------|-------------------------------------------------------------|
| "Connection refused"       | Is the app running? `pm2 status`                            |
| "502 Bad Gateway"          | Is Node.js listening on 8080? `pm2 logs convixx-api`       |
| "Database connection" error | Is PostgreSQL reachable? Check PG_HOST, firewall, pg_hba.conf |
| Old Python still responding| Ensure old service is stopped and Nginx serves only new config |
| **EACCES on npm install**  | Files owned by root after `sudo git pull`. Run: `sudo chown -R ubuntu:ubuntu /var/www/main_module` |

### EACCES: permission denied on package-lock.json

If `npm install` fails with `EACCES: permission denied` on `package-lock.json`, the directory was likely updated with `sudo git pull`, so root owns the files and the `ubuntu` user cannot write. Fix ownership, then retry:

```bash
sudo chown -R ubuntu:ubuntu /var/www/main_module
cd /var/www/main_module/apps/api
npm install
npm run build
```

To avoid this after future updates, either run `git pull` without sudo (if the repo is owned by ubuntu), or run the chown command after every `sudo git pull`.

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
