# Mở SSH/RDP trên desktop — T4.2

Chức năng truyền tệp qua `ssh2-sftp-client`: xem [SFTP.md](SFTP.md).

## RDP hiển thị trong ứng dụng Windows

Khi thêm hoặc đổi giao thức của điểm truy cập, chọn **RDP** để tự điền cổng chuẩn **3389**; bình thường không cần nhập cổng. Chỉ bật **Dùng cổng khác (nâng cao)** nếu máy đích được cấu hình cổng riêng. SSH tự dùng cổng **22**. Phần kết nối RDP ẩn số cổng khi dùng 3389.

Nếu điểm RDP cũ lưu nhầm cổng 22, màn hình kết nối hiện cảnh báo. Quản trị chọn **Dùng cổng RDP mặc định** để cập nhật cấu hình lưu qua API và cấp lại quyền cho chính mình. Màn hình đóng để tải lại dữ liệu; mở RDP lại để kết nối. Các tài khoản khác cần được cấp lại quyền theo cấu hình mới. Đích không bị tự đổi trong lúc mở kết nối, nên kiểm tra quyền và audit vẫn gắn với đúng host/cổng được lưu.

Tại điểm truy cập RDP được cấp quyền, chọn **Mở màn hình RDP**. Giao diện mở toàn bộ vùng làm việc của LCIT Manager, có tài khoản Windows, miền tùy chọn và mật khẩu (có thể để trống để Windows hỏi khi cần). Chọn **Kết nối RDP** để kiểm tra quyền qua API rồi nhúng màn hình máy đích ngay trong cửa sổ ứng dụng. Chuột và bàn phím thao tác trực tiếp trong màn hình này. **Ngắt kết nối và đóng** hủy phiên; kết nối lại luôn cần một lần cấp quyền mới.

Phần Rust (`src-tauri/src/rdp.rs`) dùng Remote Desktop ActiveX có sẵn trên Windows, chứa trong cửa sổ con ATL. Các đối tượng COM chỉ chạy trên luồng giao diện. Host/cổng lấy từ phản hồi mới của API và được kiểm tra lại. Chỉ cửa sổ đã mở phiên mới được đổi kích thước, đọc trạng thái hoặc đóng phiên. Không tải mã ActiveX từ mạng và không chạy thành phần này trong DOM của trình duyệt.

Hỗ trợ NLA/CredSSP và co giãn màn hình qua SmartSizing. Windows hiển thị bước xác minh chứng chỉ khi cần, không tự bỏ qua xác minh. Mật khẩu không lưu vào cơ sở dữ liệu, cấu hình hay log. Clipboard, ổ đĩa và máy in không được chuyển tiếp. Vùng hiển thị tự đổi kích thước theo cửa sổ và tỷ lệ DPI; phiên được hủy khi đóng giao diện RDP, chuyển màn hình hoặc đăng xuất.

Vùng native RDP được tách khỏi vùng vẽ của các cửa sổ web cùng cha bằng Windows window regions; đóng/ẩn RDP khôi phục vùng web ban đầu. Không dựa vào `document.hidden` vì WebView2 có thể coi mình bị che bởi chính màn hình RDP. Kiểm thử hiển thị kiểm tra cả kích thước cửa sổ con, thứ tự lớp, lỗ cắt vùng web và khôi phục giao diện khi ẩn/đóng.

Trạng thái hiển thị lấy từ thành phần RDP thực: đang kết nối, đã kết nối hoặc phiên đã kết thúc. `launch.log` ghi lúc tạo phiên kèm mã cấp quyền, không khẳng định đã đăng nhập thành công. Đóng màn hình không đăng xuất tài khoản Windows trên máy đích; phiên làm việc phía máy đích tuân theo chính sách Remote Desktop của máy đó.

Chức năng này cần ứng dụng Tauri trên Windows 10 trở lên, có Remote Desktop ActiveX và ATL trong thư mục hệ thống. Máy người dùng cần VPN/đường mạng đến máy đích. Chạy trình duyệt không nhúng được RDP; sau khi cập nhật phần Rust cần khởi động lại hoặc build lại ứng dụng desktop.

Kiểm tra: `cargo test` kiểm tra nạp thành phần RDP thật, cấu hình bảo mật, cổng tùy chỉnh, kích thước, dữ liệu đăng nhập, cách ly cửa sổ và dọn cửa sổ con khi đóng phiên. Máy chủ TCP cục bộ xác nhận gói kết nối RDP thực sự được gửi đến đúng cổng đã cấp. Cần kiểm tra đăng nhập thực tế với máy Windows đích để xác nhận tài khoản, NLA, chứng chỉ và chính sách máy đích.

## SSH tích hợp trong LCIT Manager (xterm.js)

SSH hiện mở ngay trong giao diện bằng `@xterm/xterm` và `@xterm/addon-fit`. Phần Rust dùng `portable-pty` (ConPTY trên Windows) để chạy OpenSSH hệ thống, truyền dữ liệu qua Tauri Channel. RDP dùng giao diện nhúng mô tả ở trên. Các mục luồng cửa sổ riêng bên dưới là mô tả lịch sử trước khi tích hợp giao diện nhúng.

Luồng SSH hiện tại:

