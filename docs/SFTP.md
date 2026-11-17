# Truyền tệp SFTP

LCIT Manager dùng `ssh2-sftp-client` trong API Node.js. Terminal tương tác vẫn dùng xterm.js và OpenSSH trên desktop. SFTP là kết nối riêng, không dùng lại phiên terminal.

## Sử dụng

1. Mở chi tiết máy chủ, tại điểm truy cập SSH đã được cấp quyền chọn **Truyền tệp SFTP**.
2. Nhập tên đăng nhập, chọn **Kiểm tra máy chủ**. Lượt này chỉ lấy dấu vân tay khóa SSH, chưa gửi mật khẩu để đăng nhập máy đích.
3. Đối chiếu dấu vân tay `SHA256:…` với thông tin đáng tin cậy do quản trị máy đích cung cấp. Nhập mật khẩu rồi chọn **Xác nhận khóa và đăng nhập**.
4. Mở thư mục, nhập đường dẫn tuyệt đối hoặc chọn **Thư mục cha**. Dùng **Tải lên tệp** và **Tải xuống** để truyền từng tệp tối đa 20 MiB. Tệp tải lên phải có tên mới; ứng dụng không ghi đè tệp có sẵn. Liên kết tượng trưng được hiển thị nhưng không có nút mở/tải xuống.
5. Chọn **Đóng SFTP** để ngắt kết nối. Khi rời màn hình, giao diện gửi yêu cầu đóng. API cũng dọn phiên sau 5 phút không hoạt động, tối đa 1 giờ tồn tại, hoặc khi dừng API. Khi trình duyệt mất mạng/đóng đột ngột hoặc phiên đăng nhập hết hạn, cơ chế dọn phiên là dự phòng.

Máy **chạy API** cần có VPN/đường mạng tới host:cổng đã lưu và máy đích cần hỗ trợ SFTP. Chức năng này dùng được cả trong desktop và trình duyệt. Với API đặt trên máy khác, dùng HTTPS vì thông tin đăng nhập SFTP được gửi tới API; không triển khai API qua HTTP trên mạng không tin cậy.

Đăng nhập hỗ trợ cả phương thức `password` và lời nhắc mật khẩu ẩn qua `keyboard-interactive` (PAM). OTP, xác thực nhiều bước hoặc lời nhắc hiển thị ký tự không được tự trả lời bằng mật khẩu. Giao diện phân biệt lỗi đăng nhập bị từ chối, xác thực bổ sung, chờ quá lâu, thiếu SFTP subsystem và không đọc được thư mục ban đầu.

## Quyền và khóa máy chủ

Quản trị hoặc Chuyên viên cần quyền cho đúng cấu hình điểm truy cập SSH. Lãnh đạo không được dùng. API gọi lại cơ chế cấp quyền hiện tại trước khi mở, liệt kê hoặc truyền tệp; thu hồi quyền, đổi đích hoặc thay đổi phạm vi sẽ chặn thao tác tiếp theo và đóng phiên. Quyền thao tác thư mục/tệp cuối cùng do tài khoản SSH trên máy đích quyết định.

Phiên gắn với cả người dùng và phiên đăng nhập LCIT, không chỉ ID phiên SFTP. API không nhận host/cổng do giao diện tự nhập. Mỗi lần mở phải kiểm tra lại khóa máy chủ; không tự chấp nhận khóa khác, không lưu khóa hay mật khẩu xuống cơ sở dữ liệu hoặc bộ nhớ trình duyệt. Thông tin đăng nhập chỉ tồn tại trong bộ nhớ tiến trình khi thiết lập/duy trì kết nối; nội dung tệp không được lưu tạm xuống đĩa của API.

API giới hạn 32 phiên đang mở/đang kết nối. Một phiên chỉ thực hiện một thao tác mỗi lần; kết nối chờ tối đa 10 giây, thao tác SFTP tối đa 90 giây. Nhật ký cấp quyền hiện tại ghi quyết định truy cập; nhật ký HTTP chỉ ghi metadata, không ghi mật khẩu, tên tệp, đường dẫn truy vấn hay nội dung truyền.

## API

Các đường dẫn dưới đây thuộc `/api/v1`, yêu cầu Bearer token LCIT.

| Phương thức | Đường dẫn | Dữ liệu |
| --- | --- | --- |
| POST | `/access-endpoints/:id/sftp/sessions` | JSON `{ username, password, fingerprint? }`; thiếu fingerprint trả `{ requiresVerification: true, fingerprint, host, port }`, xác nhận đúng trả `{ requiresVerification: false, id, path, host, port, fingerprint }` |
| GET | `/sftp/sessions/:id/files?path=…` | Danh sách thư mục từ xa |
| POST | `/sftp/sessions/:id/upload?path=…` | Body `application/octet-stream`, tối đa 20 MiB, tạo tệp mới |
| GET | `/sftp/sessions/:id/download?path=…` | Tệp nhị phân và `Content-Disposition` |
| DELETE | `/sftp/sessions/:id` | Đóng phiên |

Đường dẫn từ xa dùng cú pháp POSIX tuyệt đối, ví dụ `/home/deploy/logs/app.log`. Lỗi thao tác từ máy đích hoặc hết thời gian chờ sẽ đóng phiên, cần kết nối lại. Tệp tải lên bị gián đoạn có thể còn một phần trên máy đích; ứng dụng không tự xóa tệp đó.

## Kiểm tra

`npm run test:sftp` khởi tạo máy chủ SSH/SFTP cục bộ thật để kiểm tra bắt tay, xác nhận khóa, xác thực, liệt kê, truyền tệp nhị phân/tệp rỗng, từ chối ghi đè, giới hạn dung lượng, hết hạn và cách ly phiên, thu hồi quyền và thay đổi đích. Không cần cơ sở dữ liệu hoặc máy SSH bên ngoài cho bộ kiểm thử này. Bộ kiểm thử phân quyền cơ sở dữ liệu hiện tại nằm trong `phase4-access.test.cjs`.
