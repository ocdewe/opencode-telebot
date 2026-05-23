# SERVICE-STATUS.md

Template catatan health service untuk bot Telegram.

## Last Checked
- tanggal: 2026-05-24 02:48 WIB
- oleh: OpenCode

## Service Status
- `telebot.service`: active (running) sejak 2026-05-24 01:55 WIB

## Runtime Notes
- model aktif: `9router/cx/gpt-5.4` pada sesi aktif saat pengecekan
- workdir aktif: `/root/projects`
- status OpenCode CLI: berjalan via `/root/.opencode/bin/opencode`

## Errors / Warnings
- Chunk output panjang sempat gagal parse HTML di Telegram dan fallback ke plain text.
- Memory service tinggi saat ada beberapa proses/session aktif.

## Next Action
- Perbaiki robustness chunk splitting HTML/code block.
- Pantau memory usage saat sesi panjang.
