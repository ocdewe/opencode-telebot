# HEARTBEAT.md

Catatan fitur/area aktif yang perlu diingat lintas session.

## Aktif
- `/models` inline picker provider -> model aktif dan sudah dites.
- `/status` menampilkan info sistem, session, dan token usage dari OpenCode DB.
- Session state dan label disimpan lokal, tidak di-track git.

## Pantauan
- Perubahan format config OpenCode bisa mempengaruhi picker model.
- Perubahan CLI OpenCode bisa mempengaruhi parsing output/status.
- UX Telegram perlu dijaga tetap rapi untuk output panjang dan code block.
