# Nền tảng giám sát — T3.1

T3.1 bổ sung migration `006_monitoring.sql`, lịch chạy phía máy chủ, trạng thái lần chạy gần nhất và ràng buộc chống trùng. Tác vụ đối chiếu hạn thuộc T3.2; kiểm tra DNS/TLS thực tế thuộc T3.3; phân phối và API thông báo thuộc T3.4.

## Áp dụng và cấu hình

Chạy `npm.cmd run db:migrate` rồi khởi động lại API. Migration thêm bảng và chỉ mục, không xóa dữ liệu danh mục. Lệnh migrate áp dụng mỗi tệp một lần và bỏ qua khi chạy lại.

API đọc cấu hình qua môi trường, với giá trị mẫu trong `apps/api/.env.example`:

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `MONITORING_ENABLED` | `on` | Nhận `on` hoặc `off`; `off` không chạy tác vụ, vẫn đọc được trạng thái cũ |
| `MONITORING_TIME_ZONE` | `Asia/Ho_Chi_Minh` | Múi giờ của cả hai lịch, độc lập múi giờ máy chủ |
| `MONITORING_EXPIRY_CRON` | `0 0 2 * * *` | Đối chiếu hạn hằng ngày lúc 02:00 giờ Việt Nam |
| `MONITORING_DNS_TLS_CRON` | `0 */30 * * * *` | Kiểm tra DNS/TLS tại phút 00 và 30 mỗi giờ |

Biểu thức mẫu có sáu trường, bắt đầu bằng giây. Cron hoặc múi giờ không hợp lệ làm API từ chối khởi động. Thay đổi cấu hình cần khởi động lại. Lịch dùng NestJS Schedule, chạy khi API đang hoạt động; không khởi chạy một tác vụ ngay khi API bật lại và không tự phát lại mọi lượt đã bỏ lỡ. T3.2 cần xét hạn hiện tại và chọn mốc khẩn nhất đang áp dụng sau thời gian ngừng chạy.

Ở T3.1 chưa có handler T3.2/T3.3: trạng thái là `waiting_handler`, không tạo cron timer, không phát sinh kết quả kiểm tra/cảnh báo và không ghi nhận thành công giả. Khi handler được đăng ký, lịch tương ứng mới bắt đầu hoạt động. Chỉ bật một tiến trình lịch trong pilot theo SPEC.

## Đọc trạng thái

`GET /api/v1/monitoring/jobs`, yêu cầu phiên Quản trị. Chưa đăng nhập trả 401; Lãnh đạo và Chuyên viên trả 403. Endpoint được khai báo trong Swagger.

Trả `enabled`, `timeZone`, `items`; mỗi mục có:

- `key`: `expiry` hoặc `dns_tls`; `cron`: lịch hiện hành.
- `handlerRegistered`: tác vụ nghiệp vụ đã được nối vào hay chưa.
- `state`: `disabled`, `waiting_handler` hoặc `scheduled`.
- `nextRunAt`: thời điểm lịch tiếp theo dạng UTC, hoặc `null` khi chưa lên lịch.
- `lastSuccessAt`: thời điểm thành công gần nhất, vẫn giữ sau một lượt thất bại.
- `lastRun`: `null` nếu chưa chạy; nếu đã chạy có `id`, `status`, `startedAt`, `finishedAt`, `errorCode`.

Trạng thái lần chạy là `running`, `succeeded`, `failed`, `interrupted`. `JOB_FAILED` ghi nhận lỗi tác vụ; `PROCESS_INTERRUPTED` cho lần chạy dang dở khi lấy lại được khóa sau một tiến trình/kết nối bị mất. Nội dung exception không được lưu hoặc ghi log vì có thể chứa thông tin kết nối nhạy cảm. Cấu hình lịch phản ánh tiến trình API hiện tại; lịch sử chạy lấy từ PostgreSQL.

## Lược đồ bàn giao

| Bảng | Nội dung và ràng buộc |
| --- | --- |
| `monitoring_jobs` | Hai tác vụ cố định, tham chiếu lần chạy gần nhất và thời điểm thành công gần nhất |
| `monitoring_job_runs` | Lịch sử bắt đầu/kết thúc, trạng thái và mã lỗi; chỉ cho phép trạng thái/thời điểm nhất quán |
| `check_runs` | Một kết quả cho mỗi đích/phép kiểm/lượt tác vụ; FK tới DNS hoặc TLS; chỉ mục theo đích và thời gian |
| `alerts` | Cảnh báo hạn hoặc sự kiện gián đoạn/phục hồi; FK tới đúng một tài nguyên; nhãn nguồn và khóa chống trùng |
| `notifications` | Một thông báo cho mỗi cặp cảnh báo–người nhận; `read_at` và chỉ mục danh sách/chưa đọc theo người nhận |

