# T4.4 — Triển khai pilot, sao lưu và phục hồi

Ngày chuẩn bị và kiểm chứng: **17/11/2026**. Đã có cấu hình HTTPS/Caddy, dịch vụ API/systemd, lịch sao lưu, log có mã truy vết và công cụ phục hồi. Đã thử trên môi trường riêng; **chưa cài các dịch vụ này lên máy LAN, chưa bật lịch backup thật hoặc chuyển người dùng sang URL mới**.

## Cấu hình bàn giao

| Tệp | Mục đích |
| --- | --- |
| [Caddyfile](../deploy/pilot/Caddyfile) | HTTPS với chứng thư/khóa được cấp, proxy về API loopback, chặn Swagger, giới hạn body, loại URI/header khỏi access log |
| [api.env.example](../deploy/pilot/api.env.example) | Biến môi trường pilot, tài khoản DB ứng dụng, kho tệp riêng, lịch/đích kiểm tra |
| [lcit-api.service](../deploy/pilot/lcit-api.service) | API chạy bằng tài khoản `lcit`, tự khởi động lại khi lỗi, dừng bằng SIGTERM, log vào journal |
| [backup.env.example](../deploy/pilot/backup.env.example) | Credential owner/backup riêng, không cấp cho tiến trình API |
| [backup.sh](../deploy/pilot/backup.sh), [service](../deploy/pilot/lcit-backup.service), [timer](../deploy/pilot/lcit-backup.timer) | Cửa sổ bảo trì: khóa chống chạy trùng, dừng API, sao lưu cặp DB/tệp, mở lại API nếu trước đó đang chạy; lịch đề xuất 02:15 giờ Việt Nam |
| [grants.sql](../deploy/pilot/grants.sql) | Cấp lại DML/sequence và default privileges sau phục hồi; không cấp tạo bảng cho API |
| [journald.conf](../deploy/pilot/journald.conf) | Mẫu lưu journal bền, tối đa 1 GiB và 30 ngày; thay đổi này áp dụng journal toàn máy, cần điều chỉnh theo vận hành |

Máy đích đề xuất theo môi trường hiện có: Ubuntu 24.04, Node.js **22 trở lên**, PostgreSQL 16, Caddy 2 và `pg_dump`/`pg_restore` tương thích server. Cài gói PostgreSQL client cùng major server; bộ công cụ dùng để thử ở Windows là PostgreSQL 18.6. Không dùng kết quả trên PostgreSQL 18 để thay cho kiểm chứng môi trường pilot 16.

Trước khi kích hoạt: chốt D-03/D-04 về hostname/IP API, DNS/VPN, CA và chứng thư HTTPS có SAN đúng tên/IP, cửa sổ bảo trì, người nhận lỗi backup, nơi sao lưu ngoài máy, thời hạn giữ bản, RPO/RTO. Lịch mẫu hằng ngày chỉ cho RPO đề xuất tối đa 24 giờ khi backup thành công; chưa cam kết RTO cho dữ liệu thực.

## Chuẩn bị và khởi chạy API

1. Chuẩn bị release đã qua `npm ci`, `npm run typecheck` và `npm run build`. Đặt release tại `/opt/lcit-manager` hoặc symlink đường dẫn này đến release có phiên bản; giữ release cũ cho rollback. Không đưa `.env.local`, kho tệp hoặc backup vào gói mã nguồn. `npm ci` trên máy đích phải phù hợp nền tảng Linux; không chép `node_modules` Windows sang Ubuntu.
2. Tạo tài khoản dịch vụ và thư mục:

   ```bash
   sudo useradd --system --home /var/lib/lcit-manager --shell /usr/sbin/nologin lcit
   sudo install -d -m 0750 -o root -g lcit /etc/lcit-manager
   sudo install -d -m 0700 -o lcit -g lcit /var/lib/lcit-manager/attachments
   sudo install -d -m 0700 -o root -g root /var/backups/lcit
   ```

   Nếu tài khoản đã có, dùng tài khoản đó; không tạo lại hoặc đổi chủ dữ liệu hiện có tùy tiện. Release do tài khoản triển khai/root sở hữu, API chỉ cần đọc. Kiểm tra `/usr/bin/node --version`, vì unit dùng đường dẫn này.
