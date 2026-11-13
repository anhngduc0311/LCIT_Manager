# Giám sát — T3.1–T3.4

T3.1 bổ sung migration `006_monitoring.sql`, lịch chạy phía máy chủ, trạng thái lần chạy gần nhất và ràng buộc chống trùng. T3.2 đã nối tác vụ đối chiếu hạn. T3.3 bổ sung `007_network_monitoring.sql`, duyệt đích DNS/TLS, kiểm tra mạng và trạng thái gián đoạn/phục hồi. T3.4 đã có API cảnh báo/thông báo, trạng thái đã đọc và lọc quyền tại lúc đọc; xem [hợp đồng và fixture bàn giao](NOTIFICATIONS_API.md). Không có migration mới ở T3.4.

## Áp dụng và cấu hình

Chạy `npm.cmd run db:migrate` rồi khởi động lại API. Migration thêm bảng và chỉ mục, không xóa dữ liệu danh mục. Lệnh migrate áp dụng mỗi tệp một lần và bỏ qua khi chạy lại.

T3.2 sử dụng các bảng của `006_monitoring.sql`. T3.3 cần áp dụng thêm `007_network_monitoring.sql` trước khi build và khởi động lại API. Migration mới thêm bảng cấu hình đích, trạng thái gián đoạn và kết quả `blocked`; giữ nguyên lịch sử hiện có. Không có đích nào tự động được bật sau migration.

API đọc cấu hình qua môi trường, với giá trị mẫu trong `apps/api/.env.example`:

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `MONITORING_ENABLED` | `on` | Nhận `on` hoặc `off`; `off` không chạy tác vụ, vẫn đọc được trạng thái cũ |
| `MONITORING_TIME_ZONE` | `Asia/Ho_Chi_Minh` | Múi giờ của cả hai lịch, độc lập múi giờ máy chủ |
| `MONITORING_EXPIRY_CRON` | `0 0 2 * * *` | Đối chiếu hạn hằng ngày lúc 02:00 giờ Việt Nam |
| `MONITORING_DNS_TLS_CRON` | `0 */30 * * * *` | Kiểm tra DNS/TLS tại phút 00 và 30 mỗi giờ |

Biểu thức mẫu có sáu trường, bắt đầu bằng giây. Cron hoặc múi giờ không hợp lệ làm API từ chối khởi động. Thay đổi cấu hình cần khởi động lại. Lịch dùng NestJS Schedule, chạy khi API đang hoạt động; không khởi chạy một tác vụ ngay khi API bật lại và không tự phát lại mọi lượt đã bỏ lỡ. Tác vụ đối chiếu hạn xét hạn hiện tại và chọn mốc khẩn nhất đang áp dụng sau thời gian ngừng chạy.

Cả `expiry` và `dns_tls` đã có handler và chuyển sang `scheduled` khi bật lịch. Khi tắt lịch, cả hai trả `disabled`. Nếu chưa duyệt đích, lịch DNS/TLS vẫn có thể chạy thành công nhưng không gửi yêu cầu kiểm tra nào. Chỉ bật một tiến trình lịch trong pilot theo SPEC.

## Kiểm tra mạng — T3.3

Các đích chỉ được kiểm tra khi Quản trị đã bật chúng bằng API và chúng thỏa chính sách mạng phía máy chủ. Chỉ thêm một bản ghi DNS hoặc endpoint TLS vào danh mục chưa làm phát sinh kiểm tra tự động.

| Biến môi trường | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `MONITORING_ALLOWED_HOSTS` | Rỗng | Hostname chính xác hoặc mẫu `*.example.test`, phân cách bằng dấu phẩy; mẫu chỉ khớp tên con, không khớp tên gốc |
| `MONITORING_ALLOWED_CIDRS` | Rỗng | Các vùng IPv4/IPv6 được phép, ví dụ `10.42.0.0/16,2001:db8::/32` |
| `MONITORING_ALLOWED_TLS_PORTS` | `443` | Danh sách cổng TLS được phép |
| `MONITORING_CHECK_TIMEOUT_MS` | `5000` | Tổng thời gian mỗi phép kiểm, gồm DNS và bắt tay TLS; tối đa 30.000 ms |
| `MONITORING_CHECK_CONCURRENCY` | `4` | Số phép kiểm mạng đồng thời; từ 1 đến 16 |

