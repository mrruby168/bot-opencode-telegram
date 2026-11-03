# tele-commander v5.0 — Hướng dẫn phát hành

Bot Telegram với 2 tính năng: **điều khiển nguồn/màn hình PC** và **lấy link web OpenCode (cùng session với PC)**.

## Menu (3 nút)

- **Tắt máy sau 30s** — hỏi YES/NO trong 60s, YES mới tắt (`/cancel_shutdown` để hủy).
- **Chụp màn hình PC** — gửi ảnh toàn màn hình về Telegram.
- **Link Web (WiFi)** — gửi link mở OpenCode trên điện thoại cùng WiFi.

## Setup

1. Cài NodeJS >= 22.14 (`node --version`).
2. Cài OpenCode Desktop (bản V2, có `opencode-cli.exe`). Bot KHÔNG dùng `opencode` V1 trên PATH.
3. Copy `.env.example` thành `.env`, điền `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`.
   `OPENCODE_V2_CLI`: để trống = tự dò `%APPDATA%\ai.opencode.desktop\cli\*`. Desktop update
   version mới mà bị lỗi "Không thấy file" thì sửa dòng này. `WEB_LAN_IP` chỉ điền khi máy
   nhiều card mạng (VPN/Hyper-V/VMware).
4. `npm install` rồi `npm run doctor` (thêm `-- --offline` nếu không có mạng).
5. Chạy: double-click `start-commander.cmd` hoặc `npm start`.
6. Telegram: `/start` → menu 3 nút.

## Link Web — dùng thế nào

Bấm **Link Web (WiFi)**, mở link nhận được trên điện thoại cùng WiFi. Link dùng 1 lần, hết hạn
5 phút; mở xong trình duyệt giữ đăng nhập 30 ngày. Không dùng được qua 4G.

## Sự cố thường gặp

- **"Chưa tìm thấy opencode-cli V2"** — điền `OPENCODE_V2_CLI` trong `.env` hoặc cài Desktop.
- **"Không thấy file: …"** — Desktop đã update đổi thư mục version; sửa `OPENCODE_V2_CLI`.
- **"Opencode service chưa chạy. Bật lại?"** — bấm Bật lại (bot không tự bật).
- **Cảnh báo restart service** — lần đầu service nghe `127.0.0.1`, cần đổi sang `0.0.0.0` và restart; Desktop ngắt kết nối vài giây (có thể cắt task đang chạy).
- **Điện thoại không mở được link** — thường do firewall. Chạy 1 lần trong PowerShell (Admin):
  `New-NetFirewallRule -DisplayName "OpenCode" -Direction Inbound -Protocol TCP -LocalPort 28894 -Action Allow`
- **"Không xác định được IP LAN"** — điền `WEB_LAN_IP` (IPv4 của card WiFi/LAN).
- **Link hết hạn / đổi máy** — bấm lại nút Link Web để lấy link mới.
- **Lưu ý bảo mật:** link là credential đăng nhập; tin nhắn chứa link nằm trong lịch sử chat Telegram, nên xóa sau khi dùng.
