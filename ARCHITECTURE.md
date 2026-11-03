# ARCHITECTURE — tele-commander v5.0 (2 tính năng)

Bot Telegram điều khiển PC Windows. Chỉ còn 2 tính năng, không còn TASK/MMO/queue/duyệt permission/SDK.

## 1. Luồng chính

`/start` → MENU 3 nút (mỗi nút 1 hàng):

1. **Tắt máy sau 30s** (`go:pc:now`) → `power.js` hỏi YES/NO (TTL 60s, nonce, claim đồng bộ) →
   YES: `shutdown.exe /s /t 30`; NO/hết hạn: hủy. `/cancel_shutdown` chạy `shutdown.exe /a`.
2. **Chụp màn hình PC** (`go:pc:shot`) → `screenshot.js` chụp VirtualScreen (DPI aware) bằng
   PowerShell, rate-limit 3s, `sendPhoto` (fallback `sendDocument`), nút gửi file gốc, xóa temp.
3. **Link Web (WiFi)** (`go:web:link`, hoặc `/web`) → `weblink.js` (mục 2).

Người lạ (không thuộc `TELEGRAM_ALLOWED_USERS`): im lặng, chỉ log ID.

## 2. Link Web — dùng OpenCode V2 của Desktop

Mục tiêu: điện thoại (cùng WiFi) mở web UI OpenCode và thấy ĐÚNG session đang chat trên PC.
Bot KHÔNG spawn server riêng, KHÔNG dùng cổng 4096, KHÔNG dùng bản V1 `opencode` trên PATH.

1. Dò CLI: `OPENCODE_V2_CLI` (.env) → nếu trống: `%APPDATA%\ai.opencode.desktop\cli\<x.y.z-*>\opencode-cli.exe`
   (version lớn nhất, so số học). Thiếu/không tồn tại → báo lỗi rõ (bot vẫn chạy 2 tính năng kia).
2. `service status` (15s): in `http://host:port` = OK, ngược lại DOWN → hỏi `[Bật lại] [Không]`;
   Bật lại = `service start` + poll status 1s × 20. Không bao giờ tự start.
3. Host `127.0.0.1/localhost` → cảnh báo restart `[Tiếp tục] [Huỷ]` → `service set hostname 0.0.0.0`
   + `service start`. Host khác (0.0.0.0) → bỏ qua.
4. Firewall: `netsh advfirewall firewall show rule name=OpenCode`; chưa có → thử `add rule` (cổng của service);
   lỗi quyền → gửi lệnh `New-NetFirewallRule …` cho user chạy tay, luồng vẫn tiếp tục.
5. IP LAN: `WEB_LAN_IP` nếu có; không thì `os.networkInterfaces()` (IPv4, bỏ loopback/169.254, tránh
   card ảo/VPN, ưu tiên 192.168 > 10 > 172.16-31).
6. `pair --url http://<IP>:<port>` (timeout `PAIR_TIMEOUT_MS`, quá giờ → kill) → regex
   `https?://\S+/auth/connect/\S+` → gửi link (dùng 1 lần, hết hạn 5 phút, giữ đăng nhập 30 ngày).

Bảo mật: link pair là credential. Không ghi log/state; chỉ log `pair ok ip=<ip> port=<port>`.
Mọi output lỗi qua `redact()` (che `/auth/connect/<token>` + `maskSecrets`). Link chỉ gửi cho user whitelist.
Callback `web:<action>:<nonce>` one-shot, TTL 5 phút, claim đồng bộ; mỗi user chỉ 1 flow chạy cùng lúc.

## 3. Module

| File | Trách nhiệm |
|---|---|
| `src/bot.js` | dotenv theo `import.meta.url`, whitelist, `setMyCommands` (start/web/shot/cancel_shutdown/status), signal |
| `src/config.js` | `loadConfig`: token, allowedUsers, `v2CliPath`, `lanIp`, `pairTimeoutMs` |
| `src/router.js` | handlers + đăng ký bot; điều phối power/screenshot/weblink |
| `src/menu.js` | `mainKeyboard` 3 nút, `sendMainMenu` |
| `src/power.js` | tắt máy + hủy (TTL cấu hình) |
| `src/screenshot.js` | chụp màn hình |
| `src/weblink.js` | Link Web |
| `src/common.js` | log/mask/chunk/helper dùng chung |

Dependency: `grammy`, `dotenv`. Không còn `@opencode-ai/sdk`.

## 4. Lỗi & trạng thái

`/status`: `Bot: online` + `CLI V2: OK | thiếu | không tồn tại`. Mọi bước Link Web fail đều báo
lỗi cụ thể + cách sửa; không treo, không im lặng, không tự chọn thay user.