Hostname và SNI đều phải được phép. Host là IP trực tiếp được xét bằng CIDR. CIDR rỗng không cho phép kết nối TLS hoặc chấp nhận kết quả A/AAAA. Không suy diễn việc cho phép mạng từ dữ liệu người dùng nhập. Địa chỉ unspecified, broadcast, multicast và link-local bị từ chối dù cấu hình CIDR rộng; IPv4-mapped IPv6 dùng chính sách IPv4. Loopback chỉ dùng được khi vận hành chủ động cho phép bằng CIDR, như trong kiểm thử cục bộ.

DNS dùng resolver của máy chạy API, truy vấn đúng loại A/AAAA/CNAME/NS/PTR/MX/TXT/SRV/CAA đã lưu. Thành công nghĩa là truy vấn trả câu trả lời không rỗng; chưa đối chiếu nội dung với trường `target`. Với A/AAAA, toàn bộ địa chỉ trả về phải nằm trong CIDR được phép. Giá trị TXT/MX/SRV không được coi là lệnh hay đích để mở kết nối tiếp. Bản ghi wildcard không được dò tự động.

TLS phân giải A và AAAA, kiểm tra toàn bộ tập địa chỉ rồi kết nối trực tiếp tới **một IP đã kiểm tra**, giữ hostname/SNI cho xác thực chứng thư. Không phân giải lại trong bước mở socket, không chuyển hướng và không tự đổi đích theo nội dung trả về. Một địa chỉ ngoài chính sách trong tập câu trả lời làm cả phép kiểm bị chặn. Bản hiện tại dùng địa chỉ hợp lệ đầu tiên; không thử lần lượt mọi IP khi một máy trong cụm thất bại.

TLS yêu cầu tối thiểu TLS 1.2, kiểm tra danh tính hostname và kết quả xác thực chuỗi chứng thư. Handshake được giữ mở đủ để phân loại chứng thư hết hạn; cấu hình này không biến chứng thư không tin cậy hoặc sai hostname thành thành công. Hạn của chứng thư hợp lệ hoặc chứng thư được phân loại `CERT_HAS_EXPIRED` được ghi vào `tls_endpoints.observed_expiry_at` để tác vụ T3.2 đối chiếu. Lỗi không tin cậy/sai danh tính không ghi đè hạn đã quan sát. Nếu dùng CA nội bộ, cấu hình kho tin cậy của Node khi khởi động API, ví dụ `NODE_EXTRA_CA_CERTS`; không tải CA từ yêu cầu API.

### Duyệt đích và xem kết quả

Các API sau yêu cầu phiên Quản trị; Lãnh đạo và Chuyên viên nhận 403:

- `PUT /api/v1/monitoring/targets/dns/{dnsRecordId}` hoặc `/tls/{tlsEndpointId}` với `{"version":0,"enabled":true}` để duyệt lần đầu. `version` là phiên bản cấu hình giám sát, độc lập phiên bản tên miền.
- Khi sửa hoặc bật/tắt lại, gửi `version` hiện hành. Mỗi lần duyệt chụp lại cấu hình hiện tại và đặt lại trạng thái sức khỏe về `unknown`. Dữ liệu lịch sử vẫn giữ. Tắt bằng `enabled:false`.
- `GET /api/v1/monitoring/targets?page=1&pageSize=25`: danh sách đích đã duyệt, cấu hình hiện tại, `needsApproval`, `health`, `consecutiveFailures`, kết quả gần nhất và mã lý do.
- `GET /api/v1/monitoring/targets/{type}/{endpointId}/checks`: lịch sử theo đích, có phân trang; `type` nhận `dns` hoặc `tls`. Đích thuộc tên miền đã lưu trữ không được trả về.

Không có API chạy tức thì hoặc nhập hostname tùy ý để dò mạng. `PUT` chỉ tham chiếu tài nguyên đã lưu trong danh mục. Duyệt/bật/tắt ghi audit cùng transaction. Sửa host, cổng, SNI hoặc cấu hình DNS sau khi duyệt làm `needsApproval:true`; lần chạy ghi `blocked / CONFIG_CHANGED` và không gọi mạng cho cấu hình mới cho tới khi Quản trị duyệt lại. Kết quả đang bay bị bỏ nếu phiên bản bị đổi, đích bị tắt, cấu hình thay đổi hoặc tên miền bị lưu trữ trước khi ghi kết quả.

