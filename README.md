# LCIT Manager

Nền tảng phát triển cho ứng dụng quản lý hạ tầng. Desktop dùng Next.js xuất tĩnh và Tauri v2. API dùng NestJS và kết nối trực tiếp tới PostgreSQL Neon.

## Chạy trên Windows

1. Chuẩn bị Node.js 22 trở lên, npm và kết nối tới npm registry. Kiểm tra bằng `node -v` và `npm -v`.
2. Từ thư mục repo, chạy `npm install` để cài dependencies và sinh `package-lock.json`. Sau khi có lockfile, dùng `npm ci` để cài lại cùng bộ phiên bản.
3. Kiểm tra `apps/api/.env`. Nếu chưa có, sao chép từ `apps/api/.env.example` và đặt `DATABASE_URL` thành URI Neon của môi trường phát triển. API đọc tệp này khi chạy tại workspace API.
4. Chạy `npm run db:migrate`. Lệnh tạo schema `lcit` và bảng theo dõi migration trên DB đã cấu hình. Chạy lại để xác nhận kết quả `Database is up to date.`.
5. Chạy `npm run dev:api`. Swagger UI ở `http://127.0.0.1:4000/docs` và OpenAPI JSON ở `http://127.0.0.1:4000/docs-json`.
6. Mở terminal khác, chạy `npm run dev:desktop` rồi mở `http://127.0.0.1:3000`. Màn hình kết nối sẽ gọi readiness endpoint của API.

Kiểm tra API từ PowerShell khi API đang chạy.

```powershell
curl.exe -i http://127.0.0.1:4000/health/live
curl.exe -i http://127.0.0.1:4000/health/ready
```

Liveness trả HTTP 200 khi tiến trình API chạy. Readiness trả HTTP 200 khi PostgreSQL phản hồi và HTTP 503 khi PostgreSQL không truy cập được. Để kiểm tra nhánh lỗi, mở terminal khác, tạm đặt `$env:DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/invalid?sslmode=disable'`, dừng API đang chạy rồi khởi động API từ terminal đó. Sau khi kiểm tra, chạy `Remove-Item Env:DATABASE_URL` và khởi động lại API.

## Build và chạy ứng dụng Windows

```powershell
npm run typecheck
npm run build
npm run desktop:dev
npm run desktop:build
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
