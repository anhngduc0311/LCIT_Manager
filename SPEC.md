# SPEC.md — LCIT_Manager

## IDEA

LCIT_Manager thay thế bảng tính quản lý hệ thống bằng một ứng dụng Windows dùng chung dữ liệu. Khi nhận một IP, tên miền hoặc tên ứng dụng, người vận hành cần xác định được hệ thống, máy chủ liên quan, đơn vị chịu trách nhiệm và cách truy cập. Người phụ trách cần biết hạn gia hạn sắp tới. Lãnh đạo cần báo cáo theo đơn vị và trung tâm dữ liệu (DC).

Nguồn thiết kế là [ARCHITECTURE.md](https://chatgpt.com/library?file_id=libfile_4cf88514608481919282dd930e4c733d&account_id=personal). Kiến trúc triển khai gồm Tauri v2, Next.js xuất tĩnh, NestJS và PostgreSQL. Nhiều máy Windows dùng một API tập trung qua HTTPS. Tài liệu này là đặc tả trước triển khai.

Bản dùng thử phải thực hiện được một ca từ đầu đến cuối với dữ liệu mẫu. Quản trị phân công Chuyên viên, nhập bảng tính, rồi Chuyên viên tra cứu bằng IP hoặc tên miền và thấy đúng người phụ trách. Hệ thống tạo cảnh báo đúng mốc khi ứng dụng Windows đã đóng. Người có quyền mở SSH/RDP trên máy kiểm thử và Lãnh đạo tải được báo cáo theo bộ lọc.

Phạm vi bản đầu là vận hành trực tuyến, nhắc hạn theo dữ liệu nhập, kiểm tra DNS/TLS ở các đích được cấu hình và mở trình khách SSH/RDP của Windows. Đồng bộ ngoại tuyến, ghi nội dung phiên SSH/RDP và tự đồng bộ ngày đăng ký tên miền thuộc phạm vi mở rộng.

## Requirements

### Yêu cầu chức năng và tiêu chí nghiệm thu

| ID | Yêu cầu | Tiêu chí nghiệm thu |
| --- | --- | --- |
| FR-01 | Đăng nhập bằng tài khoản và mật khẩu, đăng xuất, quản lý trạng thái tài khoản | Tài khoản hoạt động đăng nhập được. Sai mật khẩu hoặc tài khoản bị khóa không vào được. Phiên hết hạn hoặc bị thu hồi không dùng lại được. |
| FR-02 | Ba vai trò Lãnh đạo, Quản trị và Chuyên viên. Phân công phạm vi theo ứng dụng | Hai Chuyên viên có phân công khác nhau nhận kết quả tương ứng. Truy cập trực tiếp bằng ID, tìm kiếm, tải tệp, xuất báo cáo và mở kết nối đều áp dụng quyền tại API. |
| FR-03 | Danh mục đơn vị, DC, ứng dụng và CSDL | Lưu tên, đơn vị chủ quản, người phụ trách, trạng thái và hình thức dịch vụ. Một ứng dụng liên kết được nhiều CSDL. Danh mục hình thức dịch vụ hỗ trợ đặt hàng, giám sát và quản trị vận hành. |
| FR-04 | Danh mục máy chủ và điểm truy cập | Lưu DC, hệ điều hành, cấu hình, ghi chú, IP nội bộ, IP công khai/NAT, phạm vi mạng và cổng. Hai máy có cùng IP nội bộ ở hai phạm vi mạng có thể cùng tồn tại. Từ một máy xem được các ứng dụng liên quan trong phạm vi quyền. |
| FR-05 | Tên miền, bản ghi DNS, điểm kiểm tra TLS và liên kết | Lưu tên miền đăng ký, hạn gia hạn, bản ghi host/loại/đích, host và cổng TLS. Liên kết ứng dụng với máy chủ, tên miền hoặc bản ghi tương ứng. Sửa một tên miền dùng chung phản ánh trên các ứng dụng có quyền xem. |
| FR-06 | Tra cứu chung theo IP, tên miền, tên ứng dụng hoặc đơn vị | IP và tên miền đã chuẩn hóa khớp chính xác. Tên ứng dụng và đơn vị hỗ trợ tìm theo một phần tên. Kết quả có ứng dụng, máy chủ, tên miền, đơn vị, người phụ trách và phương thức truy cập được phép. Có phân trang và trạng thái không có kết quả. |
| FR-07 | Quản lý tài liệu đính kèm | Người có quyền tải lên và tải xuống tài liệu đã liên kết. Tệp sai định dạng hoặc quá giới hạn bị từ chối. Yêu cầu ngoài phạm vi không trả nội dung tệp. |
| FR-08 | Nhập dữ liệu từ Excel | Có chọn sheet, ánh xạ cột, chuẩn hóa và xem trước dòng mới, trùng, xung đột hoặc lỗi. Chỉ ghi sau khi xác nhận. Gửi lại cùng lô không ghi thêm bản sao. Dòng lỗi có số dòng, cột và lý do. |
| FR-09 | Cảnh báo hạn tên miền và chứng thư SSL/TLS | Lịch chạy trên máy chủ, tạo cảnh báo theo mốc 90, 30, 14 và 7 ngày. Cùng tài nguyên, loại hạn, ngày hết hạn và mốc chỉ tạo một cảnh báo. Gia hạn tạo kỳ hạn mới. |
| FR-10 | Kiểm tra DNS/TLS và phát hiện gián đoạn quan sát được | Hiển thị lần kiểm tra gần nhất, trạng thái và lý do. Phân biệt lỗi DNS, timeout, lỗi bắt tay/xác thực TLS và chứng thư hết hạn khi xác định được. Một lỗi tạm thời không lập tức kết luận dịch vụ gián đoạn. |
| FR-11 | Thông báo trong ứng dụng và tích hợp khay Windows | Người dùng có thể xem, đánh dấu đã đọc. Cảnh báo tạo khi ứng dụng đóng xuất hiện ở lần đồng bộ tiếp theo. Khi ứng dụng đang chạy ở khay, cảnh báo mới có thể hiện thông báo Windows theo thiết lập người dùng. |
| FR-12 | Mở SSH hoặc Remote Desktop trên Windows | API chỉ cấp đích đã lưu cho tài khoản có quyền. Tauri mở đúng host/cổng bằng trình khách đã biết và báo lỗi nếu thiếu trình khách. Nhật ký phân biệt cấp quyền và khởi chạy. |
| FR-13 | Nhật ký nghiệp vụ | Có thể truy lại ai thực hiện, lúc nào, đối tượng nào và kết quả đối với đăng nhập, phân quyền, cập nhật, xác nhận nhập, tải tệp, xuất báo cáo và yêu cầu kết nối. Nhật ký thay đổi thành công và dữ liệu được ghi cùng transaction khi đều nằm trong PostgreSQL. |
| FR-14 | Dashboard và xuất Excel | Có số ứng dụng, máy chủ, tên miền và số ứng dụng theo DC. Bộ lọc đơn vị, DC, hình thức dịch vụ áp dụng cho dữ liệu được cấp quyền. Ứng dụng có nhiều máy tại một DC chỉ được đếm một lần ở DC đó. Báo cáo Excel khớp bộ lọc và phạm vi của màn hình tương ứng. |

### Yêu cầu phi chức năng

| ID | Yêu cầu | Cách xác nhận |
| --- | --- | --- |
| NFR-01 | Bảo vệ dữ liệu và thông tin xác thực | HTTPS khi triển khai. Mật khẩu được băm, phiên có thể thu hồi, đăng nhập được giới hạn tần suất. Nhật ký không chứa mật khẩu, token, private key hoặc nội dung tệp. Dữ liệu xuất Excel không biến văn bản do người dùng nhập thành công thức. |
| NFR-02 | Nhất quán khi lỗi, thử lại hoặc cập nhật đồng thời | Ràng buộc quan hệ, khóa duy nhất và transaction bảo vệ dữ liệu. Cập nhật từ phiên bản cũ nhận lỗi xung đột. Có ca kiểm thử nhập lại lô, chạy lại lịch, và lỗi giữa lúc lưu tệp. |
| NFR-03 | Hiệu năng và xử lý tài nguyên có giới hạn | Phân trang tìm kiếm, giới hạn tệp/lô và giới hạn đồng thời khi kiểm tra mạng. Mục tiêu thử nghiệm đề xuất là p95 tìm kiếm API ≤ 1 giây với 10.000 ứng dụng, 20.000 máy chủ và 20 người dùng đồng thời trên môi trường thử nghiệm có cấu hình được ghi lại. |
| NFR-04 | Vận hành và khôi phục | Có health check, log kèm mã truy vết, trạng thái lần chạy lịch gần nhất, migration và sao lưu cơ sở dữ liệu cùng kho tệp. Khôi phục thử trên môi trường riêng và tải lại được tệp đính kèm. |
| NFR-05 | Cài đặt và trải nghiệm Windows | Bộ cài mở được trên Windows x64 mục tiêu với WebView2. Giao diện tiếng Việt có trạng thái tải, mất kết nối, hết phiên và lỗi có cách xử lý. Kiểm thử thực tế thông báo khay, SSH và RDP. |

### Các quyết định cần chốt

| ID | Quyết định | Giá trị dùng để bắt đầu |
| --- | --- | --- |
| D-01 | Ma trận quyền và phạm vi đơn vị | Dùng ma trận đề xuất ở phần Design. Các quyền nhạy cảm chưa được cấp thì từ chối. Chốt với đơn vị trước UAT. |
| D-02 | Nguồn dữ liệu và quy tắc gộp Excel | Dùng tệp mẫu tổng hợp để phát triển. Dùng tệp thực đã ẩn thông tin nhạy cảm để chốt ánh xạ, định dạng ngày, phạm vi mạng và quy tắc chọn bản ghi. |
| D-03 | Vị trí API, vùng mạng và nơi lưu tệp | Phát triển bằng PostgreSQL local hoặc Docker. Chốt vùng mạng chạy lịch, URL API, chứng chỉ, VPN, danh sách đích được kiểm tra và backend lưu tệp trước pilot. |
| D-04 | Giới hạn, lịch và vận hành | Mặc định thử nghiệm là 20 MiB mỗi tệp đính kèm, 10 MiB và 10.000 dòng mỗi lô Excel, kiểm tra DNS/TLS mỗi 30 phút và đối chiếu hạn hằng ngày theo múi giờ Asia/Ho_Chi_Minh. Chốt giới hạn sản xuất, thời hạn lưu, RPO/RTO và Windows được hỗ trợ trước phát hành. |

## Design

### Thành phần và triển khai

| Thành phần | Thiết kế triển khai |
| --- | --- |
| Desktop | Đề xuất thư mục `apps/desktop`. Next.js đặt `output: 'export'`, Tauri trỏ `frontendDist` tới `out`. Dùng route tĩnh và truyền ID theo query cho màn hình chi tiết cần mở được từ bản đóng gói. Giao diện tải dữ liệu qua API khi chạy. |
| API | Đề xuất thư mục `apps/api`. Tách module Auth, Access, Catalog, Search, Attachments, Imports, Monitoring, Notifications, Connections, Reports và Audit. Dùng hợp đồng OpenAPI để đồng bộ kiểu request/response giữa API và desktop. |
| Dữ liệu | PostgreSQL quản lý schema bằng migration, với dữ liệu mẫu cho phát triển. Kho tệp riêng tư truy cập qua dịch vụ API. Có cấu hình tách biệt cho phát triển, kiểm thử và pilot. |
| Lịch | Bản đầu chạy một tiến trình lịch NestJS phía máy chủ. Unique constraint bảo vệ cảnh báo khi thử lại. Khi nhân bản tiến trình lịch, bổ sung cơ chế khóa phân tán hoặc hàng đợi trước khi bật nhiều tiến trình. |
| Kết nối | Desktop gọi REST API qua HTTPS. Tauri chỉ cấp capability cần thiết và mở trình khách Windows qua lệnh Rust chuyên dụng. SSH/RDP đi từ máy người dùng đến đích. |

### Ma trận quyền đề xuất

| Thao tác | Lãnh đạo | Quản trị | Chuyên viên |
| --- | --- | --- | --- |
| Xem danh mục, tìm kiếm, dashboard | Đơn vị được cấp | Toàn hệ thống | Ứng dụng được phân công và tài nguyên liên kết được phép xem |
| Tạo hoặc cập nhật danh mục dùng chung, quản lý liên kết dùng chung | — | Có | Gửi yêu cầu cho Quản trị |
| Cập nhật chi tiết ứng dụng và tệp | — | Có | Ứng dụng được phân công |
| Quản lý tài khoản, phân công, xác nhận nhập Excel, xem nhật ký toàn hệ thống | — | Có | — |
| Tải tệp và xuất báo cáo | Cần quyền tải/xuất và nằm trong phạm vi được cấp | Có | Cần quyền tải/xuất và nằm trong phạm vi phân công |
| SSH/RDP | — | Cần quyền kết nối trên đích | Cần quyền kết nối trên đích thuộc phạm vi phân công |

API lọc tài nguyên và trường trả về. Nếu máy chủ hoặc tên miền dùng chung, việc xem được một ứng dụng liên kết không cấp quyền sửa tài nguyên dùng chung hoặc xem các ứng dụng khác. Khi thay đổi vai trò, khóa tài khoản hoặc thu hồi phân công, yêu cầu kế tiếp phải dùng quyền mới.

### Lược đồ và ràng buộc chính

| Thực thể đề xuất | Ràng buộc và chỉ mục |
| --- | --- |
| `organizations`, `data_centers`, `users`, `sessions`, `app_assignments` | Tên đăng nhập chuẩn hóa duy nhất. Ghi trạng thái tài khoản, hạn và thời điểm thu hồi phiên. Khóa duy nhất theo tài khoản và ứng dụng cho phân công. |
| `applications`, `databases`, `app_databases`, `app_servers` | ID ổn định, khóa ngoại tới đơn vị và người phụ trách, khóa duy nhất theo cặp liên kết. Có phiên bản bản ghi để phát hiện ghi đè đồng thời. |
| `servers`, `server_addresses`, `access_endpoints` | Dùng kiểu địa chỉ IP hỗ trợ IPv4/IPv6, trường phạm vi mạng, loại địa chỉ và cổng 1–65535. Lập chỉ mục tra cứu IP. Với IP công khai/NAT dùng chung, định danh đích gồm cổng, giao thức và ngữ cảnh phù hợp. |
| `domains`, `dns_records`, `tls_endpoints`, `app_domains`, `app_dns_records` | Tên miền đăng ký chuẩn hóa duy nhất. DNS lưu host/loại/đích và TLS lưu host/cổng/SNI. Ngày gia hạn nhập tay, hạn TLS quan sát được và kết quả kiểm tra có trường riêng. |
| `attachments`, `import_batches`, `import_rows` | Tệp có khóa lưu riêng và trạng thái chờ/khả dụng. Lô nhập lưu người tạo, ánh xạ, phiên bản xem trước và trạng thái. Dòng giữ số dòng gốc, dữ liệu chuẩn hóa và kết quả. |
| `check_runs`, `alerts`, `notifications`, `audit_events` | Cảnh báo gia hạn có khóa duy nhất theo tài nguyên, loại hạn, nguồn, ngày hạn và mốc. Thông báo có khóa theo cảnh báo và người nhận. Chỉ mục theo đích/thời gian cho lịch sử kiểm tra và theo đối tượng/thời gian cho nhật ký. |

Ngày gia hạn nghiệp vụ lưu dạng ngày. Thời điểm TLS, nhật ký và kết quả kiểm tra lưu theo UTC. Tính ngày còn lại theo múi giờ nghiệp vụ. Danh mục đang được tham chiếu chuyển trạng thái lưu trữ thay vì xóa dây chuyền. ID và phiên bản bản ghi được dùng để cập nhật.

### Hợp đồng API tối thiểu

Các đường dẫn dưới đây dùng tiền tố `/api/v1`. Danh sách trả `items`, `page`, `pageSize` và `total`, mặc định 25 bản ghi mỗi trang và tối đa 100. Lỗi trả `code`, `message`, `requestId` và lỗi theo trường nếu có. Dùng `401` cho phiên thiếu hoặc hết hạn, `403` cho thao tác bị cấm, `404` cho tài nguyên không tồn tại hoặc ngoài phạm vi cần che, và `409` cho xung đột.

| Nhóm | Đường dẫn và hành vi |
| --- | --- |
| Phiên | `POST /auth/login`, `POST /auth/logout`, `GET /me`. Đề xuất dùng token phiên ngẫu nhiên, lưu bản băm phía máy chủ, giữ token trong bộ nhớ desktop cho bản đầu. |
| Danh mục | `/organizations`, `/data-centers`, `/applications`, `/databases`, `/servers`, `/domains`. Danh sách, chi tiết, tạo, sửa, lưu trữ và các thao tác liên kết theo quyền. Cập nhật gửi phiên bản hiện hành. |
| Tra cứu | `GET /search?q=...` trả nhóm kết quả ứng dụng đã lọc. IP dùng dạng chuẩn, tên miền bỏ dấu chấm cuối và chuẩn hóa IDN. Kết quả theo IP trùng ở nhiều vùng hiển thị thêm DC và phạm vi mạng. |
| Tệp và nhập | `POST /attachments`, `GET /attachments/{id}/download`. `POST /imports`, `POST /imports/{id}/preview`, `POST /imports/{id}/confirm`, `GET /imports/{id}`. Xác nhận dùng phiên bản xem trước và tập dòng đã chọn. |
| Giám sát và kết nối | `GET /alerts`, `GET /notifications`, `PATCH /notifications/{id}`, `POST /access-endpoints/{id}/launch`. Đích kiểm tra cấu hình qua API quản trị, yêu cầu mở kết nối tham chiếu ID điểm truy cập đã lưu. |
| Báo cáo và vận hành | `GET /dashboard`, `GET /reports/inventory`, `GET /reports/inventory.xlsx`, `GET /audit-events`, `GET /health/live`, `GET /health/ready`. Dùng chung logic truy vấn giữa báo cáo màn hình và xuất tệp. |

### Quy tắc xử lý các luồng chính

- **Nhập Excel.** Đọc sheet và giá trị ô trong giới hạn cấu hình. Xem trước tạo ảnh chụp ánh xạ và danh sách quyết định theo dòng. Gộp máy chủ theo định danh đáng tin cậy hoặc IP kèm phạm vi mạng nếu người dùng xác nhận. Khi xác nhận, khóa lô, đối chiếu lại phiên bản bản ghi và ghi tập dòng được chọn trong một transaction. Có xung đột thì hủy transaction và yêu cầu xem trước lại. Yêu cầu lặp lại đối với lô đã hoàn tất trả kết quả đã lưu.
- **Tệp đính kèm.** Kiểm tra quyền, kích thước và định dạng. Tạo siêu dữ liệu trạng thái chờ với khóa lưu ngẫu nhiên. Sau khi lưu xong, chuyển sang khả dụng và ghi nhật ký. Chỉ phục vụ tệp khả dụng. Tác vụ dọn dẹp xử lý bản ghi chờ quá hạn và đối chiếu kho tệp sau sự cố.
- **Cảnh báo và thông báo.** Khi hạn còn 0–90 ngày, chọn mốc nhỏ nhất trong tập 90/30/14/7 vẫn lớn hơn hoặc bằng số ngày còn lại. Khi quá hạn, hiển thị trạng thái quá hạn và tạo một cảnh báo quá hạn cho mỗi kỳ hạn. Ví dụ còn 13 ngày sau một lần bỏ lỡ lịch thì tạo mốc 14. Cảnh báo SSL nhập tay và TLS quan sát được có nhãn nguồn. Tạo cảnh báo và thông báo trong một transaction, có lọc người nhận theo quyền hiện hành. Desktop thăm dò thông báo trong lúc chạy và chống hiện lặp theo ID.
- **Kiểm tra DNS/TLS.** Chỉ chạy trên cấu hình do Quản trị duyệt, giới hạn cổng và vùng mạng, kiểm tra địa chỉ đã phân giải trước khi kết nối, đặt timeout và giới hạn song song. Lưu kết quả theo phép kiểm. Mỗi lần chuyển trạng thái gián đoạn hoặc phục hồi chỉ tạo một sự kiện cho cùng endpoint và loại phép kiểm. Mặc định thử nghiệm cần hai lần lỗi liên tiếp để cảnh báo gián đoạn và một lần thành công để ghi nhận phục hồi. Phép kiểm này phản ánh khả năng truy cập từ máy chạy lịch.
- **SSH/RDP.** API kiểm tra quyền, ghi sự kiện và trả giao thức, host, cổng. Tauri chỉ cho phép trình khách tương ứng và truyền từng đối số đã kiểm tra, không nội suy vào shell. Tài khoản xác thực trực tiếp bằng trình khách. Ghi kết quả khởi chạy quan sát được và hướng dẫn kiểm tra VPN, cổng hoặc trình khách khi lỗi.
- **Báo cáo và kiểm thử.** Truy vấn tổng hợp và xuất Excel dùng chung quyền và bộ lọc. Kiểm thử chéo hai đơn vị, quyền tài nguyên dùng chung, đếm theo DC, lỗi đồng thời, khôi phục sao lưu và tính năng native trên Windows.

## Tasks

Mỗi dòng là một đầu việc. Cột **Sau** là phụ thuộc trực tiếp. Dấu **—** nghĩa là có thể bắt đầu ngay. Cột **Hoàn tất khi** mô tả đầu ra để kiểm tra hoặc bàn giao. Các quyết định bên ngoài được đánh dấu ở cổng nghiệm thu của giai đoạn.

### Giai đoạn 0 — Nền tảng

| Task | Việc thực hiện | Sau | Hoàn tất khi |
| --- | --- | --- | --- |
| T0.1 | Kiểm tra Node/npm, Rust/MSVC, WebView2, PostgreSQL hoặc Docker Engine | — | Ghi phiên bản, lệnh kiểm tra và cách chạy PostgreSQL đã thử thành công. |
| T0.2 | Khởi tạo workspace TypeScript cho desktop và API, cấu hình build và kiểm tra kiểu | — | Cài được dependencies từ lockfile và chạy được build/typecheck. |
| T0.3 | Dựng PostgreSQL phát triển, cấu hình môi trường mẫu và migration đầu tiên | T0.1, T0.2 | Tạo được DB sạch và chạy migration bằng lệnh đã ghi. |
| T0.4 | Tạo NestJS bootstrap, health endpoints và khung OpenAPI | T0.2, T0.3 | Liveness trả 200, readiness báo lỗi khi DB mất kết nối. |
| T0.5 | Tạo Next.js static export, khung Tauri và màn hình kiểm tra kết nối API | T0.1, T0.2, T0.4 | Bản `out` được đóng gói và màn hình desktop đọc health endpoint. |
| T0.6 | Tạo bộ dữ liệu kiểm thử tổng hợp gồm hai đơn vị, hai DC và IP nội bộ trùng | — | Có fixture danh mục và một workbook mẫu với dòng hợp lệ, trùng và lỗi. |

**Cổng nghiệm thu:** API và desktop kết nối được trên môi trường phát triển. PostgreSQL khởi tạo lặp lại được.

### Giai đoạn 1 — Đăng nhập, danh mục và tra cứu

| Task | Việc thực hiện | Sau | Hoàn tất khi |
| --- | --- | --- | --- |
| T1.1 | Tạo migration tài khoản, đơn vị, DC, phiên, phân công, danh mục và liên kết | T0.3 | Áp dụng trên DB sạch, chạy seed và xác minh khóa ngoại/unique. |
| T1.2 | Làm login, logout, `/me`, băm mật khẩu, giới hạn thử sai và thu hồi phiên | T0.4, T1.1 | Kiểm thử đăng nhập hợp lệ, sai mật khẩu, tài khoản khóa và token hết hạn. |
| T1.3 | Làm guard và bộ lọc theo tài nguyên cho ba vai trò, quản lý tài khoản/phân công | T1.1, T1.2 | Có kiểm thử chéo đơn vị và thu hồi phân công có hiệu lực ở yêu cầu kế tiếp. |
| T1.4 | Làm API đơn vị, DC, ứng dụng, CSDL và liên kết ứng dụng–CSDL | T1.3 | Tạo/sửa/lưu trữ qua API, dữ liệu sai bị từ chối và bản ghi cũ nhận 409. |
| T1.5 | Làm API máy chủ, địa chỉ và điểm SSH/RDP | T1.3 | Lưu được hai IP nội bộ giống nhau ở hai mạng và validate host/cổng. |
| T1.6 | Làm API tên miền, bản ghi DNS, điểm TLS và liên kết với ứng dụng/máy chủ | T1.4, T1.5 | Đọc được quan hệ hai chiều theo quyền và sửa đúng một tài nguyên dùng chung. |
| T1.7 | Làm API tra cứu và chỉ mục theo IP, hostname, tên ứng dụng và đơn vị | T1.6 | Fixture tìm được theo cả bốn loại khóa, không lộ tài nguyên ngoài phạm vi. |
| T1.8 | Làm màn hình đăng nhập, danh mục, chi tiết, phân công và tìm kiếm | T0.5, T1.2, T1.4, T1.5, T1.6, T1.7 | Người dùng thực hiện được luồng từ đăng nhập đến tra cứu trên bản desktop. |
| T1.9 | Ghi audit đăng nhập, thay đổi quyền và thay đổi danh mục | T1.2, T1.3, T1.4, T1.5, T1.6 | Nhật ký có actor/action/đích/kết quả, ghi cùng transaction khi phù hợp và che thông tin xác thực. |

**Cổng nghiệm thu:** FR-01 đến FR-06 và phần nhật ký tương ứng của FR-13 đạt trên fixture.

### Giai đoạn 2 — Tài liệu và nhập Excel

| Task | Việc thực hiện | Sau | Hoàn tất khi |
| --- | --- | --- | --- |
| T2.1 | Làm kho tệp, API tải lên/xuống, kiểm tra quyền và dọn tệp chờ | T1.3, T1.6, T1.9 | Kiểm thử tệp hợp lệ, quá cỡ, truy cập trái quyền và lỗi giữa hai bước ghi. |
| T2.2 | Làm parser Excel, danh sách sheet, ánh xạ và chuẩn hóa dòng | T0.6, T1.6 | Workbook mẫu trả đúng số dòng, dữ liệu chuẩn hóa và lỗi ô. |
| T2.3 | Làm API xem trước, phát hiện trùng và lưu quyết định theo dòng | T2.2, T1.7 | Hiển thị bản ghi đối chiếu và lý do trùng, không sửa danh mục trong bước xem trước. |
| T2.4 | Làm API xác nhận nhập, transaction, khóa lô và báo cáo kết quả | T2.3, T1.9 | Gửi lại lô không ghi trùng. Thay đổi danh mục sau khi xem trước buộc xem lại nếu có xung đột. |
| T2.5 | Làm giao diện tài liệu và trình hướng dẫn nhập Excel | T1.8, T2.1, T2.4 | Người dùng xem trước, xử lý dòng lỗi, xác nhận và đọc kết quả ngay trên desktop. |
| T2.6 | Đối chiếu một tệp thực đã ẩn dữ liệu và chốt quy tắc gộp | T2.5 | Có mẫu ánh xạ và bảng đối chiếu đầu vào, bản ghi được ghi, bản ghi bị bỏ qua. |

**Cổng nghiệm thu:** FR-07, FR-08 và D-02 đạt trước khi nhập dữ liệu thật.

### Giai đoạn 3 — Giám sát, thông báo và báo cáo

| Task | Việc thực hiện | Sau | Hoàn tất khi |
| --- | --- | --- | --- |
| T3.1 | Tạo migration kết quả kiểm tra, cảnh báo và thông báo, cấu hình lịch | T1.6 | Có trạng thái lần chạy gần nhất và khóa chống trùng. |
| T3.2 | Làm tác vụ đối chiếu hạn nhập tay và hạn TLS theo lịch | T3.1 | Kiểm thử đủ mốc 90/30/14/7, quá hạn, gia hạn, bỏ lỡ lịch và chạy lại. |
| T3.3 | Làm bộ kiểm tra DNS/TLS, giới hạn đích, timeout và quy tắc gián đoạn | T3.1 | Fixture phân biệt lỗi DNS, timeout, lỗi TLS, hết hạn và phục hồi. |
| T3.4 | Làm API thông báo, trạng thái đã đọc, phân phối theo phạm vi | T3.2, T3.3, T1.3 | Người có quyền thấy thông báo, người bị thu hồi phạm vi không còn xem được. |
| T3.5 | Làm màn hình cảnh báo, đồng bộ và thông báo khay Windows | T3.4, T1.8 | Cảnh báo tạo khi đóng app hiện khi mở lại. App chạy ở khay hiện một lần mỗi thông báo mới. |
| T3.6 | Làm truy vấn dashboard và báo cáo dùng chung bộ lọc/phạm vi quyền | T1.6, T1.7 | Bộ dữ liệu một ứng dụng nhiều máy cùng DC cho số đếm đúng. |
| T3.7 | Làm xuất Excel, giao diện báo cáo và ghi audit xuất | T3.6, T1.8, T1.9 | Số liệu xuất khớp bộ lọc, ô văn bản nhạy với công thức được xử lý an toàn. |

**Cổng nghiệm thu:** FR-09 đến FR-11 và FR-14 đạt. Đích kiểm tra pilot đã xác nhận theo D-03.

### Giai đoạn 4 — SSH/RDP, kiểm thử tích hợp và phát hành thử

| Task | Việc thực hiện | Sau | Hoàn tất khi |
| --- | --- | --- | --- |
| T4.1 | Làm API cấp quyền mở kết nối và audit kết quả cấp quyền | T1.3, T1.5, T1.9 | Tài khoản có quyền nhận đúng đích đã lưu. Tài khoản ngoài phạm vi bị từ chối. |
| T4.2 | Làm lệnh Tauri mở `ssh.exe` và `mstsc.exe`, tích hợp nút kết nối | T0.5, T1.8, T4.1 | Thử được host/cổng hợp lệ, báo lỗi tham số sai hoặc thiếu trình khách và ghi kết quả mở quan sát được. |
| T4.3 | Chạy bộ kiểm thử quyền, đồng thời, hiệu năng và các luồng xuyên suốt | T2.5, T3.5, T3.7, T4.2 | Có kết quả kiểm thử theo FR/NFR và ghi cấu hình đo hiệu năng. |
| T4.4 | Chuẩn bị triển khai pilot, cấu hình HTTPS, log, sao lưu và phục hồi | T0.4, T2.1, T3.1 | Phục hồi được DB và tệp mẫu ở môi trường riêng. Có tài liệu migration và phục hồi. |
| T4.5 | Build bộ cài Windows và thử trên máy sạch | T3.5, T4.2 | Cài, mở và gỡ được. Kiểm tra kết nối API, khay thông báo, SSH và RDP qua mạng/VPN pilot. |
| T4.6 | Chạy UAT, chốt quyền và cấu hình sản xuất | T2.6, T4.3, T4.4, T4.5 | Đại diện ba vai trò chạy ca nghiệm thu, chốt D-01 đến D-04 và ghi các lỗi còn mở. |

**Cổng nghiệm thu:** FR-12, FR-13 và các NFR đã được kiểm tra. Đóng các lỗi chặn ca dùng thử trước khi phát hành pilot.