### Trạng thái và sự kiện

| Kết quả | Ý nghĩa |
| --- | --- |
| `success` | Truy vấn DNS có câu trả lời hoặc TLS xác thực thành công |
| `dns_error` | Không phân giải được hoặc không có câu trả lời |
| `timeout` | Hết thời gian kiểm tra DNS hoặc tổng thời gian kết nối |
| `tls_error` | Lỗi kết nối, bắt tay, chuỗi chứng thư hoặc hostname |
| `expired` | Chứng thư của endpoint được xác định đã hết hạn |
| `blocked` | Đích, cổng, địa chỉ hoặc cấu hình không được phép; không kết luận dịch vụ hỏng |

`errorCode` chứa mã cố định như `DNS_LOOKUP_FAILED`, `CHECK_TIMEOUT`, `TLS_UNTRUSTED`, `TLS_IDENTITY_INVALID`, `CERT_HAS_EXPIRED`, `ADDRESS_NOT_ALLOWED`. Không lưu thông điệp exception thô. Phép kiểm chỉ phản ánh khả năng truy cập từ máy chạy lịch, không chứng minh ứng dụng hoạt động đầy đủ.

Mỗi đích có trạng thái `unknown`, `up`, `down` và bộ đếm lỗi riêng. Một lần lỗi không tạo gián đoạn; hai lỗi liên tiếp mới chuyển sang `down` và tạo một `outage`. Các lần lỗi tiếp theo không tạo thêm sự kiện. Một `success` đặt lại bộ đếm; nếu trước đó `down` thì tạo đúng một `recovery`. Thành công đầu tiên từ `unknown` không phải sự kiện phục hồi. `blocked` xóa chuỗi lỗi đang đếm và giữ trạng thái sức khỏe, không tạo outage/recovery.

Kết quả kiểm tra, cập nhật trạng thái, hạn TLS quan sát, sự kiện và thông báo được ghi trong một transaction ngắn cho từng đích; không giữ transaction khi gọi mạng. Khóa duy nhất theo lượt chạy và endpoint ngăn một kết quả gửi lại làm tăng bộ đếm hai lần. Trạng thái được lưu trong PostgreSQL nên không mất khi khởi động lại. Một lượt có lỗi lưu dữ liệu nhận trạng thái tác vụ `failed`; các đích đã commit trước đó vẫn giữ kết quả và được kiểm tra ở lượt tiếp theo.

Thông báo sự kiện TLS dùng phạm vi tên miền. Sự kiện DNS dùng **liên kết đúng bản ghi DNS** với ứng dụng mà người nhận được phép xem; quyền xem tên miền cha không tự cấp quyền nhận chi tiết DNS khác. Chỉ tài khoản hoạt động, chưa xóa được nhận; các đường liên kết trùng không tạo nhiều thông báo. API T3.4 kiểm tra lại quyền hiện hành khi cung cấp dữ liệu đọc.

## Đối chiếu hạn — T3.2

Mỗi lần chạy lấy dữ liệu hiện có trong PostgreSQL từ ba nguồn độc lập:

| Nguồn | Trường dữ liệu |
| --- | --- |
| `manual_domain` | `domains.renewal_date` |
| `manual_tls` | `tls_endpoints.manual_expiry_date` |
| `observed_tls` | `tls_endpoints.observed_expiry_at` |

Chỉ xét tên miền chưa lưu trữ và endpoint thuộc tên miền đó; bỏ qua hạn trống. Tác vụ không truy vấn RDAP, DNS hoặc kết nối TLS. Hạn quan sát được lấy từ lần quan sát đã lưu; T3.3 sẽ cập nhật nguồn này khi kiểm tra thực tế.

Ngày hiện tại và ngày của thời điểm TLS được tính theo `MONITORING_TIME_ZONE`, mặc định giờ Việt Nam. Hạn nhập tay là ngày lịch. Quy tắc cảnh báo theo ngày áp dụng cho cả ba nguồn; việc chứng thư thực sự hết hạn trong ngày sẽ do trạng thái phép kiểm TLS ở T3.3 phản ánh.

