# PostgreSQL dùng chung qua LAN/VPN

Đã triển khai ngày 16/11/2026 trên máy Ubuntu 24.04 `192.168.251.126`, dùng PostgreSQL 16.15 từ kho Ubuntu. Dịch vụ tự khởi động cùng máy. Đây là database trên máy chủ nội bộ có đường LAN/VPN, không phải địa chỉ công khai trên Internet.

Cloudflare Tunnel đã được tắt theo yêu cầu ngày 17/11/2026; kết nối `127.0.0.1:15432` hiện không hoạt động. Dùng các bước LAN/VPN bên dưới để kết nối trực tiếp IP nội bộ. [Tài liệu Tunnel](PGADMIN_TUNNEL.md) được giữ làm lịch sử cấu hình.

## Thông tin kết nối

| Mục | Giá trị |
| --- | --- |
| Host | `192.168.251.126` |
| Port | `5432` |
| Database | `lcit_manager` |
| User ứng dụng | `lcit_app` |
| User SQL dùng chung cho nhóm phát triển | `lcit_team` |
| User sở hữu cấu trúc/chạy migration | `lcit_owner` |
| Mã hóa | TLS, `sslmode=verify-full`, kiểm tra bằng CA riêng |

Mật khẩu và chuỗi kết nối nằm ngoài repo tại `C:\Users\Admin\.codex\private\lcit-postgres-192.168.251.126`. Thư mục chỉ cho tài khoản Windows hiện tại và SYSTEM truy cập. Không chép mật khẩu vào `.env.example` hoặc commit Git.

`owner.env` dành cho quản trị/migration; `api.env` dành cho tiến trình API; `team.env` dành cho nhóm được phép truy cập SQL. Gói `lcit-postgres-team.zip` chỉ chứa `team.env`, CA công khai và hướng dẫn, không chứa mật khẩu owner/app hoặc khóa riêng TLS.

## Người khác kết nối

1. Kết nối vào cùng LAN/VPN và có đường tới `192.168.251.126`.
2. Nhận gói `lcit-postgres-team.zip` từ người quản trị, giải nén vào thư mục riêng.
3. Trong pgAdmin/DBeaver: nhập host/port/database ở trên; username `lcit_team`; lấy password từ `team.env`.
4. Đặt SSL mode `verify-full`, chọn `root-ca.crt` làm Root certificate. Không cần client certificate hoặc client private key.

Nếu dùng `psql`, đặt các biến PG trong `team.env`; `PGSSLROOTCERT=root-ca.crt` được tính theo thư mục hiện tại, hoặc đổi thành đường dẫn tuyệt đối tới CA trên máy người dùng. Chuỗi `DATABASE_URL` trong gói cũng dùng CA theo đường dẫn tương đối; không dùng đường dẫn của máy Admin trên máy khác.

Máy chủ chỉ nghe `127.0.0.1` và `192.168.251.126`. HBA chỉ cho các tài khoản LCIT vào database này từ `192.168.251.0/24`, với TLS + SCRAM-SHA-256. Kết nối hiện tại từ máy Admin qua gateway `192.168.251.100` đã kiểm tra thành công. Nếu VPN khác đi vào với IP ngoài dải này, quản trị cần thêm đúng dải VPN vào HBA và cho phép đường mạng tương ứng; không mở `0.0.0.0/0`.

## Quyền database và cấu trúc LCIT

`lcit_owner` sở hữu database/schema và chạy migration, không phải PostgreSQL superuser và không được tạo database/role khác. `lcit_app` và `lcit_team` kế thừa nhóm `lcit_readwrite`: đọc/thêm/sửa/xóa bảng, dùng sequence trong schema `lcit`; không tạo bảng hoặc thay cấu trúc. Default privileges của owner áp dụng cho bảng/sequence tạo bởi các migration tiếp theo.

Tài khoản SQL dùng chung là quyền truy cập trực tiếp cho người phát triển tin cậy, có thể đọc/sửa dữ liệu nghiệp vụ và các bảng quyền/phiên của ứng dụng. Người dùng nghiệp vụ thông thường cần đăng nhập qua ứng dụng/API để giữ phân quyền Lãnh đạo/Quản trị/Chuyên viên, không dùng tài khoản SQL này.

Đã áp dụng toàn bộ 9 tệp migration hiện có, từ `001_foundation.sql` tới `008_access_endpoint_grants.sql` (có hai tệp mang số 004).

Ngày 16/11/2026 đã chuyển dữ liệu từ Neon PostgreSQL 18.7 sang PostgreSQL 16.15: **33 bảng, 218 bản ghi**, gồm 3 tài khoản ứng dụng, 2 ứng dụng, 3 máy chủ và các phân công/nhật ký/thông báo/phiên hiện có. ID, mật khẩu đã băm, các giá trị sequence và toàn bộ nội dung từng bảng đã được đối chiếu khớp trước khi commit. Giữ nguyên dữ liệu trên Neon, không xóa database nguồn.