3. Từ `api.env.example`, tạo `/etc/lcit-manager/api.env`, owner `root:lcit`, mode `0640`. Điền credential ứng dụng và CA PostgreSQL đúng máy. Cấu hình mẫu dùng `sslmode=verify-full`, endpoint trực tiếp; không dùng Neon transaction pooler. Kho tệp phải là thư mục riêng tư, không đặt trong web root. CA PostgreSQL chỉ cần quyền đọc cho `lcit`; không cấp khóa riêng PostgreSQL cho API.
4. Dừng các API/scheduler/import/cleanup cùng ghi database; ngừng cả các thao tác SQL trực tiếp của nhóm. Sao lưu trước migration bằng credential owner theo phần sau. **Không để API Windows cũ và API pilot mới cùng ghi trong lúc chuyển đổi.**
5. Nạp `DATABASE_URL` của **owner** vào môi trường tiến trình migration riêng, chạy từ release:

   ```bash
   cd /opt/lcit-manager/apps/api
   node dist/migrate.js
   node dist/migrate.js
   ```

   Lần hai phải báo `Database is up to date.`. Không chạy seed/bootstrap tài khoản trên database đã có dữ liệu. Chạy `deploy/pilot/grants.sql` bằng owner (ví dụ `psql --set=ON_ERROR_STOP=1 --file=...`) nếu vừa phục hồi. Các role `lcit_owner`, `lcit_readwrite`, `lcit_app` phải được quản trị DB chuẩn bị riêng; role/ACL không nằm trong dump. API dùng `lcit_app`, không dùng credential owner.
6. Cài unit API vào `/etc/systemd/system/`, kiểm tra rồi khởi chạy:

   ```bash
   sudo systemd-analyze verify /etc/systemd/system/lcit-api.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now lcit-api.service
   curl --fail http://127.0.0.1:4000/health/live
   curl --fail http://127.0.0.1:4000/health/ready
   sudo journalctl -u lcit-api.service -n 30 --no-pager
   ```

Chỉ mở listener API tại loopback; từ ngoài đi qua HTTPS. Mẫu mặc định một tiến trình API/scheduler. Khóa giám sát có chống trùng nhưng việc nhân bản API vẫn cần xem xét pool, tải và quy trình sao lưu nhiều tiến trình. Readiness hiện kiểm tra kết nối DB, không thay thế xác minh migration và các ca nghiệp vụ.

## HTTPS và desktop

Đặt Caddyfile vào cấu hình Caddy do vận hành quản lý. Cấu hình các biến môi trường cho dịch vụ Caddy, ví dụ:

```ini
LCIT_API_SITE=https://api.pilot.example
LCIT_TLS_CERT=/etc/caddy/lcit/fullchain.pem
LCIT_TLS_KEY=/etc/caddy/lcit/key.pem
LCIT_API_PORT=4000
```

Đây là tên mẫu; phải đổi sang DNS/IP pilot thật. Chứng thư phải hợp lệ cho tên/IP đó; với CA nội bộ, quản trị phân phối CA đến máy Windows theo quy trình đơn vị. Không tắt kiểm tra chứng thư. Chỉ tài khoản Caddy/root đọc khóa riêng. Caddy dùng chứng thư đã cấp nên đơn vị chịu trách nhiệm theo dõi hạn và gia hạn; không mặc định có ACME cho hostname nội bộ.

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
curl --fail --cacert /path/to/api-ca.crt https://api.pilot.example/health/ready
```

Lệnh validate cần được chạy với các biến của Caddy đã nạp; cấu hình môi trường dịch vụ không tự có trong shell quản trị. Kiểm tra cổng 80/443 trong vùng LAN/VPN đã chốt, không mở PostgreSQL ra Internet. `/docs` và `/docs-json` bị chặn ở proxy; API pilot cũng đặt `API_DOCS_ENABLED=off`.

Desktop build đặt `NEXT_PUBLIC_API_URL=https://api.pilot.example` trước khi build. CORS của API phải chứa đúng origin Tauri/browser được dùng; CSP Tauri hiện cho HTTPS. Thử cả health, đăng nhập và tải tệp từ bộ cài. CORS không thay cho quyền tại API. Với reverse proxy loopback, giới hạn thử đăng nhập theo địa chỉ kết nối được chia sẻ giữa người dùng proxy; giữ giới hạn này và đánh giá trong pilot, không tự tin cậy `X-Forwarded-For`.

