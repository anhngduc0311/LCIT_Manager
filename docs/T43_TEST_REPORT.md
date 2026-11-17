# T4.3 — Kiểm thử tích hợp và hiệu năng

Ngày thực hiện: **17/11/2026**, giờ Việt Nam. Phạm vi: quyền, đồng thời, luồng nghiệp vụ xuyên suốt, hiệu năng tìm kiếm, build và lệnh SSH/RDP. Không thao tác lên database LAN/Neon đang dùng.

**Kết quả lượt cuối:** 29/29 ca API/tích hợp đạt, 0 lỗi, 0 bỏ qua; thời gian 72,01 giây. Rust: 9 ca mặc định đạt và 2 ca Windows thật chạy riêng đạt. `npm run typecheck` và `npm run build` toàn workspace đạt. p95 tìm kiếm **113,50 ms**, 700 yêu cầu, 0 lỗi. Mã revision trong JSON là commit nền trước các thay đổi T4.3 chưa commit; kết quả được chạy trên mã làm việc kèm bàn giao này.

## Chạy lại

Chuẩn bị PostgreSQL dùng riêng cho kiểm thử, chưa có schema `lcit`, với tài khoản được tạo/xóa schema, bảng, trigger và function. Không dùng database phát triển, pilot hoặc sản xuất. Không chạy hai bộ kiểm thử vào cùng một database.

```powershell
# Ví dụ trên PostgreSQL thử nghiệm do người chạy chuẩn bị:
$env:LCIT_TEST_DATABASE_URL = 'postgresql://test_user:test_password@127.0.0.1:55443/lcit_t43?sslmode=disable'
npm.cmd run test:t43
npm.cmd run typecheck
npm.cmd run build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
# Mở cửa sổ SSH/RDP thật; chỉ chạy trên máy Windows kiểm thử:
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --ignored
```

`test:t43` build API rồi chạy toàn bộ test tuần tự, gồm hai test mới `phase4-system` và `phase4-performance`. Lệnh từ chối thiếu URL, Neon transaction pooler và database đã có schema `lcit`, không tự lấy cấu hình database ứng dụng. Mỗi file tạo schema riêng rồi dọn schema mình tạo; kho tệp của test xuyên suốt nằm trong thư mục tạm riêng. Khi lỗi để lại schema, kiểm tra đúng database thử trước khi dọn thủ công; runner không tự xóa một schema tồn tại trước lượt chạy.

Đầu ra nằm tại `test-results/t43-junit.xml` và `test-results/t43-performance.json` (Git bỏ qua). Bản kết quả bàn giao ở [t43-performance.json](test-results/t43-performance.json) và [t43-junit.xml](test-results/t43-junit.xml). Các tệp này không chứa URL database, mật khẩu hay token.

Không chạy build hoặc nhập dữ liệu khác đồng thời với lượt đo hiệu năng. Cần hoàn tất kiểm thử giao diện trước hoặc sau phép đo để kết quả so sánh được.

## Môi trường

| Thành phần | Cấu hình |
| --- | --- |
| Máy đo | Windows 10 x64, build 19045; Intel Xeon E5-2673 v3 @ 2,40 GHz; 48 CPU logic; RAM 63,88 GiB |
| Node / npm | 26.13.0 / 11.20.0 |
| API / desktop | NestJS 11; Next.js 16.4.6; Tauri 2, Rust MSVC theo Cargo.lock |
| Database | PostgreSQL 18.6 x64 tạm thời, chỉ nghe `127.0.0.1:55443`; database `lcit_t43`, tách biệt database giao diện `lcit_t43_ui` |
| Cấu hình PostgreSQL | `shared_buffers=128 MiB`, `work_mem=4 MiB`, `max_connections=100`, JIT bật; chi tiết trong JSON |
| Đường đo | HTTP loopback, API và PostgreSQL cùng máy, không có proxy hoặc TLS; pool API tối đa 5 kết nối |
| Lịch | Tắt cron trong runner; các test lịch/tác vụ chủ động bật và gọi riêng theo ca |
| Giao diện smoke | Bản sao mã desktop hiện tại trên cổng 31043, API 44043, dữ liệu tổng hợp; không dừng ứng dụng đang dùng |

Database thử dùng PostgreSQL 18.6; database LAN hiện dùng 16.15. Kết quả này không thay cho phép đo qua LAN/VPN/HTTPS và kiểm thử trên PostgreSQL 16 tại pilot.

## Kết quả theo FR

