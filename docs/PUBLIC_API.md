# API công khai — api.akatruyen.com

> **Trạng thái 17/11/2026: ĐÃ TẮT theo yêu cầu người dùng.** `lcit-tunnel.service` inactive và disabled; API/PostgreSQL vẫn active. Không còn truy cập API hoặc database qua Tunnel. Các thông tin bên dưới mô tả triển khai trước khi tắt, không phải địa chỉ đang phục vụ. DNS/Access và cấu hình được giữ để có thể phục hồi; chưa triển khai NAT/hosting thay thế. Giao diện/bản build vẫn chứa URL API cũ nên không kết nối được cho tới khi đổi cách triển khai.

Đã triển khai ngày 16/11/2026. API chạy trên máy Ubuntu `192.168.251.126`, kết nối database `lcit_manager` nội bộ. Tên miền công khai đi qua Cloudflare Tunnel, không dùng NAT trên FortiGate và không công khai cổng PostgreSQL.

## Địa chỉ sử dụng

- API gốc: `https://api.akatruyen.com`.
- Kiểm tra database: `https://api.akatruyen.com/health/ready` trả `{"status":"ok","database":"up"}`.
- Tài liệu API: `https://api.akatruyen.com/docs`.
- Các API nghiệp vụ dùng tiền tố `/api/v1` và vẫn yêu cầu đăng nhập/phân quyền như trước. Truy cập `/api/v1/users` khi chưa đăng nhập trả 401.

Người dùng phần mềm có thể truy cập API qua Internet mà không cần VPN. Từ 17/11/2026, pgAdmin cũng có thể dùng [Tunnel database có Cloudflare Access](PGADMIN_TUNNEL.md), không cần VPN. SSH/RDP tới IP nội bộ vẫn cần đường LAN/VPN tương ứng. Tên miền gốc `akatruyen.com` chưa được triển khai website.

## Dịch vụ máy chủ

| Thành phần | Cấu hình |
| --- | --- |
| API | `lcit-api.service`, chạy bằng tài khoản hệ thống `lcit-api` |
| Origin | Chỉ nghe `127.0.0.1:4000` |
| Tunnel | `lcit-tunnel.service`, chạy bằng tài khoản hệ thống `cloudflared` |
| Tên tunnel | `lcit-manager-api` |
| Tuyến | `api.akatruyen.com` → `http://127.0.0.1:4000`; `db.akatruyen.com` → `tcp://127.0.0.1:5432` (bắt buộc Access JWT); hostname khác trả 404 |
| Database | PostgreSQL nội bộ, tài khoản `lcit_app`, TLS kiểm tra CA |
| Tệp đính kèm | `/var/lib/lcit-manager/attachments` |
| Mã API đang chạy | `/opt/lcit-manager/current/apps/api` |

Hai dịch vụ đều đang active và tự khởi động cùng máy. Node 22.23.5 được tải từ nguồn chính thức và kiểm tra SHA-256; cloudflared được cài từ kho có chữ ký Cloudflare. Nginx đã được dừng/vô hiệu hóa vì phương án Tunnel không cần nó.

Cloudflare giữ kết nối HTTPS phía Internet; cloudflared kết nối outbound tới Cloudflare bằng HTTP/2, chuyển yêu cầu tới API qua loopback. Tuyến PostgreSQL riêng yêu cầu Access và client cloudflared trên máy quản trị. Chứng thư CA tự quản của database không phải chứng thư HTTPS người dùng thấy ở tên miền công khai.

## Thông tin nhạy cảm

- `/etc/lcit-manager/api.env`: cấu hình dịch vụ, chứa mật khẩu database, root và nhóm dịch vụ đọc.
- `/etc/cloudflared/config.yml`: cấu hình tuyến, thông tin đường dẫn credential.
- `/etc/cloudflared/<tunnel-id>.json`: credential chỉ cho tunnel, root và tài khoản dịch vụ đọc.
- `/root/.cloudflared/cert.pem`: chứng thư quản trị Tunnel/DNS đã được chủ tài khoản Cloudflare xác nhận cho zone; chỉ root dùng để quản trị, không đưa vào thư mục API hoặc gửi cho người dùng.

Không commit các tệp trên hoặc đóng gói chúng vào bộ cài desktop. Tài khoản/phân quyền ứng dụng đã chuyển từ Neon trước đó được giữ nguyên.

## Giao diện và bản build Windows

Trên máy Admin đã tạo/cập nhật hai cấu hình bị Git bỏ qua:

```text
apps/desktop/.env.local
apps/desktop/.env.production.local
```

Cả hai đặt `NEXT_PUBLIC_API_URL=https://api.akatruyen.com`. Bản Next.js production đã build thành công vào `apps/desktop/out`; đã kiểm tra bundle chứa đúng địa chỉ HTTPS này. Khi build trên máy khác, cần đặt biến đó trước khi build vì Next.js nhúng địa chỉ API vào mã giao diện.

Trong phiên làm việc này chưa build lại bộ cài Tauri/NSIS. Bộ cài cũ có thể vẫn chứa địa chỉ localhost và cần build/phát hành lại để người ở mạng khác dùng. Khi chạy giao diện development đang mở, tải lại cửa sổ nếu chưa nhận cấu hình mới.

## Kiểm tra và vận hành

```sh
systemctl status lcit-api lcit-tunnel
journalctl -u lcit-api -n 50 --no-pager
journalctl -u lcit-tunnel -n 50 --no-pager
curl -f http://127.0.0.1:4000/health/ready
```

Đã kiểm tra HTTPS công khai từ máy Admin trả 200 và database `up`; API dữ liệu không đăng nhập trả 401; CORS cho origin Tauri `http://tauri.localhost` trả 204 và đúng allowed origin. Cloudflared báo kiểm tra DNS, TCP HTTP/2 và Cloudflare API đều PASS. PostgreSQL chỉ nghe loopback và IP LAN, API chỉ nghe loopback.

Giới hạn đăng nhập theo địa chỉ kết nối hiện tại của API vẫn dùng socket peer. Qua Tunnel, peer là loopback nên giới hạn IP được dùng chung cho các người dùng (ngoài giới hạn riêng từng username). Cần rà soát phần nhận IP từ proxy tin cậy trước khi mở rộng tải sử dụng; không bật tin cậy header từ mọi nguồn.

Nguồn tham chiếu: [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/), [nguồn Node 22](https://nodejs.org/dist/latest-v22.x/).