## Log và theo dõi

API ghi mỗi yêu cầu hoàn tất/ngắt kết nối một JSON event `http.request`: UTC, `requestId`, method, **route mẫu** (ví dụ `/api/v1/applications/:id`), HTTP status, thời gian xử lý và `completed`. Mã được API tạo mới, trả `X-Request-Id`, dùng chung với lỗi/audit. Log không ghi body, query, URL thô, header, cookie, password, token hoặc nội dung tệp. Endpoint không khớp chỉ ghi `<unmatched>`.

```bash
sudo journalctl -u lcit-api.service --since '1 hour ago' --no-pager
sudo journalctl -u lcit-backup.service -n 50 --no-pager
sudo systemctl list-timers lcit-backup.timer
```

Tra sự cố bằng `X-Request-Id` trên phản hồi/giao diện và `request_id` trong audit. HTTP 5xx, readiness 503, lần chạy giám sát lỗi và backup thất bại cần được vận hành theo dõi. `GET /api/v1/monitoring/jobs` chỉ dành cho quản trị cho biết lần chạy lịch gần nhất. Log lỗi nghiệp vụ đã che nội dung exception; không bật log dump toàn bộ HTTP/SQL để điều tra trên dữ liệu thật.

Có thể dùng mẫu journald để giữ log qua reboot; đánh giá tác động toàn máy trước khi cài và restart journald. Không coi log là bản sao dữ liệu hoặc backup. Quyền đọc journal/backup chỉ cấp cho vận hành được phân công.

## Sao lưu cặp DB và kho tệp

`apps/api/scripts/recovery.cjs` chỉ đọc các biến **LCIT_BACKUP_*** hoặc **LCIT_RESTORE_***; không tự đọc `.env.example`/`.env.local` và không tự lấy database ứng dụng. Build API trước để có phần kiểm tra cấu hình database.

Đảm bảo toàn bộ writer và cleanup đã dừng. Đối với máy còn truy cập SQL trực tiếp, dừng/điều phối cả người dùng đó. Công cụ giữ SHARE lock trên các bảng và dùng exported snapshot cho `pg_dump`, nhưng khóa DB không thể ngăn một tiến trình độc lập xóa file ngoài database; cửa sổ bảo trì vẫn bắt buộc.

```powershell
# Ví dụ Windows: các giá trị riêng được nạp từ kho bí mật, không lưu trong repo.
$env:LCIT_BACKUP_DATABASE_URL = $lcitOwnerUrl
$env:LCIT_BACKUP_ATTACHMENTS_DIR = 'D:\private-store\attachments'
$env:LCIT_BACKUP_MAINTENANCE = 'on'
$env:LCIT_PG_BIN = 'C:\path\to\postgresql\bin'
node apps/api/scripts/recovery.cjs backup 'D:\private-backups\20261117T020000Z'
```

Trên Linux dùng `export` cho cùng các biến. Thư mục đích phải **chưa tồn tại**, nằm ngoài kho tệp và parent đã chuẩn bị. Bộ sao lưu gồm `database.dump` custom-format, `attachments/<2 ký tự>/<storage_key>` và `manifest.json`. Dump chứa schema `lcit` và extension `pg_trgm` ở `public` để phục hồi được chỉ mục tra cứu.

Manifest là dấu hoàn tất ghi cuối, có phiên bản PostgreSQL, danh sách migration, số dòng mỗi bảng, SHA-256/kích thước dump và từng tệp. Mọi tệp `available`, kể cả đã lưu trữ, phải tồn tại và đúng SHA-256/kích thước; thiếu hoặc sai thì **backup thất bại**, không tạo manifest hoàn tất. Không phục dựng nội dung thiếu, bỏ qua tệp lỗi hoặc tự sửa dữ liệu nguồn. Tệp pending/orphan không được phục vụ và không nằm trong bản sao nội dung; metadata pending vẫn có trong dump, cleanup xử lý sau khi mở lại API.