| Yêu cầu | Bằng chứng và kết quả |
| --- | --- |
| FR-01 — Phiên, đăng nhập | Đạt: mật khẩu băm/salt, sai mật khẩu, khóa tài khoản, hạn/thu hồi phiên, đăng xuất và giới hạn thử sai; `phase1`, `phase4-system`. |
| FR-02 — Phân quyền | Đạt ở API: ba vai trò, hai đơn vị, hai chuyên viên, ID trực tiếp, tài nguyên dùng chung, tìm kiếm/tệp/xuất/kết nối; thu hồi phân công có hiệu lực ngay với token đang dùng. |
| FR-03–05 — Danh mục | Đạt: CRUD/lưu trữ, khóa ngoại/unique, liên kết và dữ liệu dùng chung, IP nội bộ trùng ở hai mạng, chuẩn hóa host/IP/cổng; `phase1`. |
| FR-06 — Tra cứu | Đạt: IP, hostname, tên miền, ứng dụng, đơn vị; không có kết quả, phân trang, phạm vi quyền. Smoke giao diện tìm `10.42.0.15` trả APP-A/LAN-A và APP-B/LAN-B. |
| FR-07 — Tệp | Đạt: loại/kích thước/chữ ký, quyền upload/download, nội dung tải lại, lỗi giữa bước ghi, dọn tệp chờ và tệp mồ côi; `phase2-attachments`, `phase4-system`. |
| FR-08 — Excel | Đạt: sheet/ánh xạ, số dòng/cột lỗi, trùng/xung đột, xem trước không ghi, xác nhận nguyên tử, thử lại đồng thời, ảnh chụp cũ; `phase2-imports`, `phase4-system`. Smoke giao diện: tải fixture, tự ánh xạ 9 cột, nhận 2 dòng đã có + 1 trùng + 1 lỗi IP; gộp dòng 2 trả 0 mới/1 gộp/3 bỏ qua. |
| FR-09 — Hạn | Đạt ở tác vụ máy chủ: mốc 90/30/14/7, quá hạn, gia hạn, bỏ lỡ lịch, múi giờ và chống lặp; `phase3-expiry`. |
| FR-10 — DNS/TLS | Đạt trên fixture/local TLS: DNS, timeout, xác thực, hostname, chứng thư hết hạn, giới hạn đích/song song, hai lỗi mới gián đoạn, một thành công phục hồi; `phase3-network`. |
| FR-11 — Thông báo | Đạt ở API: lưu bền, hộp thư/phạm vi, đã đọc, thu hồi quyền, đăng nhập lại nhận cảnh báo tạo trước đó; `phase3-notifications`, `phase4-system`. Thông báo Windows thật và hành vi chạy ở khay khi đóng/mở app cần xác nhận trên bộ cài tại T4.5. |
| FR-12 — SSH/RDP | Đạt ở API và Rust: đích đã lưu, cấp/thu hồi quyền, sửa đích làm quyền cũ hết hiệu lực, đối số an toàn, thiếu client/đầu vào sai. Đã chạy thêm 2 ca Windows thật: SSH tới cổng loopback đóng trả 255; RDP khởi chạy và được test dừng theo PID. Chưa đăng nhập một máy đích pilot qua VPN. |
| FR-13 — Audit | Đạt phần API: actor/action/đích/kết quả, che bí mật, ghi cùng transaction, rollback khi audit lỗi; `phase1`, attachments/imports/reports/access và kiểm tra bí mật trong `phase4-system`. Kết quả native được kiểm tra riêng qua Rust; chưa đối chiếu `launch.log` từ bộ cài. |
| FR-14 — Báo cáo | Đạt: dùng chung bộ lọc/quyền, một ứng dụng nhiều máy cùng DC không đếm lặp, Excel khớp màn hình và giữ ô giống công thức dưới dạng văn bản; `phase3-reports`, `phase4-system`. Smoke giao diện lọc đơn vị A còn 1 dòng. |

## Đồng thời và khả năng phục hồi

- Bốn yêu cầu xác nhận cùng lô nhận cùng kết quả, không nhân bản dữ liệu hoặc audit.
- Hai cập nhật ứng dụng cùng phiên bản: đúng một HTTP 200, một HTTP 409, chỉ một audit cập nhật thành công.
- Nhập gặp lỗi ghi audit rollback toàn bộ; thay đổi danh mục sau preview buộc xem trước lại.
- Cùng tác vụ/cảnh báo chạy lại hoặc cạnh tranh vẫn có khóa/unique chống trùng; mất kết nối được ghi nhận và phục hồi theo test.
- Lỗi lưu tệp không phục vụ nội dung chờ; cleanup đối chiếu file store.

