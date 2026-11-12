# LCIT Manager

Nền tảng phát triển cho ứng dụng quản lý hạ tầng. Desktop dùng Next.js xuất tĩnh và Tauri v2. API dùng NestJS và kết nối trực tiếp tới PostgreSQL Neon.

## Chạy lần đầu sau khi clone trên Windows

Để chạy trên trình duyệt, chuẩn bị **Node.js 22 trở lên**, npm và quyền truy cập cơ sở dữ liệu **PostgreSQL Neon** dùng cho phát triển. Chạy các lệnh bên dưới trong PowerShell tại thư mục gốc `LCIT_Manager`.

### 1. Cài dependencies và cấu hình database

```powershell
node -v
npm.cmd -v
npm.cmd install
if (-not (Test-Path apps/api/.env.local)) {
    Copy-Item apps/api/.env.example apps/api/.env.local
}
```

Mở `apps/api/.env.local` và thay giá trị mẫu của `DATABASE_URL` bằng chuỗi kết nối Neon của môi trường phát triển. Chỉ đưa tệp `.env.example` chứa cấu hình mẫu vào Git.

```powershell
npm.cmd run db:migrate
```

Lệnh áp dụng các migration còn thiếu. Nếu muốn có dữ liệu mẫu trên database thử nghiệm, chạy thêm `npm.cmd run db:seed`.


### 2. Chạy API và giao diện

Mở hai cửa sổ PowerShell tại thư mục gốc và giữ cả hai chạy trong lúc sử dụng.