**Lưu ý dữ liệu hiện có:** [POSTGRES_LAN.md](POSTGRES_LAN.md) ghi nhận 3 tệp đã lưu trữ bị thiếu nội dung từ trước khi chuyển. Cần kiểm kê status và đúng kho tệp của API đang dùng trước khi kích hoạt backup thật; công cụ sẽ từ chối nếu đó là bản ghi `available` thiếu nội dung. Không dùng thử phục hồi tổng hợp ở T4.4 để kết luận kho thật đã đầy đủ.

Thư mục backup chứa cả dữ liệu tài khoản/phiên và tài liệu riêng: mode 0700 trên Linux, ACL chỉ tài khoản vận hành/SYSTEM trên Windows, lưu bản sao ngoài máy được mã hóa. SHA-256 phát hiện hỏng file, không xác thực nguồn hoặc chống sửa manifest có chủ đích. Chỉ phục hồi backup tin cậy do đơn vị quản lý. Không commit/chia sẻ dump, manifest thật, chứng thư có khóa hoặc credential.

Kích hoạt lịch sau khi chốt cửa sổ dừng API, thử chạy tay và có giám sát lỗi:

```bash
sudo install -m 0600 -o root -g root /path/to/prepared-backup.env /etc/lcit-manager/backup.env
sudo install -m 0644 deploy/pilot/lcit-backup.service deploy/pilot/lcit-backup.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/lcit-backup.service /etc/systemd/system/lcit-backup.timer
sudo systemctl daemon-reload
sudo systemctl start lcit-backup.service
# Xác minh manifest và thử restore sang DB riêng trước khi bật lịch:
sudo systemctl enable --now lcit-backup.timer
```

Lịch mẫu 02:15 Việt Nam, `Persistent=true` chạy bù sau khi máy khởi động lại. Script mở lại API sau backup kể cả khi backup lỗi, nếu API vốn đang chạy. Chưa tự gửi email/cảnh báo, chưa tự xóa bản cũ hoặc tải bản sao ra ngoài máy; đơn vị phải chốt giám sát, mã hóa, lưu ngoài máy và retention trước khi dùng pilot.

## Phục hồi và rollback migration

1. Giữ nguyên hệ thống nguồn; tạo **database riêng trống** bằng quản trị PostgreSQL, với owner phù hợp. Không dùng `--clean`, không xóa schema/database đang hoạt động. Cài sẵn gói extension `pg_trgm` trên máy đích và dùng `pg_restore` cùng bộ công cụ đã dump. Bản dump không chứa role toàn cluster hoặc cấu hình TLS/HBA.
2. Chuẩn bị thư mục kho đích **chưa tồn tại**, parent có quyền ghi. Xác minh bản backup tin cậy, phiên bản ứng dụng tương thích và đủ dung lượng.
3. Chạy:

   ```powershell
   $env:LCIT_RESTORE_DATABASE_URL = $lcitNewOwnerUrl
   $env:LCIT_RESTORE_ATTACHMENTS_DIR = 'D:\private-store\restored-attachments'
   $env:LCIT_PG_BIN = 'C:\path\to\postgresql\bin'
   node apps/api/scripts/recovery.cjs restore 'D:\private-backups\20261117T020000Z'
   ```

4. Công cụ kiểm tra toàn bộ hash trước khi đụng DB, từ chối database có schema `lcit`/quan hệ người dùng và thư mục đích tồn tại, chép vào thư mục staging mới rồi restore DB bằng một transaction. Đối chiếu số dòng và tham chiếu tệp, thu hồi mọi phiên đang hoạt động, cuối cùng đổi tên staging thành kho đích. Người dùng phải đăng nhập lại.
5. Nếu restore lỗi: không mở API vào đích đó. Giữ log, staging và bản backup để điều tra. `pg_restore` rollback lỗi SQL, nhưng lỗi sau khi DB đã commit (đối chiếu/thu hồi phiên/đổi tên kho) không thể rollback cả DB và filesystem; dùng **database/thư mục mới** cho lần thử kế tiếp. Công cụ không tự dọn dữ liệu đích.
6. Chạy migration từ phiên bản muốn sử dụng và kiểm tra lần hai không còn pending. Chạy `grants.sql` bằng owner, đổi quyền thư mục phục hồi cho tài khoản API. Đặt URL database và `ATTACHMENTS_DIR` của **API kiểm chứng riêng**, tắt monitoring/cleanup lúc đối chiếu. Không chạy API pilot và bản kiểm chứng cùng sửa một dữ liệu.
7. Xác minh readiness, đăng nhập mới, tổng danh mục/phân quyền, trạng thái tác vụ và tải tệp mẫu có SHA-256 khớp. Sau khi đạt mới dừng API cũ, đổi cấu hình pilot sang cặp database/kho mới và khởi động lại. Giữ bản trước chuyển đổi cho đến khi chốt nghiệm thu.

