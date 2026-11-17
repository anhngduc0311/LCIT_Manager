# pgAdmin qua Cloudflare Tunnel

> **Trạng thái 17/11/2026: ĐÃ TẮT theo yêu cầu người dùng.** Tunnel máy chủ đã dừng và disabled; client cổng 15432 trên máy Admin đã dừng, shortcut Desktop chuyển vào thư mục riêng với tên `LCIT Database Tunnel.disabled.lnk`. Hướng dẫn bên dưới chỉ là cấu hình trước đây, hiện không dùng được. Dùng pgAdmin qua LAN/VPN với host `192.168.251.126`, port `5432`, cùng tài khoản/CA hiện có theo `POSTGRES_LAN.md`.

Đã triển khai ngày 17/11/2026. `db.akatruyen.com` đi qua tunnel `lcit-manager-api` tới PostgreSQL loopback `127.0.0.1:5432` trên máy chủ. Không cần NAT hoặc VPN trên máy dùng pgAdmin; máy chủ và máy khách phải có Internet.

## Mở kết nối

Máy Admin đã cài cloudflared 2026.11.0 từ gói chính thức, kiểm tra hash qua winget. Máy khác cài:

```powershell
winget install --id Cloudflare.cloudflared --exact --source winget
```

Chạy `ops/postgres/open_pgadmin_tunnel.ps1`, hoặc:

```powershell
cloudflared access tcp --hostname db.akatruyen.com --url 127.0.0.1:15432
```

Giữ tiến trình chạy trong lúc dùng pgAdmin. Khi có yêu cầu, đăng nhập Cloudflare Access bằng email được cấp quyền. Hiện chỉ cho phép `Akzan0311@gmail.com`; các email khác bị từ chối. Phiên Access có thời hạn 24 giờ. Không chia sẻ token Access hoặc credential tunnel máy chủ.

## Các trường trong pgAdmin 4

Register → Server, General → Name: `LCIT Cloudflare`.

| Tab Connection | Giá trị |
| --- | --- |
| Host name/address | `127.0.0.1` |
| Port | `15432` |
| Maintenance database | `lcit_manager` |
| Username | `lcit_owner` (quản trị cấu trúc), hoặc `lcit_team` (đọc/ghi dữ liệu) |
| Password | Lấy từ `owner.env` hoặc `team.env` tương ứng trong thư mục riêng |

Tab Parameters/SSL (tùy phiên bản pgAdmin): SSL mode `verify-full`; Root certificate chọn `C:\Users\Admin\.codex\private\lcit-postgres-192.168.251.126\root-ca.crt`. Không cần client certificate/key, không bật SSH Tunnel trong pgAdmin. Trên máy khác chép CA công khai và chọn đường dẫn tương ứng.

Mật khẩu riêng trên máy Admin nằm tại `C:\Users\Admin\.codex\private\lcit-postgres-192.168.251.126`. Không ghi mật khẩu vào tài liệu này. Không nhập trực tiếp hostname `db.akatruyen.com` và cổng 5432 vào pgAdmin: dịch vụ này cần client cloudflared và đăng nhập Access trước.

## Bảo vệ và vận hành

- Access application `LCIT PostgreSQL`, ID `9a1cdf0d-2471-4cf5-a9ba-ccdbc12ab565`; policy `LCIT PostgreSQL owner only`, chỉ đúng email đã duyệt, không có Bypass/Everyone.
- Team domain `bitter-band-7000.cloudflareaccess.com`. Máy chủ kiểm tra JWT với `originRequest.access.required: true` và đúng AUD của application; nếu xóa nhầm Access application, origin vẫn yêu cầu JWT.
- PostgreSQL tiếp tục yêu cầu TLS và mật khẩu SCRAM. Kết nối qua Tunnel đã xác minh TLS 1.3, database `lcit_manager`, 33 bảng. Chứng thư PostgreSQL có SAN `127.0.0.1`, phù hợp host cục bộ của pgAdmin.
- Đã kiểm tra lại từ máy Admin sau khi người dùng tắt VPN: PostgreSQL vẫn kết nối được qua Tunnel, 33 bảng; API `/health/ready` trả 200 và database `up`. Truy cập hostname DB chưa đăng nhập trả 302 tới Cloudflare Access.
- Thay đổi tuyến bằng `configure_database_tunnel.py`, đầu vào JSON `teamName`, `audience`. Script chỉ thêm vào đúng tunnel LCIT, sao lưu cấu hình, kiểm tra ingress và phục hồi khi lỗi. Không chạy lại script khởi tạo tunnel API vì script đó ghi lại ingress chỉ có API.
- Muốn cấp người khác: thêm đúng email vào policy Access sau khi được quản trị duyệt, cấp tài khoản PostgreSQL phù hợp, gửi CA công khai và hướng dẫn client. Có mật khẩu database nhưng chưa được cấp Access vẫn không vào được qua hostname này.
- Nếu báo connection refused: mở lại client cloudflared và kiểm tra cổng 15432. Nếu browser báo denied: kiểm tra đúng email. Nếu lỗi SSL: kiểm tra CA, host và hạn chứng thư; giữ kiểm tra chứng thư bật.

Nguồn: [Cloudflare giao thức TCP](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/), [xác minh JWT tại origin](https://developers.cloudflare.com/tunnel/reference/origin-parameters/#access), [pgAdmin Server dialog](https://www.pgadmin.org/docs/pgadmin4/latest/server_dialog.html).