`check_runs.status` phân biệt `success`, `dns_error`, `timeout`, `tls_error`, `expired`. Phép kiểm DNS không được nhận trạng thái lỗi TLS/hết hạn. Kết quả có địa chỉ đã phân giải, hạn TLS quan sát được nếu có và mã lỗi tùy chọn. Không lưu chuỗi exception thô. Cặp `check_run_id` và ID đích trong cảnh báo được kiểm tra bằng khóa ngoại ghép để không tham chiếu kết quả của endpoint khác.

Cảnh báo hạn có nguồn `manual_domain`, `manual_tls` hoặc `observed_tls`, với `expiry_date` và `threshold_days`. Khóa duy nhất gồm loại tài nguyên, ID, nguồn, ngày hạn và mốc. Các mốc nhận `90`, `30`, `14`, `7`, `0`; `0` dành cho **quá hạn**, còn ngày hết hạn có số ngày còn lại bằng 0 vẫn dùng mốc 7 theo SPEC. Nguồn nhập tay và quan sát được độc lập; gia hạn sang ngày hạn mới tạo kỳ mới.

Sự kiện gián đoạn/phục hồi có nguồn `dns` hoặc `tls`, `check_run_id` và `transition_key` bắt buộc. Khóa duy nhất theo tài nguyên, loại kiểm tra và `transition_key`. T3.3 phải chọn một khóa ổn định cho mỗi lần chuyển trạng thái và dùng lại khi thử lại, thay vì tạo khóa mới cho mỗi lần lỗi liên tiếp. Nền tảng này chưa thực hiện quy tắc hai lần lỗi/một lần thành công; đó là T3.3.

Các thời điểm lưu `timestamptz`; ngày hạn nghiệp vụ lưu `date`. Các bảng có FK giữ toàn vẹn lịch sử: tài nguyên đã có kết quả/cảnh báo không thể xóa vật lý khi còn được tham chiếu. Có thể lưu trữ tài nguyên cha theo cơ chế danh mục hiện có. Không có xóa dây chuyền lịch sử. Thời hạn lưu kết quả và thông báo cần chốt ở D-04.

## Nối tác vụ T3.2–T3.3

Provider nghiệp vụ gọi `MonitoringService.register(key, handler)` trong `onModuleInit`; mỗi key chỉ nhận một handler. Handler nhận `{ runId, client }`, trong đó `client` là kết nối PostgreSQL riêng đang giữ advisory lock của tác vụ.

Runner ghi nhận bắt đầu trước khi gọi handler, rồi lưu thành công/thất bại khi kết thúc. Dùng kết nối `client` được cấp cho truy vấn của handler. Nếu cần nhiều thay đổi nguyên tử, mở transaction ngắn và luôn `COMMIT`/`ROLLBACK` trước khi trả về. Không giữ transaction trong lúc chờ DNS/TLS. Khi ghi cảnh báo và danh sách người nhận ở T3.2–T3.4, chúng phải ở cùng transaction và dùng `ON CONFLICT` phù hợp với các unique index. Người nhận và dữ liệu trả về vẫn phải lọc theo quyền hiện hành.

Runner giữ session advisory lock trong cả lượt xử lý; các transaction ngắn không làm mất khóa. Một lần gọi trùng lúc đang chạy trả `skipped_running` và không tạo bản ghi chạy mới. Lần không có handler hoặc đã tắt lịch cũng không ghi nhận thành công. Nếu tác vụ ném lỗi SQL khiến transaction bị hủy, runner rollback trước khi ghi `failed`. Khi lỗi mất kết nối làm chưa thể lưu kết quả, lần chạy còn `running` được chuyển thành `interrupted` khi khởi động lại hoặc trước lần chạy tiếp theo, sau khi lấy được khóa. Khởi động một API khác khi khóa còn được giữ không đánh dấu nhầm tác vụ đang hoạt động.

Khi tắt API bình thường, runner ngừng lịch và chờ tác vụ đang chạy; kết nối chuyên dụng được đóng để giải phóng khóa. Worker T3.3 phải có timeout và giới hạn song song để không giữ shutdown vô hạn. Unique constraint vẫn là lớp bảo vệ dữ liệu khi thử lại sau lỗi hoặc mất kết nối; không coi advisory lock là sự bảo đảm mọi tác động bên ngoài chỉ xảy ra một lần.

## Kiểm thử

`npm.cmd test --workspace @lcit/api` kiểm tra cấu hình lịch và múi giờ. Đặt `LCIT_TEST_DATABASE_URL` tới PostgreSQL dùng riêng, **chưa có schema `lcit`**, để chạy thêm migration hai lần, FK/check constraint, chống trùng cảnh báo/thông báo/kết quả kiểm tra, quyền API trạng thái, khóa giữa hai runner, lưu lỗi và phục hồi sau khởi động lại. Kiểm thử dùng handler giả, không gửi yêu cầu DNS/TLS ra mạng.
