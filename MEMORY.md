# MEMORY.md

Ringkasan konteks jangka panjang untuk repo `opencode-telebot`.

## Tujuan
- Repo ini menyimpan source bot Telegram untuk mengakses OpenCode dari chat Telegram.
- Fokus repo ini adalah source/app, bukan backup session runtime atau secret file.

## Batasan Repo
- `.env` tidak boleh masuk git.
- `session-state.json` tidak masuk git.
- `session-labels.json` tidak masuk git.
- file output sementara seperti `*.jsonl` tidak masuk git.

## Fitur Penting
- Command bot untuk session, model, agent, shell, timeout, status.
- `/models` memakai 2-stage inline picker: provider -> model.
- Bot mendukung file dan gambar untuk diteruskan ke OpenCode.

## Recovery Notes
- Untuk restore bot di server baru, yang dibutuhkan dari repo ini hanya source + `.env` baru + OpenCode CLI yang sudah jalan.
- State session runtime berada di mesin lokal dan tidak ikut repo.
