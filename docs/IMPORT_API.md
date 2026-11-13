# Bàn giao nhập Excel — T2.2, T2.3, T2.4

Phạm vi người A: parser `.xlsx`, API xem trước, quyết định từng dòng và xác nhận nhập. Migration: `005_imports.sql`. Giao diện trình hướng dẫn và đối chiếu tệp thực thuộc T2.5–T2.6 của người B.

## Quyền và giới hạn

Chỉ Quản trị được sử dụng các API dưới `/api/v1/imports`. Lô thuộc tài khoản tạo; tài khoản khác nhận 404. Mọi yêu cầu cần `Authorization: Bearer <token>`. Không cần quyền tải tệp đính kèm để nhập Excel.

Nhận `.xlsx` không mã hóa, tối đa 10 MiB, 20 sheet, 10.000 dòng dữ liệu trên toàn workbook, 64 cột mỗi sheet và 4.000 ký tự mỗi ô. ZIP được kiểm tra trước khi đọc workbook: tối đa 2.000 mục, tổng kích thước giải nén khai báo tối đa 50 MiB. Công thức, hyperlink và ô lỗi được báo lỗi khi ánh xạ; không chạy công thức hoặc truy cập liên kết. `.xls` chưa được hỗ trợ.

## Hợp đồng API

1. `POST /imports?fileName=sample.xlsx`: body là nội dung tệp, `Content-Type: application/octet-stream`. Trả HTTP 201 với `id`, `fileName`, `status: uploaded`, `previewVersion: 0` và `sheets`. Mỗi sheet có `name`, `rowCount` (số dòng không rỗng, gồm tiêu đề) và tối đa năm `sampleRows`, mỗi dòng gồm `rowNumber` gốc và `cells`.
2. `POST /imports/{id}/preview`: gửi sheet, dòng tiêu đề, ánh xạ cột, phiên bản hiện tại và quyết định nếu có. Trả HTTP 200, phiên bản mới và toàn bộ dòng xem trước. Xem trước không ghi danh mục.
3. `GET /imports/{id}`: đọc lại sheet, ánh xạ, phiên bản, các dòng và quyết định đã lưu. Sau xác nhận có thêm `result` của từng dòng và biên nhận toàn lô.
4. `POST /imports/{id}/confirm`: gửi phiên bản xem trước và số dòng được chọn. Trả biên nhận đã lưu gồm số dòng `created`, `merged`, `skipped` và ID tài nguyên theo dòng. Các số đếm này là số dòng nguồn, không phải số tài nguyên.

Ví dụ ánh xạ cho `fixtures/import-sample.xlsx`:

```json
{
  "sheet": "Catalog",
  "headerRow": 1,
  "previewVersion": 0,
  "columns": {
    "organizationCode": 1,
    "dataCenterCode": 2,
    "applicationCode": 3,
    "applicationName": 4,
    "serverCode": 5,
    "hostname": 6,
    "networkScope": 7,
    "privateIp": 8,
    "domain": 9
  },
  "decisions": []
}
```

Chín trường trên bắt buộc ánh xạ. Cột đánh số từ 1, không dùng một cột cho nhiều trường. Tùy chọn thêm `serviceType` và `renewalDate`. `serviceType` mặc định `operations`, nhận `ordered`, `monitoring`, `operations`. Ngày nhận ô ngày Excel hoặc chuỗi `YYYY-MM-DD`; không suy đoán `dd/mm/yyyy` hay ngày mơ hồ. Mã và phạm vi mạng được viết hoa, hostname/tên miền được chuẩn hóa chữ thường, IDN và dấu chấm cuối; IPv6 được chuẩn hóa. Giữ nguyên số dòng gốc, bỏ dòng rỗng.

## Dòng xem trước và xử lý trùng

Mỗi dòng có `rowNumber`, `data`, `errors` (`column`, `field`, `reason`), `status`, `reasons`, `matches`, `targets`, `snapshot`, `duplicateOf`, `decision`. `matches` chứa bản ghi đối chiếu và phiên bản; giao diện không cần gửi lại chúng. Máy chủ chỉ dùng dữ liệu xem trước đã lưu.

| status | Ý nghĩa | Quyết định |
| --- | --- | --- |
| `new` | Chưa có ứng dụng, máy chủ hoặc tên miền đối chiếu | Mặc định `create`; có thể `skip` |
| `match` | Có bản ghi theo mã, tên miền hoặc IP kèm phạm vi mạng | Mặc định `skip`; cần chọn `merge` rõ ràng |
| `duplicate` | Dữ liệu chuẩn hóa giống hệt dòng trước trong workbook | `skip`; `duplicateOf` chỉ dòng gốc |
| `conflict` | Tham chiếu thiếu/lưu trữ, định danh mâu thuẫn hoặc dữ liệu trong lô mâu thuẫn | `skip`; sửa nguồn và tải lô mới |
| `error` | Ô không hợp lệ, ví dụ IP hoặc ngày sai | `skip`; sửa nguồn và tải lô mới |