| Số ngày còn lại | Mốc tạo cảnh báo |
| --- | --- |
| Trên 90 | Không tạo |
| 31–90 | 90 |
| 15–30 | 30 |
| 8–14 | 14 |
| 0–7 | 7 |
| Âm | 0 — quá hạn |

Ví dụ lịch bị lỡ tới khi còn 13 ngày: chỉ tạo mốc 14, không phát lại mốc 90 và 30. Chạy lại cùng mốc, nguồn và kỳ hạn không tạo thêm cảnh báo hoặc gửi lại thông báo. Đổi ngày hạn sau gia hạn tạo kỳ mới, giữ nguyên lịch sử cũ. Hai nguồn SSL nhập tay và TLS quan sát được có thể cùng cảnh báo cho một endpoint vì chúng có nhãn nguồn riêng.

Cảnh báo mới và thông báo cho người nhận được tạo bằng một câu lệnh PostgreSQL nguyên tử, cùng ảnh chụp dữ liệu/quyền. Nếu ghi thông báo lỗi, cả cảnh báo mới cũng hoàn tác và lần sau có thể thử lại. Khóa của runner ngăn hai lượt chạy cùng tác vụ; unique constraint tiếp tục chống trùng khi thử lại hoặc có truy vấn đồng thời.

Chỉ thông báo cho tài khoản đang hoạt động, chưa xóa: Quản trị toàn hệ thống; Lãnh đạo có quyền xem đơn vị liên quan; Chuyên viên được phân công ứng dụng liên quan. Dùng cùng bộ lọc quyền tên miền của API, gồm liên kết trực tiếp, qua bản ghi DNS hoặc máy chủ dùng chung. Ứng dụng đã lưu trữ không cấp quyền xem. Mỗi người chỉ nhận một thông báo cho mỗi cảnh báo dù có nhiều đường liên kết. Tên miền chưa liên kết ứng dụng vẫn cảnh báo cho Quản trị.

Người nhận được chốt tại thời điểm tạo cảnh báo mới. Chạy lại không bổ sung người nhận vào cảnh báo cũ; các mốc/kỳ mới dùng quyền tại lần tạo tương ứng. API T3.4 lọc lại quyền hiện hành khi đọc, để thông báo cũ không lộ tài nguyên sau khi thu hồi phân công. Chưa có màn hình hoặc thông báo khay ở bước này.

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

`check_runs.status` phân biệt `success`, `dns_error`, `timeout`, `tls_error`, `expired`, `blocked`. Phép kiểm DNS không được nhận trạng thái lỗi TLS/hết hạn. Kết quả có địa chỉ đã phân giải, hạn TLS quan sát được nếu có và mã lỗi tùy chọn. Không lưu chuỗi exception thô. Cặp `check_run_id` và ID đích trong cảnh báo được kiểm tra bằng khóa ngoại ghép để không tham chiếu kết quả của endpoint khác. Bảng `monitoring_targets` lưu duyệt đích, bộ đếm lỗi và tham chiếu kết quả gần nhất.

Cảnh báo hạn có nguồn `manual_domain`, `manual_tls` hoặc `observed_tls`, với `expiry_date` và `threshold_days`. Khóa duy nhất gồm loại tài nguyên, ID, nguồn, ngày hạn và mốc. Các mốc nhận `90`, `30`, `14`, `7`, `0`; `0` dành cho **quá hạn**, còn ngày hết hạn có số ngày còn lại bằng 0 vẫn dùng mốc 7 theo SPEC. Nguồn nhập tay và quan sát được độc lập; gia hạn sang ngày hạn mới tạo kỳ mới.

Sự kiện gián đoạn/phục hồi có nguồn `dns` hoặc `tls`, `check_run_id` và `transition_key` bắt buộc. Khóa duy nhất theo tài nguyên, loại kiểm tra và `transition_key`. T3.3 dùng ID kết quả gây chuyển trạng thái làm khóa ổn định, không tạo sự kiện cho lỗi liên tiếp sau khi đã down.

Các thời điểm lưu `timestamptz`; ngày hạn nghiệp vụ lưu `date`. Các bảng có FK giữ toàn vẹn lịch sử: tài nguyên đã có kết quả/cảnh báo không thể xóa vật lý khi còn được tham chiếu. Có thể lưu trữ tài nguyên cha theo cơ chế danh mục hiện có. Không có xóa dây chuyền lịch sử. Thời hạn lưu kết quả và thông báo cần chốt ở D-04.

