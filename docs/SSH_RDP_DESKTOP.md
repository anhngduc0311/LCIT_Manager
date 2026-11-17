# Mở SSH/RDP trên desktop — T4.2

T4.2 nối API cấp quyền của T4.1 ([ACCESS_API.md](ACCESS_API.md)) với trình khách có sẵn của Windows: `ssh.exe` (OpenSSH) và `mstsc.exe` (Remote Desktop Connection). Desktop không lưu và không nhận mật khẩu. Người dùng đăng nhập trực tiếp vào máy đích trong cửa sổ của trình khách.

## Luồng

1. Ở chi tiết **máy chủ**, mục **Kết nối SSH/RDP** gọi `GET /servers/{id}/access-endpoints`. Quản trị thấy mọi điểm truy cập kèm `canLaunch`. Chuyên viên chỉ thấy điểm đã được cấp. Lãnh đạo không thấy mục này.
2. Mỗi lần bấm **Kết nối**, desktop gọi `POST /access-endpoints/{id}/launch`. API kiểm tra lại phiên, phạm vi và quyền, ghi nhật ký `access.launch.authorize`, rồi trả `protocol`, `host`, `port`, `authorizationId`.
3. Desktop chuyển đúng các giá trị vừa nhận cho lệnh Tauri `launch_access`. Không dùng giá trị tự nhập hoặc lưu từ trước.
4. Lệnh Tauri kiểm tra lại, mở trình khách, theo dõi vài giây rồi trả kết quả quan sát được.

Ở chi tiết **tài khoản** (Quản trị, vai trò Quản trị hoặc Chuyên viên), mục **Quyền kết nối SSH/RDP** liệt kê, cấp, cấp lại và thu hồi quyền theo từng điểm truy cập. Quyền gắn với đúng cấu hình đang lưu: đổi giao thức, host hoặc cổng thì quyền cũ mất hiệu lực và giao diện báo "cần cấp lại". Mặc định chưa ai có quyền nào, kể cả Quản trị. Quản trị có thể bấm **Cấp quyền cho tôi** ngay ở chi tiết máy chủ.

## Quy tắc an toàn trong `src-tauri/src/launch.rs`

| Quy tắc | Cách thực hiện |
| --- | --- |
| Trình khách cố định theo giao thức | `ssh` → `%SystemRoot%\System32\OpenSSH\ssh.exe`, `rdp` → `%SystemRoot%\System32\mstsc.exe`. Không tìm qua PATH hoặc thư mục hiện tại |
| Không qua shell, không nội suy | Gọi `CreateProcessW` trực tiếp. Mỗi đối số là một token đã kiểm tra, đối số cần trích dẫn bị từ chối |
| Đối số của `ssh` | `-p <cổng> -- <host>`. Dấu `--` ngăn host bị hiểu là tùy chọn |
| Đối số của `mstsc` | `/v:host:cổng`, IPv6 viết `/v:[địa chỉ]:cổng` |
| Kiểm tra đích | Giao thức chỉ `ssh` hoặc `rdp` (chữ thường). Cổng 1–65535. Host là IPv4/IPv6 không kèm cổng, ngoặc hoặc zone, hoặc hostname ASCII (chữ, số, `-`, `_`), không bắt đầu bằng `-`. `authorizationId` phải đúng dạng UUID |
| Console cho `ssh` | Chạy trong cửa sổ console riêng và không thừa kế handle của ứng dụng |

Test: `cargo test` trong `apps/desktop/src-tauri` (9 test, gồm danh sách chuỗi bị từ chối như `-oProxyCommand=...`, `;`, `|`, xuống dòng, và trường hợp thiếu trình khách). `cargo test -- --ignored --test-threads=1` chạy thật `ssh.exe` và `mstsc.exe` (mở cửa sổ trong vài giây).

## Kết quả quan sát được

Lệnh theo dõi trình khách sau khi mở: `ssh` 4 giây (từ chối kết nối trên loopback mất khoảng 2 giây), `mstsc` 1,5 giây.

