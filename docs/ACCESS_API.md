# Cấp quyền SSH/RDP — T4.1

T4.1 cung cấp API xác nhận quyền đối với đích đã lưu và ghi audit kết quả cấp quyền. Việc mở `ssh.exe`/`mstsc.exe`, báo lỗi trình khách và ghi nhận kết quả khởi chạy thuộc T4.2 của người B. API không mở kết nối mạng hoặc xác nhận người dùng đã đăng nhập được vào máy chủ.

## Áp dụng

Chạy `npm.cmd run db:migrate` để áp dụng `008_access_endpoint_grants.sql`, sau đó build và khởi động lại API. Migration thêm bảng quyền theo từng tài khoản/điểm truy cập, không tự cấp quyền cho bất kỳ ai, kể cả Quản trị. `DATABASE_URL` tiếp tục dùng endpoint trực tiếp theo cấu hình API hiện có.

## Quy tắc quyền

| Vai trò | Điều kiện cấp quyền mở kết nối |
| --- | --- |
| Quản trị | Có quyền riêng cho đúng điểm truy cập đang yêu cầu |
| Chuyên viên | Có quyền riêng cho đúng điểm truy cập và máy chủ còn liên kết với ứng dụng đang được phân công |
| Lãnh đạo | Không được mở SSH/RDP qua API |

Chỉ tài khoản hoạt động, chưa xóa với phiên còn hiệu lực mới được dùng API. Máy chủ đã lưu trữ hoặc ngoài phạm vi không được cấp đích. Quyền ứng dụng, quyền xem máy chủ, quyền tải tệp và quyền xuất báo cáo không thay thế quyền kết nối.

Hai điểm truy cập có cùng host/IP vẫn là hai tài nguyên riêng. Có quyền SSH không tự cấp quyền RDP hoặc quyền tới cổng khác. Máy chủ dùng chung có thể thuộc phạm vi nhiều Chuyên viên nhưng mỗi người vẫn cần quyền đích riêng; API không trả danh sách các ứng dụng khác đang dùng chung máy.

Quyền được gắn với ảnh chụp `serverId`, `protocol`, `host`, `port`. Khi đích đổi một trong các giá trị này, quyền cũ hết hiệu lực và cần được Quản trị cấp lại. Lặp PUT khi cấu hình không đổi không tạo thêm quyền hoặc audit trùng. Việc đổi vai trò hoặc xóa tài khoản xóa các quyền kết nối đã cấp. Khóa tài khoản hoặc thu hồi phân công có hiệu lực ở yêu cầu kế tiếp.

## API dưới `/api/v1`

Tất cả yêu cầu cần `Authorization: Bearer <token>`.

| API | Hành vi |
| --- | --- |
| `GET /users/{userId}/access-endpoints` | Quản trị xem quyền đích của một tài khoản, có phân trang; mỗi mục gồm `endpointId`, `serverId`, giao thức/host/cổng hiện tại, `grantedBy`, `grantedAt`, `isCurrent` |
| `PUT /users/{userId}/access-endpoints/{endpointId}` | Quản trị cấp quyền cho cấu hình đích hiện tại; không có body hoặc `{}`; trả 204 |
| `DELETE /users/{userId}/access-endpoints/{endpointId}` | Quản trị thu hồi; không có body hoặc `{}`; trả 204; lặp lại an toàn khi tài khoản và đích vẫn tồn tại |
| `GET /servers/{serverId}/access-endpoints` | Quản trị thấy mọi điểm truy cập của máy chủ kèm `canLaunch`; Chuyên viên chỉ thấy điểm đã được cấp đúng cấu hình trong phạm vi; Lãnh đạo nhận 403 |
| `POST /access-endpoints/{endpointId}/launch` | Kiểm tra lại phiên, quyền và đích; lưu audit; trả đích khi thành công |

Các danh sách nhận `page` từ 1, `pageSize` mặc định 25 và tối đa 100; trả `items`, `total`, `page`, `pageSize`. `isCurrent` chỉ nói ảnh chụp cấu hình còn khớp, không thay cho kiểm tra phạm vi/trạng thái tài khoản ở bước launch. `canLaunch` là gợi ý tại lúc tải danh sách; desktop vẫn phải POST launch ở mỗi lần bấm kết nối.

PUT chỉ cấp cho Quản trị hoặc Chuyên viên đang hoạt động; với Chuyên viên, cần phân công ứng dụng và liên kết máy chủ trước. Quyền cho máy chủ đã lưu trữ hoặc ngoài phạm vi bị từ chối. Quản trị có thể cấp quyền cho chính mình. Thu hồi vẫn thực hiện được khi tài khoản bị khóa hoặc máy chủ đã lưu trữ.

Ví dụ luồng: Quản trị tạo điểm SSH/RDP trong danh mục máy chủ, phân công Chuyên viên, PUT cấp quyền cho ID điểm đó. Chuyên viên GET các điểm được phép rồi POST launch khi bấm nút.

## Phản hồi launch

Yêu cầu không có body hoặc body `{}`. Không nhận host/cổng/giao thức/username/lệnh từ máy khách. Trường lạ hoặc UUID sai trả 400, không bị bỏ qua để kết nối tùy ý.