1. Ở **Máy chủ → Kết nối SSH/RDP**, chọn **Kết nối** tại điểm SSH được cấp quyền.
2. Nhập **Tên đăng nhập SSH**, bấm **Mở SSH**. Mỗi lần mở mới gọi `POST /access-endpoints/{id}/launch` để kiểm tra quyền và ghi audit. Đích lấy từ phản hồi mới nhất của API.
3. `ssh_open` kiểm tra đích và tên đăng nhập, chạy OpenSSH với `-tt -l <username>` cùng cổng, host và thời gian chờ đã kiểm tra. Không thông qua shell.
4. Nhập mật khẩu hoặc trả lời câu hỏi khóa máy chủ ngay trong terminal; mật khẩu không hiển thị. OpenSSH quản lý `known_hosts`, SSH config và khóa như thông thường. Không tự chấp nhận khóa máy chủ.
5. Terminal hỗ trợ màu ANSI, Ctrl+C, phím mũi tên, dán văn bản và tự đổi kích thước. **Đóng terminal**, rời màn hình hoặc đăng xuất sẽ đóng phiên và dừng tiến trình SSH; đóng cửa sổ chính xuống khay vẫn giữ phiên như các chức năng hiện tại.

`ssh_write`, `ssh_resize`, `ssh_close` chỉ thao tác phiên thuộc cửa sổ đã mở nó. Dữ liệu đầu ra giữ dạng byte để không hỏng UTF-8 khi chia gói. Không ghi mật khẩu, lệnh hay nội dung terminal vào log. `launch.log` ghi metadata khi tạo và kết thúc tiến trình; trạng thái `ExitedEarly` ở luồng nhúng biểu thị tiến trình đã kết thúc dù phiên kéo dài bao lâu, kèm mã thoát. `Started` chỉ có nghĩa tiến trình đang chạy, không khẳng định đăng nhập thành công.

Cần Windows có ConPTY (Windows 10 1809 trở lên) và OpenSSH Client, cùng VPN/đường mạng tới đích. Chế độ trình duyệt vẫn không mở SSH. Mỗi bảng chi tiết mở một terminal; muốn kết nối lại hãy đóng terminal cũ.

Kiểm tra: `npm run typecheck --workspace @lcit/desktop`, `npm run build --workspace @lcit/desktop`, `cargo test` trong `apps/desktop/src-tauri`. Test PTY thật kiểm tra nhập lệnh, thay đổi kích thước, nhận dữ liệu và mã thoát bằng tiến trình cục bộ. Cần thử đăng nhập thực tế với máy SSH nội bộ để xác nhận VPN, thông tin đăng nhập và các chương trình tương tác.

## Luồng cửa sổ riêng trước đây

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
| Đối số của `ssh` | `-o ConnectTimeout=10 -o ConnectionAttempts=1 -p <cổng> -- <host>`. Giới hạn chờ kết nối/bắt tay ban đầu 10 giây, thử một lần. Dấu `--` ngăn host bị hiểu là tùy chọn |
| Đối số của `mstsc` | `/v:host:cổng`, IPv6 viết `/v:[địa chỉ]:cổng` |
| Kiểm tra đích | Giao thức chỉ `ssh` hoặc `rdp` (chữ thường). Cổng 1–65535. Host là IPv4/IPv6 không kèm cổng, ngoặc hoặc zone, hoặc hostname ASCII (chữ, số, `-`, `_`), không bắt đầu bằng `-`. `authorizationId` phải đúng dạng UUID |
| Console cho `ssh` | Chạy trong cửa sổ console riêng và không thừa kế handle của ứng dụng |

Test: `cargo test` trong `apps/desktop/src-tauri` (9 test, gồm danh sách chuỗi bị từ chối như `-oProxyCommand=...`, `;`, `|`, xuống dòng, và trường hợp thiếu trình khách). `cargo test -- --ignored --test-threads=1` chạy thật `ssh.exe` và `mstsc.exe` (mở cửa sổ trong vài giây).

## Kết quả quan sát được

Lệnh theo dõi trình khách sau khi mở: `ssh` 4 giây (từ chối kết nối trên loopback mất khoảng 2 giây), `mstsc` 1,5 giây.

| Trạng thái | Ý nghĩa | Giao diện báo |
| --- | --- | --- |
| `started` | Trình khách còn chạy sau thời gian theo dõi | Với SSH, hiển thị cảnh báo đang chờ kết nối hoặc đăng nhập; không đánh dấu kết nối thành công |
| `exited_early` | Trình khách thoát sớm, kèm mã thoát (`ssh` mã 255 là không kết nối được) | Nhiều khả năng không kết nối được. Kiểm tra VPN, mạng, địa chỉ, cổng |
| `client_missing` | Máy không có `ssh.exe` hoặc `mstsc.exe` | Hướng dẫn cài OpenSSH Client |
| `spawn_failed` | Windows không mở được trình khách | Hiện lý do |
| `invalid` | Đích không qua kiểm tra, không có gì được mở | Báo Quản trị kiểm tra điểm truy cập |

Lỗi kết nối xảy ra muộn hơn thời gian theo dõi (ví dụ chờ hết hạn mạng) chỉ hiện trong cửa sổ của trình khách.

Khi cửa sổ SSH trống, đối chiếu **host của điểm truy cập** với địa chỉ mong muốn, VPN và cổng. Host có thể khác hostname máy chủ do NAT hoặc jump host, nên ứng dụng không tự sửa cho giống hostname. Nếu xác nhận là gõ nhầm, sửa điểm truy cập rồi cấp lại quyền cho đúng đích; không giữ nguyên quyền gắn với cấu hình cũ. Giới hạn 10 giây chỉ áp dụng kết nối/bắt tay ban đầu, không giới hạn thời gian người dùng nhập mật khẩu hoặc phiên làm việc.

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
