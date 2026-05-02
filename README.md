# 🤖 OpenCode Remote — Telegram Bot

Control [OpenCode](https://github.com/nicepkg/opencode) from your phone via Telegram. Full remote coding interface — chat, edit files, manage sessions, send images — all from Telegram.

## ✨ Features

- 💬 **Chat with AI** — Send messages directly to OpenCode from Telegram
- 📷 **Image/File support** — Send photos or documents for analysis
- 📋 **Session management** — List, switch, rename, delete, label sessions
- 🔄 **Session persistence** — Survives bot restarts, syncs with CLI
- ⏱️ **Timeout control** — Set, extend, or stop running processes
- 🖥️ **Cross-platform** — Works on Windows and Linux
- 🤖 **Multi-model/agent** — Switch models and agents on the fly
- ⚡ **Shell access** — Run shell commands directly

## 📋 Commands

| Command | Description |
|---------|-------------|
| `/start` | Info & status |
| `/help` | Show all commands |
| `/sessions` | List sessions (current dir) |
| `/sessions all` | List all sessions |
| `/session` | Active session info |
| `/switch <id/label/n>` | Switch to another session |
| `/label <name>` | Label active session |
| `/rename <name>` | Rename active session |
| `/delete <id/label/n>` | Delete a session |
| `/new` | Start new session |
| `/continue` | Resume latest session |
| `/model <model>` | Change model |
| `/agent <agent>` | Change agent (build/plan) |
| `/stop` | Interrupt running process |
| `/timeout <min>` | Set default timeout |
| `/extend <min>` | Add time to running process |
| `/shell <cmd>` | Run shell command |
| `/reset` | Force reset (if stuck) |
| `/status` | System info |

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [OpenCode CLI](https://github.com/nicepkg/opencode) installed and configured
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))

### 1. Clone & Install

```bash
git clone https://github.com/triyuga/opencode-telebot.git
cd opencode-telebot
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:
```env
BOT_TOKEN=your_bot_token_here
ALLOWED_USER_IDS=your_telegram_user_id
OPENCODE_PATH=opencode
WORK_DIR=/path/to/your/project
DEFAULT_MODEL=your-provider/model-name
```

> 💡 Get your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot) or using `/id` command after starting the bot with `ALLOWED_USER_IDS` empty.

### 3. Run

**Development:**
```bash
npx tsx src/index.ts
```

**Production (build first):**
```bash
npm run build
npm start
```

## 🖥️ Platform Setup

### Windows

1. Install OpenCode: `choco install opencode` or download from releases
2. Run as **Administrator** (required for OpenCode)
3. Optional: Use `telebot.bat` for quick launch

**Desktop shortcut:**
Create a shortcut to `telebot.bat` and set "Run as administrator" in Properties → Advanced.

**PowerShell function (add to `$PROFILE`):**
```powershell
function telebot {
  Start-Process powershell -Verb RunAs -ArgumentList "-NoExit", "-Command", "cd 'C:\path\to\opencode-telegram-remote'; npx tsx src/index.ts"
}
```

### Linux (VPS / Server)

1. Install OpenCode:
```bash
curl -fsSL https://opencode.sh | bash
```

2. Edit `run_oc.sh` — update the OpenCode path if needed:
```bash
#!/bin/bash
export PATH=/path/to/opencode:$PATH
OUTFILE="$1"
shift
opencode "$@" > "$OUTFILE" 2>/dev/null
```

3. Make executable:
```bash
chmod +x run_oc.sh
```

4. **Systemd service (auto-start on boot):**

Edit `telebot.service` with your paths, then:
```bash
sudo cp telebot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable telebot
sudo systemctl start telebot
```

Check status:
```bash
sudo systemctl status telebot
journalctl -u telebot -f
```

## ⚙️ OpenCode Configuration

Make sure OpenCode is configured with at least one provider. Example `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "my-provider": {
      "name": "My Provider",
      "type": "openai",
      "url": "https://api.example.com/v1",
      "key": "sk-your-api-key"
    }
  },
  "model": {
    "my-provider/claude-opus-4.6": {
      "name": "Claude Opus 4.6",
      "provider": "my-provider",
      "id": "claude-opus-4-20250514",
      "attachments": true
    }
  }
}
```

## 🏗️ Project Structure

```
opencode-telegram-remote/
├── src/
│   └── index.ts          # Main bot code (cross-platform)
├── run_oc.sh             # Linux wrapper script
├── telebot.bat           # Windows launcher
├── telebot.service       # Systemd service definition
├── .env.example          # Environment template
├── package.json
└── tsconfig.json
```

## 📝 Notes

- The bot uses **spawn** with shell for reliable process management
- On Windows: uses PowerShell + `Tee-Object` for output capture
- On Linux: uses `run_oc.sh` wrapper with file-based output polling
- Session state persists to `session-state.json` (auto-created)
- Session labels persist to `session-labels.json` (auto-created)

## 📄 License

MIT