```json
{
  "authorizationId": "44000000-0000-4000-8000-000000000001",
  "endpointId": "45000000-0000-4000-8000-000000000001",
  "serverId": "46000000-0000-4000-8000-000000000001",
  "protocol": "ssh",
  "host": "srv-a.example.test",
  "port": 2222,
  "authorizedAt": "2026-11-16T03:00:00.000Z"
}
```

Trả HTTP 200, `Cache-Control: no-store`. `authorizationId` khớp header `X-Request-Id` và `request_id` của bản ghi audit, dùng để đối chiếu quyết định. Đây **không phải** bearer token, thông tin đăng nhập máy chủ hoặc quyền có thể tái sử dụng thay cho POST launch.

Host được kiểm tra lại bằng bộ chuẩn hóa IP/hostname của API, cổng trong 1–65535 và giao thức chỉ `ssh`/`rdp`. IPv6 trả về dạng địa chỉ không có ngoặc, không kèm cổng hoặc zone; Tauri chịu trách nhiệm định dạng đối số cho trình khách đúng loại. Không trả shell command, executable tùy ý, mật khẩu, private key hoặc token phiên.

## Lỗi và nhật ký

| HTTP/code | Ý nghĩa |
| --- | --- |
| 401 `INVALID_SESSION` | Phiên hết hạn, bị thu hồi hoặc tài khoản khóa/xóa |
| 403 `CONNECTION_NOT_PERMITTED` | Vai trò không được mở kết nối |
| 403 `CONNECTION_GRANT_REQUIRED` | Đích nằm trong phạm vi nhưng thiếu quyền cho cấu hình hiện tại |
| 404 `NOT_FOUND` | Đích không tồn tại, máy chủ đã lưu trữ hoặc ngoài phạm vi; cùng phản hồi để không lộ đích |
| 409 `CONNECTION_ACCOUNT_INELIGIBLE` | Cấp quyền cho tài khoản không đủ điều kiện |
| 409 `CONNECTION_TARGET_OUT_OF_SCOPE` | Cấp quyền tới máy chủ đã lưu trữ hoặc ngoài phạm vi tài khoản nhận |
| 503 `ACCESS_ENDPOINT_INVALID` | Dữ liệu đích đã lưu không hợp lệ; cần Quản trị sửa |

Quyết định launch ghi `action=access.launch.authorize`, `target_type=access_endpoints`, ID đích, actor, request ID và kết quả `success`, `denied` hoặc `failure`. Thành công kèm `related_id` là máy chủ. Yêu cầu xác thực hợp lệ nhưng sai UUID/body cũng ghi từ chối mà không lưu payload hoặc chuỗi ID sai. Yêu cầu 401 bị guard chặn trước bước cấp quyền và không tạo audit launch.

Audit từ chối được commit trước khi trả lỗi; không bị rollback vì exception HTTP. Nếu không ghi được audit, API không trả đích cho máy khách. Tài khoản/phiên, đích và quyền được giữ khóa trong transaction ngắn cho tới khi quyết định/audit commit. Thay đổi quyền hoặc phân công qua các API tương ứng sẽ được áp dụng ở lần kiểm tra kế tiếp. Không giữ transaction trong khi chạy trình khách Windows.

Cấp/thu hồi quyền ghi `access.grant.grant` / `access.grant.revoke`, đích audit là tài khoản nhận và `related_id` là điểm truy cập, trong cùng transaction thay đổi quyền. `success` của `access.launch.authorize` chỉ có nghĩa **đã cấp đích**, không phải khởi chạy trình khách hoặc đăng nhập SSH/RDP thành công.

## Bàn giao T4.2

- Fixture hai phản hồi SSH/RDP: [access-launch.json](../fixtures/access-launch.json), UUID và địa chỉ là dữ liệu giả.
- Dùng GET danh sách mới để dựng nút kết nối cho Chuyên viên; phần chi tiết máy chủ cũ vẫn chỉ trả cấu hình SSH/RDP cho Quản trị.
- Mỗi lần bấm cần POST launch, rồi chỉ dùng giao thức/host/cổng vừa nhận. Không dùng một host/cổng do người dùng tự nhập hoặc thông tin cấp quyền đã cache từ trước.
- Tauri kiểm tra lại dữ liệu và chọn trình khách cố định theo giao thức, truyền đối số riêng, không nội suy shell. T4.2 xử lý thiếu trình khách, tham số không hợp lệ, đường mạng/VPN và kết quả khởi chạy quan sát được.
- Giữ `authorizationId` để đối chiếu với yêu cầu; luồng báo kết quả khởi chạy thuộc T4.2. API T4.1 chưa nhận kết quả mở trình khách và không xác minh đăng nhập ở máy đích. Việc xác thực máy đích diễn ra trực tiếp trong SSH/RDP bằng tài khoản của người dùng.

## Kiểm thử

`npm.cmd test --workspace @lcit/api`. Đặt `LCIT_TEST_DATABASE_URL` tới PostgreSQL trực tiếp dùng riêng, chưa có schema `lcit`, để chạy ca T4.1: migration lặp, hai máy cùng IP, máy dùng chung, quyền riêng cả với Quản trị, SSH/RDP/IPv6/cổng tùy chỉnh, từ chối dữ liệu đích từ máy khách, audit thành công/từ chối/lỗi, lỗi ghi audit không trả đích, thu hồi, đổi đích, mất phân công, lưu trữ và đổi vai trò/xóa tài khoản. Bài kiểm thử không mở SSH/RDP thật.
