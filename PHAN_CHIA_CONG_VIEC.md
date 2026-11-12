# Phân chia công việc LCIT_Manager

Phân công cho **hai người**, dựa trên mã task, phụ thuộc và tiêu chí nghiệm thu trong [SPEC.md](SPEC.md). A và B là ký hiệu có thể thay bằng tên thành viên. Mỗi task có một người chịu trách nhiệm chính và người còn lại kiểm tra các phần giao nhau.

- **Người A** phụ trách nền tảng API và PostgreSQL, đăng nhập/phân quyền, nhập Excel, giám sát và vận hành pilot.
- **Người B** phụ trách ứng dụng Windows, API máy chủ/tên miền và tra cứu, kho tệp, báo cáo, SSH/RDP phía desktop và bộ cài.

Ngày công là ước lượng lập kế hoạch, giả định hai người có kinh nghiệm tương đương. Mỗi ước lượng bao gồm triển khai, kiểm thử phạm vi task và bàn giao. Ngày công thể hiện công sức. Lịch bàn giao phụ thuộc vào thời điểm tích hợp và việc có dữ liệu mẫu, VPN, máy Windows kiểm thử.

## Tổng hợp khối lượng

| Giai đoạn | Người A | Người B |
| --- | ---: | ---: |
| 0. Nền tảng | 3 | 3 |
| 1. Đăng nhập, danh mục và tra cứu | 10 | 10 |
| 2. Tài liệu và nhập Excel | 6 | 6 |
| 3. Giám sát, thông báo và báo cáo | 7,5 | 7,5 |
| 4. SSH/RDP, kiểm thử tích hợp và phát hành thử | 6,5 | 6,5 |
| **Tổng ngày công** | **33** | **33** |
| **Tổng số task** | **18** | **16** |

## Bảng phân công theo task

