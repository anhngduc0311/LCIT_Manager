# Bàn giao cảnh báo và thông báo — T3.4

API đã sẵn sàng để người B tích hợp màn hình, đồng bộ và khay Windows ở T3.5. Dùng phiên Bearer hiện có; mọi thời điểm trả về ở UTC. Không có migration mới: dùng bảng của T3.1–T3.3. Build và khởi động lại API để nạp các controller mới.

## Các điểm truy cập

| API dưới `/api/v1` | Hành vi |
| --- | --- |
| `GET /alerts` | Lịch sử cảnh báo trong phạm vi tài nguyên hiện tại, độc lập người đã nhận thông báo |
| `GET /alerts/{id}` | Chi tiết cảnh báo còn trong phạm vi xem |
| `GET /notifications` | Chỉ thông báo đã phân phối cho tài khoản đang đăng nhập và còn trong phạm vi xem |
| `GET /notifications/{id}` | Chi tiết thông báo của chính tài khoản, kèm cảnh báo |
| `PATCH /notifications/{id}` | Body `{"read":true}` để đánh dấu đã đọc; `{"read":false}` để đánh dấu chưa đọc |

Lãnh đạo, Chuyên viên và Quản trị đều dùng được các API này theo quyền. Quản trị xem mọi cảnh báo của tài nguyên chưa lưu trữ, nhưng hộp thông báo vẫn chỉ là hộp của chính họ; không có quyền sửa trạng thái đã đọc của người khác. Các API cấu hình giám sát và lịch sử kiểm tra của T3.3 vẫn chỉ dành cho Quản trị.

Chưa đăng nhập hoặc phiên hết hiệu lực trả 401. ID không tồn tại, ID của người khác hoặc tài nguyên đã ngoài phạm vi đều trả cùng lỗi 404. UUID, bộ lọc hoặc body không hợp lệ trả 400. PATCH chỉ nhận trường `read` kiểu boolean; không nhận ID người nhận hoặc thời điểm do máy khách gửi.

## Danh sách và bộ lọc

Hai API danh sách nhận `page` từ 1, `pageSize` mặc định 25, tối đa 100. Sắp xếp thời điểm tạo giảm dần rồi ID giảm dần để ổn định khi thời điểm bằng nhau. Trả `items`, `page`, `pageSize`, `total`.

Bộ lọc chung:

- `kind`: `expiry`, `outage`, `recovery`.
- `source`: `manual_domain`, `manual_tls`, `observed_tls`, `dns`, `tls`.
- `domainId`: UUID tên miền cha. ID hợp lệ nhưng ngoài quyền trả danh sách rỗng.

Riêng `/notifications` nhận `read=all|unread|read`, mặc định `all`. Trả thêm `unreadCount`: số thông báo chưa đọc còn được xem, áp dụng bộ lọc kind/source/domainId nhưng **không phụ thuộc** bộ lọc read hoặc trang hiện tại. `total` áp dụng cả bộ lọc read. Không đếm thông báo ngoài quyền vào bất kỳ số tổng nào.

Ví dụ: `/notifications?read=unread&page=1&pageSize=100`, hoặc `/alerts?kind=expiry&source=manual_tls`.

## Dữ liệu trả về

Cảnh báo có:

| Trường | Ý nghĩa |
| --- | --- |
| `id`, `createdAt` | ID ổn định và thời điểm tạo cảnh báo |
| `kind`, `source` | Loại sự kiện và nguồn dữ liệu |
| `resourceType`, `resourceId` | `domain`, `dns_record` hoặc `tls_endpoint`, cùng ID tài nguyên |
| `domainId`, `domainName` | Tên miền cha |
| `resourceLabel` | Host của bản ghi DNS; với cảnh báo tên miền/TLS là tên miền cha |
| `expiryDate`, `thresholdDays` | Ngày hạn và mốc 90/30/14/7; mốc 0 là quá hạn; `null` với sự kiện mạng |
| `check` | `null` nếu không gắn kết quả kiểm tra; nếu có gồm `status`, `errorCode`, `finishedAt` |

Payload không chứa địa chỉ IP đã phân giải, cổng TLS, SNI hoặc hostname nội bộ của endpoint TLS. Không suy ra quyền xem cấu hình quản trị từ việc xem được cảnh báo hạn/gián đoạn.

Mỗi thông báo có `id`, `createdAt`, `readAt` và `alert` chứa cảnh báo theo cấu trúc trên. ID thông báo dùng cho PATCH và chống hiện lặp; ID cảnh báo dùng để mở chi tiết cảnh báo. Chúng là hai ID khác nhau. Một cảnh báo có thể có nhiều thông báo cho những người nhận khác nhau.