## Nối tác vụ T3.2–T3.3

Provider nghiệp vụ gọi `MonitoringService.register(key, handler)` trong `onModuleInit`; mỗi key chỉ nhận một handler. `ExpiryMonitorService` đăng ký key `expiry`; `NetworkMonitorService` đăng ký `dns_tls`. Handler nhận `{ runId, client }`, trong đó `client` là kết nối PostgreSQL riêng đang giữ advisory lock của tác vụ.

Runner ghi nhận bắt đầu trước khi gọi handler, rồi lưu thành công/thất bại khi kết thúc. Dùng kết nối `client` được cấp cho truy vấn của handler. Nếu cần nhiều thay đổi nguyên tử, mở transaction ngắn và luôn `COMMIT`/`ROLLBACK` trước khi trả về. Không giữ transaction trong lúc chờ DNS/TLS. Khi ghi cảnh báo và danh sách người nhận ở T3.2–T3.4, chúng phải ở cùng transaction và dùng `ON CONFLICT` phù hợp với các unique index. Người nhận và dữ liệu trả về vẫn phải lọc theo quyền hiện hành.

Runner giữ session advisory lock trong cả lượt xử lý; các transaction ngắn không làm mất khóa. Một lần gọi trùng lúc đang chạy trả `skipped_running` và không tạo bản ghi chạy mới. Lần không có handler hoặc đã tắt lịch cũng không ghi nhận thành công. Nếu tác vụ ném lỗi SQL khiến transaction bị hủy, runner rollback trước khi ghi `failed`. Khi lỗi mất kết nối làm chưa thể lưu kết quả, lần chạy còn `running` được chuyển thành `interrupted` khi khởi động lại hoặc trước lần chạy tiếp theo, sau khi lấy được khóa. Khởi động một API khác khi khóa còn được giữ không đánh dấu nhầm tác vụ đang hoạt động.

Khi tắt API bình thường, runner ngừng lịch và chờ tác vụ đang chạy; kết nối chuyên dụng được đóng để giải phóng khóa. Worker T3.3 phải có timeout và giới hạn song song để không giữ shutdown vô hạn. Unique constraint vẫn là lớp bảo vệ dữ liệu khi thử lại sau lỗi hoặc mất kết nối; không coi advisory lock là sự bảo đảm mọi tác động bên ngoài chỉ xảy ra một lần.

## Kiểm thử

`npm.cmd test --workspace @lcit/api` kiểm tra cấu hình lịch và múi giờ. Đặt `LCIT_TEST_DATABASE_URL` tới PostgreSQL dùng riêng, **chưa có schema `lcit`**, để chạy thêm migration hai lần, FK/check constraint, chống trùng cảnh báo/thông báo/kết quả kiểm tra, quyền API trạng thái, khóa giữa hai runner, lưu lỗi và phục hồi sau khởi động lại. Kiểm thử dùng handler giả, không gửi yêu cầu DNS/TLS ra mạng.

Bộ kiểm thử T3.2 chạy tác vụ thật trên dữ liệu tổng hợp với thời điểm cố định: đủ mốc và ranh giới 90/30/14/7, ngày 0, quá hạn, lỡ lịch, gia hạn, hai nguồn TLS, UTC qua ngày tại Việt Nam, phạm vi hai đơn vị và máy chủ dùng chung, tài khoản khóa/xóa, hoàn tác khi thông báo lỗi và chạy đồng thời. Có ca gọi qua runner thực để xác nhận việc nối tác vụ và lưu trạng thái.

Bộ kiểm thử T3.3 dùng resolver giả và máy chủ TLS cục bộ với CA/chứng thư chỉ dành cho kiểm thử, không gọi đích bên ngoài. Phân biệt thành công, lỗi DNS, timeout, sai danh tính, không tin cậy, hết hạn; kiểm tra tập DNS pha địa chỉ bị cấm, IP ghim, IPv4-mapped IPv6, giới hạn song song, quyền duyệt đích, lỗi thoáng qua, outage/recovery chống lặp, vô hiệu hóa khi đang chạy và hoàn tác khi thông báo lỗi.