Migration hiện chạy transaction và chỉ áp dụng tệp chưa có trong ledger. Không sửa migration đã áp dụng, không tự chạy SQL hạ phiên bản. Nếu release mới lỗi mà schema vẫn tương thích, chuyển release cũ và kiểm tra lại. Nếu schema đã đổi không tương thích, phục hồi **cả DB lẫn tệp từ cùng bundle** vào đích mới, rồi dùng release tương ứng bản sao lưu. Rollback sẽ mất thay đổi sau thời điểm backup; vận hành phải chốt thời điểm/cửa sổ trước khi chuyển người dùng.

## Kết quả kiểm chứng và giới hạn

- Hai ca T4.4 đạt, không bỏ qua: log an toàn; sao lưu/khôi phục thực với PostgreSQL 18.6 và Caddy 2.11.9 trên Windows x64.
- Kiểm tra hồi quy sau thay đổi: **29/29** ca T4.3 đạt, không bỏ qua, p95 tìm kiếm 114,45 ms; build/kiểm tra kiểu API đạt. Các artifact hồi quy của T4.4 được lưu riêng dưới tiền tố `t44-regression` để giữ nguyên kết quả bàn giao T4.3.
- Khôi phục **33 bảng, 9 migration, 1 tệp PDF**; migration chạy lại báo up to date; đăng nhập mới và tải qua API thành công, SHA-256 `9b0acb3f78bc4b227d0dc81bf065b2ab7b194af6fb282e13dbf3dfdce428c786`.
- Dump/tệp cố tình hỏng bị từ chối trước khi ghi DB; database nguồn có dữ liệu bị từ chối; bearer token cũ không dùng lại được sau restore.
- HTTPS proxy đến API phục hồi trả readiness 200 với CA được cung cấp; không truyền CA thì kết nối bị từ chối. HSTS đúng; Swagger trả 404; không sửa trust store Windows.
- `caddy validate` đạt; `backup.sh` qua kiểm tra cú pháp Bash. Unit systemd/permission/service restart/timer chưa được chạy trên Ubuntu thật; phải `systemd-analyze verify` và chạy tay trước khi bật lịch.
- Kết quả JUnit bàn giao: [t44-junit.xml](test-results/t44-junit.xml). Database và file dùng cho test là tổng hợp, không đọc hoặc sao lưu dữ liệu LAN/Neon thật.

Chạy lại `npm.cmd run test:t44` cần hai URL database trống (`LCIT_TEST_DATABASE_URL`, `LCIT_TEST_RESTORE_DATABASE_URL`) và `LCIT_PG_BIN`. Để kiểm tra HTTPS thật trong cùng ca, đặt thêm `LCIT_TEST_CADDY_BIN`, `LCIT_TEST_TLS_CERT`, `LCIT_TEST_TLS_KEY`, `LCIT_TEST_TLS_CA` trỏ tới chứng thư chỉ dùng thử, có SAN localhost. Nếu không đặt Caddy, kết quả diagnostic ghi `tls=not_requested`, không được coi là đã kiểm chứng HTTPS.

Nguồn đối chiếu cấu hình: [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html), [pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html), [biến môi trường libpq](https://www.postgresql.org/docs/current/libpq-envars.html), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [TLS](https://caddyserver.com/docs/caddyfile/directives/tls), [lọc log](https://caddyserver.com/docs/caddyfile/directives/log), [systemd service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).
