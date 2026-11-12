import { useHealth, useSignIn } from '../controllers/use-sign-in';
import { apiUrl, Session } from '../models/api';
import styles from './sign-in.module.css';

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
  return <main className={styles.shell}>
    <div className={styles.surface}>
      <header className={styles.brand}><span className={styles.mark} aria-hidden="true">L</span><span>LCIT Manager</span></header>
      <section className={styles.card} aria-labelledby="sign-in-title">
        <h1 id="sign-in-title">Đăng nhập</h1>
        <form className={styles.form} onSubmit={submit} aria-busy={busy}>
          <label htmlFor="sign-in-username">Tên đăng nhập</label>
          <input id="sign-in-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={64} required />
          <label htmlFor="sign-in-password">Mật khẩu</label>
          <input id="sign-in-password" name="password" type="password" autoComplete="current-password" maxLength={256} required />
          {(error || notice) && <p className={styles.error} role="alert">{error || notice}</p>}
          <button type="submit" className={styles.submit} disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
        </form>
      </section>
      <Health />
    </div>
  </main>;
}