Đơn vị và DC phải tồn tại và chưa lưu trữ; nhập Excel không tự tạo chúng. Ứng dụng đối chiếu bằng mã; tên giống nhau trong cùng đơn vị nhưng khác mã cần người dùng sửa mã nguồn. Máy chủ đối chiếu theo mã hoặc IP riêng kèm phạm vi mạng; hai tiêu chí trỏ hai máy khác nhau thì xung đột. Không gộp chỉ dựa vào hostname hoặc IP không có phạm vi. Nếu chọn gộp qua IP và phạm vi, giữ mã máy chủ đang tồn tại. Tên miền đối chiếu tên chuẩn hóa.

Gộp cập nhật tên, đơn vị và hình thức dịch vụ của ứng dụng; hostname và DC của máy chủ; ngày gia hạn của tên miền khi có giá trị. Thêm IP riêng và các liên kết ứng dụng–máy chủ, ứng dụng–tên miền; giữ các liên kết, địa chỉ cũ và trường ngoài ánh xạ. Gộp có thể sửa tài nguyên dùng chung, vì vậy cần hiển thị bản ghi đối chiếu cho Quản trị trước khi họ chọn. Ngày trống giữ ngày hiện có. Hình thức dịch vụ không ánh xạ dùng mặc định `operations`, kể cả khi gộp.

Nhiều dòng có thể dùng chung ứng dụng/máy chủ/tên miền nếu thông tin tương ứng nhất quán. Dòng sau có thông tin mâu thuẫn được đánh dấu xung đột. Không tự chọn dòng thắng.

Để lưu quyết định gộp cho dòng 2, gọi lại preview với cùng ánh xạ, `previewVersion` hiện tại và:

```json
{ "decisions": [{ "rowNumber": 2, "action": "merge" }] }
```

Đây là phần bổ sung vào body preview đầy đủ. Mỗi lần preview tạo lại quyết định từ mặc định và danh sách gửi lên; giao diện cần gửi lại toàn bộ lựa chọn muốn giữ. Cập nhật từ phiên bản cũ trả 409, tránh ghi đè lựa chọn giữa hai cửa sổ.

## Xác nhận, xung đột và thử lại

```json
{ "previewVersion": 1, "rowNumbers": [2, 3] }
```

Chỉ chọn các dòng có quyết định `create` hoặc `merge`. Dòng không chọn được ghi kết quả `skipped`. Danh sách rỗng hoàn tất lô mà không nhập tài nguyên.

Xác nhận khóa lô, khóa các bảng danh mục liên quan để ngăn ghi xen kẽ, đối chiếu lại bản ghi/phạm vi IP và phiên bản so với ảnh chụp xem trước. Nếu tài nguyên liên quan bị sửa hoặc xuất hiện đối chiếu mới, trả 409 `IMPORT_CONFLICT`; toàn bộ thay đổi bị hủy. Gọi preview lại bằng phiên bản hiện tại rồi chọn và xác nhận lại. Các thay đổi danh mục không liên quan không làm hết hiệu lực bản xem trước.

Dữ liệu danh mục, kết quả từng dòng, trạng thái lô và audit `imports.confirm` được ghi trong cùng transaction. Bất kỳ lỗi nào cũng hoàn tác toàn lô. Hai xác nhận đồng thời cho cùng lô trả cùng biên nhận; lô hoàn tất gửi lại trả kết quả đã lưu dù phiên bản hay tập dòng trong yêu cầu mới khác. Không thể sửa preview của lô hoàn tất. Khóa xác nhận cho phép đọc bình thường nhưng các thao tác ghi danh mục khác phải chờ; triển khai pilot nên nhập lô lớn ngoài giờ cập nhật cao điểm.

Nội dung workbook được chuyển thành dữ liệu ô trong PostgreSQL, không lưu tệp gốc vào kho đính kèm. Sao lưu PostgreSQL bao gồm lô và kết quả; thời hạn lưu lô cần chốt ở D-04 trước sản xuất. Audit không chứa nội dung workbook.

## Kiểm thử

`npm.cmd test --workspace @lcit/api` chạy parser, chuẩn hóa, lỗi ô, giới hạn ZIP và nhận diện trùng. Đặt `LCIT_TEST_DATABASE_URL` tới PostgreSQL riêng, chưa có schema `lcit`, để chạy thêm toàn bộ kiểm thử API, transaction, quyền, xung đột và xác nhận đồng thời. Các bài tích hợp chỉ dọn schema do chúng tự tạo. Không đặt biến này trỏ tới database phát triển hoặc sản xuất.

Với DB trống đã tạo hai đơn vị và hai DC mẫu: dòng 2–3 là mới, dòng 4 trùng dòng 2, dòng 5 lỗi IP. Với DB đã seed: dòng 2–3 đối chiếu dữ liệu sẵn có và cần chọn gộp. D-02 vẫn cần tệp thực đã ẩn dữ liệu và xác nhận quy tắc từ người B trước khi nhập dữ liệu thật.
