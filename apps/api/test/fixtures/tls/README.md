# Chứng thư TLS chỉ dùng cho kiểm thử

CA và khóa/chứng thư tại đây là dữ liệu tổng hợp cho máy chủ thử nghiệm cục bộ. Khóa này không được dùng cho triển khai. Khóa riêng của CA không được lưu.

`valid.pem` có SAN `monitor.example.test`, hiệu lực 2020–2120. `expired.pem` có cùng SAN và hết hạn năm 2021. Cả hai dùng `test-only-key.pem` và được ký bởi `ca.pem`. Bài kiểm thử chỉ truyền CA cho kết nối cục bộ của nó, không thay đổi kho tin cậy hệ thống.