| Cửa sổ | Lệnh | Địa chỉ |
| --- | --- | --- |
| API | `npm.cmd run dev:api` | [Swagger UI](http://127.0.0.1:4000/docs), [OpenAPI JSON](http://127.0.0.1:4000/docs-json) |
| Giao diện | `npm.cmd run dev:desktop`, `npm.cmd run desktop:dev` | [LCIT Manager](http://127.0.0.1:3000) |

Mở giao diện và đăng nhập bằng tài khoản ở bước 2 hoặc tài khoản đã có trên database. Nếu muốn chạy bản ứng dụng Windows bằng Tauri, xem mục [Build và chạy ứng dụng Windows](#build-và-chạy-ứng-dụng-windows).

### Kiểm tra kết nối API

Kiểm tra API từ PowerShell khi API đang chạy.

```powershell
curl.exe -i http://127.0.0.1:4000/health/live
curl.exe -i http://127.0.0.1:4000/health/ready
```

Liveness trả HTTP 200 khi tiến trình API chạy. Readiness trả HTTP 200 khi PostgreSQL phản hồi và HTTP 503 khi PostgreSQL không truy cập được. Để kiểm tra nhánh lỗi, mở terminal khác, tạm đặt `$env:DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/invalid?sslmode=disable'`, dừng API đang chạy rồi khởi động API từ terminal đó. Sau khi kiểm tra, chạy `Remove-Item Env:DATABASE_URL` và khởi động lại API.

## Cấu trúc mã nguồn MVC

- **Model** nằm trong `apps/api/src/models` và `apps/desktop/src/models`. Các service NestJS xử lý nghiệp vụ và truy vấn PostgreSQL. Model desktop định nghĩa kiểu dữ liệu và gửi yêu cầu tới API.
- **View** nằm trong `apps/desktop/src/views`, gồm các thành phần React, cấu hình hiển thị danh mục và CSS theo màn hình. Next.js dùng `apps/desktop/app` để khai báo route và layout.
- **Controller** nằm trong `apps/api/src/controllers` và `apps/desktop/src/controllers`. Controller NestJS nhận yêu cầu HTTP, khai báo Swagger và gọi service. Các hook desktop xử lý phiên, điều hướng và thao tác dữ liệu cho View.

Luồng chính đi từ View qua hook desktop và API client đến controller NestJS. Controller gọi Model để đọc hoặc ghi PostgreSQL rồi trả JSON cho desktop.

## API Giai đoạn 1

Trong Swagger UI tại `http://127.0.0.1:4000/docs`, gọi `POST /api/v1/auth/login`, rồi nhập `token` vào **Authorize** để gọi API bảo vệ. Token hết hạn sau tám giờ. `POST /api/v1/auth/logout` thu hồi phiên hiện tại. Đổi mật khẩu hoặc khóa tài khoản thu hồi các phiên của tài khoản đó. Đăng nhập giới hạn năm lượt theo tên đăng nhập và 60 lượt theo địa chỉ kết nối trong mỗi cửa sổ 15 phút. Nếu API đặt sau reverse proxy, cân nhắc giới hạn theo địa chỉ kết nối khi nhiều người dùng dùng chung một proxy.

| API dưới `/api/v1` | Hành vi |
| --- | --- |
| `/users`, `/users/{id}` | Quản trị tạo, xem và sửa tài khoản. Gửi `version` khi sửa. Các vai trò là `admin`, `leader`, `specialist`. |
| `/users/{id}/assignments` | Xem ID đơn vị và ứng dụng đã phân công. `PUT` hoặc `DELETE` trên `/{type}/{targetId}` cấp hoặc thu hồi, với `type` là `organizations` cho Lãnh đạo hoặc `applications` cho Chuyên viên. Đổi vai trò xóa phân công của vai trò trước. |
| `/organizations`, `/data-centers`, `/applications`, `/databases` | Danh sách có `page` và `pageSize`. Chi tiết dùng `/{id}`. Quản trị tạo bằng `POST`, sửa bằng `PATCH /{id}` và lưu trữ bằng `POST /{id}/archive`. Sửa và lưu trữ gửi `version`. |
| `/applications/{id}/databases/{databaseId}` | Quản trị dùng `PUT` hoặc `DELETE` để thêm hoặc bỏ liên kết. Gửi `version` hiện hành của ứng dụng. Chi tiết ứng dụng trả `databaseIds` đã lọc theo quyền. |
| `/servers`, `/domains` | Danh sách và chi tiết theo phạm vi. Quản trị tạo bằng `POST`, sửa bằng `PATCH /{id}` và lưu trữ bằng `POST /{id}/archive`. Gửi `version` khi sửa hoặc lưu trữ. |
| `/servers/{id}/addresses`, `/servers/{id}/access-endpoints`, `/domains/{id}/dns-records`, `/domains/{id}/tls-endpoints` | Danh sách mục con nằm trong chi tiết tài nguyên. Quản trị thêm bằng `POST`, sửa bằng `PATCH /{childId}` và xóa bằng `DELETE /{childId}`. Các lệnh ghi gửi `version` của máy chủ hoặc tên miền. |
| `/applications/{id}/servers/{targetId}`, `/applications/{id}/domains/{targetId}`, `/applications/{id}/dns-records/{targetId}`, `/domains/{id}/servers/{targetId}` | Quản trị dùng `PUT` và `DELETE` để quản lý liên kết. Gửi `version` của ứng dụng hoặc tên miền. |
| `/search?q=...` | Trả ứng dụng cùng đơn vị, người phụ trách, máy chủ, DC, địa chỉ và phạm vi mạng, tên miền đã lọc quyền. IP và hostname/tên miền đầy đủ khớp chính xác. Từ khóa văn bản có thể khớp một phần tên ứng dụng hoặc đơn vị. |
| `/audit-events` | Quản trị xem nhật ký đăng nhập, thay đổi phân công, tài khoản và danh mục. |

Lãnh đạo thấy danh mục theo đơn vị được cấp. Chuyên viên thấy ứng dụng được phân công và tài nguyên liên kết trong phạm vi. Chuyên viên có thể sửa `name`, `description` và `status` của ứng dụng được phân công. `serviceType` nhận `ordered`, `monitoring` hoặc `operations`. Guard phiên nằm trong `apps/api/src/guards/session.guard.ts`. Các hàm lọc `applicationScope`, `serverScope`, `domainScope` nằm trong `apps/api/src/models/access.ts`. Các thao tác ghi của người B có thể gọi `recordAudit` trong cùng transaction.

Chạy `npm.cmd test --workspace @lcit/api` để kiểm tra băm mật khẩu. Đặt `LCIT_TEST_DATABASE_URL` tới một PostgreSQL **dùng riêng cho kiểm thử, chưa có schema `lcit`** để chạy thêm ca tích hợp migration, seed, phiên, phân quyền và nhật ký. Bộ kiểm thử tạo schema và dữ liệu riêng trong DB đó.

Giao diện Giai đoạn 1 dùng chung các màn hình cho trình duyệt và Tauri. Sau khi áp dụng migration `003_catalog_search.sql` và khởi động lại API, mở giao diện, đăng nhập, chọn **Tra cứu** và thử `10.42.0.15` với bộ dữ liệu mẫu. Quản trị có thể mở danh mục máy chủ, tên miền, tài khoản và phân công ngay trên giao diện. Lãnh đạo và Chuyên viên chỉ thấy bản ghi DNS được liên kết với ứng dụng họ có quyền xem. Các điểm TLS và cấu hình SSH/RDP dành cho Quản trị. Luồng cấp quyền mở kết nối và gọi trình khách Windows thuộc Giai đoạn 4.

## Build và chạy ứng dụng Windows

Để chạy bản Tauri, khởi động API như ở bước 3, sau đó chạy `npm.cmd run desktop:dev` trong cửa sổ PowerShell riêng.

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run desktop:dev
npm.cmd run desktop:build
```

`npm run build` xuất giao diện tĩnh vào `apps/desktop/out`. Hai lệnh `desktop:*` cần Rust toolchain MSVC, Visual Studio Build Tools với workload **Desktop development with C++**, Windows SDK và WebView2. Kiểm tra Rust bằng `rustc -V` và `cargo -V`, MSVC bằng `cl` trong Developer PowerShell, WebView2 tại **Settings → Apps → Installed apps**. Bản Windows dùng trình cài NSIS.

Nếu đổi địa chỉ API, sao chép `apps/desktop/.env.example` sang `apps/desktop/.env.local` và đặt `NEXT_PUBLIC_API_URL` trước khi build. Cập nhật `API_CORS_ORIGINS` nếu đổi origin desktop và cập nhật `connect-src` trong cấu hình Tauri nếu dùng một cổng HTTP phát triển khác. `DATABASE_URL` thuộc cấu hình API.

## Dữ liệu kiểm thử tổng hợp

- [catalog.json](fixtures/catalog.json) có hai đơn vị, hai trung tâm dữ liệu và hai máy chủ dùng cùng IP nội bộ ở hai phạm vi mạng khác nhau.
- [import-sample.xlsx](fixtures/import-sample.xlsx) có sheet `Catalog`. Dòng 2 và 3 hợp lệ, dòng 4 lặp lại dòng 2, dòng 5 có IP sai định dạng. Workbook phục vụ kiểm thử parser và quy tắc phát hiện trùng.

## Trạng thái kiểm tra môi trường

Đã xác nhận Node.js 26.13.0, npm 11.20.0 và WebView2 157.0.4341.46. TypeScript 5.9.3 biên dịch từng tệp nguồn thành công khi kiểm tra riêng cú pháp. Fixture JSON và workbook đã được kiểm tra với hai đơn vị, hai DC, IP trùng giữa hai mạng và các dòng Excel hợp lệ, trùng, lỗi.

DNS của Neon phân giải được. Tiến trình kiểm tra nhận `EACCES` khi mở kết nối tới `registry.npmjs.org:443` và Neon trên cổng `5432`. Cần chạy `npm install` để sinh lockfile, sau đó chạy `npm run typecheck`, `npm run build` và `npm run db:migrate` hai lần trên môi trường có thể truy cập hai dịch vụ. Nghiệm thu desktop Windows còn cần Rust/MSVC và xác nhận màn hình đọc được `/health/ready`.

Tham khảo [Tauri với Next.js](https://v2.tauri.app/start/frontend/nextjs/) và [điều kiện build Tauri trên Windows](https://v2.tauri.app/start/prerequisites/).