| Trạng thái | Ý nghĩa | Giao diện báo |
| --- | --- | --- |
| `started` | Trình khách còn chạy sau thời gian theo dõi | Đã mở cửa sổ. Không có nghĩa là đăng nhập thành công |
| `exited_early` | Trình khách thoát sớm, kèm mã thoát (`ssh` mã 255 là không kết nối được) | Nhiều khả năng không kết nối được. Kiểm tra VPN, mạng, địa chỉ, cổng |
| `client_missing` | Máy không có `ssh.exe` hoặc `mstsc.exe` | Hướng dẫn cài OpenSSH Client |
| `spawn_failed` | Windows không mở được trình khách | Hiện lý do |
| `invalid` | Đích không qua kiểm tra, không có gì được mở | Báo Quản trị kiểm tra điểm truy cập |

Lỗi kết nối xảy ra muộn hơn thời gian theo dõi (ví dụ chờ hết hạn mạng) chỉ hiện trong cửa sổ của trình khách.

Mỗi lần thử ghi một dòng vào `%LOCALAPPDATA%\vn.lcit.manager\logs\launch.log` (thời điểm ghi là sau khi theo dõi xong, nên chậm hơn nhật ký API vài giây): thời điểm UTC, `authorizationId`, giao thức, đích, trạng thái và mã thoát. Không có thông tin đăng nhập. `authorizationId` khớp `request_id` của nhật ký `access.launch.authorize` trên API. Giao diện hiện 8 ký tự đầu làm mã đối chiếu.

## Cần thống nhất với người A

T4.1 chưa có API nhận kết quả mở trình khách, nên nhật ký trên API chỉ cho biết **đã cấp đích**, không biết trình khách có mở được hay không (FR-13 muốn phân biệt hai điều này). Hiện kết quả chỉ nằm ở giao diện và `launch.log` trên máy người dùng. Đề xuất: thêm `POST /access-endpoints/launches/{authorizationId}/result` nhận `{ status, exitCode }` (không nhận host/cổng), kiểm tra `authorizationId` thuộc chính phiên gọi và ghi audit `access.launch.client`. Khi API có, desktop chỉ cần gọi thêm sau `launch_access`.

## Kiểm tra thủ công (máy Windows)

1. Đăng nhập Quản trị, mở **Máy chủ → một máy chủ có điểm truy cập**. Bấm **Cấp quyền cho tôi** rồi **Kết nối**.
2. Thử cổng đóng (ví dụ `127.0.0.1:22` khi chưa chạy SSH server): phải báo "đã đóng ngay (mã 255)".
3. Với RDP, cửa sổ Remote Desktop phải mở tới đúng `host:cổng`.
4. Đăng nhập Chuyên viên: chỉ thấy điểm đã được cấp. Lãnh đạo không thấy mục kết nối.
5. Đổi cổng của điểm truy cập: quyền cũ báo "cần cấp lại" và nút **Kết nối** của Chuyên viên bị khóa.
6. Trên máy không có OpenSSH Client: phải báo `client_missing` kèm hướng dẫn cài.

## Đã thử trên máy thật (17/11/2026)

- Khi đích không tới được (cổng đóng trên loopback): `ExitedEarly`, mã 255.
- Khi đích tới được qua VPN (máy Ubuntu trong mạng nội bộ): `Started`, cửa sổ `ssh` hiện câu hỏi khóa máy chủ lần đầu. `authorizationId` trong `launch.log` khớp `request_id` của nhật ký `access.launch.authorize`.
- Host gõ sai trong điểm truy cập được mở đúng như đã lưu. Hệ thống không kiểm tra host có phải đích mong muốn, chỉ kiểm tra dạng hợp lệ.

## Hạn chế đã biết

- `ssh` dùng tên tài khoản Windows làm tên đăng nhập nếu không có `User` trong `%USERPROFILE%\.ssh\config`. API và giao diện chưa truyền tên đăng nhập.
- `Started` không phân biệt được kết nối đang chờ hết hạn mạng với kết nối thành công; lỗi hiện trong cửa sổ `ssh`.
- Cần thử thêm: cách `mstsc` nhận địa chỉ IPv6 (`/v:[...]:cổng`), kết nối RDP thật, và máy không có OpenSSH Client.