Có 4 bản ghi đính kèm, đều đã lưu trữ: 1 tệp còn nội dung được kiểm tra SHA-256 và sao chép sang `/var/lib/lcit-manager/attachments` trên máy chủ; 3 tệp còn lại đã thiếu nội dung trên máy Windows trước lúc chuyển. Giữ nguyên cả 4 bản ghi, không đánh dấu lại hoặc dựng nội dung giả. API Windows vẫn dùng thư mục tệp cục bộ hiện có; bản trên máy chủ là bản sao nội dung để phục vụ triển khai API sau này.

Bản chụp nguồn, dữ liệu đích trước khi chuyển, cấu hình API cũ và báo cáo đối chiếu lưu ở thư mục riêng `migration-2026-11-16T05-17-10.505Z` bên trong thư mục credential. Các bản chụp chứa dữ liệu tài khoản/phiên và chỉ dành cho quản trị, không đưa vào gói chia sẻ hoặc Git.

## Cho API sử dụng database này

Máy Admin đã chuyển API sang database mới và khởi động lại thành công; `/health/ready` trả database `up`. Các script npm đã hỗ trợ `.env.local` (ứng dụng) và `.env.migrate.local` (owner chỉ cho migration). Hai tệp này nằm trong `apps/api`, được Git bỏ qua và giới hạn quyền đọc trên Windows; các cấu hình API khác trước khi chuyển được giữ nguyên.

Chạy thông thường:

```powershell
npm.cmd run dev:api
```

Với máy khác, nhận credential ứng dụng và CA từ quản trị, đặt `DATABASE_URL` vào `apps/api/.env.local`, sửa đường dẫn `sslrootcert` theo máy đó. Không dùng lại đường dẫn CA riêng của máy Admin. Dừng/khởi động lại các API cũ còn trỏ Neon để tránh tiếp tục ghi dữ liệu tách biệt ở nguồn cũ. Biến `DATABASE_URL` trong môi trường Windows/dịch vụ, nếu đã đặt, vẫn có ưu tiên cao hơn các tệp env và cũng cần đổi.

Nếu cần nạp trực tiếp cấu hình riêng vào terminal:

```powershell
$lcitAccessDir = Join-Path $env:USERPROFILE '.codex\private\lcit-postgres-192.168.251.126'
$env:DATABASE_URL = (Get-Content (Join-Path $lcitAccessDir 'api.env') | Where-Object { $_ -like 'DATABASE_URL=*' }) -replace '^DATABASE_URL=', ''
npm.cmd run dev:api
```

Trên máy Admin, `npm.cmd run db:migrate` đọc thêm `.env.migrate.local` để dùng owner. Trên máy khác, cấu hình owner riêng chỉ cho người được quản trị cấu trúc. Không dùng tài khoản nhóm để chạy migration. Các tài khoản đăng nhập ứng dụng từ Neon đã được giữ nguyên; không cần bootstrap lại hoặc đổi mật khẩu chỉ vì chuyển database.

## Vận hành

- Cấu hình riêng: `/etc/postgresql/16/main/conf.d/lcit-lan.conf`; HBA: `/etc/postgresql/16/main/pg_hba.conf`. Cấu hình mặc định trước khi triển khai có hậu tố `.before-lcit`.
- Dữ liệu: `/var/lib/postgresql/16/main`; log: `/var/log/postgresql/postgresql-16-main.log`.
- TLS: `/etc/postgresql/lcit-tls`; chỉ chia sẻ `ca.crt`. Không chia sẻ `ca.key` hoặc `server.key`. Chứng thư máy chủ hết hạn **16/11/2027** và cần được gia hạn trước ngày đó; chưa cấu hình gia hạn tự động.
- Bản lưu thông tin quản trị trên máy chủ: `/root/lcit-postgres-credentials.json`, quyền 0600, chỉ root đọc.
- Chưa cấu hình sao lưu tự động. Có thể xuất bản sao lưu nhất quán bằng `pg_dump -Fc` qua tài khoản quản trị; backup kho tệp đính kèm riêng nếu sau này API lưu tệp trên máy này.

## Đã xác minh

Kết nối từ máy Admin qua LAN/VPN với kiểm tra CA/TLS thành công cho owner, app và team; app/team có DML nhưng không có CREATE schema. Thử thêm dữ liệu rồi ROLLBACK không để lại dữ liệu thử. Khóa giám sát chặn kết nối thứ hai và giữ qua COMMIT. Kết nối không TLS và mật khẩu sai bị từ chối. PostgreSQL đang online, chỉ nghe địa chỉ nội bộ/loopback và được bật tự khởi động.

Nguồn cài đặt/cấu hình: [Ubuntu PostgreSQL](https://ubuntu.com/server/docs/install-and-configure-postgresql/), [PostgreSQL HBA](https://www.postgresql.org/docs/16/auth-pg-hba-conf.html).