Cột **Sau** ghi phụ thuộc trực tiếp theo SPEC. Dấu **—** nghĩa là có thể bắt đầu ngay. Dùng tiêu chí **Hoàn tất khi** của task tương ứng trong [SPEC.md](SPEC.md#tasks) để xác nhận bàn giao.

### Giai đoạn 0 — Nền tảng

| Task | Phụ trách | Công việc | Sau | Ngày công |
| --- | --- | --- | --- | ---: |
| T0.1 | B | Kiểm tra Node/npm, Rust/MSVC, WebView2, PostgreSQL hoặc Docker Engine | — | 0,5 |
| T0.2 | A | Khởi tạo workspace TypeScript cho desktop và API, cấu hình build và kiểm tra kiểu | — | 1 |
| T0.3 | A | Dựng PostgreSQL phát triển, cấu hình môi trường mẫu và migration đầu tiên | T0.1, T0.2 | 1 |
| T0.4 | A | Tạo NestJS bootstrap, health endpoints và khung OpenAPI | T0.2, T0.3 | 1 |
| T0.5 | B | Tạo Next.js static export, khung Tauri và màn hình kiểm tra kết nối API | T0.1, T0.2, T0.4 | 1,5 |
| T0.6 | B | Tạo bộ dữ liệu kiểm thử tổng hợp gồm hai đơn vị, hai DC và IP nội bộ trùng | — | 1 |

### Giai đoạn 1 — Đăng nhập, danh mục và tra cứu

| Task | Phụ trách | Công việc | Sau | Ngày công |
| --- | --- | --- | --- | ---: |
| T1.1 | A | Tạo migration tài khoản, đơn vị, DC, phiên, phân công, danh mục và liên kết | T0.3 | 2 |
| T1.2 | A | Làm login, logout, `/me`, băm mật khẩu, giới hạn thử sai và thu hồi phiên | T0.4, T1.1 | 2 |
| T1.3 | A | Làm guard và bộ lọc theo tài nguyên cho ba vai trò, quản lý tài khoản/phân công | T1.1, T1.2 | 3 |
| T1.4 | A | Làm API đơn vị, DC, ứng dụng, CSDL và liên kết ứng dụng–CSDL | T1.3 | 2 |
| T1.5 | B | Làm API máy chủ, địa chỉ và điểm SSH/RDP | T1.3 | 2 |
| T1.6 | B | Làm API tên miền, bản ghi DNS, điểm TLS và liên kết với ứng dụng/máy chủ | T1.4, T1.5 | 2 |
| T1.7 | B | Làm API tra cứu và chỉ mục theo IP, hostname, tên ứng dụng và đơn vị | T1.6 | 2 |
| T1.8 | B | Làm màn hình đăng nhập, danh mục, chi tiết, phân công và tìm kiếm | T0.5, T1.2, T1.4, T1.5, T1.6, T1.7 | 4 |
| T1.9 | A | Ghi audit đăng nhập, thay đổi quyền và thay đổi danh mục | T1.2, T1.3, T1.4, T1.5, T1.6 | 1 |

### Giai đoạn 2 — Tài liệu và nhập Excel

| Task | Phụ trách | Công việc | Sau | Ngày công |
| --- | --- | --- | --- | ---: |
| T2.1 | B | Làm kho tệp, API tải lên/xuống, kiểm tra quyền và dọn tệp chờ | T1.3, T1.6, T1.9 | 2 |
| T2.2 | A | Làm parser Excel, danh sách sheet, ánh xạ và chuẩn hóa dòng | T0.6, T1.6 | 2 |
| T2.3 | A | Làm API xem trước, phát hiện trùng và lưu quyết định theo dòng | T2.2, T1.7 | 2 |
| T2.4 | A | Làm API xác nhận nhập, transaction, khóa lô và báo cáo kết quả | T2.3, T1.9 | 2 |
| T2.5 | B | Làm giao diện tài liệu và trình hướng dẫn nhập Excel | T1.8, T2.1, T2.4 | 3 |
| T2.6 | B | Đối chiếu một tệp thực đã ẩn dữ liệu và chốt quy tắc gộp | T2.5 | 1 |

### Giai đoạn 3 — Giám sát, thông báo và báo cáo

| Task | Phụ trách | Công việc | Sau | Ngày công |
| --- | --- | --- | --- | ---: |
| T3.1 | A | Tạo migration kết quả kiểm tra, cảnh báo và thông báo, cấu hình lịch | T1.6 | 1 |
| T3.2 | A | Làm tác vụ đối chiếu hạn nhập tay và hạn TLS theo lịch | T3.1 | 2 |
| T3.3 | A | Làm bộ kiểm tra DNS/TLS, giới hạn đích, timeout và quy tắc gián đoạn | T3.1 | 3 |
| T3.4 | A | Làm API thông báo, trạng thái đã đọc, phân phối theo phạm vi | T3.2, T3.3, T1.3 | 1,5 |
| T3.5 | B | Làm màn hình cảnh báo, đồng bộ và thông báo khay Windows | T3.4, T1.8 | 2,5 |
| T3.6 | B | Làm truy vấn dashboard và báo cáo dùng chung bộ lọc/phạm vi quyền | T1.6, T1.7 | 2 |
| T3.7 | B | Làm xuất Excel, giao diện báo cáo và ghi audit xuất | T3.6, T1.8, T1.9 | 3 |

### Giai đoạn 4 — SSH/RDP, kiểm thử tích hợp và phát hành thử

| Task | Phụ trách | Công việc | Sau | Ngày công |
| --- | --- | --- | --- | ---: |
| T4.1 | A | Làm API cấp quyền mở kết nối và audit kết quả cấp quyền | T1.3, T1.5, T1.9 | 1,5 |
| T4.2 | B | Làm lệnh Tauri mở `ssh.exe` và `mstsc.exe`, tích hợp nút kết nối | T0.5, T1.8, T4.1 | 2,5 |
| T4.3 | A | Chạy bộ kiểm thử quyền, đồng thời, hiệu năng và các luồng xuyên suốt | T2.5, T3.5, T3.7, T4.2 | 3 |
| T4.4 | A | Chuẩn bị triển khai pilot, cấu hình HTTPS, log, sao lưu và phục hồi | T0.4, T2.1, T3.1 | 2 |
| T4.5 | B | Build bộ cài Windows và thử trên máy sạch | T3.5, T4.2 | 2 |
| T4.6 | B | Chạy UAT, chốt quyền và cấu hình sản xuất | T2.6, T4.3, T4.4, T4.5 | 2 |

## Bắt đầu và bàn giao

**Bắt đầu ngay.** A làm **T0.2** để tạo workspace. B làm **T0.1** và **T0.6** để kiểm tra môi trường và chuẩn bị fixture. Hai người thống nhất sớm dữ liệu mẫu và hợp đồng API. B có thể chuẩn bị giao diện bằng dữ liệu giả lập trong lúc API đang được triển khai. Tích hợp và nghiệm thu theo các phụ thuộc trong bảng.

| Bàn giao | Người giao | Người nhận | Đầu ra cần có |
| --- | --- | --- | --- |
| Nền tảng API → desktop | A | B | URL phát triển, lệnh chạy API, health endpoint và OpenAPI từ T0.4 để B tích hợp T0.5. B cung cấp kết quả kiểm tra công cụ từ T0.1 để A dựng PostgreSQL ở T0.3. |
| Phân quyền → danh mục và tra cứu | A | B | Guard, quy tắc lọc theo tài nguyên và fixture hai đơn vị ở T1.3. B dùng cho T1.5–T1.7, sau đó cung cấp các API và ca kiểm thử để A hoàn tất tích hợp nhật ký T1.9. |
| Nhập Excel → giao diện | A | B | Chốt trước cấu trúc dòng xem trước, lỗi theo ô và kết quả xác nhận. B dựng giao diện T2.5 với fixture trước khi tích hợp API T2.4. |
| Thông báo → ứng dụng Windows | A | B | API danh sách thông báo, đánh dấu đã đọc và fixture có cảnh báo mới từ T3.4 để B thử đồng bộ và thông báo khay ở T3.5. |
| Cấp quyền SSH/RDP → bộ cài và pilot | A | B | Điểm truy cập mẫu, API T4.1 và ca kiểm thử quyền. B thử T4.2 và T4.5 trên Windows rồi chuyển kết quả cho A tổng hợp kiểm thử tích hợp T4.3. |

Trước nghiệm thu pilot, A kiểm tra phân quyền, nhật ký và khôi phục dữ liệu. B kiểm tra luồng sử dụng trên bộ cài Windows. Hai người cùng tham gia UAT do B điều phối và đối chiếu các quyết định D-01 đến D-04 trong SPEC.
