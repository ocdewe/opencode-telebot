# RESTORE-CHECKLIST.md

Checklist restore cepat untuk repo `opencode-telebot`.

## 1. Clone dan Install
- clone repo
- jalankan `npm install`

## 2. Buat Environment
- copy `.env.example` menjadi `.env`
- isi `BOT_TOKEN`
- isi `ALLOWED_USER_IDS`
- isi `WORK_DIR`
- isi `DEFAULT_MODEL`
- verifikasi `OPENCODE_PATH`

## 3. Siapkan OpenCode
- pastikan OpenCode CLI terinstall
- pastikan `~/.config/opencode/opencode.json` valid
- pastikan model default tersedia

## 4. Test Manual
- jalankan `npx tsx src/index.ts`
- kirim `/start`
- kirim `/status`
- kirim `/models`

## 5. Aktifkan Service
- pasang `telebot.service`
- `systemctl daemon-reload`
- `systemctl enable --now telebot`
- cek `systemctl status telebot`
