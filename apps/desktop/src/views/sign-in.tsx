import { useState } from 'react';
import { useHealth, useSignIn } from '../controllers/use-sign-in';
import { apiUrl, Session } from '../models/api';
import styles from './sign-in.module.css';
import { Icon } from './icon';

const healthMessages = {
  checking: 'Đang kiểm tra kết nối', ready: 'API và cơ sở dữ liệu đang hoạt động',
  unavailable: 'API đang chạy, cơ sở dữ liệu chưa sẵn sàng', offline: 'Không kết nối được API',
};

export function Health() {
  const { status, retry } = useHealth();
  return <aside className={styles.health} aria-label="Kết nối hệ thống">
    <div className={styles.healthText}>
      <p role="status"><span className={styles.statusDot} data-status={status} aria-hidden="true" />{healthMessages[status]}</p>
      <code>{apiUrl}</code>
    </div>
    <button type="button" className={styles.retry} disabled={status === 'checking'} onClick={retry}>Kiểm tra lại</button>
  </aside>;
}

export function SignIn({ onLogin, notice }: { onLogin: (session: Session) => void; notice: string }) {
  const { error, busy, submit } = useSignIn(onLogin);
  const [passwordVisible, setPasswordVisible] = useState(false);
  return <main className={styles.shell}>
    <section className={styles.intro} aria-label="Giới thiệu LCIT Manager">
      <div className={styles.introBrand}><span className={styles.mark}>L</span>LCIT Manager</div>
      <div className={styles.introContent}><span className={styles.kicker}>KHÔNG GIAN QUẢN LÝ TẬP TRUNG</span><h2>Hạ tầng rõ ràng.<br /><em>Vận hành chủ động.</em></h2><p>Kết nối ứng dụng, máy chủ và dữ liệu trong một không gian làm việc thống nhất.</p>
      <div className={styles.resourceGrid}>{[['applications', 'Ứng dụng'], ['servers', 'Máy chủ'], ['domains', 'Tên miền'], ['databases', 'Cơ sở dữ liệu']].map(([icon, label]) => <div key={icon}><Icon name={icon} /><span>{label}</span></div>)}</div></div>
      <div className={styles.introFooter}><Icon name="shield" size={18} />Thông tin tập trung · Truy cập theo phân quyền</div>
    </section>
    <div className={styles.surface}>
      <header className={styles.brand}><span className={styles.mark} aria-hidden="true">L</span><span>LCIT Manager</span></header>
      <section className={styles.card} aria-labelledby="sign-in-title">
        <p className="eyebrow">CHÀO MỪNG TRỞ LẠI</p><h1 id="sign-in-title">Đăng nhập</h1><p className={styles.subtitle}>Truy cập không gian làm việc của bạn.</p>
        <form className={styles.form} onSubmit={submit} aria-busy={busy}>
          <label htmlFor="sign-in-username">Tên đăng nhập</label>
          <input id="sign-in-username" name="username" placeholder="Nhập tên đăng nhập" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={64} required />
          <label htmlFor="sign-in-password">Mật khẩu</label>
          <div className={styles.passwordField}>
            <input id="sign-in-password" name="password" placeholder="Nhập mật khẩu" type={passwordVisible ? 'text' : 'password'} autoComplete="current-password" maxLength={256} required />
            <button
              type="button"
              className={styles.passwordToggle}
              aria-label={passwordVisible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
              aria-controls="sign-in-password"
              onClick={() => setPasswordVisible((visible) => !visible)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {passwordVisible ? <>
                  <path d="M10.7 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a19.5 19.5 0 0 1-3 3.6M6.2 6.2C3.5 8 2 12 2 12s4 7 10 7a9 9 0 0 0 4.1-1.1" />
                  <path d="m3 3 18 18" />
                </> : <>
                  <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </>}
              </svg>
            </button>
          </div>
          {(error || notice) && <p className={styles.error} role="alert">{error || notice}</p>}
          <button type="submit" className={styles.submit} disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
        </form>
      </section>
      <Health />
    </div>
  </main>;
}