PATCH trả `id`, `createdAt`, `readAt`. Lặp lại `read:true`, kể cả gửi đồng thời, giữ nguyên thời điểm đọc đầu tiên. Thao tác chỉ sửa hàng của người đang đăng nhập và kiểm tra quyền trong cùng câu lệnh cập nhật. `read:false` đặt lại `readAt` thành `null`.

## Quyền hiện tại và phân phối

T3.2/T3.3 đã tạo thông báo cùng transaction với cảnh báo. Chỉ tài khoản hoạt động, chưa xóa và có quyền tại thời điểm tạo được nhận. Chạy lại cùng cảnh báo không phát lại thông báo. Người mới được cấp quyền có thể xem lịch sử `/alerts`; họ không tự nhận hộp thông báo cũ của người khác. Các cảnh báo mới tiếp theo dùng phân công mới.

Mỗi GET/PATCH kiểm tra lại phân công, vai trò, liên kết và trạng thái lưu trữ hiện tại. Thu hồi phân công hoặc bỏ liên kết làm thông báo cũ biến mất khỏi danh sách, chi tiết, số đếm và thao tác đã đọc ngay ở yêu cầu tiếp theo. Không xóa lịch sử trong PostgreSQL. Tên miền đã lưu trữ bị ẩn kể cả với Quản trị.

Quyền tên miền/TLS dùng cùng bộ lọc tên miền của danh mục: liên kết trực tiếp, DNS hoặc máy chủ dùng chung qua các ứng dụng còn được xem. Cảnh báo DNS chỉ được xem nếu **đúng bản ghi DNS đó** được liên kết với ứng dụng trong phạm vi; xem được tên miền cha không cấp quyền cho mọi bản ghi con. Các bộ lọc này được áp dụng cả khi một thông báo cũ từng bị phân phối nhầm hoặc quyền đã thay đổi.

## Tích hợp T3.5

- Dữ liệu mẫu không nhạy cảm: [notifications.json](../fixtures/notifications.json), gồm hai thông báo mới chưa đọc: một lỗi DNS và một cảnh báo hạn SSL nhập tay. Tệp khớp hình dạng phản hồi `/notifications`; các UUID là dữ liệu giả để dựng giao diện, không PATCH lên API thật bằng các ID này.
- Khi mở ứng dụng, tải các trang `/notifications` để lấy dữ liệu đã lưu trong lúc desktop đóng. Không chỉ đọc trang đầu nếu còn dữ liệu. API không tự đánh dấu đã đọc khi GET.
- Khi thăm dò trong lúc chạy, chống hiện thông báo Windows lặp bằng **ID thông báo**, tách bộ nhớ theo tài khoản. Cập nhật danh sách từ API, bỏ các mục không còn trong phạm vi và xử lý 404 khi mở một mục cũ. Không chỉ nối thêm dữ liệu vào cache cũ mãi mãi.
- Phân trang là dạng page/offset. Nếu phân trang hộp chưa đọc, nên lấy xong danh sách trước khi đánh dấu đã đọc để tránh dịch trang. Các lượt đồng bộ cần gộp theo ID và có thể đọc lặp để bắt kịp mục mới xuất hiện trong lúc phân trang; API chưa cung cấp cursor hoặc push.
- Hiển thị nguồn rõ ràng: `manual_domain` = hạn tên miền nhập tay; `manual_tls` = hạn SSL nhập tay; `observed_tls` = hạn TLS quan sát; `dns`/`tls` = phép kiểm mạng. `outage`/`recovery` phản ánh quan sát từ máy chạy lịch, không phải kiểm chứng toàn bộ ứng dụng.
- Đánh dấu đã đọc khi người dùng yêu cầu hoặc mở thông báo theo hành vi giao diện đã thống nhất; không PATCH chỉ vì vừa hiển thị thông báo khay. Thao tác đọc ở thiết bị khác sẽ xuất hiện ở lần tải dữ liệu tiếp theo.

## Kiểm thử

`npm.cmd test --workspace @lcit/api` gồm kiểm thử API T3.4 khi `LCIT_TEST_DATABASE_URL` trỏ tới PostgreSQL riêng, chưa có schema `lcit`. Các ca kiểm tra hai đơn vị, tên miền dùng chung, DNS bị giới hạn riêng, hộp cá nhân của Quản trị, đếm chưa đọc không lộ dữ liệu, PATCH đồng thời/idempotent, mất quyền, đổi vai trò, tài khoản khóa, tài nguyên lưu trữ và dữ liệu/đã đọc còn nguyên sau khởi động lại. Cảnh báo hạn trong ca kiểm thử được tạo bằng tác vụ T3.2 thật.