Trong quá trình chạy tổng hợp có lượt đăng nhập timeout khi build/kiểm tra khác đang chạy; teardown cũ xóa schema trước khi dừng API làm lượt lỗi kéo dài và ảnh hưởng các file kế tiếp. Đã sửa `phase1` dừng và chờ API thoát trước khi dọn schema, đóng pool cuối cùng, đồng thời thêm tên method/path vào lỗi mạng (không log body/token). Lượt chạy cuối phải dùng kết quả JUnit bàn giao, không lấy lượt chạy bị lỗi làm bằng chứng đạt.

Smoke giao diện cũng có một lần tải workbook HTTP 500; thử lại cùng fixture đạt, kiểm tra trực tiếp API tải cùng fixture trả 201. Giữ đây là quan sát lỗi gián đoạn của môi trường, chưa kết luận nguyên nhân. Khi chạy pilot cần theo dõi mã truy vết và tải đồng thời để xác nhận không tái diễn.

## Hiệu năng NFR-03

Fixture gồm **10.000 ứng dụng, 20.000 máy chủ, 20.000 địa chỉ và 10.000 tên miền**, chia hai đơn vị và hai DC; mỗi ứng dụng có hai máy chủ. Có 20 tài khoản/phiên khác nhau: 7 quản trị, 7 lãnh đạo, 6 chuyên viên. Lãnh đạo/chuyên viên chỉ thấy 5.000 ứng dụng được cấp. Phiên được chuẩn bị trực tiếp trong DB; phép đo chỉ tính tìm kiếm sau xác thực, không tính băm mật khẩu/đăng nhập.

Warm-up 140 yêu cầu, sau đó đo 700 yêu cầu (100 mỗi dạng: IP, hostname, tên miền, tên ứng dụng, đơn vị, không có kết quả, trang 2). Mỗi người dùng giữ một yêu cầu đang chạy, không có thời gian nghỉ giả lập. Đo từ trước HTTP fetch đến sau khi nhận/đọc kết quả JSON; kiểm tra HTTP 200, tổng/số dòng, ID không trùng, phạm vi, máy chủ và trang trả về. Không bỏ yêu cầu lỗi ra khỏi thống kê; test thất bại nếu có lỗi hoặc p95 tổng/bất kỳ dạng tìm kiếm vượt 1.000 ms.

Số đo chính xác và phân bố theo dạng tìm kiếm/vai trò nằm trong JSON bàn giao. Phép đo này có cache đã làm nóng và kéo dài ngắn; không chứng minh tải bền nhiều giờ, đĩa chậm, WAN, TLS/proxy hoặc thời gian hiển thị UI.

| Dạng tìm kiếm | Số yêu cầu | p95 (ms) |
| --- | ---: | ---: |
| IP | 100 | 88,24 |
| Hostname | 100 | 104,24 |
| Tên miền | 100 | 99,89 |
| Tên ứng dụng | 100 | 118,81 |
| Đơn vị | 100 | 111,62 |
| Không có kết quả | 100 | 95,71 |
| Trang 2 | 100 | 118,43 |
| **Tổng** | **700** | **113,50** |

## Các NFR còn lại và bàn giao

| NFR | Kết luận |
| --- | --- |
| NFR-01 | Đạt phần mật khẩu/phiên/giới hạn thử sai, audit không chứa bí mật, chống công thức Excel. HTTPS và cấu hình pilot thuộc T4.4. |
| NFR-02 | Đạt các ca transaction, version, nhập lặp, lịch lặp và lỗi ghi tệp nêu trên. |
| NFR-03 | Đối chiếu `passed` và p95 trong JSON bàn giao; chỉ áp dụng cấu hình máy/đường đo đã ghi. |
| NFR-04 | Health/readiness, migration chạy lại, audit/request ID và trạng thái/khóa lịch đã có test. Khôi phục backup DB + kho tệp chưa thực hiện trong T4.3; thuộc T4.4. |
| NFR-05 | Typecheck, build static, Rust tests và smoke UI đạt. Máy Windows sạch, bộ cài, khay/thông báo Windows và đích SSH/RDP thật qua mạng pilot thuộc T4.5/T4.6. |

T4.3 cung cấp bộ kiểm thử chạy lại được và kết quả theo FR/NFR. Các giới hạn trên cần được giữ trong danh sách nghiệm thu T4.4–T4.6; báo cáo này không ký thay UAT hoặc xác nhận sẵn sàng sản xuất.
